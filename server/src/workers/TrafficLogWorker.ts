import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { db } from '../db';
import { logger } from '../utils/logger';
import { geoipService } from '../services/geoip.service';

/**
 * TrafficLogWorker — tails /etc/nginx/oblihub_traffic.log (bind-mounted from the proxy container
 * to <stacksDir>/_proxy/), aggregates in-memory into per-(proxy_host, minute) buckets, flushes
 * every 60s to `proxy_traffic_1m` + top-K tables + latency histogram + sample tables.
 *
 * Log line format (pipe-separated, 14 fields, defined in nginx.service.ts main config):
 *   $proxy_host_id|$msec|$status|$body_bytes_sent|$request_length|$request_time|
 *   $upstream_response_time|$remote_addr|$request_method|$request_uri|$http_user_agent|
 *   $http_referer|$upstream_cache_status|$server_protocol
 *
 * In-memory state (all flushed atomically):
 *   - buckets[key] = 1-minute aggregation (counts by class + granular code + latency histogram)
 *   - topIps[key][class][ip] = { count, bytesOut } — bucketed at hour granularity
 *   - topUris[key][class][uri] = { count, latencySum } — idem
 *   - errorSamples: per-host ring buffer, capped at ~SAMPLE_RING_SIZE
 *   - slowSamples: per-host per-hour top-N by latency
 *
 * On flush, per-1m rows UPSERT with counter-increment merge; top-N tables get per-class rows;
 * error samples INSERT then TRIM per host (keeping the most recent SAMPLE_RING_SIZE); slow
 * requests replace the top-N per (host, hour) window.
 */

const LOG_PATH = path.join(config.stacksDir, '_proxy', 'oblihub_traffic.log');
const POLL_INTERVAL_MS = 1_000;
const FLUSH_INTERVAL_MS = 60_000;
const TOP_K = 20;
const SAMPLE_RING_SIZE = 500;          // error samples kept per host
const SLOW_TOP_PER_HOUR = 20;          // slow-request samples kept per (host, hour)

// Latency histogram buckets (upper bounds, ms). Anything ≥ last bucket lands in _ge_10000.
const LAT_BOUNDS = [50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;
const LAT_KEYS = ['lt_50', 'lt_100', 'lt_250', 'lt_500', 'lt_1000', 'lt_2500', 'lt_5000', 'lt_10000', 'ge_10000'] as const;

// Granular codes we track as their own counter columns (matches migration 047).
const GRANULAR_CODES = [401, 403, 404, 429, 499, 500, 502, 503, 504] as const;

interface LatHist { edge: number[]; upstream: number[]; upSum: number; upMax: number; upCount: number; }
interface BucketStats {
  reqCount: number;
  bytesOut: number;
  bytesIn: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  granular: Record<number, number>; // 401 → count, 403 → count, ...
  latencyMsSum: number;
  latencyMsMax: number;
  uniqueIps: Set<string>;
  hist: LatHist;
}

interface TopStat { count: number; bytesOut: number; latencyMsSum: number; }
type StatusClass = 'all' | '2xx' | '3xx' | '4xx' | '5xx';

interface ErrorSample {
  ts: number; status: number; method: string; uri: string; ip: string;
  latencyMs: number; upstreamMs: number | null; ua: string; referer: string;
}

interface SlowSample extends ErrorSample {}

const buckets = new Map<string, BucketStats>();                                // key: `${hostId}|${minuteMs}`
const topIps = new Map<string, Map<StatusClass, Map<string, TopStat>>>();      // key: `${hostId}|${hourMs}`
const topUris = new Map<string, Map<StatusClass, Map<string, TopStat>>>();     // key: `${hostId}|${hourMs}`
const errorSamplesByHost = new Map<number, ErrorSample[]>();                   // in-flight ring buffer per host
const slowSamplesByHostHour = new Map<string, SlowSample[]>();                 // key: `${hostId}|${hourMs}`

let lastSize = 0;
let watching = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let activeLogPath: string | null = null;

function resolveLogPath(): string | null {
  return fs.existsSync(LOG_PATH) ? LOG_PATH : null;
}

function bucketKey(hostId: number, tsMs: number, granularity: 'minute' | 'hour'): string {
  const align = granularity === 'minute' ? 60_000 : 3_600_000;
  const bucketTs = Math.floor(tsMs / align) * align;
  return `${hostId}|${bucketTs}`;
}

function statusClassOf(status: number): '2xx' | '3xx' | '4xx' | '5xx' | 'other' {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500) return '5xx';
  return 'other';
}

