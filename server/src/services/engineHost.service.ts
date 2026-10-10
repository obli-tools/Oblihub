import * as os from 'node:os';
import type {
  DockerEngine, EngineHostAgentInfo, EngineHostFacts, EngineHostGpu, EngineHostLive, EngineHostSnapshot,
  GpuInfo, GpuLiveStat, GpuPowerLimitResult, GpuStatsSource, GpuStatus,
} from '@oblihub/shared';
import { config } from '../config';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { withTimeout, TimeoutError } from '../utils/withTimeout';
import type { AgentSample } from '../utils/hostAgentProtocol';
import { getEngineStatsAt, getLatestForEngine } from '../state/containerStats.state';
import { engineService } from './engine.service';
import { engineFactsService, type EngineFacts } from './engineFacts.service';
import { hostAgentService } from './hostAgent.service';
import { hostStatsService, type HostStats } from './hostStats.service';
import { peekLocalGpus, queryLocalGpus, setPowerLimit as setLocalPowerLimit, type LocalGpuQuery } from './gpuDetection.service';

/**
 * Per-engine host view (EngineHostSnapshot) for the Resources dashboard and the per-stack tab, and
 * host-wide GPU power limits per engine.
 *
 * Engine ids are always concrete numbers here: orphaned stacks (engine deleted) are handled by the
 * callers. Snapshots never wait on a remote engine for more than ~2 s: they read the facts cache,
 * the host agent's latest sample and the in-memory container stats.
 *
 * `nvidia-smi -pl` does not survive a host reboot or a driver reload, so the limits an admin sets
 * are stored in gpu_power_limits and re-applied once per boot of Oblihub and after a host reboot
 * (detected from the agent's uptime). Never periodically: a manual `nvidia-smi` change on the host
 * is not fought.
 */

const SNAPSHOT_TIMEOUT_MS = 2_000;
const FACTS_WAIT_MS = 1_500;
// Local parts run in parallel with the facts lookup, so the whole snapshot stays under 2 s.
const LOCAL_PART_TIMEOUT_MS = 1_500;
const LOCAL_FALLBACK_MAX_AGE_MS = 30_000;
const AGGREGATE_FRESH_MS = 60_000;
// The facts loop refreshes every 60 s; cached facts much older than that mean docker info stopped answering.
const FACTS_STALE_MS = 180_000;
const DESIRED_TTL_MS = 30_000;
const APPLIED_WAIT_MS = 4_000;
const BOOT_REAPPLY_DELAY_MS = 10_000;
const REBOOT_UPTIME_SLACK_S = 60;
const GPU_KEY_RE = /^([0-9]{1,3}|GPU-[0-9a-fA-F-]{8,64})$/;
const ENGINE_DISABLED = 'Engine is disabled';
const TIMEOUT_ERROR = 'timeout';

let started = false;
const desiredCache = new Map<number, { at: number; value: Record<string, number> }>();
const reapplyInflight = new Map<number, Promise<void>>();
const seenEngines = new Set<number>();
// Engines whose re-apply waits for a sample that actually lists GPUs (the driver may still be
// loading right after a reboot). Value = why the re-apply was requested.
const pendingReapply = new Map<number, string>();
const reapplyFailureLogged = new Set<number>();

// Freshness of the agent's samples scales with OBLIHUB_AGENT_INTERVAL (2-30 s): a fixed window
// shorter than the interval would flag every sample stale before the next one arrives (GPU section
// "unavailable", power-limit Save refused, GPU-util watchdog readings missing). The multipliers leave
// room for the nvidia-smi collection time the agent adds on top of its sleep; the floors keep the
// default 3 s interval tolerant of one or two late samples.
function agentFreshMs(): number {
  return Math.max(15_000, Math.ceil(2.5 * config.hostAgentIntervalSeconds * 1000));
}

