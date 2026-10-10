import { db } from '../db';
import { dockerService } from './docker.service';
import { registryService } from './registry.service';
import { stackService } from './stack.service';
import { appConfigService } from './appConfig.service';
import { maintenanceService } from './maintenance.service';
import { maintenanceAllowsNow } from '@oblihub/shared';
import { notificationService } from './notification.service';
import { logger } from '../utils/logger';
import type { Server as SocketIOServer } from 'socket.io';
import { SOCKET_EVENTS } from '@oblihub/shared';
import type { UpdateHistoryEntry, UpdateStatus } from '@oblihub/shared';

let _io: SocketIOServer | null = null;

/**
 * Status message of a container whose engine was deleted (engine_id NULL). Rows orphaned by engine
 * deletions made before this version (FK ON DELETE SET NULL) used to be checked, pulled and
 * recreated on the hub, because a NULL engine resolves to the local socket.
 */
const ORPHAN_MESSAGE = "This container's engine no longer exists";

// In-flight updates keyed by container id. Lets concurrent triggers (scheduler tick during a
// 16 GB pull, manual re-click, auto-update racing a check-now) share the running operation
// instead of starting a duplicate. The AbortController is exposed so a Cancel button can stop
// a stuck pull mid-stream.
interface InFlightUpdate {
  promise: Promise<void>;
  abort: AbortController;
  startedAt: number;
  stackId: number | null;
  containerName: string;
  triggeredBy: 'auto' | 'manual';
}
const inFlightUpdates = new Map<number, InFlightUpdate>();

// Notification throttle: avoid spamming (default 300s)
const lastNotified = new Map<string, number>();
function shouldNotify(key: string, thresholdMs: number = 300000): boolean {
  const now = Date.now();
  const last = lastNotified.get(key) || 0;
  if (now - last < thresholdMs) return false;
  lastNotified.set(key, now);
  return true;
}

export function setUpdateServiceIO(io: SocketIOServer): void {
  _io = io;
}

interface HistoryRow {
  id: number;
  stack_id: number | null;
  container_id: number | null;
  container_name: string;
  image: string;
  old_digest: string | null;
  new_digest: string | null;
  status: string;
  error_message: string | null;
  triggered_by: string;
  started_at: Date;
  completed_at: Date | null;
}

