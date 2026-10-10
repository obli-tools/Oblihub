import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { geoipService } from '../services/geoip.service';
import { AppError } from '../middleware/errorHandler';

/**
 * Traffic controller. All reads are scoped by team-visibility (own teams + global for admin).
 *
 * Every list endpoint supports a common `Filters` shape parsed from the query string. The
 * filter store on the client mirrors this — a `?hosts=1,2&status=4xx&ip=1.2.3.4&errorsOnly=1`
 * URL round-trips 1:1 with the Zustand store so any dashboard state is deep-linkable.
 *
 * Latency percentiles are computed from the on-row histogram (migration 048) via linear
 * interpolation between adjacent buckets — good enough for dashboarding, no need for
 * per-request storage.
 */

// ── Common filter parsing ──

interface Filters {
  hostIds: number[] | null;      // null = every visible host
  countries: string[] | null;    // ISO-2 country codes; null = no country filter
  statusClasses: Array<'2xx' | '3xx' | '4xx' | '5xx'> | null;
  statusCodes: number[] | null;
  ips: string[] | null;
  uriPrefixes: string[] | null;
  errorsOnly: boolean;
}

function parseFilters(req: Request): Filters {
  const q = req.query as Record<string, string | undefined>;
  const csv = (v: string | undefined): string[] | null => v ? v.split(',').map(s => s.trim()).filter(Boolean) : null;
  const csvNum = (v: string | undefined): number[] | null => {
    const arr = csv(v);
    return arr ? arr.map(s => parseInt(s, 10)).filter(n => !isNaN(n)) : null;
  };
  const cls = csv(q.status);
  const validClasses = cls?.filter(c => ['2xx','3xx','4xx','5xx'].includes(c)) as Filters['statusClasses'] | undefined;
  return {
    hostIds: csvNum(q.hosts),
    countries: csv(q.countries),
    statusClasses: validClasses && validClasses.length > 0 ? validClasses : null,
    statusCodes: csvNum(q.codes),
    ips: csv(q.ip),
    uriPrefixes: csv(q.uri),
    errorsOnly: q.errorsOnly === '1' || q.errorsOnly === 'true',
  };
}

interface RangeSpec { fromMs: number; bucket: 'minute' | 'hour' }

function parseRange(raw: string | undefined): RangeSpec {
  const now = Date.now();
  switch (raw) {
    case '1h':  return { fromMs: now - 60 * 60 * 1000, bucket: 'minute' };
    case '6h':  return { fromMs: now - 6 * 60 * 60 * 1000, bucket: 'minute' };
    case '24h': return { fromMs: now - 24 * 60 * 60 * 1000, bucket: 'minute' };
    case '7d':  return { fromMs: now - 7 * 24 * 60 * 60 * 1000, bucket: 'minute' };
    case '30d': return { fromMs: now - 30 * 24 * 60 * 60 * 1000, bucket: 'hour' };
    case '90d': return { fromMs: now - 90 * 24 * 60 * 60 * 1000, bucket: 'hour' };
    default:    return { fromMs: now - 24 * 60 * 60 * 1000, bucket: 'minute' };
  }
}

async function visibleHostIdsForUser(req: Request): Promise<number[]> {
  const session = req.session as { userId?: number; role?: string };
  if (!session.userId) throw new AppError(401, 'Not authenticated');
  if (session.role === 'admin') {
    const rows = await db('proxy_hosts').select('id');
    return rows.map(r => r.id as number);
  }
  const teamIds = (await db('team_members').where({ user_id: session.userId }).pluck('team_id')) as number[];
  if (teamIds.length === 0) return [];
  const rows = await db('proxy_hosts')
    .join('stacks', 'proxy_hosts.stack_id', 'stacks.id')
    .whereIn('stacks.team_id', teamIds)
    .select('proxy_hosts.id');
  return rows.map(r => r.id as number);
}

