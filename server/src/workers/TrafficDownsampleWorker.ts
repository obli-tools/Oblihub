import { db } from '../db';
import { logger } from '../utils/logger';

/**
 * Downsample + retention worker for traffic time-series and sample tables.
 *
 * Runs hourly + once on start. Handles:
 *   - proxy_traffic_1m → proxy_traffic_1h roll-up for anything older than 7 days (SUM counters,
 *     MAX latency_ms_max/lat_up_max, SUM histograms bucket-by-bucket, SUM unique_ips as approx)
 *   - Delete rolled-up 1m rows
 *   - Delete 1h rows older than 90d, plus their top-N companions
 *   - Delete error samples older than 24h
 *   - Delete slow-request samples older than 30d
 */

const RUN_INTERVAL_MS = 60 * 60 * 1000;
const MS_1M_RETENTION = 7 * 24 * 60 * 60 * 1000;
const MS_1H_RETENTION = 90 * 24 * 60 * 60 * 1000;
const MS_ERROR_SAMPLES = 24 * 60 * 60 * 1000;
const MS_SLOW_SAMPLES = 30 * 24 * 60 * 60 * 1000;

// Kept in sync with the log worker + migration.
const GRANULAR_CODES = [401, 403, 404, 429, 499, 500, 502, 503, 504];
const LAT_KEYS = ['lt_50', 'lt_100', 'lt_250', 'lt_500', 'lt_1000', 'lt_2500', 'lt_5000', 'lt_10000', 'ge_10000'];

let timer: NodeJS.Timeout | null = null;

/**
 * Build the SELECT list for the 1m → 1h roll-up. Sums every counter, MAX for the peaks,
 * bucket-by-bucket sum for the histograms. Column list grows over time — factored out so it
 * stays readable.
 */
function rollUpSelect(): string {
  const cols: string[] = [
    'proxy_host_id',
    `date_trunc('hour', ts) AS ts_h`,
    'SUM(req_count) AS req_count',
    'SUM(bytes_out) AS bytes_out',
    'SUM(bytes_in) AS bytes_in',
    'SUM(status_2xx) AS status_2xx',
    'SUM(status_3xx) AS status_3xx',
    'SUM(status_4xx) AS status_4xx',
    'SUM(status_5xx) AS status_5xx',
    'SUM(latency_ms_sum) AS latency_ms_sum',
    'MAX(latency_ms_max) AS latency_ms_max',
    'SUM(unique_ips) AS unique_ips',
    'SUM(lat_up_sum) AS lat_up_sum',
    'MAX(lat_up_max) AS lat_up_max',
    'SUM(lat_up_count) AS lat_up_count',
  ];
  for (const code of GRANULAR_CODES) cols.push(`SUM(status_${code}) AS status_${code}`);
  for (const b of LAT_KEYS) cols.push(`SUM(lat_edge_${b}) AS lat_edge_${b}`);
  for (const b of LAT_KEYS) cols.push(`SUM(lat_up_${b}) AS lat_up_${b}`);
  return cols.join(',\n        ');
}

function insertColumns(): string {
  const cols = [
    'proxy_host_id', 'ts',
    'req_count', 'bytes_out', 'bytes_in',
    'status_2xx', 'status_3xx', 'status_4xx', 'status_5xx',
    'latency_ms_sum', 'latency_ms_max', 'unique_ips',
    'lat_up_sum', 'lat_up_max', 'lat_up_count',
  ];
  for (const code of GRANULAR_CODES) cols.push(`status_${code}`);
  for (const b of LAT_KEYS) cols.push(`lat_edge_${b}`);
  for (const b of LAT_KEYS) cols.push(`lat_up_${b}`);
  return cols.join(', ');
}

