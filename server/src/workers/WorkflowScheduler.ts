import { db } from '../db';
import { logger } from '../utils/logger';
import { workflowService, _runWorkflow as runWorkflow } from '../services/workflow.service';
import type { Workflow } from '@oblihub/shared';

/**
 * Ticks once per minute. For each enabled workflow, decides whether the current minute matches
 * its trigger and — if yes — kicks off a run (fire-and-forget; the runner takes care of its own
 * concurrency guard).
 *
 * Also runs a retention purge every hour: for each workflow, drop runs older than 30 days AND
 * beyond the 100 most recent. Configurable later if it becomes an operator gripe.
 *
 * Not started when nothing to run — first tick lists workflows and if the list is empty we
 * still keep ticking (cheap: one COUNT query per minute).
 */

const TICK_INTERVAL_MS = 60_000;
const RETENTION_TICK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const KEEP_LAST_N_RUNS = 100;
const KEEP_WITHIN_DAYS = 30;

// ── Cron matcher ──

/**
 * Minimalist 5-field cron parser: `min hour dom month dow`. Each field supports:
 *   - `*`            → any value
 *   - `N`            → exact match
 *   - `N,M,P`        → set of values
 *   - `N-M`          → inclusive range
 *   - `*​/N`          → step (every Nth from field's min)
 *   - `A-B/N`        → step within a range
 * Days-of-week are 0-6 (0=Sunday). Not supported: named months/days (`JAN`, `SUN`), `?`, `L`, `W`.
 * That covers >95% of self-hosted cron use cases without pulling a full parser.
 */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  const parts = field.split(',');
  for (const raw of parts) {
    const [rangePart, stepPart] = raw.split('/');
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (isNaN(step) || step < 1) throw new Error(`Invalid cron step in "${raw}"`);
    let lo = min, hi = max;
    if (rangePart !== '*') {
      if (rangePart.includes('-')) {
        const [a, b] = rangePart.split('-').map(n => parseInt(n, 10));
        if (isNaN(a) || isNaN(b)) throw new Error(`Invalid cron range in "${raw}"`);
        lo = a; hi = b;
      } else {
        const v = parseInt(rangePart, 10);
        if (isNaN(v)) throw new Error(`Invalid cron value "${raw}"`);
        lo = v; hi = v;
      }
    }
    for (let v = lo; v <= hi; v += step) {
      if (v < min || v > max) continue;
      out.add(v);
    }
  }
  return out;
}

function matchesCron(cron: string, now: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  try {
    const min = parseCronField(fields[0], 0, 59);
    const hr  = parseCronField(fields[1], 0, 23);
    const dom = parseCronField(fields[2], 1, 31);
    const mo  = parseCronField(fields[3], 1, 12);
    const dow = parseCronField(fields[4], 0, 6);
    return (
      min.has(now.getMinutes()) &&
      hr.has(now.getHours()) &&
      dom.has(now.getDate()) &&
      mo.has(now.getMonth() + 1) &&
      dow.has(now.getDay())
    );
  } catch (err) {
    logger.warn({ cron, err: err instanceof Error ? err.message : String(err) }, 'Cron parse error');
    return false;
  }
}

// ── Trigger evaluation ──

function shouldFire(workflow: Workflow, now: Date): boolean {
  if (!workflow.enabled) return false;
  const cfg = workflow.triggerConfig as Record<string, unknown>;
  switch (workflow.triggerType) {
    case 'on-demand':
      return false; // never fires from scheduler — only from the "Run now" button
    case 'schedule-interval': {
      const intervalSeconds = Number(cfg.intervalSeconds || 0);
      if (intervalSeconds <= 0) return false;
      if (!workflow.lastFiredAt) return true;
      const last = new Date(workflow.lastFiredAt).getTime();
      return now.getTime() - last >= intervalSeconds * 1000;
    }
    case 'schedule-cron': {
      const cron = String(cfg.cron || '');
      if (!cron) return false;
      // Prevent double-fire within the same minute — a scheduler restart mid-minute could
      // otherwise re-match. If lastFiredAt is within the current minute, skip.
      if (workflow.lastFiredAt) {
        const last = new Date(workflow.lastFiredAt);
        if (last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth()
            && last.getDate() === now.getDate() && last.getHours() === now.getHours()
            && last.getMinutes() === now.getMinutes()) {
          return false;
        }
      }
      return matchesCron(cron, now);
    }
    case 'on-cert-renew':
      return false; // event-driven — fired by fireOnCertRenew() below, not by the scheduler
    default:
      return false;
  }
}

