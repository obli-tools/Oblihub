import { Router } from 'express';
import { db } from '../db';
import { sleepService } from '../services/sleep.service';
import { logger } from '../utils/logger';

/**
 * Internal wake endpoints — called by nginx-served waking page (via /__oblihub_internal/ proxy).
 * No session auth: nginx is the trust boundary (only requests from the proxy container reach this path).
 * We DO require a shared secret header to prevent direct external probing.
 *
 * Routes:
 *   POST /wake?host=<proxyHostId>            — initiate wake (idempotent)
 *   GET  /wake/status?host=<proxyHostId>     — { state, elapsedMs, message }
 */

const router = Router();

const INTERNAL_TOKEN = process.env.OBLIHUB_INTERNAL_TOKEN || 'oblihub-internal';

router.use((req, res, next) => {
  if (req.headers['x-oblihub-internal'] !== INTERNAL_TOKEN) {
    res.status(403).json({ success: false, error: 'forbidden' });
    return;
  }
  next();
});

async function resolveContainer(proxyHostId: number): Promise<number | null> {
  const row = await db('proxy_hosts').where({ id: proxyHostId }).select('wake_container_id').first();
  return (row?.wake_container_id as number) ?? null;
}

/**
 * Resolve the full wake target set: primary (used by readiness probe) + extras (waked in
 * parallel, not probed). Returns null if no primary is set.
 */
async function resolveWakeTargets(proxyHostId: number): Promise<{ primary: number; extras: number[] } | null> {
  const row = await db('proxy_hosts')
    .where({ id: proxyHostId })
    .select('wake_container_id', 'wake_extra_container_ids')
    .first();
  const primary = (row?.wake_container_id as number) ?? null;
  if (!primary) return null;
  let extras: number[] = [];
  const raw = row?.wake_extra_container_ids;
  if (Array.isArray(raw)) extras = raw as number[];
  else if (typeof raw === 'string' && raw) { try { extras = JSON.parse(raw) as number[]; } catch { /* keep empty */ } }
  // Defensive: filter out the primary from extras to avoid double-wake on the same id.
  extras = extras.filter(id => id !== primary);
  return { primary, extras };
}

router.post('/wake', async (req, res) => {
  const proxyHostId = parseInt((req.query.host as string) || '', 10);
  if (!proxyHostId) { res.status(400).json({ success: false, error: 'missing host' }); return; }
  const targets = await resolveWakeTargets(proxyHostId);
  if (!targets) { res.status(404).json({ success: false, error: 'no wake target' }); return; }
  // Fire-and-forget on every target. Each call is idempotent via sleepService's in-flight map.
  // We wake the primary first so its state transitions are observed by the polling page; extras
  // start in parallel and don't affect readiness — they're nice-to-have backend boots.
  sleepService.wake(targets.primary).catch(err => logger.warn({ err, containerId: targets.primary }, 'wake failed (primary)'));
  for (const extraId of targets.extras) {
    sleepService.wake(extraId).catch(err => logger.warn({ err, containerId: extraId }, 'wake failed (extra)'));
  }
  res.json({ success: true });
});

router.get('/wake/status', async (req, res) => {
  const proxyHostId = parseInt((req.query.host as string) || '', 10);
  if (!proxyHostId) { res.status(400).json({ success: false, error: 'missing host' }); return; }
  const containerId = await resolveContainer(proxyHostId);
  if (!containerId) { res.status(404).json({ success: false, error: 'no wake target' }); return; }
  const status = await sleepService.getWakeStatus(containerId);
  // Map sleep_state to a simpler frontend signal
  const ready = status.state === 'awake';
  res.json({
    success: true,
    data: {
      ready,
      state: status.state,
      elapsedMs: status.elapsedMs,
      estimatedMs: status.estimatedMs,
      sampleCount: status.sampleCount,
      message: status.message,
    },
  });
});

export default router;