function gpuReadingFreshMs(): number {
  return Math.max(10_000, Math.ceil(2 * config.hostAgentIntervalSeconds * 1000));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function short(text: string, max = 500): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function iso(ms: number | null | undefined): string | null {
  return ms != null && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function bounded<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  return withTimeout(p, ms, label).catch((err: unknown) => {
    logger.debug({ label, err: errMessage(err) }, 'Engine snapshot part unavailable');
    return null;
  });
}

function recentLocalGpus(): LocalGpuQuery | null {
  const q = peekLocalGpus();
  return q && Date.now() - q.at < LOCAL_FALLBACK_MAX_AGE_MS ? q : null;
}

function findGpu(gpus: GpuInfo[], key: string): GpuInfo | null {
  if (key.startsWith('GPU-')) {
    const k = key.toLowerCase();
    return gpus.find((g) => (g.uuid ?? '').toLowerCase() === k) ?? null;
  }
  return gpus.find((g) => g.index === key) ?? null;
}

function desiredKey(gpu: GpuInfo): string {
  return gpu.uuid ?? `idx:${gpu.index}`;
}

/** Same bounds as the legacy route: nvidia-smi accepts silently and fails at apply time otherwise. */
function powerRange(gpu: GpuInfo): { min: number; max: number } | null {
  if (!(gpu.powerLimitMaxWatts > 0)) return null;
  const min = Math.max(1, Math.round(gpu.powerLimitMinWatts));
  const max = Math.max(min + 1, Math.round(gpu.powerLimitMaxWatts));
  return { min, max };
}

function mapFacts(facts: EngineFacts | null, isLocal: boolean, sample: AgentSample | null): EngineHostFacts {
  return {
    hostname: facts?.hostname ?? null,
    // docker info first; the agent and (local engine only) this process see the same host.
    cpuCount: facts?.cpuCount ?? sample?.nproc ?? (isLocal ? os.cpus().length || null : null),
    ramBytes: facts?.memTotalBytes ?? sample?.memTotalBytes ?? (isLocal ? os.totalmem() || null : null),
    os: facts?.os ?? null,
    kernel: facts?.kernel ?? null,
    arch: facts?.arch ?? null,
    dockerVersion: facts?.dockerVersion ?? null,
    containersRunning: facts?.containersRunning ?? null,
    containersTotal: facts?.containersTotal ?? null,
    // The UI's "GPU-capable engine" signal: a CDI-only engine runs GPU containers just as well.
    nvidiaRuntime: !!(facts?.nvidiaRuntime || facts?.cdiNvidia),
    fetchedAt: iso(facts?.fetchedAt),
  };
}

function emptyLive(): EngineHostLive {
  return {
    source: 'none', cpuPercent: null, ramUsedBytes: null, ramPercent: null, loadAvg: null, disk: null,
    cpuModel: null, cpuTemperatureCelsius: null, uptimeSeconds: null, measuredAt: null, stale: false,
  };
}

function liveFromHostStats(snap: HostStats): EngineHostLive {
  return {
    source: 'local-os',
    cpuPercent: snap.cpu.percent,
    ramUsedBytes: snap.ram.total > 0 ? snap.ram.used : null,
    ramPercent: snap.ram.percent,
    loadAvg: snap.loadAvg,
    disk: snap.disk.total > 0 ? { usedBytes: snap.disk.used, totalBytes: snap.disk.total, percent: snap.disk.percent } : null,
    cpuModel: snap.cpu.model,
    cpuTemperatureCelsius: snap.cpu.temperatureCelsius,
    uptimeSeconds: Math.round(os.uptime()),
    measuredAt: snap.measuredAt,
    stale: false,
  };
}

function liveFromAgent(latest: { sample: AgentSample; receivedAt: number; cpuPercent: number | null }): EngineHostLive {
  const s = latest.sample;
  const ramUsed = s.memTotalBytes != null && s.memAvailableBytes != null ? Math.max(0, s.memTotalBytes - s.memAvailableBytes) : null;
  return {
    source: 'agent',
    cpuPercent: latest.cpuPercent,
    ramUsedBytes: ramUsed,
    ramPercent: ramUsed != null && s.memTotalBytes ? (ramUsed / s.memTotalBytes) * 100 : null,
    loadAvg: s.loadAvg,
    disk: s.disk
      ? { usedBytes: s.disk.usedBytes, totalBytes: s.disk.totalBytes, percent: s.disk.totalBytes > 0 ? (s.disk.usedBytes / s.disk.totalBytes) * 100 : null }
      : null,
    cpuModel: s.cpuModel,
    cpuTemperatureCelsius: s.cpuTemperatureCelsius,
    uptimeSeconds: s.uptimeSeconds,
    measuredAt: iso(latest.receivedAt),
    stale: false,
  };
}

/** Without an agent: the sum of the engine's containers (docker stats), which is a floor for host
 *  usage, not host usage. */
function liveFromContainers(engineId: number, facts: EngineFacts | null): EngineHostLive | null {
  const at = getEngineStatsAt(engineId);
  if (at == null || Date.now() - at > AGGREGATE_FRESH_MS) return null;
  let cpuSum = 0;
  let memSum = 0;
  for (const row of getLatestForEngine(engineId)) {
    cpuSum += Number(row.cpuPercent) || 0;
    memSum += Number(row.memoryUsage) || 0;
  }
  const cpuCount = facts?.cpuCount ?? null;
  const memTotal = facts?.memTotalBytes ?? null;
  return {
    ...emptyLive(),
    source: 'containers-aggregate',
    // docker stats reports "% of one core" per container.
    cpuPercent: cpuCount ? Math.min(100, cpuSum / cpuCount) : null,
    ramUsedBytes: memSum,
    ramPercent: memTotal ? Math.min(100, (memSum / memTotal) * 100) : null,
    measuredAt: iso(at),
  };
}

function gpuResult(
  source: GpuStatsSource, status: GpuStatus, message: string | null,
  data: { gpus?: GpuInfo[]; live?: GpuLiveStat[]; at?: number | null } = {},
): Omit<EngineHostGpu, 'desiredPowerLimits'> {
  return {
    source, status, message,
    gpus: data.gpus ?? [],
    live: data.live ?? [],
    powerLimitEditable: status === 'ok',
    measuredAt: iso(data.at ?? null),
  };
}

function buildGpu(
  facts: EngineFacts | null,
  agent: EngineHostAgentInfo,
  latest: { sample: AgentSample; receivedAt: number } | null,
  localQuery: LocalGpuQuery | null,
  isLocal: boolean,
): Omit<EngineHostGpu, 'desiredPowerLimits'> {
  if (localQuery && localQuery.available && localQuery.gpus.length > 0) {
    return gpuResult('local-nvidia-smi', 'ok', localQuery.ok ? null : localQuery.error, { gpus: localQuery.gpus, live: localQuery.live, at: localQuery.at });
  }
  const gpuCapable = !!(facts?.nvidiaRuntime || facts?.cdiNvidia);

  if (latest) {
    const age = Date.now() - latest.receivedAt;
    const g = latest.sample.gpu;
    if (age < agentFreshMs()) {
      if (g.present && g.gpus.length > 0) return gpuResult('agent', 'ok', g.error, { gpus: g.gpus, live: g.live, at: latest.receivedAt });
      if (g.present && g.error) return gpuResult('agent', 'error', short(`nvidia-smi failed on the host: ${g.error}`), { at: latest.receivedAt });
      if (g.present) return gpuResult('agent', 'no-gpu', 'nvidia-smi reports no GPU', { at: latest.receivedAt });
      if (agent.gpuEnabled) {
        return gpuResult('agent', 'unsupported', 'nvidia-smi is not available inside the host agent (the NVIDIA toolkit did not inject it)', { at: latest.receivedAt });
      }
    } else if (g.gpus.length > 0) {
      // Keep the catalog visible, but stale live values would mislead and limits cannot be verified.
      return gpuResult('agent', 'error', `No host agent sample for ${Math.round(age / 1000)} s`, { gpus: g.gpus, at: latest.receivedAt });
    }
  }

  switch (agent.state) {
    case 'creating': return gpuResult('none', 'starting', agent.message ?? 'Starting the host agent…');
    case 'unsupported': return gpuResult('none', 'unsupported', agent.message);
    case 'error': return gpuResult('none', 'error', agent.message);
    default: break;
  }
  if (isLocal && localQuery?.available && !localQuery.ok) {
    return gpuResult('none', 'error', localQuery.error ?? 'nvidia-smi failed inside Oblihub');
  }
  // A missing binary answers instantly (ENOENT); only a present but hung nvidia-smi times out.
  if (isLocal && localQuery == null) return gpuResult('none', 'error', 'nvidia-smi inside Oblihub did not answer in time');
  if (agent.mode === 'off' && gpuCapable) {
    return gpuResult('none', 'disabled', isLocal
      ? 'nvidia-smi does not work inside Oblihub and the Host agent is Off on this engine'
      : 'Host agent is Off on this engine: GPU stats need it');
  }
  if (!gpuCapable) return gpuResult('none', 'no-gpu', null);
  if (agent.state === 'running' && !agent.gpuEnabled) return gpuResult('none', 'unsupported', agent.message);
  return gpuResult('none', 'starting', 'Waiting for the host agent…');
}

async function loadDesired(engineId: number): Promise<Record<string, number>> {
  const cached = desiredCache.get(engineId);
  if (cached && Date.now() - cached.at < DESIRED_TTL_MS) return { ...cached.value };
  const rows = await db('gpu_power_limits').where({ engine_id: engineId }).select('gpu_uuid', 'watts') as Array<{ gpu_uuid: string; watts: number | string }>;
  const value: Record<string, number> = {};
  for (const r of rows) {
    const w = Number(r.watts);
    if (Number.isFinite(w)) value[r.gpu_uuid] = w;
  }
  desiredCache.set(engineId, { at: Date.now(), value });
  return { ...value };
}

function disabledSnapshot(engine: DockerEngine): EngineHostSnapshot {
  return {
    engine: engineService.toSummary(engine),
    reachable: false,
    error: ENGINE_DISABLED,
    facts: mapFacts(null, false, null),
    live: emptyLive(),
    gpu: { ...gpuResult('none', 'disabled', ENGINE_DISABLED), desiredPowerLimits: desiredCache.get(engine.id)?.value ?? {} },
    agent: hostAgentService.getAgent(engine.id, engine),
  };
}

function fallbackSnapshot(engine: DockerEngine, err: unknown): EngineHostSnapshot {
  const timedOut = err instanceof TimeoutError;
  const latest = hostAgentService.getLatestSample(engine.id);
  return {
    engine: engineService.toSummary(engine),
    reachable: false,
    error: timedOut ? TIMEOUT_ERROR : short(errMessage(err)),
    facts: mapFacts(engineFactsService.peek(engine.id), engine.type === 'local', latest?.sample ?? null),
    live: emptyLive(),
    gpu: {
      ...gpuResult('none', 'error', timedOut ? 'Host stats did not answer in time' : short(errMessage(err))),
      desiredPowerLimits: desiredCache.get(engine.id)?.value ?? {},
    },
    agent: hostAgentService.getAgent(engine.id, engine),
  };
}

async function buildSnapshot(engine: DockerEngine): Promise<EngineHostSnapshot> {
  if (!engine.enabled) return disabledSnapshot(engine);
  const id = engine.id;
  const isLocal = engine.type === 'local';

  // Started first so they overlap the (rare) wait for docker info. Without NVIDIA persistence mode
  // one nvidia-smi exec can take seconds: a recent reading beats flapping to "unavailable".
  const localStatsP = isLocal
    ? bounded(hostStatsService.get(), LOCAL_PART_TIMEOUT_MS, 'host stats').then((s) => s ?? hostStatsService.peek(LOCAL_FALLBACK_MAX_AGE_MS))
    : Promise.resolve(null);
  const localGpuP = isLocal
    ? bounded(queryLocalGpus(1500), LOCAL_PART_TIMEOUT_MS, 'local nvidia-smi').then((q) => q ?? recentLocalGpus())
    : Promise.resolve(null);
  const desiredP = engineHostService.desiredLimits(id).catch((err: unknown) => {
    logger.debug({ engineId: id, err: errMessage(err) }, 'Cannot read desired GPU power limits');
    return desiredCache.get(id)?.value ?? {};
  });

  const facts = engineFactsService.peek(id) ?? await engineFactsService.get(id, { allowStale: true, timeoutMs: FACTS_WAIT_MS });
  const agent = hostAgentService.getAgent(id, engine);
  hostAgentService.touch(id);
  // Off wins over a reading left from before the switch (the reconcile that clears it may still be
  // running): live stats, the stale flag, reachability and the GPU card all ignore it.
  const latest = agent.mode === 'off' ? null : hostAgentService.getLatestSample(id);
  const agentAge = latest ? Date.now() - latest.receivedAt : Infinity;
  const freshAgent = agentAge < agentFreshMs();

  const [localStats, localGpu, desired] = await Promise.all([localStatsP, localGpuP, desiredP]);

  let live: EngineHostLive;
  if (localStats) live = liveFromHostStats(localStats);
  else if (latest && freshAgent) live = liveFromAgent(latest);
  else live = liveFromContainers(id, facts) ?? emptyLive();
  // An agent sample exists but stopped arriving (stream stalled, engine slow).
  if (live.source !== 'local-os' && latest && !freshAgent) live.stale = true;

  const gpu: EngineHostGpu = { ...buildGpu(facts, agent, latest, localGpu, isLocal), desiredPowerLimits: desired };

  let error: string | null = facts?.error ?? null;
  if (!error && facts?.fetchedAt != null && Date.now() - facts.fetchedAt > FACTS_STALE_MS) {
    error = `docker info has not answered for ${Math.round((Date.now() - facts.fetchedAt) / 60_000)} min`;
  }
  const reachable = !error || freshAgent;
  return {
    engine: engineService.toSummary(engine),
    reachable,
    error: reachable ? null : error,
    facts: mapFacts(facts, isLocal, latest?.sample ?? null),
    live,
    gpu,
    agent,
  };
}

function snapshotWithTimeout(engine: DockerEngine): Promise<EngineHostSnapshot> {
  return withTimeout(buildSnapshot(engine), SNAPSHOT_TIMEOUT_MS, `host snapshot of ${engine.name}`)
    .catch((err: unknown) => fallbackSnapshot(engine, err));
}

/**
 * Engine errors are raw dockerode/ssh2 text that names the engine's address ("connect ECONNREFUSED
 * 192.0.2.5:2376", "getaddrinfo ENOTFOUND gpu-box.internal"), and that address is admin-only
 * (EngineSummary omits host, the Engines routes are admin-gated). That text reaches `error`, the
 * agent message in 'error' / 'unsupported' / 'running' (the GPU-access failure and the GPU fallback
 * both embed the Docker error) and the GPU message derived from them, so non-admins get a generic
 * line there instead.
 * The facts' hostname (docker info Name) is often that same address (SSH/TLS engines added by their
 * MagicDNS name), and the engine-wide container counts include other users' containers: both are
 * dropped. cpuCount and ramBytes stay, the dashboard computes each stack's share of the host from them.
 */
function redactSnapshot(snapshot: EngineHostSnapshot): EngineHostSnapshot {
  const { error, agent, gpu } = snapshot;
  return {
    ...snapshot,
    error: error == null || error === TIMEOUT_ERROR || error === ENGINE_DISABLED ? error : 'Engine unreachable',
    facts: { ...snapshot.facts, hostname: null, containersRunning: null, containersTotal: null },
    agent: {
      ...agent,
      message: agent.state === 'error' ? 'Host agent unavailable'
        : agent.state === 'unsupported' ? 'Host agent not supported on this engine'
          // A running agent only carries a message when it fell back to no GPU access.
          : agent.state === 'running' && agent.message != null ? 'Running without GPU access'
            : agent.message,
    },
    gpu: {
      ...gpu,
      message: gpu.status === 'error' ? 'GPU stats unavailable'
        : gpu.status === 'unsupported' ? 'GPU stats not supported on this engine'
          : gpu.message,
    },
  };
}

/** The GPUs as the engine reports them right now, and whether nvidia-smi works in-process (local). */
async function currentGpus(engine: DockerEngine): Promise<{ gpus: GpuInfo[]; localAvailable: boolean } | null> {
  if (engine.type === 'local') {
    const q = await queryLocalGpus(1500);
    if (q.available && q.gpus.length > 0) return { gpus: q.gpus, localAvailable: true };
  }
  const latest = hostAgentService.getLatestSample(engine.id);
  if (latest && Date.now() - latest.receivedAt < agentFreshMs() && latest.sample.gpu.gpus.length > 0) {
    return { gpus: latest.sample.gpu.gpus, localAvailable: false };
  }
  return null;
}

/**
 * Applies one limit: in-process nvidia-smi on the local engine when it works there, otherwise a
 * hardened one-shot helper on the engine. Throws AppError (409 refused, 502 failed) carrying the
 * command to run on the host.
 */
async function applyLimit(
  engine: DockerEngine, gpu: GpuInfo, watts: number, localAvailable: boolean,
): Promise<{ via: 'local-nvidia-smi' | 'oneshot-container'; note: string | null }> {
  const id = gpu.uuid ?? gpu.index;
  const hostCommand = `nvidia-smi -i ${id} -pl ${watts}`;
  let note: string | null = null;
  if (engine.type === 'local' && localAvailable) {
    const r = await setLocalPowerLimit(id, watts);
    if (r.ok) return { via: 'local-nvidia-smi', note: null };
    if (!r.permissionDenied && !r.unavailable) {
      throw new AppError(502, `${short(r.error ?? 'nvidia-smi -pl failed')} — run on the host: ${hostCommand}`);
    }
    note = 'nvidia-smi inside Oblihub lacks the permission; applied with a helper container';
  }
  const res = await hostAgentService.runOneShot(engine.id, {
    purpose: 'gpu-power-limit',
    // Absolute path: a PATH-shadowing binary in a mirrored image must never run with SYS_ADMIN.
    cmd: ['/usr/bin/nvidia-smi', '-i', id, '-pl', String(watts)],
    gpu: true,
    capAdd: ['SYS_ADMIN'],
    timeoutMs: 60_000,
  });
  if (res.refused) throw new AppError(409, `${res.error ?? 'Helper container refused'} — run on the host: ${hostCommand}`);
  if (!res.ok) throw new AppError(502, `${short(res.output || res.error || 'nvidia-smi -pl failed')} — run on the host: ${hostCommand}`);
  return { via: 'oneshot-container', note };
}

/** Next agent samples until one shows the target (or the deadline): the value that actually stuck. */
function waitForAgentLimit(engineId: number, gpu: GpuInfo, target: number, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    let observed: number | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(observed);
    };
    const unsubscribe = hostAgentService.onSample((id, sample) => {
      if (id !== engineId) return;
      const g = findGpu(sample.gpu.gpus, gpu.uuid ?? gpu.index);
      if (!g) return;
      observed = g.powerLimitCurrentWatts;
      if (Math.abs(observed - target) <= 1) finish();
    });
    const timer = setTimeout(finish, ms);
    timer.unref();
  });
}