function latencyBucketIdx(ms: number): number {
  for (let i = 0; i < LAT_BOUNDS.length; i++) if (ms < LAT_BOUNDS[i]) return i;
  return LAT_BOUNDS.length; // ge_10000
}

function getOrInitBucket(key: string): BucketStats {
  let b = buckets.get(key);
  if (!b) {
    b = {
      reqCount: 0, bytesOut: 0, bytesIn: 0,
      status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0,
      granular: {},
      latencyMsSum: 0, latencyMsMax: 0,
      uniqueIps: new Set(),
      hist: {
        edge: new Array(LAT_KEYS.length).fill(0),
        upstream: new Array(LAT_KEYS.length).fill(0),
        upSum: 0, upMax: 0, upCount: 0,
      },
    };
    buckets.set(key, b);
  }
  return b;
}

function bumpTop(map: Map<string, Map<StatusClass, Map<string, TopStat>>>, hourKey: string, cls: StatusClass, ident: string, bytesOut: number, latencyMs: number): void {
  let byClass = map.get(hourKey);
  if (!byClass) { byClass = new Map(); map.set(hourKey, byClass); }
  let inner = byClass.get(cls);
  if (!inner) { inner = new Map(); byClass.set(cls, inner); }
  let s = inner.get(ident);
  if (!s) { s = { count: 0, bytesOut: 0, latencyMsSum: 0 }; inner.set(ident, s); }
  s.count++;
  s.bytesOut += bytesOut;
  s.latencyMsSum += latencyMs;
}

function pushErrorSample(hostId: number, sample: ErrorSample): void {
  let arr = errorSamplesByHost.get(hostId);
  if (!arr) { arr = []; errorSamplesByHost.set(hostId, arr); }
  arr.push(sample);
  // Ring behavior: cap to SAMPLE_RING_SIZE in memory too, so a burst doesn't blow up RAM
  // between flushes.
  if (arr.length > SAMPLE_RING_SIZE) arr.splice(0, arr.length - SAMPLE_RING_SIZE);
}

function pushSlowSample(hostId: number, hourMs: number, sample: SlowSample): void {
  const key = `${hostId}|${hourMs}`;
  let arr = slowSamplesByHostHour.get(key);
  if (!arr) { arr = []; slowSamplesByHostHour.set(key, arr); }
  arr.push(sample);
  // Keep 2x the target so quicksort at flush time still finds the true top-N.
  if (arr.length > SLOW_TOP_PER_HOUR * 2) {
    arr.sort((a, b) => b.latencyMs - a.latencyMs);
    arr.length = SLOW_TOP_PER_HOUR;
  }
}

function decodePipeField(s: string): string {
  // nginx escapes bytes < 32 as \xHH — leave them as-is; we truncate anyway.
  return s || '';
}

