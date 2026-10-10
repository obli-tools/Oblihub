import { logger } from '../utils/logger';
import { db } from '../db';
import { withTimeout } from '../utils/withTimeout';
import { markCriticalBusy } from '../state/criticalActivity.state';
import { dockerService } from '../services/docker.service';
import { engineHostService } from '../services/engineHost.service';
import { getYieldedStackIds } from './PriorityWatchdogWorker';
import type { ResourceLimits, YieldSignalSource } from '@oblihub/shared';

/**
 * GpuUtilPoller — the 'gpu-util' yield signal. Every 2 s it reads the per-GPU utilisation of each
 * engine that hosts a GPU-watched Critical stack (local nvidia-smi or that engine's host agent,
 * through engineHostService) and stamps the Critical stack busy when a GPU it can see is above the
 * threshold. The watchdog fans that out to every Opportunistic stack yielding to it.
 *
 * Bindings are per engine: GPU "0" of the hub and GPU "0" of a remote engine are different cards,
 * so a Critical stack only ever looks at its own engine's GPUs. Orphaned stacks (engine
 * deleted) are never mapped to the local engine: they are skipped.
 *
 * Threshold and interval are constants; they can be promoted to app_config later.
 */

const POLL_INTERVAL_MS = 2_000;
const REFRESH_INTERVAL_MS = 30_000;
const UTIL_THRESHOLD_PERCENT = 20;
const SUPPRESSED_LOG_INTERVAL_MS = 5 * 60_000;
// Container GPU probes (see classifyGpuUse): how long a refresh waits for them, when a failed probe
// may run again, and when a probe that never answered (dead SSH session) may be replaced.
const PROBE_WAIT_MS = 5_000;
const PROBE_RETRY_MS = 2 * 60_000;
const PROBE_INFLIGHT_MAX_MS = 2 * 60_000;

export interface GpuReading {
  index: string;
  uuid: string | null;
  utilGpu: number;
  utilMem: number;
}

export interface GpuReadings {
  at: number;
  gpus: GpuReading[];
}

/** A Critical stack whose GPU activity counts as busy. `visible` null = every GPU of its engine, empty = none. */
export interface CriticalGpuBinding {
  stackId: number;
  engineId: number;
  visible: Set<string> | null;
}

/**
 * An Opportunistic stack that yields to Critical stacks, with the GPUs its containers were actually
 * granted on its engine (see classifyGpuUse) — never its stored visibleGpuIds, which may not be applied.
 */
export interface OpportunisticGpuBinding {
  stackId: number;
  engineId: number;
  visible: Set<string> | null;
  yieldsTo: Set<number>;
}

