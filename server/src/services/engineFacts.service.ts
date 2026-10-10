import type Docker from 'dockerode';
import type { DockerEngineType } from '@oblihub/shared';
import { db } from '../db';
import { logger } from '../utils/logger';
import { withTimeout, TimeoutError } from '../utils/withTimeout';
import { dockerService } from './docker.service';
import { engineService } from './engine.service';

/**
 * `docker info` per engine: capacity (NCPU / MemTotal) used to size CPU/RAM caps, GPU signals
 * (nvidia runtime, CDI devices) and host identity.
 *
 * Request paths only read the cache (`peek`) or wait a bounded time (`get`); the background loop
 * started by `ensureRefreshLoop()` is what primes and refreshes it. Over SSH every API call is a new
 * handshake, so a remote engine can take seconds to answer: fetches are single-flight per engine and
 * a fetch that outlives its caller's timeout keeps running and still fills the cache.
 *
 * This module must not import compose.service or composeRunner (they import it).
 */

export interface EngineFacts {
  engineId: number;
  daemonKey: string;
  hostname: string | null;
  cpuCount: number | null;
  memTotalBytes: number | null;
  os: string | null;
  osType: string | null;
  kernel: string | null;
  arch: string | null;
  dockerVersion: string | null;
  containersTotal: number | null;
  containersRunning: number | null;
  containersPaused: number | null;
  runtimes: string[];
  nvidiaRuntime: boolean;
  cdiNvidia: boolean;
  fetchedAt: number | null;
  error: string | null;
}

interface CacheEntry { facts: EngineFacts; client: Docker; at: number }
interface Inflight { promise: Promise<EngineFacts>; startedAt: number }

const DEFAULT_MAX_AGE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const PEEK_REFRESH_AFTER_MS = 60_000;
const LOOP_INTERVAL_MS = 60_000;
const LOOP_TIMEOUT_MS = 10_000;
// A hung `info()` (dead SSH session) would otherwise hold the single-flight slot forever and no
// later refresh could start; after this long a new fetch may replace it.
const INFLIGHT_MAX_MS = 120_000;
const LOCAL_ENGINE_TTL_MS = 60_000;
const ENGINE_TYPE_TTL_MS = 30_000;

const cache = new Map<number, CacheEntry>();
const inflight = new Map<number, Inflight>();
// Bumped by invalidate(): a fetch started before an invalidation must not write its (possibly
// pre-update) answer into the cache afterwards.
const generation = new Map<number, number>();

let localEngineCache: { id: number | null; at: number } | null = null;
const engineTypeCache = new Map<number, { type: DockerEngineType | null; at: number }>();