async function assertHostVisible(req: Request, hostId: number): Promise<void> {
  const visible = await visibleHostIdsForUser(req);
  if (!visible.includes(hostId)) throw new AppError(403, 'Not authorized for this proxy host');
}

async function effectiveHostIds(req: Request, filters: Filters): Promise<number[]> {
  const visible = await visibleHostIdsForUser(req);
  if (!filters.hostIds) return visible;
  return visible.filter(id => filters.hostIds!.includes(id));
}

// ── Latency percentile computation ──

const LAT_KEYS = ['lt_50', 'lt_100', 'lt_250', 'lt_500', 'lt_1000', 'lt_2500', 'lt_5000', 'lt_10000', 'ge_10000'] as const;
const LAT_UPPER = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]; // cap on ge_10000 for interpolation

/**
 * Given a histogram (array of counts, one per LAT_KEYS bucket), compute the pTh percentile
 * (p ∈ [0..1]) by linear interpolation. Returns 0 when the histogram is empty.
 */
function percentileFromHist(buckets: number[], p: number): number {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < buckets.length; i++) {
    const prevAcc = acc;
    acc += buckets[i];
    if (acc >= target) {
      const lower = i === 0 ? 0 : LAT_UPPER[i - 1];
      const upper = LAT_UPPER[i];
      const frac = buckets[i] > 0 ? (target - prevAcc) / buckets[i] : 0;
      return Math.round(lower + (upper - lower) * frac);
    }
  }
  return LAT_UPPER[LAT_UPPER.length - 1];
}

function extractHist(row: Record<string, unknown>, prefix: 'lat_edge_' | 'lat_up_'): number[] {
  return LAT_KEYS.map(k => Number(row[`${prefix}${k}`]) || 0);
}

// ── Controller ──

