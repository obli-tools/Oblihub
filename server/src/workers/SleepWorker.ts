import { sleepService } from '../services/sleep.service';
import { logger } from '../utils/logger';

let timer: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 30_000; // check idle containers every 30s

export function startSleepWorker(): void {
  const run = async () => {
    try {
      // First: reconcile any containers stuck in wake_failed/sleeping that are actually running.
      // Cheap (one inspect per stuck row, usually 0-2 rows) and self-heals leftover bad state
      // from earlier failed wakes — important after engine config changes or bug fixes that
      // rendered the previous probe target unreachable.
      await sleepService.reconcileStuckStates();

      const candidates = await sleepService.listIdleSleepCandidates();
      for (const c of candidates) {
        logger.info({ containerId: c.id, containerName: c.containerName, idleAfterS: c.sleepAfterSeconds }, 'Sleeping idle container');
        await sleepService.sleep(c.id);
      }
    } catch (err) {
      logger.error(err, 'Sleep worker tick failed');
    }
  };
  timer = setInterval(run, TICK_MS);
  // First tick after 30s — give activity tracker time to populate last_active_at on boot
  setTimeout(run, TICK_MS);
  logger.info({ tickMs: TICK_MS }, 'Sleep worker started');
}

export function stopSleepWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