// ── Public: cert-renew hook ──

/**
 * Called by certificate.service.ts immediately after a successful LE renewal / issuance. Any
 * workflow whose trigger is `on-cert-renew` with matching `certificateId` fires now.
 */
export async function fireOnCertRenew(certificateId: number): Promise<void> {
  const workflows = await workflowService.list({ includeGlobal: true });
  const matching = workflows.filter(w =>
    w.enabled &&
    w.triggerType === 'on-cert-renew' &&
    (w.triggerConfig as { certificateId?: number }).certificateId === certificateId,
  );
  logger.info({ certificateId, count: matching.length }, 'Firing on-cert-renew workflows');
  for (const w of matching) {
    // Fire-and-forget; runner records its own row.
    runWorkflow(w, 'on-cert-renew').catch(err => {
      logger.warn({ workflowId: w.id, err: err instanceof Error ? err.message : String(err) }, 'on-cert-renew fire failed');
    });
  }
}

// ── Ticker + retention purge ──

let tickTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    const now = new Date();
    const workflows = await workflowService.list({ includeGlobal: true });
    for (const w of workflows) {
      if (!shouldFire(w, now)) continue;
      runWorkflow(w, 'scheduler').catch(err => {
        logger.warn({ workflowId: w.id, err: err instanceof Error ? err.message : String(err) }, 'Scheduled workflow fire failed');
      });
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Workflow scheduler tick failed');
  }
}

async function retentionSweep(): Promise<void> {
  try {
    // Two-pass purge: (1) drop anything strictly older than KEEP_WITHIN_DAYS days,
    // (2) among what remains, keep only the KEEP_LAST_N_RUNS most recent per workflow.
    // The union of the two windows = what stays. Cheap set-based SQL, one round-trip per
    // workflow (fine — a few dozen workflows max in a typical install).
    const cutoff = new Date(Date.now() - KEEP_WITHIN_DAYS * 24 * 60 * 60 * 1000);
    const workflowIds = (await db('workflows').select('id')).map(r => r.id as number);
    for (const wid of workflowIds) {
      // Get the ids of runs to KEEP: KEEP_LAST_N_RUNS most recent OR within the cutoff.
      const recent = await db('workflow_runs').where({ workflow_id: wid }).orderBy('started_at', 'desc').limit(KEEP_LAST_N_RUNS).pluck('id');
      const withinWindow = await db('workflow_runs').where({ workflow_id: wid }).where('started_at', '>=', cutoff).pluck('id');
      const keep = new Set<number>([...(recent as number[]), ...(withinWindow as number[])]);
      if (keep.size === 0) continue;
      const deleted = await db('workflow_runs').where({ workflow_id: wid }).whereNotIn('id', [...keep]).delete();
      if (deleted > 0) logger.info({ workflowId: wid, deleted }, 'Purged old workflow runs');
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Workflow retention sweep failed');
  }
}

export function startWorkflowScheduler(): void {
  if (tickTimer) return;
  logger.info('Starting workflow scheduler (60s tick, hourly purge)');
  // First tick immediately so a boot-time schedule doesn't wait 60s. Then setInterval.
  tick();
  tickTimer = setInterval(tick, TICK_INTERVAL_MS);
  retentionTimer = setInterval(retentionSweep, RETENTION_TICK_INTERVAL_MS);
}

export function stopWorkflowScheduler(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
}