function logReapplyFailure(engineId: number, message: string, context: Record<string, unknown> = {}): void {
  // Once per engine and boot: a refusal (Host agent Off, https-apikey) or a permission problem would
  // otherwise repeat at every reboot detection with nothing new to say.
  if (reapplyFailureLogged.has(engineId)) {
    logger.debug({ engineId, ...context, err: message }, 'GPU power limit re-apply failed');
    return;
  }
  reapplyFailureLogged.add(engineId);
  logger.warn({ engineId, ...context, err: message }, 'GPU power limit re-apply failed');
}

async function doReapply(engineId: number, reason: string): Promise<void> {
  const desired = await loadDesired(engineId);
  if (Object.keys(desired).length === 0) return;
  const engine = await engineService.getById(engineId);
  if (!engine || !engine.enabled) return;
  const readings = await currentGpus(engine);
  if (!readings) {
    logger.debug({ engineId, reason }, 'GPU power limit re-apply skipped: no GPU readings yet');
    return;
  }
  for (const [key, watts] of Object.entries(desired)) {
    const gpu = key.startsWith('idx:')
      ? readings.gpus.find((g) => g.index === key.slice(4)) ?? null
      : readings.gpus.find((g) => g.uuid === key) ?? null;
    if (!gpu) {
      logger.info({ engineId, gpu: key }, 'GPU power limit not re-applied: GPU not present');
      continue;
    }
    if (Math.abs(gpu.powerLimitCurrentWatts - watts) <= 1) continue;
    const range = powerRange(gpu);
    if (!range || watts < range.min || watts > range.max) {
      logger.warn({ engineId, gpu: key, watts, range }, 'GPU power limit not re-applied: outside the GPU range');
      continue;
    }
    try {
      const out = await applyLimit(engine, gpu, watts, readings.localAvailable);
      logger.info({ engineId, gpu: key, watts, via: out.via, reason }, 'Re-applied GPU power limit');
    } catch (err) {
      logReapplyFailure(engineId, errMessage(err), { gpu: key, watts, reason });
    }
  }
}