function processLine(line: string): void {
  if (!line || line[0] === '#') return;
  const parts = line.split('|');
  if (parts.length < 14) return; // old format lines during a rolling reload — skip

  const hostId = parseInt(parts[0], 10);
  if (!hostId || isNaN(hostId)) return;

  const msec = parseFloat(parts[1]);
  const tsMs = isNaN(msec) ? Date.now() : Math.floor(msec * 1000);
  const status = parseInt(parts[2], 10) || 0;
  const bytesOut = parseInt(parts[3], 10) || 0;
  const bytesIn = parseInt(parts[4], 10) || 0;
  const reqTimeSec = parseFloat(parts[5]);
  const latencyMs = isNaN(reqTimeSec) ? 0 : Math.round(reqTimeSec * 1000);
  const upTimeRaw = parts[6];
  let upstreamMs: number | null = null;
  if (upTimeRaw && upTimeRaw !== '-') {
    // nginx joins multiple upstream times with commas when it retries — take the LAST value
    // (the one that actually served the response).
    const last = upTimeRaw.split(',').pop()!.trim();
    const v = parseFloat(last);
    if (!isNaN(v)) upstreamMs = Math.round(v * 1000);
  }
  const ip = parts[7] || '';
  const method = decodePipeField(parts[8]).slice(0, 8);
  const uri = decodePipeField(parts[9]).split('?')[0].slice(0, 1024);
  const ua = decodePipeField(parts[10]).slice(0, 512);
  const referer = decodePipeField(parts[11]).slice(0, 512);
  // parts[12] = upstream_cache_status, parts[13] = server_protocol — collected for future use.

  const minKey = bucketKey(hostId, tsMs, 'minute');
  const hourKey = bucketKey(hostId, tsMs, 'hour');
  const hourMs = Math.floor(tsMs / 3_600_000) * 3_600_000;

  const b = getOrInitBucket(minKey);
  b.reqCount++;
  b.bytesOut += bytesOut;
  b.bytesIn += bytesIn;
  const cls = statusClassOf(status);
  if (cls === '2xx') b.status2xx++;
  else if (cls === '3xx') b.status3xx++;
  else if (cls === '4xx') b.status4xx++;
  else if (cls === '5xx') b.status5xx++;
  if ((GRANULAR_CODES as readonly number[]).includes(status)) {
    b.granular[status] = (b.granular[status] || 0) + 1;
  }
  b.latencyMsSum += latencyMs;
  if (latencyMs > b.latencyMsMax) b.latencyMsMax = latencyMs;
  if (ip) b.uniqueIps.add(ip);

  // Latency histograms — edge always, upstream only when contacted.
  b.hist.edge[latencyBucketIdx(latencyMs)]++;
  if (upstreamMs != null) {
    b.hist.upstream[latencyBucketIdx(upstreamMs)]++;
    b.hist.upSum += upstreamMs;
    b.hist.upCount++;
    if (upstreamMs > b.hist.upMax) b.hist.upMax = upstreamMs;
  }

  // Top-N counters — populated for both 'all' AND the specific status class so per-class
  // top-erroring URIs is a point query.
  if (ip) {
    bumpTop(topIps, hourKey, 'all', ip, bytesOut, latencyMs);
    if (cls !== 'other') bumpTop(topIps, hourKey, cls, ip, bytesOut, latencyMs);
  }
  if (uri) {
    bumpTop(topUris, hourKey, 'all', uri, bytesOut, latencyMs);
    if (cls !== 'other') bumpTop(topUris, hourKey, cls, uri, bytesOut, latencyMs);
  }

  // Sample ring buffers — error samples for every 4xx/5xx, slow-request samples for the top-N
  // per hour regardless of status. Both are BOUNDED, so the DB doesn't explode.
  if (cls === '4xx' || cls === '5xx') {
    pushErrorSample(hostId, { ts: tsMs, status, method, uri, ip, latencyMs, upstreamMs, ua, referer });
  }
  pushSlowSample(hostId, hourMs, { ts: tsMs, status, method, uri, ip, latencyMs, upstreamMs, ua, referer });
}

async function pollFile(): Promise<void> {
  if (!activeLogPath) {
    activeLogPath = resolveLogPath();
    if (!activeLogPath) return;
    try { lastSize = fs.statSync(activeLogPath).size; } catch { lastSize = 0; }
  }
  let stat: fs.Stats;
  try { stat = fs.statSync(activeLogPath); } catch { return; }
  if (stat.size === lastSize) return;
  if (stat.size < lastSize) { lastSize = 0; }
  const fd = fs.openSync(activeLogPath, 'r');
  try {
    const toRead = stat.size - lastSize;
    if (toRead > 0) {
      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, lastSize);
      lastSize = stat.size;
      const text = buf.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim()) processLine(line);
      }
    }
  } finally { fs.closeSync(fd); }
}

