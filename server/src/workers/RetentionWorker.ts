import { db } from '../db';
import { logger } from '../utils/logger';
import { GEO_CACHE_TTL_MS } from '../services/geoip.service';

/**
 * Hourly retention purges for tables that otherwise grow forever:
 *
 * - ip_geo_cache: rows looked up more than 30 days ago (the same TTL after which
 *   geoipService.lookup() re-resolves an IP; a purged IP is simply re-fetched).
 * - update_history: rows started more than 365 days ago.
 * - managed_stack_deploy_history: per managed stack, keep the last 100 deploys OR
 *   anything from the last 90 days, whichever keeps more (same rule as the
 *   workflow_runs retention in WorkflowScheduler).
 *
 * Every delete runs in bounded batches (DELETE ... WHERE id IN (SELECT ... LIMIT n))
 * so a large backlog never becomes one long lock-holding statement. Indexes:
 * migration 055 (looked_up_at, started_at) and msdh_stack_time_idx (035).
 */

const RUN_EVERY_MS = 60 * 60 * 1000;
/** First run a minute after boot, out of the startup path. */
const FIRST_RUN_DELAY_MS = 60 * 1000;
const BATCH_SIZE = 5000;
/** Per table and per run; a bigger backlog continues on the next run. */
const MAX_BATCHES = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
const UPDATE_HISTORY_KEEP_DAYS = 365;
const DEPLOY_HISTORY_KEEP_LAST_N = 100;
const DEPLOY_HISTORY_KEEP_WITHIN_DAYS = 90;

let timer: NodeJS.Timeout | null = null;
let firstRun: NodeJS.Timeout | null = null;
let running = false;

/** Run `deleteBatch` until it deletes fewer than BATCH_SIZE rows (or MAX_BATCHES is hit). */
async function inBatches(deleteBatch: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await deleteBatch();
    total += n;
    if (n < BATCH_SIZE) break;
  }
  return total;
}

function rowCount(result: unknown): number {
  return Number((result as { rowCount?: number } | undefined)?.rowCount ?? 0);
}

async function purgeGeoCache(now: number): Promise<number> {
  const cutoff = new Date(now - GEO_CACHE_TTL_MS);
  // ip_geo_cache is keyed by ip (no id column).
  return inBatches(() => db('ip_geo_cache')
    .whereIn('ip', db('ip_geo_cache').select('ip').where('looked_up_at', '<', cutoff).limit(BATCH_SIZE))
    .delete());
}

async function purgeUpdateHistory(now: number): Promise<number> {
  const cutoff = new Date(now - UPDATE_HISTORY_KEEP_DAYS * DAY_MS);
  return inBatches(() => db('update_history')
    .whereIn('id', db('update_history').select('id').where('started_at', '<', cutoff).limit(BATCH_SIZE))
    .delete());
}

async function purgeDeployHistory(now: number): Promise<number> {
  const cutoff = new Date(now - DEPLOY_HISTORY_KEEP_WITHIN_DAYS * DAY_MS);
  // A row goes only when it is BOTH outside the last N of its stack AND older than the window,
  // so what stays is the union of the two (whichever keeps more).
  return inBatches(async () => rowCount(await db.raw(
    `DELETE FROM managed_stack_deploy_history
      WHERE id IN (
        SELECT id FROM (
          SELECT id, deployed_at,
                 row_number() OVER (PARTITION BY managed_stack_id ORDER BY deployed_at DESC, id DESC) AS rn
            FROM managed_stack_deploy_history
        ) ranked
        WHERE ranked.rn > ? AND ranked.deployed_at < ?
        LIMIT ?
      )`,
    [DEPLOY_HISTORY_KEEP_LAST_N, cutoff, BATCH_SIZE],
  )));
}

async function step(table: string, fn: () => Promise<number>): Promise<void> {
  try {
    const deleted = await fn();
    if (deleted > 0) logger.info({ table, deleted }, 'Retention purge');
  } catch (err) {
    // One failing purge never stops the others.
    logger.error({ table, err: err instanceof Error ? err.message : String(err) }, 'Retention purge failed');
  }
}

export async function runRetentionSweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    await step('ip_geo_cache', () => purgeGeoCache(now));
    await step('update_history', () => purgeUpdateHistory(now));
    await step('managed_stack_deploy_history', () => purgeDeployHistory(now));
  } finally {
    running = false;
  }
}

export function startRetentionWorker(): void {
  if (timer) return;
  timer = setInterval(() => { void runRetentionSweep(); }, RUN_EVERY_MS);
  firstRun = setTimeout(() => { firstRun = null; void runRetentionSweep(); }, FIRST_RUN_DELAY_MS);
}

export function stopRetentionWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (firstRun) { clearTimeout(firstRun); firstRun = null; }
}