let loopTimer: NodeJS.Timeout | null = null;
let loopStopped = false;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Capacity values: 0 would size every cap to nothing, so it counts as unknown. */
function capacity(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function emptyFacts(engineId: number, daemonKey: string): EngineFacts {
  return {
    engineId, daemonKey, hostname: null, cpuCount: null, memTotalBytes: null, os: null, osType: null,
    kernel: null, arch: null, dockerVersion: null, containersTotal: null, containersRunning: null,
    containersPaused: null, runtimes: [], nvidiaRuntime: false, cdiNvidia: false, fetchedAt: null, error: null,
  };
}

interface DockerInfoLike {
  Name?: unknown; NCPU?: unknown; MemTotal?: unknown; OperatingSystem?: unknown; OSType?: unknown;
  KernelVersion?: unknown; Architecture?: unknown; ServerVersion?: unknown; Containers?: unknown;
  ContainersRunning?: unknown; ContainersPaused?: unknown; Runtimes?: unknown; DiscoveredDevices?: unknown;
}

function mapInfo(engineId: number, daemonKey: string, info: DockerInfoLike): EngineFacts {
  const runtimes = info.Runtimes && typeof info.Runtimes === 'object' ? Object.keys(info.Runtimes as object) : [];
  // DiscoveredDevices only exists on recent daemons (CDI discovery): absent means "unknown", not "no GPU".
  const cdiNvidia = Array.isArray(info.DiscoveredDevices) && info.DiscoveredDevices.some((d) => {
    const dev = d as { ID?: unknown; Id?: unknown } | null;
    const id = dev?.ID ?? dev?.Id;
    return typeof id === 'string' && /nvidia\.com\/gpu/i.test(id);
  });
  return {
    engineId,
    daemonKey,
    hostname: str(info.Name),
    cpuCount: capacity(info.NCPU),
    memTotalBytes: capacity(info.MemTotal),
    os: str(info.OperatingSystem),
    osType: str(info.OSType),
    kernel: str(info.KernelVersion),
    arch: str(info.Architecture),
    dockerVersion: str(info.ServerVersion),
    containersTotal: count(info.Containers),
    containersRunning: count(info.ContainersRunning),
    containersPaused: count(info.ContainersPaused),
    runtimes,
    nvidiaRuntime: runtimes.includes('nvidia'),
    cdiNvidia,
    fetchedAt: Date.now(),
    error: null,
  };
}

/** Single-flight `docker info` for one engine; fills the cache on success. */
function fetchFacts(engineId: number): Promise<EngineFacts> {
  const current = inflight.get(engineId);
  if (current && Date.now() - current.startedAt < INFLIGHT_MAX_MS) return current.promise;
  const gen = generation.get(engineId) ?? 0;
  const run = (async () => {
    const client = await dockerService.forEngine(engineId);
    const info = (await client.info()) as DockerInfoLike;
    const facts = mapInfo(engineId, await engineFactsService.daemonKey(engineId), info);
    if ((generation.get(engineId) ?? 0) === gen) {
      cache.set(engineId, { facts, client, at: Date.now() });
    }
    return facts;
  })();
  const entry: Inflight = { promise: run, startedAt: Date.now() };
  inflight.set(engineId, entry);
  const clear = () => { if (inflight.get(engineId) === entry) inflight.delete(engineId); };
  run.then(clear, clear);
  return run;
}

function refreshInBackground(engineId: number): void {
  fetchFacts(engineId).catch((err: unknown) => {
    logger.debug({ engineId, err: errMessage(err) }, 'Background docker info refresh failed');
  });
}

async function refreshAllEnabled(): Promise<void> {
  try {
    const rows = await db('docker_engines').where({ enabled: true }).select('id') as Array<{ id: number }>;
    await Promise.allSettled(rows.map((r) =>
      withTimeout(fetchFacts(r.id), LOOP_TIMEOUT_MS, `docker info on engine ${r.id}`).catch((err: unknown) => {
        logger.debug({ engineId: r.id, err: errMessage(err) }, 'Engine facts refresh failed');
      })));
  } catch (err) {
    logger.debug({ err: errMessage(err) }, 'Engine facts refresh loop failed');
  }
}

export const engineFactsService = {
  /** null only when no engine row exists. On timeout or error, the previous numbers (if any) come
   *  back with `error` set. */
  async get(engineId: number, opts: { maxAgeMs?: number; timeoutMs?: number; allowStale?: boolean } = {}): Promise<EngineFacts | null> {
    engineFactsService.ensureRefreshLoop();
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const allowStale = opts.allowStale ?? true;
    const engine = await engineService.getById(engineId);
    if (!engine) return null;

    const entry = cache.get(engineId);
    if (entry) {
      let client: Docker | null = null;
      try { client = await dockerService.forEngine(engineId); } catch { client = null; }
      // A different client instance means engineService rebuilt it after an engine update: the
      // cached facts may describe another host, so they are neither fresh nor usable as stale.
      if (client === entry.client) {
        if (Date.now() - entry.at < maxAgeMs) return entry.facts;
        if (allowStale) {
          refreshInBackground(engineId);
          return entry.facts;
        }
      }
    }

    try {
      return await withTimeout(fetchFacts(engineId), timeoutMs, `docker info on engine ${engineId}`);
    } catch (err) {
      const previous = cache.get(engineId)?.facts ?? emptyFacts(engineId, await engineFactsService.daemonKey(engineId));
      // The single-flight fetch keeps running after a TimeoutError and fills the cache when it
      // resolves: over SSH every call is a new handshake, and a request-level timeout must not waste
      // the answer.
      if (err instanceof TimeoutError) return { ...previous, error: 'timeout' };
      return { ...previous, error: errMessage(err) };
    }
  },

  /** Cache only, never blocks; starts a background refresh when the entry is missing or older than 60 s. */
  peek(engineId: number): EngineFacts | null {
    engineFactsService.ensureRefreshLoop();
    const entry = cache.get(engineId);
    if (!entry || Date.now() - entry.at > PEEK_REFRESH_AFTER_MS) refreshInBackground(engineId);
    return entry?.facts ?? null;
  },

  invalidate(engineId?: number): void {
    if (engineId == null) {
      for (const id of new Set([...cache.keys(), ...inflight.keys(), ...generation.keys()])) {
        generation.set(id, (generation.get(id) ?? 0) + 1);
      }
      cache.clear();
      inflight.clear();
      engineTypeCache.clear();
      localEngineCache = null;
      return;
    }
    generation.set(engineId, (generation.get(engineId) ?? 0) + 1);
    cache.delete(engineId);
    inflight.delete(engineId);
    engineTypeCache.delete(engineId);
    localEngineCache = null;
  },

  /** First engine of type 'local' (is_default desc, id asc), cached 60 s. */
  async resolveLocalEngineId(): Promise<number | null> {
    engineFactsService.ensureRefreshLoop();
    if (localEngineCache && Date.now() - localEngineCache.at < LOCAL_ENGINE_TTL_MS) return localEngineCache.id;
    const row = await db('docker_engines')
      .where({ type: 'local' })
      .orderBy([{ column: 'is_default', order: 'desc' }, { column: 'id', order: 'asc' }])
      .select('id')
      .first() as { id: number } | undefined;
    localEngineCache = { id: row?.id ?? null, at: Date.now() };
    return localEngineCache.id;
  },

  /** Cached 30 s. null for an unknown engine id. */
  async engineType(engineId: number): Promise<DockerEngineType | null> {
    engineFactsService.ensureRefreshLoop();
    const cached = engineTypeCache.get(engineId);
    if (cached && Date.now() - cached.at < ENGINE_TYPE_TTL_MS) return cached.type;
    const engine = await engineService.getById(engineId);
    const type = engine?.type ?? null;
    engineTypeCache.set(engineId, { type, at: Date.now() });
    return type;
  },

  /** 'local' for local-type engines (all share Oblihub's own socket), else 'e<id>' (also for unknown ids). */
  async daemonKey(engineId: number): Promise<string> {
    engineFactsService.ensureRefreshLoop();
    return (await engineFactsService.engineType(engineId)) === 'local' ? 'local' : `e${engineId}`;
  },

  /** managed_stacks semantics: a NULL engine_id is the legacy local socket. */
  async managedDaemonKey(engineId: number | null): Promise<string> {
    engineFactsService.ensureRefreshLoop();
    return engineId == null ? 'local' : engineFactsService.daemonKey(engineId);
  },

  /** Engine ids of that daemon: local → every local-type engine id; otherwise [id]. */
  async daemonEngineIds(managedEngineId: number | null): Promise<number[]> {
    engineFactsService.ensureRefreshLoop();
    const key = await engineFactsService.managedDaemonKey(managedEngineId);
    if (key !== 'local') return managedEngineId == null ? [] : [managedEngineId];
    const rows = await db('docker_engines').where({ type: 'local' }).orderBy('id').select('id') as Array<{ id: number }>;
    return rows.map((r) => r.id);
  },

  /**
   * Idempotent; every read method calls it. Request paths only read the cache — this loop is what
   * primes it: immediately, then every 60 s, every ENABLED engine with a 10 s timeout, in parallel.
   */
  ensureRefreshLoop(): void {
    if (loopTimer || loopStopped) return;
    loopTimer = setInterval(() => { void refreshAllEnabled(); }, LOOP_INTERVAL_MS);
    loopTimer.unref();
    void refreshAllEnabled();
  },

  /** Stops the loop for good (shutdown): later reads do not restart it. */
  stopRefreshLoop(): void {
    loopStopped = true;
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = null;
  },
};