function reapplyDesired(engineId: number, reason: string): Promise<void> {
  const current = reapplyInflight.get(engineId);
  if (current) return current;
  const run = doReapply(engineId, reason).catch((err: unknown) => logReapplyFailure(engineId, errMessage(err), { reason }));
  reapplyInflight.set(engineId, run);
  run.then(() => { if (reapplyInflight.get(engineId) === run) reapplyInflight.delete(engineId); });
  return run;
}

// Boot time = engine clock minus uptime: it only moves when the host reboots, however long the agent
// was not followed (engine disabled, agent Off / not needed) and whatever the uptimes were.
function bootEpochS(s: AgentSample): number | null {
  return s.uptimeSeconds != null ? s.at / 1000 - s.uptimeSeconds : null;
}

function onAgentSample(engineId: number, sample: AgentSample, prev: AgentSample | null): void {
  const first = !seenEngines.has(engineId);
  seenEngines.add(engineId);
  // The uptime drop alone misses a reboot seen across a gap longer than the old uptime (the new
  // uptime is then larger); the boot-time jump catches it. A forward clock step > 60 s would read
  // as a reboot too, which only re-runs doReapply: idempotent, it skips GPUs already within 1 W.
  const boot = bootEpochS(sample);
  const prevBoot = prev ? bootEpochS(prev) : null;
  const rebooted = (prev != null && sample.uptimeSeconds != null && prev.uptimeSeconds != null
      && sample.uptimeSeconds + REBOOT_UPTIME_SLACK_S < prev.uptimeSeconds)
    || (boot != null && prevBoot != null && boot - prevBoot > REBOOT_UPTIME_SLACK_S);
  if (rebooted) pendingReapply.set(engineId, 'host reboot');
  else if (first) pendingReapply.set(engineId, 'first sample since Oblihub started');
  const reason = pendingReapply.get(engineId);
  if (!reason) return;
  // Right after a reboot the driver may not answer yet: wait for a sample that lists the GPUs.
  if (sample.gpu.gpus.length === 0) return;
  pendingReapply.delete(engineId);
  void reapplyDesired(engineId, reason);
}