export const trafficController = {
  /** Host-level time series with granular codes + latency percentiles. */
  async hostTimeSeries(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await assertHostVisible(req, id);
      const { fromMs, bucket } = parseRange(req.query.range as string);
      const table = bucket === 'minute' ? 'proxy_traffic_1m' : 'proxy_traffic_1h';
      const rows = await db(table).where({ proxy_host_id: id }).where('ts', '>=', new Date(fromMs)).orderBy('ts');
      res.json({ success: true, data: { bucket, points: rows.map(pointFromRow) } });
    } catch (err) { next(err); }
  },

  async hostTopIps(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await assertHostVisible(req, id);
      const { fromMs } = parseRange(req.query.range as string);
      const statusClass = (req.query.class as string) || 'all';
      const rows = await db('proxy_traffic_top_ips_1h')
        .where({ proxy_host_id: id, status_class: statusClass })
        .where('ts', '>=', new Date(fromMs))
        .select('ip', db.raw('SUM(req_count)::bigint AS req_count'), db.raw('SUM(bytes_out)::bigint AS bytes_out'))
        .groupBy('ip').orderBy('req_count', 'desc').limit(50);
      const geoMap = await geoipService.lookupMany(rows.map(r => r.ip as string));
      res.json({ success: true, data: rows.map(r => ({
        ip: r.ip as string,
        reqCount: Number(r.req_count) || 0,
        bytesOut: Number(r.bytes_out) || 0,
        geo: geoMap.get(r.ip as string) || null,
      })) });
    } catch (err) { next(err); }
  },

  async hostTopUris(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await assertHostVisible(req, id);
      const { fromMs } = parseRange(req.query.range as string);
      const statusClass = (req.query.class as string) || 'all';
      const rows = await db('proxy_traffic_top_uris_1h')
        .where({ proxy_host_id: id, status_class: statusClass })
        .where('ts', '>=', new Date(fromMs))
        .select('uri',
          db.raw('SUM(req_count)::bigint AS req_count'),
          db.raw('SUM(req_count * avg_latency_ms) / GREATEST(1, SUM(req_count)) AS avg_latency_ms'))
        .groupBy('uri').orderBy('req_count', 'desc').limit(50);
      res.json({ success: true, data: rows.map(r => ({
        uri: r.uri as string,
        reqCount: Number(r.req_count) || 0,
        avgLatencyMs: Math.round(Number(r.avg_latency_ms) || 0),
      })) });
    } catch (err) { next(err); }
  },

  /**
   * Team cumul — sums per-bucket across every visible host filtered by the filter query
   * params. Also returns percentile-ready aggregates.
   */
  async teamCumul(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters = parseFilters(req);
      const hostIds = await effectiveHostIds(req, filters);
      const { fromMs, bucket } = parseRange(req.query.range as string);
      if (hostIds.length === 0) { res.json({ success: true, data: { bucket, points: [] } }); return; }
      const table = bucket === 'minute' ? 'proxy_traffic_1m' : 'proxy_traffic_1h';
      const rows = await db(table)
        .whereIn('proxy_host_id', hostIds)
        .where('ts', '>=', new Date(fromMs))
        .select('ts',
          ...sumCounters(),
          ...sumHistograms())
        .groupBy('ts').orderBy('ts');
      res.json({ success: true, data: { bucket, points: rows.map(pointFromRow) } });
    } catch (err) { next(err); }
  },

  async hostsSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters = parseFilters(req);
      const hostIds = await effectiveHostIds(req, filters);
      if (hostIds.length === 0) { res.json({ success: true, data: [] }); return; }
      const rangeSpec = parseRange(req.query.range as string);
      const from = new Date(rangeSpec.fromMs);
      const table = rangeSpec.bucket === 'minute' ? 'proxy_traffic_1m' : 'proxy_traffic_1h';
      const rows = await db(table)
        .whereIn('proxy_host_id', hostIds).where('ts', '>=', from)
        .select('proxy_host_id',
          db.raw('SUM(req_count)::bigint AS req_count'),
          db.raw('SUM(bytes_out)::bigint AS bytes_out'),
          db.raw('SUM(status_4xx)::bigint AS status_4xx'),
          db.raw('SUM(status_5xx)::bigint AS status_5xx'),
          db.raw('SUM(latency_ms_sum)::bigint AS latency_ms_sum'),
          db.raw('MAX(latency_ms_max)::bigint AS latency_ms_max'))
        .groupBy('proxy_host_id').orderBy('req_count', 'desc');
      if (rows.length === 0) { res.json({ success: true, data: [] }); return; }
      const ids = rows.map(r => Number(r.proxy_host_id));
      const hostRows = await db('proxy_hosts').whereIn('id', ids).select('id', 'domain_names');
      const domainById = new Map<number, string>();
      for (const h of hostRows) {
        const raw = h.domain_names;
        const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? JSON.parse(raw) : []);
        domainById.set(h.id as number, arr[0] || `#${h.id}`);
      }
      res.json({ success: true, data: rows.map(r => ({
        proxyHostId: Number(r.proxy_host_id),
        domain: domainById.get(Number(r.proxy_host_id)) || `#${r.proxy_host_id}`,
        reqCount: Number(r.req_count) || 0,
        bytesOut: Number(r.bytes_out) || 0,
        errorCount4xx: Number(r.status_4xx) || 0,
        errorCount5xx: Number(r.status_5xx) || 0,
        errorCount: (Number(r.status_4xx) || 0) + (Number(r.status_5xx) || 0),
      })) });
    } catch (err) { next(err); }
  },

  async geoAggregated(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters = parseFilters(req);
      const hostIds = await effectiveHostIds(req, filters);
      if (hostIds.length === 0) { res.json({ success: true, data: [] }); return; }
      const { fromMs } = parseRange(req.query.range as string);
      const statusClass = filters.statusClasses && filters.statusClasses.length === 1 ? filters.statusClasses[0] : 'all';
      const rows = await db('proxy_traffic_top_ips_1h')
        .whereIn('proxy_host_id', hostIds).where('ts', '>=', new Date(fromMs))
        .where('status_class', statusClass)
        .select('ip', db.raw('SUM(req_count)::bigint AS req_count'))
        .groupBy('ip').orderBy('req_count', 'desc').limit(500);
      const geoMap = await geoipService.lookupMany(rows.map(r => r.ip as string));
      const byCountry = new Map<string, { code: string; name: string; reqCount: number; lat: number; lon: number; sampleIps: number }>();
      for (const r of rows) {
        const geo = geoMap.get(r.ip as string);
        if (!geo || !geo.countryCode) continue;
        const existing = byCountry.get(geo.countryCode);
        if (existing) { existing.reqCount += Number(r.req_count) || 0; existing.sampleIps++; }
        else byCountry.set(geo.countryCode, {
          code: geo.countryCode, name: geo.countryName || geo.countryCode,
          reqCount: Number(r.req_count) || 0, lat: geo.latitude || 0, lon: geo.longitude || 0, sampleIps: 1,
        });
      }
      res.json({ success: true, data: [...byCountry.values()].sort((a, b) => b.reqCount - a.reqCount) });
    } catch (err) { next(err); }
  },

  async topIpsGlobal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters = parseFilters(req);
      const hostIds = await effectiveHostIds(req, filters);
      if (hostIds.length === 0) { res.json({ success: true, data: [] }); return; }
      const { fromMs } = parseRange(req.query.range as string);
      const statusClass = filters.errorsOnly ? '4xx' : (filters.statusClasses?.[0] || 'all');
      const rows = await db('proxy_traffic_top_ips_1h')
        .whereIn('proxy_host_id', hostIds).where('ts', '>=', new Date(fromMs))
        .where('status_class', statusClass)
        .select('ip', db.raw('SUM(req_count)::bigint AS req_count'), db.raw('SUM(bytes_out)::bigint AS bytes_out'))
        .groupBy('ip').orderBy('req_count', 'desc').limit(20);
      const geoMap = await geoipService.lookupMany(rows.map(r => r.ip as string));
      res.json({ success: true, data: rows.map(r => ({
        ip: r.ip as string,
        reqCount: Number(r.req_count) || 0,
        bytesOut: Number(r.bytes_out) || 0,
        geo: geoMap.get(r.ip as string) || null,
      })) });
    } catch (err) { next(err); }
  },

  async topUrisGlobal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters = parseFilters(req);
      const hostIds = await effectiveHostIds(req, filters);
      if (hostIds.length === 0) { res.json({ success: true, data: [] }); return; }
      const { fromMs } = parseRange(req.query.range as string);
      const statusClass = filters.errorsOnly ? '4xx' : (filters.statusClasses?.[0] || 'all');
      const rows = await db('proxy_traffic_top_uris_1h')
        .whereIn('proxy_host_id', hostIds).where('ts', '>=', new Date(fromMs))
        .where('status_class', statusClass)
        .select('uri',
          db.raw('SUM(req_count)::bigint AS req_count'),
          db.raw('SUM(req_count * avg_latency_ms) / GREATEST(1, SUM(req_count)) AS avg_latency_ms'))
        .groupBy('uri').orderBy('req_count', 'desc').limit(20);
      res.json({ success: true, data: rows.map(r => ({
        uri: r.uri as string,
        reqCount: Number(r.req_count) || 0,
        avgLatencyMs: Math.round(Number(r.avg_latency_ms) || 0),
      })) });
    } catch (err) { next(err); }
  },

  /** Error summary — per-code breakdown + top erroring URIs + IPs for a host. */
  async hostErrorSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await assertHostVisible(req, id);
      const rangeSpec = parseRange(req.query.range as string);
      const table = rangeSpec.bucket === 'minute' ? 'proxy_traffic_1m' : 'proxy_traffic_1h';
      const from = new Date(rangeSpec.fromMs);
      const codes = [401, 403, 404, 429, 499, 500, 502, 503, 504];
      const cols = codes.map(c => `SUM(status_${c})::bigint AS status_${c}`).join(', ');
      const [totals] = await db.raw(`
        SELECT
          SUM(req_count)::bigint AS req_count,
          SUM(status_4xx)::bigint AS status_4xx,
          SUM(status_5xx)::bigint AS status_5xx,
          ${cols}
        FROM ${table}
        WHERE proxy_host_id = ? AND ts >= ?
      `, [id, from]).then((r: { rows: Record<string, unknown>[] }) => r.rows);

      const [top4xxUris, top5xxUris] = await Promise.all([
        db('proxy_traffic_top_uris_1h').where({ proxy_host_id: id, status_class: '4xx' }).where('ts', '>=', from)
          .select('uri', db.raw('SUM(req_count)::bigint AS req_count'))
          .groupBy('uri').orderBy('req_count', 'desc').limit(10),
        db('proxy_traffic_top_uris_1h').where({ proxy_host_id: id, status_class: '5xx' }).where('ts', '>=', from)
          .select('uri', db.raw('SUM(req_count)::bigint AS req_count'))
          .groupBy('uri').orderBy('req_count', 'desc').limit(10),
      ]);

      const [top4xxIps, top5xxIps] = await Promise.all([
        db('proxy_traffic_top_ips_1h').where({ proxy_host_id: id, status_class: '4xx' }).where('ts', '>=', from)
          .select('ip', db.raw('SUM(req_count)::bigint AS req_count'))
          .groupBy('ip').orderBy('req_count', 'desc').limit(10),
        db('proxy_traffic_top_ips_1h').where({ proxy_host_id: id, status_class: '5xx' }).where('ts', '>=', from)
          .select('ip', db.raw('SUM(req_count)::bigint AS req_count'))
          .groupBy('ip').orderBy('req_count', 'desc').limit(10),
      ]);

      const allIps = [
        ...top4xxIps.map(r => r.ip as string),
        ...top5xxIps.map(r => r.ip as string),
      ];
      const geoMap = await geoipService.lookupMany([...new Set(allIps)]);

      const perCode: Record<string, number> = {};
      for (const c of codes) perCode[String(c)] = Number(totals?.[`status_${c}`]) || 0;

      res.json({ success: true, data: {
        totalRequests: Number(totals?.req_count) || 0,
        total4xx: Number(totals?.status_4xx) || 0,
        total5xx: Number(totals?.status_5xx) || 0,
        perCode,
        topErrorUris: {
          '4xx': top4xxUris.map(r => ({ uri: r.uri as string, reqCount: Number(r.req_count) || 0 })),
          '5xx': top5xxUris.map(r => ({ uri: r.uri as string, reqCount: Number(r.req_count) || 0 })),
        },
        topErrorIps: {
          '4xx': top4xxIps.map(r => ({ ip: r.ip as string, reqCount: Number(r.req_count) || 0, geo: geoMap.get(r.ip as string) || null })),
          '5xx': top5xxIps.map(r => ({ ip: r.ip as string, reqCount: Number(r.req_count) || 0, geo: geoMap.get(r.ip as string) || null })),
        },
      }});
    } catch (err) { next(err); }
  },

  /** Recent error samples for a host — the "what actually broke" companion to counters. */
  async hostErrorSamples(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await assertHostVisible(req, id);
      const limit = Math.min(200, parseInt((req.query.limit as string) || '100', 10));
      const rows = await db('proxy_traffic_error_samples')
        .where({ proxy_host_id: id }).orderBy('ts', 'desc').limit(limit);
      res.json({ success: true, data: rows.map(sampleRow) });
    } catch (err) { next(err); }
  },

  /** Slow-request samples for a host. */
  async hostSlowSamples(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await assertHostVisible(req, id);
      const limit = Math.min(200, parseInt((req.query.limit as string) || '100', 10));
      const rows = await db('proxy_traffic_slow_requests')
        .where({ proxy_host_id: id }).orderBy('latency_ms', 'desc').limit(limit);
      res.json({ success: true, data: rows.map(sampleRow) });
    } catch (err) { next(err); }
  },

  /**
   * Percentile summary for the scope — computes p50/p95/p99 for edge (nginx) and upstream
   * (backend) latency from the histogram columns. Also returns comparison-to-previous-period
   * deltas.
   */
  async percentileSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters = parseFilters(req);
      const hostIds = await effectiveHostIds(req, filters);
      if (hostIds.length === 0) { res.json({ success: true, data: null }); return; }
      const rangeSpec = parseRange(req.query.range as string);
      const table = rangeSpec.bucket === 'minute' ? 'proxy_traffic_1m' : 'proxy_traffic_1h';
      const winMs = Date.now() - rangeSpec.fromMs;
      const from = new Date(rangeSpec.fromMs);
      const prevFrom = new Date(rangeSpec.fromMs - winMs);
      const prevTo = from;

      const histColsEdge = LAT_KEYS.map(k => `SUM(lat_edge_${k})::bigint AS lat_edge_${k}`).join(', ');
      const histColsUp = LAT_KEYS.map(k => `SUM(lat_up_${k})::bigint AS lat_up_${k}`).join(', ');

      const query = (fromDate: Date, toDate?: Date) => {
        let q = db.raw(`
          SELECT ${histColsEdge}, ${histColsUp}, SUM(req_count)::bigint AS req_count,
                 SUM(status_4xx + status_5xx)::bigint AS err_count
          FROM ${table}
          WHERE proxy_host_id = ANY(?) AND ts >= ? ${toDate ? 'AND ts < ?' : ''}
        `, toDate ? [hostIds, fromDate, toDate] : [hostIds, fromDate]);
        return q.then((r: { rows: Record<string, unknown>[] }) => r.rows[0]);
      };
      const [cur, prev] = await Promise.all([query(from), query(prevFrom, prevTo)]);

      const edgeHist = extractHist(cur, 'lat_edge_');
      const upHist = extractHist(cur, 'lat_up_');
      const prevEdgeHist = extractHist(prev, 'lat_edge_');
      const prevUpHist = extractHist(prev, 'lat_up_');
      const curReq = Number(cur?.req_count) || 0;
      const curErr = Number(cur?.err_count) || 0;
      const prevReq = Number(prev?.req_count) || 0;
      const prevErr = Number(prev?.err_count) || 0;

      res.json({ success: true, data: {
        current: {
          reqCount: curReq,
          errorRate: curReq > 0 ? curErr / curReq : 0,
          edge: {
            p50: percentileFromHist(edgeHist, 0.5),
            p95: percentileFromHist(edgeHist, 0.95),
            p99: percentileFromHist(edgeHist, 0.99),
          },
          upstream: {
            p50: percentileFromHist(upHist, 0.5),
            p95: percentileFromHist(upHist, 0.95),
            p99: percentileFromHist(upHist, 0.99),
          },
        },
        previous: {
          reqCount: prevReq,
          errorRate: prevReq > 0 ? prevErr / prevReq : 0,
          edge: {
            p50: percentileFromHist(prevEdgeHist, 0.5),
            p95: percentileFromHist(prevEdgeHist, 0.95),
            p99: percentileFromHist(prevEdgeHist, 0.99),
          },
          upstream: {
            p50: percentileFromHist(prevUpHist, 0.5),
            p95: percentileFromHist(prevUpHist, 0.95),
            p99: percentileFromHist(prevUpHist, 0.99),
          },
        },
      }});
    } catch (err) { next(err); }
  },
};