function mergeClause(): string {
  const parts: string[] = [
    'req_count = proxy_traffic_1h.req_count + EXCLUDED.req_count',
    'bytes_out = proxy_traffic_1h.bytes_out + EXCLUDED.bytes_out',
    'bytes_in = proxy_traffic_1h.bytes_in + EXCLUDED.bytes_in',
    'status_2xx = proxy_traffic_1h.status_2xx + EXCLUDED.status_2xx',
    'status_3xx = proxy_traffic_1h.status_3xx + EXCLUDED.status_3xx',
    'status_4xx = proxy_traffic_1h.status_4xx + EXCLUDED.status_4xx',
    'status_5xx = proxy_traffic_1h.status_5xx + EXCLUDED.status_5xx',
    'latency_ms_sum = proxy_traffic_1h.latency_ms_sum + EXCLUDED.latency_ms_sum',
    'latency_ms_max = GREATEST(proxy_traffic_1h.latency_ms_max, EXCLUDED.latency_ms_max)',
    'unique_ips = proxy_traffic_1h.unique_ips + EXCLUDED.unique_ips',
    'lat_up_sum = proxy_traffic_1h.lat_up_sum + EXCLUDED.lat_up_sum',
    'lat_up_max = GREATEST(proxy_traffic_1h.lat_up_max, EXCLUDED.lat_up_max)',
    'lat_up_count = proxy_traffic_1h.lat_up_count + EXCLUDED.lat_up_count',
  ];
  for (const code of GRANULAR_CODES) parts.push(`status_${code} = proxy_traffic_1h.status_${code} + EXCLUDED.status_${code}`);
  for (const b of LAT_KEYS) parts.push(`lat_edge_${b} = proxy_traffic_1h.lat_edge_${b} + EXCLUDED.lat_edge_${b}`);
  for (const b of LAT_KEYS) parts.push(`lat_up_${b} = proxy_traffic_1h.lat_up_${b} + EXCLUDED.lat_up_${b}`);
  return parts.join(',\n        ');
}

async function sweep(): Promise<void> {
  const now = Date.now();
  const cutoff1m = new Date(now - MS_1M_RETENTION);
  const cutoff1h = new Date(now - MS_1H_RETENTION);
  const cutoffErrors = new Date(now - MS_ERROR_SAMPLES);
  const cutoffSlow = new Date(now - MS_SLOW_SAMPLES);

  try {
    // (1) 1m → 1h roll-up
    const rolled = await db.raw(`
      INSERT INTO proxy_traffic_1h (${insertColumns()})
      SELECT
        ${rollUpSelect()}
      FROM proxy_traffic_1m
      WHERE ts < ?
      GROUP BY proxy_host_id, date_trunc('hour', ts)
      ON CONFLICT (proxy_host_id, ts) DO UPDATE SET
        ${mergeClause()}
      RETURNING id
    `, [cutoff1m]);

    // (2) Drop source 1m rows
    const deleted1m = await db('proxy_traffic_1m').where('ts', '<', cutoff1m).delete();

    // (3) Drop 1h rows past long retention
    const deleted1h = await db('proxy_traffic_1h').where('ts', '<', cutoff1h).delete();
    const deletedIps = await db('proxy_traffic_top_ips_1h').where('ts', '<', cutoff1h).delete();
    const deletedUris = await db('proxy_traffic_top_uris_1h').where('ts', '<', cutoff1h).delete();

    // (4) Drop sample tables past their own retention windows
    const deletedErrSamples = await db('proxy_traffic_error_samples').where('ts', '<', cutoffErrors).delete();
    const deletedSlowSamples = await db('proxy_traffic_slow_requests').where('ts', '<', cutoffSlow).delete();

    logger.info({
      rolled: (rolled as { rowCount: number }).rowCount ?? 0,
      deleted1m, deleted1h, deletedIps, deletedUris,
      deletedErrSamples, deletedSlowSamples,
    }, 'Traffic downsample sweep done');
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Traffic downsample sweep failed');
  }
}

export function startTrafficDownsampleWorker(): void {
  if (timer) return;
  logger.info('Starting traffic downsample worker (hourly)');
  setTimeout(() => sweep().catch(() => {}), 30_000);
  timer = setInterval(() => sweep().catch(() => {}), RUN_INTERVAL_MS);
}

export function stopTrafficDownsampleWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