function rowToHistory(row: HistoryRow): UpdateHistoryEntry {
  return {
    id: row.id,
    stackId: row.stack_id,
    containerId: row.container_id,
    containerName: row.container_name,
    image: row.image,
    oldDigest: row.old_digest,
    newDigest: row.new_digest,
    status: row.status as UpdateStatus,
    errorMessage: row.error_message,
    triggeredBy: row.triggered_by as 'auto' | 'manual',
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

export const updateService = {
  /**
   * Check all containers in a stack for updates.
   * Updates container status and emits Socket.io events.
   */
  /**
   * `trigger`: 'schedule' (scheduler tick) or 'manual' (Check button). Only the scheduler is gated
   * by the maintenance window here (it checks before calling); the auto-apply at the end is gated
   * for both, so a manual Check outside the window reports updates without applying them.
   */
  async checkStack(stackId: number, trigger: 'schedule' | 'manual' = 'schedule'): Promise<void> {
    const stack = await stackService.getById(stackId);
    if (!stack || !stack.enabled) return;

    logger.info({ stackId, stackName: stack.name }, 'Checking stack for updates...');

    for (const container of stack.containers) {
      if (container.excluded || container.status === 'stopped') continue;
      if (container.engineId == null) {
        logger.warn({ containerId: container.id, containerName: container.containerName }, 'Engine deleted — update check skipped');
        if (container.status !== 'error' || container.errorMessage !== ORPHAN_MESSAGE) {
          await stackService.updateContainerStatus(container.id, 'error', null, null, ORPHAN_MESSAGE);
        }
        continue;
      }

      try {
        // Get ALL local digests for this image (Docker may accumulate several for the same
        // image when a registry re-manifests a tag — any of them is a valid "up-to-date" match).
        const localDigests = await dockerService.getLocalDigests(`${container.image}:${container.imageTag}`, container.engineId);
        const primaryLocalDigest = localDigests[0] ?? null;

        // Check remote against full local digest set
        const { hasUpdate, remoteDigest } = await registryService.checkForUpdate(
          container.image,
          container.imageTag,
          localDigests,
        );

        const newStatus = hasUpdate ? 'update_available' as const : 'up_to_date' as const;

        await stackService.updateContainerStatus(
          container.id,
          newStatus,
          remoteDigest,
          primaryLocalDigest,
        );

        if (_io) {
          _io.emit(SOCKET_EVENTS.CONTAINER_STATUS_CHANGED, {
            containerId: container.id,
            stackId,
            status: newStatus,
            currentDigest: primaryLocalDigest,
            latestDigest: remoteDigest,
          });
        }

        // Notify if update available (throttled, respecting overrides)
        const notifyAvailGlobal = (await appConfigService.get('notify_update_available')) !== 'false';
        const notifyAvailStack = stack.notifyUpdateAvailable;
        const shouldNotifyAvail = notifyAvailStack !== null ? notifyAvailStack : notifyAvailGlobal;
        const delayGlobal = parseInt((await appConfigService.get('notify_delay')) || '300', 10) * 1000;
        const delayStack = stack.notifyDelay !== null ? stack.notifyDelay * 1000 : delayGlobal;

        if (hasUpdate && shouldNotifyAvail && shouldNotify(`update_available:${container.id}`, delayStack)) {
          notificationService.sendForStack(stackId, stack.name, {
            stackName: stack.name,
            containerName: container.containerName,
            image: `${container.image}:${container.imageTag}`,
            oldDigest: primaryLocalDigest || undefined,
            newDigest: remoteDigest || undefined,
            eventType: 'update_available',
            message: `Update available for ${container.containerName} (${container.image}:${container.imageTag})`,
            timestamp: new Date().toISOString(),
          }).catch(err => logger.warn({ err }, 'Failed to send update_available notification'));
        }
      } catch (err) {
        logger.error({ containerId: container.id, err }, 'Failed to check container');
        await stackService.updateContainerStatus(container.id, 'error', null, null, String(err));
      }
    }

    await stackService.markChecked(stackId);

    if (_io) {
      _io.emit(SOCKET_EVENTS.STACK_STATUS_CHANGED, { stackId });
    }

    // Auto-update: per-stack toggle OR global toggle
    const globalAutoUpdate = (await appConfigService.get('global_auto_update')) === 'true';
    if (stack.autoUpdate || globalAutoUpdate) {
      // Outside the maintenance window the updates stay "available": the first scheduled check
      // inside the window applies them.
      if (!maintenanceAllowsNow(await maintenanceService.effectiveFor(stack.maintenanceWindow))) {
        logger.info({ stackId, stackName: stack.name, trigger }, 'Auto-update deferred — outside the maintenance window');
        return;
      }
      const updatedStack = await stackService.getById(stackId);
      const hasUpdates = updatedStack?.containers.some(c => c.status === 'update_available');
      if (hasUpdates) {
        await this.updateStack(stackId, 'auto');
      }
    }
  },

  /**
   * Update all containers in a stack that have updates available.
   */
  async updateStack(stackId: number, triggeredBy: 'auto' | 'manual' = 'manual'): Promise<void> {
    const stack = await stackService.getById(stackId);
    if (!stack) return;

    const toUpdate = stack.containers.filter(c => c.status === 'update_available' && !c.excluded);
    if (toUpdate.length === 0) return;

    logger.info({ stackId, stackName: stack.name, count: toUpdate.length }, 'Updating stack...');

    for (const container of toUpdate) {
      await this.updateContainer(container.id, stackId, triggeredBy);
    }

    await stackService.markUpdated(stackId);
  },

  /**
   * Update a single container. Concurrent callers (auto-update scheduler tick during a long
   * pull, double-click on the UI, etc.) share the same in-flight run instead of starting a
   * second one. Returns the same promise to all waiters.
   */
  async updateContainer(containerId: number, stackId: number | null, triggeredBy: 'auto' | 'manual' = 'manual'): Promise<void> {
    const existing = inFlightUpdates.get(containerId);
    if (existing) {
      logger.info({ containerId, runningSince: existing.startedAt }, 'Update already in progress — joining existing run');
      return existing.promise;
    }

    const container = await stackService.getContainerById(containerId);
    if (!container) return;

    const abort = new AbortController();
    const promise = (async () => {
      try {
        await this._updateContainerInner(containerId, stackId, triggeredBy, abort.signal);
      } finally {
        inFlightUpdates.delete(containerId);
      }
    })();
    inFlightUpdates.set(containerId, {
      promise, abort, startedAt: Date.now(), stackId, containerName: container.containerName, triggeredBy,
    });
    return promise;
  },

  /** True when an update is currently running for this container. */
  isUpdating(containerId: number): boolean {
    return inFlightUpdates.has(containerId);
  },

  /**
   * Abort an in-flight update. Returns true if a run was actually cancelled, false when no
   * update was running. The pull stream and any downstream awaits observe the abort signal
   * and bail out, which results in an UPDATE_COMPLETE with `error: 'Cancelled by user'`.
   */
  cancelUpdate(containerId: number): boolean {
    const entry = inFlightUpdates.get(containerId);
    if (!entry) return false;
    logger.warn({ containerId, runningSinceMs: Date.now() - entry.startedAt }, 'Cancelling in-flight update');
    entry.abort.abort(new Error('Cancelled by user'));
    return true;
  },

  /**
   * Internal — the actual update sequence. Wrapped by `updateContainer` for in-flight tracking.
   * Accepts an AbortSignal that's checked at each major step to allow user-initiated cancel.
   */
  async _updateContainerInner(containerId: number, stackId: number | null, triggeredBy: 'auto' | 'manual', signal: AbortSignal): Promise<void> {
    const container = await stackService.getContainerById(containerId);
    if (!container) return;
    if (container.engineId == null) {
      logger.warn({ containerId, containerName: container.containerName }, 'Engine deleted — update skipped');
      await stackService.updateContainerStatus(containerId, 'error', null, null, ORPHAN_MESSAGE);
      if (_io) {
        _io.emit(SOCKET_EVENTS.UPDATE_COMPLETE, {
          stackId, containerId, success: false, error: ORPHAN_MESSAGE,
        });
      }
      return;
    }
    const throwIfCancelled = () => {
      if (signal.aborted) throw new Error('Cancelled by user');
    };

    // Create history entry
    const [historyRow] = await db('update_history').insert({
      stack_id: stackId,
      container_id: containerId,
      container_name: container.containerName,
      image: `${container.image}:${container.imageTag}`,
      old_digest: container.currentDigest,
      new_digest: container.latestDigest,
      status: 'pulling',
      triggered_by: triggeredBy,
    }).returning('*') as HistoryRow[];

    const historyId = historyRow.id;

    try {
      // Update status
      await stackService.updateContainerStatus(containerId, 'updating');
      if (_io) {
        _io.emit(SOCKET_EVENTS.UPDATE_PROGRESS, {
          stackId, containerId, phase: 'pulling',
          message: `Pulling ${container.image}:${container.imageTag}...`,
        });
      }

      // Check if this is a self-update (our own container)
      const selfId = dockerService.getSelfContainerId();
      const isSelfUpdate = selfId !== null && container.dockerId === selfId;

      if (isSelfUpdate) {
        logger.info({ containerId, containerName: container.containerName }, 'Self-update detected — using special self-update path');
        await db('update_history').where({ id: historyId }).update({ status: 'recreating' });
        if (_io) {
          _io.emit(SOCKET_EVENTS.UPDATE_PROGRESS, {
            stackId, containerId, phase: 'self_update',
            message: 'Self-updating Oblihub — the service will restart momentarily...',
          });
        }
        // selfUpdate pulls, renames, creates new, starts it, then exits this process
        await dockerService.selfUpdate(container.image, container.imageTag);
        // We never reach here — process.exit() is called inside selfUpdate
        return;
      }

      throwIfCancelled();

      // 1. Pull new image — forward live progress to subscribers. Pull events arrive as one
      // JSON object per line in the docker stream; we format each into a short human-readable
      // string and emit as UPDATE_LOG so the stack page can render a streaming tail.
      //
      // We check the abort signal on every progress event (cheap, runs hundreds of times for a
      // multi-GB pull) and throw if set — the surrounding catch surfaces it as "Cancelled".
      // The pull itself can't be force-killed via Node, but the throw stops us from waiting for
      // it to finish, and the Docker daemon eventually GC's the orphaned pull.
      await dockerService.pullImage(container.image, container.imageTag, container.engineId, (ev) => {
        if (signal.aborted) throw new Error('Cancelled by user');
        if (!_io) return;
        let chunk: string;
        if (ev.status && ev.id) {
          chunk = `${ev.id}: ${ev.status}${ev.progress ? ` ${ev.progress}` : ''}`;
        } else if (ev.status) {
          chunk = ev.status;
        } else {
          chunk = JSON.stringify(ev);
        }
        _io.emit(SOCKET_EVENTS.UPDATE_LOG, {
          stackId, containerId, containerName: container.containerName, chunk,
        });
      });

      throwIfCancelled();

      // Update history
      await db('update_history').where({ id: historyId }).update({ status: 'recreating' });
      if (_io) {
        _io.emit(SOCKET_EVENTS.UPDATE_PROGRESS, {
          stackId, containerId, phase: 'recreating',
          message: `Recreating ${container.containerName}...`,
        });
        _io.emit(SOCKET_EVENTS.UPDATE_LOG, {
          stackId, containerId, containerName: container.containerName,
          chunk: `Recreating ${container.containerName}...`,
        });
      }

      // 2. Recreate container. An update must not wake a sleeping container, nor restart a miner the
      // priority watchdog stopped while its Critical stack is busy: the new container keeps the old
      // one's state in those cases.
      const yieldStackId = stackId ?? container.stackId;
      const preserveState = (container.sleepEnabled && container.sleepState === 'sleeping')
        || (yieldStackId != null && (await import('../workers/PriorityWatchdogWorker')).getYieldedStackIds().has(yieldStackId));
      const newDockerId = await dockerService.recreateContainer(
        container.dockerId,
        container.image,
        container.imageTag,
        container.engineId,
        { preserveState },
      );

      // 3. Get new digest
      const newDigest = await dockerService.getLocalDigest(`${container.image}:${container.imageTag}`, container.engineId);

      // 4. Update DB
      await stackService.updateContainerDockerId(containerId, newDockerId);
      await stackService.updateContainerStatus(containerId, 'up_to_date', newDigest, newDigest);

      // 5. Complete history
      await db('update_history').where({ id: historyId }).update({
        status: 'success',
        new_digest: newDigest,
        completed_at: new Date(),
      });

      if (_io) {
        _io.emit(SOCKET_EVENTS.UPDATE_COMPLETE, {
          stackId, containerId, success: true,
        });
      }

      logger.info({ containerId, containerName: container.containerName }, 'Container updated successfully');

      // Notify update applied (respecting overrides)
      const stackForNotif = stackId ? await stackService.getById(stackId) : null;
      const notifyAppliedGlobal = (await appConfigService.get('notify_update_applied')) !== 'false';
      const notifyAppliedStack = stackForNotif?.notifyUpdateApplied;
      const shouldNotifyApplied = notifyAppliedStack !== null ? notifyAppliedStack : notifyAppliedGlobal;

      if (shouldNotifyApplied) notificationService.sendForStack(stackId!, stackForNotif?.name || '', {
        stackName: stackForNotif?.name || '',
        containerName: container.containerName,
        image: `${container.image}:${container.imageTag}`,
        oldDigest: container.currentDigest || undefined,
        newDigest: newDigest || undefined,
        eventType: 'update_applied',
        message: `${container.containerName} updated successfully`,
        timestamp: new Date().toISOString(),
      }).catch(err => logger.warn({ err }, 'Failed to send update_applied notification'));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ containerId, err }, 'Container update failed');

      await db('update_history').where({ id: historyId }).update({
        status: 'failed',
        error_message: errorMsg,
        completed_at: new Date(),
      });

      await stackService.updateContainerStatus(containerId, 'error', null, null, errorMsg);

      if (_io) {
        _io.emit(SOCKET_EVENTS.UPDATE_COMPLETE, {
          stackId, containerId, success: false, error: errorMsg,
        });
      }

      // Notify update failed
      const stack = await stackService.getById(stackId!);
      notificationService.sendForStack(stackId!, stack?.name || '', {
        stackName: stack?.name || '',
        containerName: container.containerName,
        image: `${container.image}:${container.imageTag}`,
        eventType: 'update_failed',
        message: `Failed to update ${container.containerName}: ${errorMsg}`,
        timestamp: new Date().toISOString(),
      }).catch(e => logger.warn({ e }, 'Failed to send update_failed notification'));
    }
  },

  /** Get update history for a stack */
  async getHistory(stackId: number, limit: number = 50, offset: number = 0): Promise<UpdateHistoryEntry[]> {
    const rows = await db<HistoryRow>('update_history')
      .where({ stack_id: stackId })
      .orderBy('started_at', 'desc')
      .limit(limit)
      .offset(offset);
    return rows.map(rowToHistory);
  },

  /** Get all update history */
  async getAllHistory(limit: number = 100): Promise<UpdateHistoryEntry[]> {
    const rows = await db<HistoryRow>('update_history')
      .orderBy('started_at', 'desc')
      .limit(limit);
    return rows.map(rowToHistory);
  },
};
