import Docker from 'dockerode';
import { db } from '../db';
import { logger } from '../utils/logger';
import { engineService } from '../services/engine.service';
import { dockerService } from '../services/docker.service';
import { withTimeout, mapWithConcurrency, TimeoutError } from '../utils/withTimeout';
import { isOblihubHiddenContainer, containerNameOf } from '../utils/oblihubContainers';
import { setEngineStats, clearEngine, type LatestContainerStat } from '../state/containerStats.state';
import type { Server as SocketIOServer } from 'socket.io';
import type { DockerEngine } from '@oblihub/shared';

let statsTimer: ReturnType<typeof setInterval> | null = null;

// Sequential per-container sampling used to take longer than the 10 s interval past ~10
// containers, so runs piled up on top of each other. A tick is now skipped while a run is going.
let running = false;

// A timed-out engine's collect keeps running (a dockerode request cannot be cancelled). Skipping
// that engine until it settles keeps a slow daemon at one abandoned pass instead of one per tick.
const collectingEngines = new Set<number>();

const ENGINE_TIMEOUT_MS = 25_000;
const CONTAINER_TIMEOUT_MS = 8_000;
const CONTAINER_CONCURRENCY = 4;
const SEED_MAX_AGE_SECONDS = 90;

export function calculateCpuPercent(stats: Docker.ContainerStats): number {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage || 0);
  const numCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  if (systemDelta > 0 && cpuDelta >= 0) {
    return (cpuDelta / systemDelta) * numCpus * 100;
  }
  return 0;
}

/**
 * Memory in use without the reclaimable page cache, the same figure `docker stats` shows: the raw
 * `usage` counts file cache, which made containers that read a lot of files look close to their
 * limit. cgroup v2 reports `inactive_file`, v1 `total_inactive_file` (the @types only know v1).
 */
export function memoryUsageExcludingCache(stats: Docker.ContainerStats): number {
  const memory = stats.memory_stats as unknown as
    { usage?: number; stats?: { inactive_file?: number; total_inactive_file?: number } } | undefined;
  const usage = memory?.usage || 0;
  const inactiveFile = memory?.stats?.inactive_file ?? memory?.stats?.total_inactive_file ?? 0;
  return Math.max(0, usage - inactiveFile);
}

async function collect(engine: DockerEngine): Promise<void> {
  const docker = await dockerService.forEngine(engine.id);
  // The host agent and one-shot helpers are Oblihub's own plumbing: no stats rows for them.
  const containers = (await docker.listContainers({ all: false })).filter((c) => !isOblihubHiddenContainer(c));

  const samples = await mapWithConcurrency(containers, CONTAINER_CONCURRENCY, (c) =>
    withTimeout(docker.getContainer(c.Id).stats({ stream: false }) as Promise<Docker.ContainerStats>, CONTAINER_TIMEOUT_MS, 'stats'),
  );

  const now = new Date();
  const at = now.getTime();
  const rows: Record<string, unknown>[] = [];
  const latest: LatestContainerStat[] = [];

  samples.forEach((sample, i) => {
    // Rejected: the container stopped between listing and sampling, or its sample timed out.
    if (sample.status !== 'fulfilled') return;
    const stats = sample.value;
    const c = containers[i];

    const cpuPercent = Math.round(calculateCpuPercent(stats) * 100) / 100;
    const memoryUsage = memoryUsageExcludingCache(stats);
    const memoryLimit = stats.memory_stats?.limit || 1;

    let networkRx = 0;
    let networkTx = 0;
    if (stats.networks) {
      for (const net of Object.values(stats.networks)) {
        networkRx += (net as { rx_bytes: number }).rx_bytes || 0;
        networkTx += (net as { tx_bytes: number }).tx_bytes || 0;
      }
    }

    const dockerId = c.Id.substring(0, 12);
    const name = containerNameOf(c);

    rows.push({
      engine_id: engine.id,
      container_docker_id: dockerId,
      container_name: name,
      cpu_percent: cpuPercent,
      memory_usage: memoryUsage,
      memory_limit: memoryLimit,
      network_rx: networkRx,
      network_tx: networkTx,
      timestamp: now,
    });
    latest.push({ engineId: engine.id, dockerId, name, cpuPercent, memoryUsage, memoryLimit, at });
  });

  if (rows.length > 0) await db('container_stats').insert(rows);
  setEngineStats(engine.id, latest);
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const engines = await engineService.getAll();
    const tasks: Promise<void>[] = [];
    for (const engine of engines) {
      if (!engine.enabled) {
        // A disabled engine's last samples would otherwise stay "current" forever.
        clearEngine(engine.id);
        continue;
      }
      if (collectingEngines.has(engine.id)) continue;
      collectingEngines.add(engine.id);
      const pass = collect(engine).finally(() => { collectingEngines.delete(engine.id); });
      tasks.push(
        withTimeout(pass, ENGINE_TIMEOUT_MS, `stats ${engine.name}`).catch((err: unknown) => {
          logger.warn({ engineId: engine.id, engineName: engine.name, err: err instanceof Error ? err.message : err }, 'Stats worker failed for engine');
          // A slow engine keeps its last values; an unreachable or broken one must not look alive.
          if (!(err instanceof TimeoutError)) clearEngine(engine.id);
        }),
      );
    }
    await Promise.allSettled(tasks);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'Stats worker run failed');
  } finally {
    running = false;
  }
}