export const engineHostService = {
  /** Idempotent: starts the host agents and the reboot re-apply of power limits. */
  ensureStarted(): void {
    if (started) return;
    started = true;
    hostAgentService.start();
    hostAgentService.onSample(onAgentSample);
    // Local engines where nvidia-smi works in-process have no agent samples to trigger the re-apply.
    const t = setTimeout(() => {
      void (async () => {
        try {
          const localId = await engineFactsService.resolveLocalEngineId();
          if (localId != null) await reapplyDesired(localId, 'Oblihub started');
        } catch (err) {
          logger.warn({ err: errMessage(err) }, 'GPU power limit re-apply at boot failed');
        }
      })();
    }, BOOT_REAPPLY_DELAY_MS);
    t.unref();
  },

  /** Enabled engines (or exactly the given ids), in id order, each bounded to ~2 s. */
  async getSnapshots(engineIds?: number[]): Promise<EngineHostSnapshot[]> {
    const all = await engineService.getAll();
    const engines = engineIds ? all.filter((e) => engineIds.includes(e.id)) : all.filter((e) => e.enabled);
    return Promise.all(engines.map((e) => snapshotWithTimeout(e)));
  },

  async getSnapshot(engineId: number): Promise<EngineHostSnapshot | null> {
    const engine = await engineService.getById(engineId);
    return engine ? snapshotWithTimeout(engine) : null;
  },

  /**
   * The snapshot as the viewer may see it: unchanged for admins, engine error text replaced by
   * generic lines and the address-bearing / cross-tenant facts dropped otherwise. Applied where snapshots leave the server, never before internal use
   * (setPowerLimit quotes the raw GPU message to the admin).
   */
  forViewer(snapshot: EngineHostSnapshot, isAdmin: boolean): EngineHostSnapshot {
    return isAdmin ? snapshot : redactSnapshot(snapshot);
  },

  /** Per-GPU utilisation for the GPU-util watchdog signal. null when no recent reading exists. */
  async getGpuReadings(engineId: number): Promise<{ at: number; gpus: Array<{ index: string; uuid: string | null; utilGpu: number; utilMem: number }> } | null> {
    const toReading = (live: GpuLiveStat[]) => live.map((g) => ({
      index: g.index, uuid: g.uuid ?? null, utilGpu: g.utilizationGpuPercent, utilMem: g.utilizationMemoryPercent,
    }));
    const type = await engineFactsService.engineType(engineId);
    if (type == null) return null;
    if (type === 'local') {
      const q = await queryLocalGpus(1500);
      if (q.available && q.live.length > 0) return { at: q.at, gpus: toReading(q.live) };
    }
    const latest = hostAgentService.getLatestSample(engineId);
    if (latest && Date.now() - latest.receivedAt < gpuReadingFreshMs() && latest.sample.gpu.live.length > 0) {
      return { at: latest.receivedAt, gpus: toReading(latest.sample.gpu.live) };
    }
    return null;
  },

  /**
   * Host-wide power limit of one GPU of one engine (admin). `watts` null = back to the default limit
   * and forget the stored value. Persisted only after a successful apply.
   */
  async setPowerLimit(engineId: number, gpuKey: string, watts: number | null, userId: number | null): Promise<GpuPowerLimitResult> {
    const key = String(gpuKey ?? '').trim();
    if (!GPU_KEY_RE.test(key)) throw new AppError(400, 'GPU must be an index (0-999) or a uuid (GPU-…)');
    if (watts !== null && (typeof watts !== 'number' || !Number.isFinite(watts) || watts <= 0)) {
      throw new AppError(400, 'watts must be a positive number, or null to reset to the default');
    }
    const engine = await engineService.getById(engineId);
    if (!engine) throw new AppError(404, 'Engine not found');
    if (!engine.enabled) throw new AppError(409, `Engine "${engine.name}" is disabled`);

    const snapshot = await engineHostService.getSnapshot(engineId);
    if (!snapshot) throw new AppError(404, 'Engine not found');
    if (snapshot.gpu.status !== 'ok') {
      throw new AppError(409, `GPU stats unavailable on ${engine.name}: ${snapshot.gpu.message ?? snapshot.gpu.status}`);
    }
    const gpu = findGpu(snapshot.gpu.gpus, key);
    if (!gpu) throw new AppError(404, `GPU ${key} not found on ${engine.name}`);

    const range = powerRange(gpu);
    if (!range) throw new AppError(409, `GPU ${gpu.index} on ${engine.name} does not report an adjustable power limit`);
    const requested = watts == null ? null : Math.round(watts);
    if (requested != null && (requested < range.min || requested > range.max)) {
      throw new AppError(400, `watts must be within ${range.min}–${range.max} for GPU ${gpu.index}`);
    }
    const fallbackTarget = gpu.powerLimitDefaultWatts != null && gpu.powerLimitDefaultWatts > 0 ? gpu.powerLimitDefaultWatts : gpu.powerLimitMaxWatts;
    const target = requested ?? Math.round(fallbackTarget);
    const localAvailable = engine.type === 'local' && snapshot.gpu.source === 'local-nvidia-smi';

    const applied = await applyLimit(engine, gpu, target, localAvailable);
    const messages: string[] = [];
    if (applied.note) messages.push(applied.note);

    let persisted = false;
    const rowKey = desiredKey(gpu);
    try {
      if (requested != null) {
        await db('gpu_power_limits')
          .insert({ engine_id: engineId, gpu_uuid: rowKey, gpu_index: gpu.index, watts: requested, updated_by_user_id: userId, updated_at: new Date() })
          .onConflict(['engine_id', 'gpu_uuid'])
          .merge(['gpu_index', 'watts', 'updated_by_user_id', 'updated_at']);
        persisted = true;
      } else {
        await db('gpu_power_limits').where({ engine_id: engineId }).whereIn('gpu_uuid', [rowKey, `idx:${gpu.index}`]).delete();
        messages.push('Reset to the default limit; Oblihub no longer re-applies a limit on this GPU.');
      }
    } catch (err) {
      logger.warn({ engineId, gpu: rowKey, err: errMessage(err) }, 'Cannot store the GPU power limit');
      messages.push(requested != null
        ? 'Applied, but not saved: it will not be re-applied after a host reboot.'
        : 'Reset applied, but the stored limit could not be removed.');
    } finally {
      desiredCache.delete(engineId);
    }

    let appliedWatts: number | null = null;
    if (applied.via === 'local-nvidia-smi' || localAvailable) {
      const q = await queryLocalGpus(0);
      appliedWatts = findGpu(q.gpus, gpu.uuid ?? gpu.index)?.powerLimitCurrentWatts ?? null;
    } else {
      appliedWatts = await waitForAgentLimit(engineId, gpu, target, APPLIED_WAIT_MS);
      if (appliedWatts == null) messages.push('Applied; the new value shows with the next host agent sample.');
    }
    if (appliedWatts != null && Math.abs(appliedWatts - target) > 1) {
      messages.push(`The driver reports ${appliedWatts} W.`);
    }
    logger.info({ engineId, gpu: rowKey, watts: requested, target, via: applied.via, userId }, 'GPU power limit set');

    return {
      engineId,
      index: gpu.index,
      gpuUuid: gpu.uuid ?? null,
      requestedWatts: requested,
      appliedWatts,
      via: applied.via,
      persisted,
      message: messages.length > 0 ? messages.join(' ') : null,
    };
  },

  retryAgent(engineId: number): Promise<EngineHostAgentInfo> {
    return hostAgentService.retry(engineId);
  },

  /** Stored limits keyed by GPU uuid (or 'idx:<n>'), cached 30 s. */
  desiredLimits(engineId: number): Promise<Record<string, number>> {
    return loadDesired(engineId);
  },
};