let bindings: CriticalGpuBinding[] = [];
let opportunists: OpportunisticGpuBinding[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let polling = false;
const suppressedLoggedAt = new Map<number, number>();
const orphanLogged = new Set<number>();

/**
 * The NVIDIA GPUs a container was granted: 'none', null (every GPU of its engine), or only those
 * (nvidia-smi indexes and/or GPU uuids).
 */
export type ContainerGpuAccess = Set<string> | null | 'none';

/** Per `${engineId}:${dockerId}`: the GPUs that container was granted (undefined = not known yet). */
interface GpuProbe { access: ContainerGpuAccess | undefined; at: number; promise: Promise<void> | null }
const gpuProbes = new Map<string, GpuProbe>();
/** Opportunistic stacks whose containers were all probed and none can reach a GPU (last refresh). */
let gpuLessStackIds = new Set<number>();
/** Per yielding Opportunistic stack: the GPUs its containers were granted (null = every GPU), last refresh. */
let opportunisticGpuSets = new Map<number, Set<string> | null>();

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseLimits(raw: unknown): ResourceLimits | null {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ResourceLimits : null;
}

/** null → null (all GPUs), [] → empty set (none). UUIDs are also stored lower-cased, so a uuid typed
 *  in upper case still matches the one nvidia-smi prints (compared lower-cased in `sees`). */
function toVisibleSet(ids: string[] | null | undefined): Set<string> | null {
  if (ids == null) return null;
  const out = new Set<string>();
  for (const raw of ids) {
    const id = String(raw);
    out.add(id);
    if (/^gpu-/i.test(id)) out.add(id.toLowerCase());
  }
  return out;
}

function sees(visible: Set<string> | null, gpu: GpuReading): boolean {
  if (visible == null) return true;
  if (visible.has(gpu.index)) return true;
  return gpu.uuid != null && (visible.has(gpu.uuid) || visible.has(gpu.uuid.toLowerCase()));
}

function utilOf(gpu: GpuReading): number {
  // The higher of the two: an inference workload may be VRAM-bound with idle compute.
  return Math.max(Number.isFinite(gpu.utilGpu) ? gpu.utilGpu : 0, Number.isFinite(gpu.utilMem) ? gpu.utilMem : 0);
}

/**
 * True when the load on `gpu` may come from a running Opportunistic stack that yields to this
 * Critical stack: same engine, it can see that GPU, and the watchdog has not yielded it.
 *
 * WHY: on a shared GPU the miner's own load looked like Critical activity. The watchdog then yielded
 * the miner, the load vanished, the miner resumed, the load came back — a yield/resume flapping loop.
 * Without per-process attribution the load is ambiguous, so gpu-util can now only KEEP a miner
 * yielded (once it is yielded its load is gone and what remains is the Critical stack's); the first
 * yield has to come from nginx traffic or the busy webhook.
 *
 * A miner whose containers cannot reach any GPU (a CPU-only one) creates no GPU load, so it cannot
 * cause that loop: refreshBindings gives it an empty `visible` set, so gpu-util can yield it first.
 */
export function isAmbiguous(
  binding: CriticalGpuBinding,
  gpu: GpuReading,
  opps: OpportunisticGpuBinding[],
  yielded: Set<number>,
): boolean {
  return opps.some((o) => o.yieldsTo.has(binding.stackId)
    && o.engineId === binding.engineId
    && sees(o.visible, gpu)
    && !yielded.has(o.stackId));
}

/** hit: a GPU the Critical stack can see is busy and not ambiguous. suppressed: a busy GPU was ignored as ambiguous. */
export function bindingHits(
  binding: CriticalGpuBinding,
  readings: GpuReadings,
  opps: OpportunisticGpuBinding[],
  yielded: Set<number>,
  threshold = UTIL_THRESHOLD_PERCENT,
): { hit: boolean; suppressed: boolean } {
  let suppressed = false;
  for (const gpu of readings.gpus) {
    if (!sees(binding.visible, gpu)) continue;
    if (!(utilOf(gpu) > threshold)) continue;
    if (isAmbiguous(binding, gpu, opps, yielded)) {
      suppressed = true;
      continue;
    }
    return { hit: true, suppressed: false };
  }
  return { hit: false, suppressed };
}

/** The parts of `docker inspect` that decide GPU access (Docker.ContainerInspectInfo fits it). */
export interface GpuInspectView {
  HostConfig?: {
    Privileged?: boolean;
    Runtime?: string;
    DeviceRequests?: unknown[] | null;
    Devices?: unknown;
    DeviceCgroupRules?: string[] | null;
  } | null;
  Config?: { Env?: string[] | null } | null;
}

const NVIDIA_RE = /nvidia/i;
// `a …` allows every device, `c *:…` every char device, 195 is the NVIDIA driver's major number.
const GPU_CGROUP_RULE_RE = /^\s*(a\b|c\s+(\*|195):)/;
// A single whole GPU as nvidia-smi names it on the host: its index or its uuid (same shape as the
// visibleGpuIds check). Anything else (MIG ids, other CDI kinds, typos) cannot be matched to a
// reading, so it widens the answer to every GPU.
const GPU_ID_RE = /^(\d{1,3}|GPU-[0-9a-f-]{8,64})$/i;
const CDI_GPU_PREFIX = 'nvidia.com/gpu=';

/** The listed ids as a set, or null (every GPU) when one is 'all' or not a single whole GPU. */
function gpuIdList(ids: string[]): Set<string> | null {
  const out = new Set<string>();
  for (const id of ids) {
    if (!GPU_ID_RE.test(id)) return null;
    out.add(id);
  }
  return out.size > 0 ? out : null;
}

/**
 * The NVIDIA GPUs a container was granted, from its inspect data. Container GPU access is fixed at
 * creation (`docker update` cannot change it), so the answer holds for the container's lifetime.
 *
 * WHY the granted set and not the stack's stored visibleGpuIds: the stored restriction is often not
 * in effect — stored but not applied on a non-managed stack, skipped by the renderer when the compose
 * requests no GPU (a CUDA image on a default-runtime nvidia daemon still gets every GPU), or waiting
 * for a recreate. Trusting it let a miner's own load on an "invisible" GPU look like Critical
 * activity, the very flapping loop isAmbiguous guards against.
 *
 * Doubtful cases widen the answer (null, then "can"): a too-narrow set brings that loop back, a
 * too-wide one only keeps the old behaviour (the first yield needs traffic).
 */
export function containerGpuSet(info: GpuInspectView): ContainerGpuAccess {
  const host = info.HostConfig ?? {};
  // Privileged containers see every host device, /dev/nvidia* included. /dev/nvidiaN minor numbers
  // are not nvidia-smi indexes, so a mapped device or a cgroup rule also counts as every GPU.
  if (host.Privileged === true) return null;
  if (Array.isArray(host.Devices) && host.Devices.some((d) => {
    const dev = d as { PathOnHost?: unknown; PathInContainer?: unknown } | null;
    return [dev?.PathOnHost, dev?.PathInContainer].some((p) => typeof p === 'string' && NVIDIA_RE.test(p));
  })) return null;
  if (Array.isArray(host.DeviceCgroupRules) && host.DeviceCgroupRules.some((r) => GPU_CGROUP_RULE_RE.test(String(r)))) return null;

  // --gpus, compose deploy.resources.reservations.devices (Oblihub's own override included) and CDI
  // requests all land here. The daemon writes the request into the OCI spec after the image env, so
  // Config.Env is not consulted: NVIDIA_VISIBLE_DEVICES=all in a CUDA image does not widen it.
  if (Array.isArray(host.DeviceRequests) && host.DeviceRequests.length > 0) {
    const ids: string[] = [];
    for (const raw of host.DeviceRequests) {
      const req = raw as { Count?: unknown; DeviceIDs?: unknown } | null;
      const deviceIds = req?.DeviceIDs;
      const reqIds = Array.isArray(deviceIds) ? deviceIds.map(String) : [];
      // Count -1 is "all"; a count without ids leaves the pick to the toolkit (not knowable here).
      if (req?.Count === -1 || reqIds.length === 0) return null;
      for (const id of reqIds) {
        const bare = id.startsWith(CDI_GPU_PREFIX) ? id.slice(CDI_GPU_PREFIX.length) : id;
        ids.push(bare);
      }
    }
    return gpuIdList(ids);
  }

  const env = new Map<string, string>();
  for (const entry of info.Config?.Env ?? []) {
    const eq = String(entry).indexOf('=');
    if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  const visibleDevices = env.get('NVIDIA_VISIBLE_DEVICES');
  if (visibleDevices !== undefined) {
    // 'void', 'none' and empty expose no GPU. Any other value counts whatever HostConfig.Runtime says:
    // on a default-runtime nvidia daemon this variable (CUDA base images set it to 'all') is how a
    // service gets a GPU without asking for one in its compose; under runc it only errs toward "can".
    const value = visibleDevices.trim();
    if (['', 'void', 'none'].includes(value.toLowerCase())) return 'none';
    if (value.toLowerCase() === 'all') return null;
    return gpuIdList(value.split(',').map((s) => s.trim()).filter((s) => s !== ''));
  }
  // Legacy CUDA images (CUDA_VERSION without NVIDIA_VISIBLE_DEVICES) get every GPU under the NVIDIA
  // runtime; an empty Runtime is an older daemon that did not record its default.
  const runtime = host.Runtime ?? '';
  return (runtime === '' || NVIDIA_RE.test(runtime)) && env.has('CUDA_VERSION') ? null : 'none';
}

/** Whether a container can reach an NVIDIA GPU at all (see containerGpuSet). */
export function containerCanUseGpu(info: GpuInspectView): boolean {
  return containerGpuSet(info) !== 'none';
}

/** Starts (or joins) the inspect of one container; resolves once its GPU set is stored or it failed. */
function probeGpuUse(engineId: number, dockerId: string, now: number): Promise<void> | null {
  const key = `${engineId}:${dockerId}`;
  const current = gpuProbes.get(key);
  // `access` null is a known answer ("every GPU"); only undefined means not probed yet.
  if (current && current.access !== undefined) return null;
  if (current?.promise && now - current.at < PROBE_INFLIGHT_MAX_MS) return current.promise;
  if (current && !current.promise && now - current.at < PROBE_RETRY_MS) return null;
  const probe: GpuProbe = { access: undefined, at: now, promise: null };
  probe.promise = dockerService.inspectContainer(dockerId, engineId)
    .then((info) => { probe.access = containerGpuSet(info); })
    .catch((err: unknown) => {
      logger.debug({ engineId, dockerId, err: errMessage(err) }, 'GpuUtilPoller: container GPU probe failed');
    })
    .finally(() => { probe.promise = null; probe.at = Date.now(); });
  gpuProbes.set(key, probe);
  return probe.promise;
}

/**
 * Per Opportunistic stack, the GPUs its containers were actually granted: the union of each
 * container's containerGpuSet (uuids also lower-cased, as toVisibleSet does). An empty set means
 * every container discovery attached to it was inspected and none can reach a GPU. null (every GPU)
 * whenever the answer is not known: no container row yet, a row without an id or on another engine,
 * a probe not answered or failed, or one container granted every GPU.
 *
 * WHY not the stored visibleGpuIds: null there also means "no restriction" for a stack whose compose
 * asks for no GPU at all (Oblihub never grants one), so a CPU-only miner made every busy GPU of
 * its Critical stack ambiguous; and a stored restriction is not always applied (see containerGpuSet),
 * so a miner still loading a GPU outside it was taken for Critical activity.
 */
async function classifyGpuUse(opps: Array<{ stackId: number; engineId: number }>): Promise<Map<number, Set<string> | null>> {
  if (opps.length === 0) {
    gpuProbes.clear();
    return new Map();
  }
  const rows = await db('containers')
    .whereIn('stack_id', opps.map((o) => o.stackId))
    .select('stack_id', 'docker_id', 'engine_id') as Array<{ stack_id: number; docker_id: string | null; engine_id: number | null }>;
  const engineOf = new Map(opps.map((o) => [o.stackId, o.engineId]));
  const byStack = new Map<number, Array<{ engineId: number; dockerId: string } | null>>();
  for (const row of rows) {
    const engineId = engineOf.get(row.stack_id);
    if (engineId === undefined) continue;
    // A row without an id, or on another engine than its stack, cannot be probed: unknown.
    const ref = row.docker_id && row.engine_id === engineId ? { engineId, dockerId: row.docker_id } : null;
    const list = byStack.get(row.stack_id);
    if (list) list.push(ref); else byStack.set(row.stack_id, [ref]);
  }

  const now = Date.now();
  const seen = new Set<string>();
  const waits: Promise<void>[] = [];
  for (const refs of byStack.values()) {
    for (const ref of refs) {
      if (!ref) continue;
      seen.add(`${ref.engineId}:${ref.dockerId}`);
      const wait = probeGpuUse(ref.engineId, ref.dockerId, now);
      if (wait) waits.push(wait);
    }
  }
  // Only new containers are inspected; bounded so a slow engine never holds the refresh.
  if (waits.length > 0) await withTimeout(Promise.all(waits), PROBE_WAIT_MS, 'container GPU probes').catch(() => undefined);
  for (const key of gpuProbes.keys()) if (!seen.has(key)) gpuProbes.delete(key);

  const sets = new Map<number, Set<string> | null>();
  for (const { stackId } of opps) {
    const access = (byStack.get(stackId) ?? [])
      .map((ref) => (ref ? gpuProbes.get(`${ref.engineId}:${ref.dockerId}`)?.access : undefined));
    const unknownOrAll = access.length === 0 || access.some((a) => a === undefined || a === null);
    sets.set(stackId, toVisibleSet(unknownOrAll ? null : access.flatMap((a) => (a instanceof Set ? [...a] : []))));
  }
  return sets;
}

/** Opportunistic stacks (yielding to a Critical one) proven unable to use a GPU, as of the last refresh. */
export function getGpuLessStackIds(): Set<number> {
  return new Set(gpuLessStackIds);
}

/**
 * Per yielding Opportunistic stack, the GPUs its containers were granted (null = every GPU), as of
 * the last refresh — what the Resources tab's shared-GPU hint should compare, like gpu-util does.
 */
export function getOpportunisticGpuSets(): Record<number, string[] | null> {
  const out: Record<number, string[] | null> = {};
  for (const [stackId, set] of opportunisticGpuSets) out[stackId] = set == null ? null : [...set];
  return out;
}

async function refreshBindings(): Promise<void> {
  const rows = await db('stacks')
    .whereNotNull('resource_limits')
    .select('id', 'engine_id', 'resource_limits') as Array<{ id: number; engine_id: number | null; resource_limits: unknown }>;

  const criticals: Array<CriticalGpuBinding & { signal: YieldSignalSource | null }> = [];
  // No `visible` here: an Opportunistic stack's GPUs come from its containers (classifyGpuUse).
  const opps: Array<Omit<OpportunisticGpuBinding, 'visible'> & { signal: YieldSignalSource | null }> = [];
  for (const row of rows) {
    const limits = parseLimits(row.resource_limits);
    if (!limits) continue;
    if (limits.priority !== 'critical' && limits.priority !== 'opportunistic') continue;
    if (row.engine_id == null) {
      // A NULL engine is a deleted engine, never the local one — its GPU ids mean nothing here.
      if (!orphanLogged.has(row.id)) {
        orphanLogged.add(row.id);
        logger.info({ stackId: row.id }, 'GpuUtilPoller: skipping a stack whose engine was deleted');
      }
      continue;
    }
    const signal = limits.yieldSignalSource ?? null;
    if (limits.priority === 'critical') {
      // The Critical side keeps its stored ids: narrower than what it was granted only makes it look
      // less busy (a missed yield), never a miner's load taken for its own.
      criticals.push({ stackId: row.id, engineId: row.engine_id, visible: toVisibleSet(limits.visibleGpuIds), signal });
    } else if (limits.yieldsToStackIds && limits.yieldsToStackIds.length > 0) {
      opps.push({
        stackId: row.id,
        engineId: row.engine_id,
        yieldsTo: new Set(limits.yieldsToStackIds.map(Number).filter(Number.isFinite)),
        signal,
      });
    }
  }

  // WHY both: the old Resources tab stored the signal choice on the Opportunistic stack, while the
  // poller only read it from the Critical one — so 'gpu-util' picked on a miner silently did nothing.
  const gpuActive = (c: { stackId: number; signal: YieldSignalSource | null }) =>
    c.signal === 'gpu-util' || opps.some((o) => o.yieldsTo.has(c.stackId) && o.signal === 'gpu-util');

  // Every yielding stack is classified, not only those of gpu-util Critical stacks, so that
  // getGpuLessStackIds also answers before gpu-util is switched on (the Resources tab's shared-GPU hint).
  // A stored [] is classified too: it may not be applied, so it cannot stand for "no GPU".
  let gpuSets: Map<number, Set<string> | null>;
  try {
    gpuSets = await classifyGpuUse(opps);
  } catch (err) {
    // Unknown means every GPU (see containerGpuSet); the bindings themselves still refresh.
    logger.warn({ err: errMessage(err) }, 'GpuUtilPoller: container GPU classification failed');
    gpuSets = new Map();
  }
  const gpuLess = new Set<number>();
  for (const [stackId, set] of gpuSets) if (set != null && set.size === 0) gpuLess.add(stackId);
  for (const stackId of gpuLess) {
    if (!gpuLessStackIds.has(stackId)) {
      logger.info({ stackId }, 'GpuUtilPoller: Opportunistic stack cannot use a GPU — its load never makes gpu-util ambiguous');
    }
  }
  gpuLessStackIds = gpuLess;
  opportunisticGpuSets = new Map(opps.map((o) => [o.stackId, gpuSets.get(o.stackId) ?? null]));

  bindings = criticals.filter(gpuActive).map(({ stackId, engineId, visible }) => ({ stackId, engineId, visible }));
  opportunists = opps.map(({ stackId, engineId, yieldsTo }) => ({
    stackId,
    engineId,
    visible: gpuSets.get(stackId) ?? null,
    yieldsTo,
  }));
}

async function pollOnce(): Promise<void> {
  if (bindings.length === 0) return;
  const byEngine = new Map<number, CriticalGpuBinding[]>();
  for (const b of bindings) {
    const list = byEngine.get(b.engineId);
    if (list) list.push(b); else byEngine.set(b.engineId, [b]);
  }
  const opps = opportunists;
  const yielded = getYieldedStackIds();
  const now = Date.now();

  await Promise.all([...byEngine].map(async ([engineId, engineBindings]) => {
    let readings: GpuReadings | null = null;
    try {
      readings = await engineHostService.getGpuReadings(engineId);
    } catch (err) {
      logger.debug({ engineId, err: errMessage(err) }, 'GpuUtilPoller: GPU readings unavailable');
    }
    // No recent reading (no GPU, agent starting, engine unreachable): poll silently until it recovers.
    if (!readings) return;
    for (const b of engineBindings) {
      const r = bindingHits(b, readings, opps, yielded);
      if (r.hit) {
        markCriticalBusy(b.stackId, now);
      } else if (r.suppressed) {
        const last = suppressedLoggedAt.get(b.stackId) ?? 0;
        if (now - last >= SUPPRESSED_LOG_INTERVAL_MS) {
          suppressedLoggedAt.set(b.stackId, now);
          logger.info({ stackId: b.stackId, engineId },
            'GpuUtilPoller: busy GPU ignored — it is shared with a running Opportunistic stack yielding to this one (the first yield must come from traffic or the busy webhook)');
        }
      }
    }
  }));
}

export function startGpuUtilPoller(): void {
  if (running) return;
  running = true;
  // Boots the host agents (remote GPU readings) and the power-limit re-apply at startup, without
  // waiting for someone to open the Resources dashboard.
  engineHostService.ensureStarted();
  logger.info({ intervalMs: POLL_INTERVAL_MS, thresholdPercent: UTIL_THRESHOLD_PERCENT }, 'Starting GPU utilization poller');
  refreshBindings().catch(err => logger.warn({ err: errMessage(err) }, 'GpuUtilPoller initial bindings refresh failed'));
  pollTimer = setInterval(() => {
    // One poll at a time: a slow engine must not pile up a reading every 2 s.
    if (polling) return;
    polling = true;
    pollOnce()
      .catch(err => logger.warn({ err: errMessage(err) }, 'GpuUtilPoller poll failed'))
      .finally(() => { polling = false; });
  }, POLL_INTERVAL_MS);
  refreshTimer = setInterval(() => {
    refreshBindings().catch(err => logger.warn({ err: errMessage(err) }, 'GpuUtilPoller bindings refresh failed'));
  }, REFRESH_INTERVAL_MS);
}

export function stopGpuUtilPoller(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  running = false;
}

export const __test_only = {
  refreshBindings,
  pollOnce,
  classifyGpuUse,
  gpuProbes,
  getBindings: () => ({ bindings, opportunists }),
};