async function flushBuckets(): Promise<void> {
  if (buckets.size === 0 && topIps.size === 0 && topUris.size === 0
      && errorSamplesByHost.size === 0 && slowSamplesByHostHour.size === 0) return;

  const bucketSnap = new Map(buckets);
  const ipsSnap = new Map(topIps);
  const urisSnap = new Map(topUris);
  const errorSnap = new Map(errorSamplesByHost);
  const slowSnap = new Map(slowSamplesByHostHour);
  buckets.clear(); topIps.clear(); topUris.clear();
  errorSamplesByHost.clear(); slowSamplesByHostHour.clear();

  try {
    // ── 1m aggregate rows ──
    for (const [key, b] of bucketSnap) {
      const [hostIdStr, tsStr] = key.split('|');
      const hostId = parseInt(hostIdStr, 10);
      const ts = new Date(parseInt(tsStr, 10));
      const row: Record<string, unknown> = {
        proxy_host_id: hostId, ts,
        req_count: b.reqCount, bytes_out: b.bytesOut, bytes_in: b.bytesIn,
        status_2xx: b.status2xx, status_3xx: b.status3xx, status_4xx: b.status4xx, status_5xx: b.status5xx,
        latency_ms_sum: b.latencyMsSum, latency_ms_max: b.latencyMsMax,
        unique_ips: b.uniqueIps.size,
        lat_up_sum: b.hist.upSum, lat_up_max: b.hist.upMax, lat_up_count: b.hist.upCount,
      };
      for (const code of GRANULAR_CODES) row[`status_${code}`] = b.granular[code] || 0;
      for (let i = 0; i < LAT_KEYS.length; i++) {
        row[`lat_edge_${LAT_KEYS[i]}`] = b.hist.edge[i] || 0;
        row[`lat_up_${LAT_KEYS[i]}`] = b.hist.upstream[i] || 0;
      }

      // Build the ON CONFLICT MERGE clause dynamically — every counter is additive, MAX for
      // per-bucket peaks.
      const mergeClause: Record<string, unknown> = {
        req_count: db.raw('proxy_traffic_1m.req_count + ?', [b.reqCount]),
        bytes_out: db.raw('proxy_traffic_1m.bytes_out + ?', [b.bytesOut]),
        bytes_in: db.raw('proxy_traffic_1m.bytes_in + ?', [b.bytesIn]),
        status_2xx: db.raw('proxy_traffic_1m.status_2xx + ?', [b.status2xx]),
        status_3xx: db.raw('proxy_traffic_1m.status_3xx + ?', [b.status3xx]),
        status_4xx: db.raw('proxy_traffic_1m.status_4xx + ?', [b.status4xx]),
        status_5xx: db.raw('proxy_traffic_1m.status_5xx + ?', [b.status5xx]),
        latency_ms_sum: db.raw('proxy_traffic_1m.latency_ms_sum + ?', [b.latencyMsSum]),
        latency_ms_max: db.raw('GREATEST(proxy_traffic_1m.latency_ms_max, ?)', [b.latencyMsMax]),
        unique_ips: db.raw('proxy_traffic_1m.unique_ips + ?', [b.uniqueIps.size]),
        lat_up_sum: db.raw('proxy_traffic_1m.lat_up_sum + ?', [b.hist.upSum]),
        lat_up_max: db.raw('GREATEST(proxy_traffic_1m.lat_up_max, ?)', [b.hist.upMax]),
        lat_up_count: db.raw('proxy_traffic_1m.lat_up_count + ?', [b.hist.upCount]),
      };
      for (const code of GRANULAR_CODES) {
        const v = b.granular[code] || 0;
        mergeClause[`status_${code}`] = db.raw(`proxy_traffic_1m.status_${code} + ?`, [v]);
      }
      for (let i = 0; i < LAT_KEYS.length; i++) {
        mergeClause[`lat_edge_${LAT_KEYS[i]}`] = db.raw(`proxy_traffic_1m.lat_edge_${LAT_KEYS[i]} + ?`, [b.hist.edge[i] || 0]);
        mergeClause[`lat_up_${LAT_KEYS[i]}`] = db.raw(`proxy_traffic_1m.lat_up_${LAT_KEYS[i]} + ?`, [b.hist.upstream[i] || 0]);
      }
      await db('proxy_traffic_1m').insert(row).onConflict(['proxy_host_id', 'ts']).merge(mergeClause);
    }

    // ── Top IPs — per (host, hour, class) row ──
    for (const [key, byClass] of ipsSnap) {
      const [hostIdStr, tsStr] = key.split('|');
      const hostId = parseInt(hostIdStr, 10);
      const ts = new Date(parseInt(tsStr, 10));
      for (const [cls, ipMap] of byClass) {
        const sorted = [...ipMap.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, TOP_K);
        for (const [ip, s] of sorted) {
          await db('proxy_traffic_top_ips_1h')
            .insert({ proxy_host_id: hostId, ts, status_class: cls, ip, req_count: s.count, bytes_out: s.bytesOut })
            .onConflict(['proxy_host_id', 'ts', 'status_class', 'ip'])
            .merge({
              req_count: db.raw('proxy_traffic_top_ips_1h.req_count + ?', [s.count]),
              bytes_out: db.raw('proxy_traffic_top_ips_1h.bytes_out + ?', [s.bytesOut]),
            });
        }
      }
    }

    // ── Top URIs — per (host, hour, class) row ──
    for (const [key, byClass] of urisSnap) {
      const [hostIdStr, tsStr] = key.split('|');
      const hostId = parseInt(hostIdStr, 10);
      const ts = new Date(parseInt(tsStr, 10));
      for (const [cls, uriMap] of byClass) {
        const sorted = [...uriMap.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, TOP_K);
        for (const [uri, s] of sorted) {
          const avg = Math.round(s.latencyMsSum / Math.max(1, s.count));
          await db('proxy_traffic_top_uris_1h')
            .insert({ proxy_host_id: hostId, ts, status_class: cls, uri, req_count: s.count, avg_latency_ms: avg })
            .onConflict(['proxy_host_id', 'ts', 'status_class', 'uri'])
            .merge({
              req_count: db.raw('proxy_traffic_top_uris_1h.req_count + ?', [s.count]),
              avg_latency_ms: db.raw('((proxy_traffic_top_uris_1h.avg_latency_ms * proxy_traffic_top_uris_1h.req_count) + ?) / (proxy_traffic_top_uris_1h.req_count + ?)', [s.latencyMsSum, s.count]),
            });
        }
      }
    }

    // ── Error samples ring buffer ──
    for (const [hostId, samples] of errorSnap) {
      if (samples.length === 0) continue;
      // Resolve geo up-front (cache-hit fast path) and enrich.
      const ips = [...new Set(samples.map(s => s.ip).filter(Boolean))];
      const geoMap = await geoipService.lookupMany(ips);
      const rows = samples.map(s => ({
        proxy_host_id: hostId,
        ts: new Date(s.ts),
        status: s.status,
        method: s.method || null,
        uri: s.uri,
        ip: s.ip,
        country_code: geoMap.get(s.ip)?.countryCode || null,
        latency_ms: s.latencyMs,
        upstream_ms: s.upstreamMs,
        user_agent: s.ua || null,
        referer: s.referer || null,
      }));
      await db('proxy_traffic_error_samples').insert(rows);
      // Trim to ring buffer size — delete oldest rows once total for this host exceeds cap.
      const count = await db('proxy_traffic_error_samples').where({ proxy_host_id: hostId }).count<{ count: string }[]>('* as count').first();
      const total = Number(count?.count || 0);
      if (total > SAMPLE_RING_SIZE) {
        const excess = total - SAMPLE_RING_SIZE;
        const toDelete = await db('proxy_traffic_error_samples')
          .where({ proxy_host_id: hostId })
          .orderBy('ts', 'asc')
          .limit(excess)
          .pluck('id');
        if (toDelete.length > 0) await db('proxy_traffic_error_samples').whereIn('id', toDelete).delete();
      }
    }

    // ── Slow-request samples ──
    for (const [key, samples] of slowSnap) {
      if (samples.length === 0) continue;
      const [hostIdStr, tsStr] = key.split('|');
      const hostId = parseInt(hostIdStr, 10);
      const hourTs = new Date(parseInt(tsStr, 10));
      // Final top-N pick.
      samples.sort((a, b) => b.latencyMs - a.latencyMs);
      const top = samples.slice(0, SLOW_TOP_PER_HOUR);
      const ips = [...new Set(top.map(s => s.ip).filter(Boolean))];
      const geoMap = await geoipService.lookupMany(ips);
      // Replace-in-place: drop previous rows for the same (host, hour) then insert the fresh top.
      // This makes the table an idempotent snapshot rather than an accumulator.
      await db('proxy_traffic_slow_requests').where({ proxy_host_id: hostId, ts: hourTs }).delete();
      await db('proxy_traffic_slow_requests').insert(top.map(s => ({
        proxy_host_id: hostId,
        ts: hourTs,
        status: s.status,
        method: s.method || null,
        uri: s.uri,
        ip: s.ip,
        country_code: geoMap.get(s.ip)?.countryCode || null,
        latency_ms: s.latencyMs,
        upstream_ms: s.upstreamMs,
        user_agent: s.ua || null,
        referer: s.referer || null,
      })));
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'TrafficLogWorker flush failed');
  }
}

export function startTrafficLogWorker(): void {
  if (watching) return;
  watching = true;
  logger.info({ logPath: LOG_PATH }, 'Starting traffic log worker (1s poll, 60s flush)');
  pollTimer = setInterval(() => { pollFile().catch(err => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'TrafficLogWorker poll failed')); }, POLL_INTERVAL_MS);
  flushTimer = setInterval(() => { flushBuckets().catch(err => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'TrafficLogWorker flush failed')); }, FLUSH_INTERVAL_MS);
}

export function stopTrafficLogWorker(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  watching = false;
}