// ── SQL helpers ──

function sumCounters(): Array<ReturnType<typeof db.raw>> {
  const codes = [401, 403, 404, 429, 499, 500, 502, 503, 504];
  const raws: Array<ReturnType<typeof db.raw>> = [
    db.raw('SUM(req_count)::bigint AS req_count'),
    db.raw('SUM(bytes_out)::bigint AS bytes_out'),
    db.raw('SUM(bytes_in)::bigint AS bytes_in'),
    db.raw('SUM(status_2xx)::bigint AS status_2xx'),
    db.raw('SUM(status_3xx)::bigint AS status_3xx'),
    db.raw('SUM(status_4xx)::bigint AS status_4xx'),
    db.raw('SUM(status_5xx)::bigint AS status_5xx'),
    db.raw('SUM(latency_ms_sum)::bigint AS latency_ms_sum'),
    db.raw('MAX(latency_ms_max)::bigint AS latency_ms_max'),
    db.raw('SUM(unique_ips)::bigint AS unique_ips'),
    db.raw('SUM(lat_up_sum)::bigint AS lat_up_sum'),
    db.raw('MAX(lat_up_max)::bigint AS lat_up_max'),
    db.raw('SUM(lat_up_count)::bigint AS lat_up_count'),
  ];
  for (const c of codes) raws.push(db.raw(`SUM(status_${c})::bigint AS status_${c}`));
  return raws;
}

