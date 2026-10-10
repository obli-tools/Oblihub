import { stackService } from './stack.service';
import { updateService } from './update.service';
import { maintenanceService } from './maintenance.service';
import { logger } from '../utils/logger';

const timers = new Map<number, ReturnType<typeof setInterval>>();

/**
 * Stacks whose scheduled check fell outside their maintenance window. Checked as soon as the window
 * opens (minute ticker) rather than at the next interval tick, which could fall outside the window
 * again forever (a 24 h interval landing at 14:00 with an 18:00 → 08:00 window).
 */
const deferred = new Set<number>();
let deferredTicker: ReturnType<typeof setInterval> | null = null;
const DEFERRED_TICK_MS = 60_000;

async function runScheduledCheck(stackId: number): Promise<void> {
  if (!(await maintenanceService.allowsStack(stackId))) {
    if (!deferred.has(stackId)) logger.info({ stackId }, 'Scheduled check deferred — outside the maintenance window');
    deferred.add(stackId);
    return;
  }
  deferred.delete(stackId);
  await updateService.checkStack(stackId, 'schedule');
}

async function runDeferred(): Promise<void> {
  for (const stackId of [...deferred]) {
    if (!timers.has(stackId)) { deferred.delete(stackId); continue; }
    try {
      if (await maintenanceService.allowsStack(stackId)) {
        deferred.delete(stackId);
        logger.info({ stackId }, 'Maintenance window open — running the deferred check');
        await updateService.checkStack(stackId, 'schedule');
      }
    } catch (err) {
      logger.error({ stackId, err }, 'Deferred scheduled check failed');
    }
  }
}

export const schedulerService = {
  /** Start all scheduled checks for enabled stacks */
  async startAll(): Promise<void> {
    const stacks = await stackService.getAll();
    for (const stack of stacks) {
      if (stack.enabled) {
        this.schedule(stack.id, stack.checkInterval);
      }
    }
    if (!deferredTicker) {
      deferredTicker = setInterval(() => { runDeferred().catch(err => logger.error({ err }, 'Deferred checks tick failed')); }, DEFERRED_TICK_MS);
    }
    logger.info({ count: timers.size }, 'Scheduler started');
  },

  /** Schedule checks for a specific stack */
  schedule(stackId: number, intervalSeconds: number): void {
    // Clear existing timer
    this.unschedule(stackId);

    const timer = setInterval(async () => {
      try {
        await runScheduledCheck(stackId);
      } catch (err) {
        logger.error({ stackId, err }, 'Scheduled check failed');
      }
    }, intervalSeconds * 1000);

    timers.set(stackId, timer);
    logger.info({ stackId, intervalSeconds }, 'Stack check scheduled');
  },

  /** Unschedule checks for a stack */
  unschedule(stackId: number): void {
    const existing = timers.get(stackId);
    if (existing) {
      clearInterval(existing);
      timers.delete(stackId);
    }
    deferred.delete(stackId);
  },

  /** Reschedule after config change */
  reschedule(stackId: number, intervalSeconds: number, enabled: boolean): void {
    this.unschedule(stackId);
    if (enabled) {
      this.schedule(stackId, intervalSeconds);
    }
  },

  /** Stop all timers (graceful shutdown) */
  stopAll(): void {
    if (deferredTicker) { clearInterval(deferredTicker); deferredTicker = null; }
    deferred.clear();
    for (const [stackId, timer] of timers) {
      clearInterval(timer);
      timers.delete(stackId);
    }
    logger.info('Scheduler stopped');
  },
};
