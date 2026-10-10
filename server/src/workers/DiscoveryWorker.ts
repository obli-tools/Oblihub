import { dockerService } from '../services/docker.service';
import { stackService } from '../services/stack.service';
import { engineService } from '../services/engine.service';
import { logger } from '../utils/logger';
import { config } from '../config';
import { withTimeout } from '../utils/withTimeout';
import type { Server as SocketIOServer } from 'socket.io';
import { SOCKET_EVENTS } from '@oblihub/shared';
import type { DockerEngine } from '@oblihub/shared';

let discoveryTimer: ReturnType<typeof setInterval> | null = null;
let io: SocketIOServer | null = null;
let inflight: Promise<number> | null = null;

const ENGINE_LIST_TIMEOUT_MS = 20_000;

async function pass(): Promise<number> {
  let totalContainers = 0;
  try {
    const engines = (await engineService.getAll()).filter((e) => e.enabled);

    // Fetch in parallel: one unreachable engine used to hold up discovery of every engine after it.
    const fetched = await Promise.allSettled(
      engines.map((engine) =>
        withTimeout(dockerService.listContainers(engine.id), ENGINE_LIST_TIMEOUT_MS, `discovery ${engine.name}`)),
    );

    // Connection-status follow-ups run in the background, all at once: a bad engine's slow ping
    // must not delay the others (or the sync).
    const followUps: Promise<unknown>[] = [];
    const markFailed = (engine: DockerEngine, err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ engineId: engine.id, engineName: engine.name, err: message }, 'Discovery failed for engine');
      // Surface the error in the engine's last_ping_* so the user can see it on the Engines page.
      followUps.push(engineService.testConnection(engine.id).catch(() => {}));
    };

    // Sync SEQUENTIALLY, in engine id order (getAll orders by id): parallel DB writes race on
    // orphan-row adoption and on re-associating rows between engines.
    for (let i = 0; i < engines.length; i++) {
      const engine = engines[i];
      const result = fetched[i];
      if (result.status === 'rejected') {
        markFailed(engine, result.reason);
        continue;
      }
      try {
        await stackService.syncWithDocker(result.value, engine.id);
        totalContainers += result.value.length;
        // Engine reachable — mark last_ping as ok
        if (engine.lastPingStatus !== 'ok') {
          followUps.push(engineService.testConnection(engine.id).catch(() => {}));
        }
      } catch (err) {
        markFailed(engine, err);
      }
    }

    void Promise.allSettled(followUps);

    // Signal clients to re-fetch via API (which filters by team/permissions).
    // DO NOT broadcast stack data via socket - it bypasses team/permission checks.
    io?.emit(SOCKET_EVENTS.DISCOVERY_COMPLETE, { containerCount: totalContainers });
  } catch (err) {
    logger.error(err, 'Discovery pass failed');
  }
  return totalContainers;
}

/**
 * One discovery pass (parallel fetch, sequential sync). A call made while a pass runs gets that
 * pass's promise instead of starting a second one. The manual refresh route used to call
 * listContainers + syncWithDocker itself, bypassing this guard and the per-engine timeout, and raced
 * the 30 s worker on orphan-row adoption and row re-association. Never rejects: errors are logged
 * inside the pass and it resolves with the container count of the engines that synced.
 */
export function runDiscoveryOnce(): Promise<number> {
  if (inflight) return inflight;
  inflight = pass().finally(() => { inflight = null; });
  return inflight;
}

export function startDiscoveryWorker(socketServer: SocketIOServer): void {
  io = socketServer;

  // Run immediately on start. Going through runDiscoveryOnce IS the overlap guard: a tick that
  // lands during a running pass joins it instead of starting another.
  void runDiscoveryOnce();

  // Then on interval
  discoveryTimer = setInterval(() => { void runDiscoveryOnce(); }, config.discoveryIntervalMs);
  logger.info({ intervalMs: config.discoveryIntervalMs }, 'Discovery worker started (multi-engine)');
}

export function stopDiscoveryWorker(): void {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
}