/**
 * Seeds the in-memory latest stats from recent rows so the dashboard has values right after a
 * restart instead of waiting for the first pass. Rows older than 90 s would show stale load, and
 * rows without an engine (written before migration 054) cannot be attributed to a daemon.
 */
async function seedLatestFromDb(): Promise<void> {
  try {
    const result = await db.raw(
      `SELECT DISTINCT ON (engine_id, container_docker_id)
              engine_id, container_docker_id, container_name, cpu_percent, memory_usage, memory_limit, timestamp
         FROM container_stats
        WHERE engine_id IS NOT NULL
          AND timestamp > now() - interval '${SEED_MAX_AGE_SECONDS} seconds'
        ORDER BY engine_id, container_docker_id, timestamp DESC`,
    );
    const rows = (result.rows ?? []) as Array<{
      engine_id: number;
      container_docker_id: string;
      container_name: string;
      cpu_percent: number | string;
      memory_usage: number | string;
      memory_limit: number | string;
      timestamp: Date | string;
    }>;
    const perEngine = new Map<number, LatestContainerStat[]>();
    for (const r of rows) {
      const engineId = Number(r.engine_id);
      const list = perEngine.get(engineId) ?? [];
      list.push({
        engineId,
        dockerId: r.container_docker_id,
        name: r.container_name,
        cpuPercent: Number(r.cpu_percent),
        memoryUsage: Number(r.memory_usage),
        memoryLimit: Number(r.memory_limit),
        at: new Date(r.timestamp).getTime(),
      });
      perEngine.set(engineId, list);
    }
    for (const [engineId, list] of perEngine) setEngineStats(engineId, list);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'Stats worker could not seed latest stats from the database');
  }
}

export function startStatsWorker(_io: SocketIOServer): void {
  const seeded = seedLatestFromDb();
  const tick = () => { void seeded.then(run); };

  // Run every 10 seconds
  statsTimer = setInterval(tick, 10000);
  // First run after 5s (let other workers start first)
  setTimeout(tick, 5000);

  logger.info('Stats worker started (10s interval, multi-engine)');
}

export function stopStatsWorker(): void {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

/** Cleanup old stats (keep last 7 days) */
export async function cleanupOldStats(): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const deleted = await db('container_stats').where('timestamp', '<', cutoff).delete();
  if (deleted > 0) {
    logger.info({ deleted }, 'Cleaned up old container stats');
  }
}