function sumHistograms(): Array<ReturnType<typeof db.raw>> {
  const out: Array<ReturnType<typeof db.raw>> = [];
  for (const k of LAT_KEYS) out.push(db.raw(`SUM(lat_edge_${k})::bigint AS lat_edge_${k}`));
  for (const k of LAT_KEYS) out.push(db.raw(`SUM(lat_up_${k})::bigint AS lat_up_${k}`));
  return out;
}

function pointFromRow(row: Record<string, unknown>): Record<string, unknown> {
  const edgeHist = extractHist(row, 'lat_edge_');
  const upHist = extractHist(row, 'lat_up_');
  return {
    ts: (row.ts as Date).toISOString(),
    reqCount: Number(row.req_count) || 0,
    bytesOut: Number(row.bytes_out) || 0,
    bytesIn: Number(row.bytes_in) || 0,
    status2xx: Number(row.status_2xx) || 0,
    status3xx: Number(row.status_3xx) || 0,
    status4xx: Number(row.status_4xx) || 0,
    status5xx: Number(row.status_5xx) || 0,
    status401: Number(row.status_401) || 0,
    status403: Number(row.status_403) || 0,
    status404: Number(row.status_404) || 0,
    status429: Number(row.status_429) || 0,
    status499: Number(row.status_499) || 0,
    status500: Number(row.status_500) || 0,
    status502: Number(row.status_502) || 0,
    status503: Number(row.status_503) || 0,
    status504: Number(row.status_504) || 0,
    avgLatencyMs: row.req_count ? Math.round(Number(row.latency_ms_sum) / Number(row.req_count)) : 0,
    maxLatencyMs: Number(row.latency_ms_max) || 0,
    uniqueIps: Number(row.unique_ips) || 0,
    // Percentiles from histogram for THIS bucket — cheap since we're already loading the row.
    p50EdgeMs: percentileFromHist(edgeHist, 0.5),
    p95EdgeMs: percentileFromHist(edgeHist, 0.95),
    p99EdgeMs: percentileFromHist(edgeHist, 0.99),
    p50UpstreamMs: percentileFromHist(upHist, 0.5),
    p95UpstreamMs: percentileFromHist(upHist, 0.95),
    p99UpstreamMs: percentileFromHist(upHist, 0.99),
    avgUpstreamMs: row.lat_up_count && Number(row.lat_up_count) > 0 ? Math.round(Number(row.lat_up_sum) / Number(row.lat_up_count)) : 0,
  };
}

function sampleRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id as number,
    ts: (row.ts as Date).toISOString(),
    status: row.status as number,
    method: (row.method as string) || null,
    uri: row.uri as string,
    ip: row.ip as string,
    countryCode: (row.country_code as string) || null,
    latencyMs: Number(row.latency_ms) || 0,
    upstreamMs: row.upstream_ms != null ? Number(row.upstream_ms) : null,
    userAgent: (row.user_agent as string) || null,
    referer: (row.referer as string) || null,
  };
}
