import type Docker from 'dockerode';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { DockerEngine, EngineHostAgentInfo, HostAgentMode, HostAgentState } from '@oblihub/shared';
import { config } from '../config';
import { logger } from '../utils/logger';
import { withTimeout, TimeoutError } from '../utils/withTimeout';
import {
  HOST_AGENT_NAME, ONESHOT_NAME_PREFIX, OBLIHUB_INTERNAL_LABEL, OBLIHUB_ROLE_LABEL, containerNameOf, hasComposeProject, labelsOf,
} from '../utils/oblihubContainers';
import { AGENT_VERSION, NVIDIA_QUERY, buildAgentScript, parseAgentSample, type AgentSample } from '../utils/hostAgentProtocol';
import { dockerService } from './docker.service';
import { engineService } from './engine.service';
import { engineFactsService, type EngineFacts } from './engineFacts.service';
import { queryLocalGpus } from './gpuDetection.service';

/**
 * Host agent: one small labelled container per engine (`oblihub-host-agent`) that prints host
 * CPU/RAM/disk/temperature and nvidia-smi samples to its TTY; Oblihub reads them through ONE
 * `logs --follow` stream per engine. Also runs short-lived hardened one-shot helpers
 * (`oblihub-oneshot-*`: GPU power limits, MPS probe).
 *
 * Why a container: a remote engine is only reachable through the Docker API, and inside
 * oblihub-server nvidia-smi is often unusable. Why logs instead of exec: over SSH every API call is
 * a new handshake, and an exec per poll would cost two or three of them.
 *
 * Mode per engine (docker_engines.host_agent_mode): `auto` = only GPU-capable engines (and the
 * local one only when nvidia-smi does not work in-process), `always` = every engine, `off` = Oblihub
 * creates NO container there at all (neither the agent nor one-shots). Identity is the name AND the
 * labels AND no compose project: a container that only has the name, or a compose container that
 * copies name and labels, is never touched.
 */

export interface OneShotSpec {
  purpose: 'gpu-power-limit' | 'mps-probe';
  cmd: string[];
  gpu: boolean;
  driverCapabilities?: string;
  capAdd?: string[];
  mounts?: Array<{ Type: 'bind'; Source: string; Target: string; ReadOnly?: boolean }>;
  env?: string[];
  timeoutMs?: number;
}

export interface OneShotResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
  error: string | null;
  unsupported?: boolean;
  mountMissing?: boolean;
  refused?: boolean;
}

export type AgentGpuMode = 'runtime' | 'cdi' | 'device-request' | 'none';

/** `prev` = the sample received just before this one from the engine's agent, even across a window
 *  where the agent was not followed (engine disabled, agent Off or not needed): the reboot re-apply
 *  of GPU power limits compares against it. null only for the engine's first sample since boot. */
type SampleListener = (engineId: number, sample: AgentSample, prev: AgentSample | null) => void;
type FollowStream = NodeJS.ReadableStream & { destroy?: (err?: Error) => void };

const ROLE_AGENT = 'host-agent';
const ROLE_ONESHOT = 'oneshot';
const AGENT_VERSION_LABEL = 'oblihub.agent.version';
const AGENT_GPU_LABEL = 'oblihub.agent.gpu';
// Not in the original label set: without them a changed OBLIHUB_AGENT_IMAGE / OBLIHUB_AGENT_INTERVAL
// would never reach an agent that already exists.
const AGENT_IMAGE_LABEL = 'oblihub.agent.image';
const AGENT_INTERVAL_LABEL = 'oblihub.agent.interval';
const ONESHOT_PURPOSE_LABEL = 'oblihub.oneshot.purpose';

const MiB = 1024 * 1024;
const RECONCILE_INTERVAL_MS = 60_000;
const FACTS_TIMEOUT_MS = 10_000;
const DOCKER_CALL_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 600_000;
const ERROR_BACKOFF_MIN_MS = 60_000;
const ERROR_BACKOFF_MAX_MS = 30 * 60_000;
const UNSUPPORTED_BACKOFF_MS = 30 * 60_000;
const GPU_FALLBACK_MS = 30 * 60_000;
const FOLLOW_BACKOFF_MIN_MS = 2_000;
const FOLLOW_BACKOFF_MAX_MS = 60_000;
const ONESHOT_LEFTOVER_AGE_MS = 5 * 60_000;
const SWEEP_EVERY_MS = 10 * 60_000;
const TEARDOWN_SUPPRESS_MS = 2 * 60_000;
const TOUCH_DEBOUNCE_MS = 500;
const RECONCILE_NOW_WAIT_MS = 15_000;
// A few sample blocks: enough for an immediate sample after (re)attaching. `since: now - 10 s`
// would depend on the hub and the engine agreeing on the time; with the engine's clock behind, every
// reattach would skip samples until its clock caught up.
const LOG_TAIL_LINES = 60;
const MAX_BLOCK_LINES = 400;
const MAX_PARTIAL_LINE = 64 * 1024;
const NO_SAMPLE_STREAMS_BEFORE_ERROR = 3;
const SEEN_SAMPLES_KEPT = 16;
const MESSAGE_MAX = 500;

const AGENT_OFF_MESSAGE = 'Host agent is Off for this engine';
const FORBIDDEN_MESSAGE = "The engine's API proxy refuses container creation (needs CONTAINERS=1, POST=1, IMAGES=1)";
const FOREIGN_AGENT_MESSAGE = 'A container named oblihub-host-agent exists but is not managed by Oblihub';
const ONESHOT_OFF_MESSAGE = 'Host agent is Off on this engine — Oblihub creates no helper containers there. Set it to Auto or Always, or run the command on the host.';
const ONESHOT_HTTPS_MESSAGE = 'Privileged helper containers are disabled on this https-apikey engine (plain HTTP). Set its Host agent to Always to allow them, or run the command on the host.';
const NO_GPU_MESSAGE = 'No NVIDIA runtime or CDI GPU device on this engine (docker info)';
const GPU_ERROR_RE = /nvidia|device driver|runtime|cdi/i;
const MOUNT_MISSING_RE = /bind source path does not exist|invalid mount config/i;

interface EngineAgentState {
  mode: HostAgentMode;
  state: HostAgentState;
  message: string | null;
  gpuMode: AgentGpuMode;
  containerId: string | null;
  stream: FollowStream | null;
  streamStartedAt: number;
  streamsWithoutSample: number;
  lastSample: AgentSample | null;
  prevSample: AgentSample | null;
  /** Reboot baseline for the sample listeners. Unlike `lastSample` (what is displayed), clearSamples
   *  keeps it: a host rebooted while the engine was disabled or its agent was not wanted must still be
   *  seen as rebooted when samples resume, or its GPU power limits are never re-applied. */
  lastReceivedSample: AgentSample | null;
  seenSampleAts: number[];
  cpuPercent: number | null;
  lastSampleAt: number | null;
  backoffUntil: number;
  backoffMs: number;
  followBackoffMs: number;
  inflight: Promise<void> | null;
  retryTimer: NodeJS.Timeout | null;
  /** `always` mode: the agent could not get GPU access in this mode; run it without GPU for a while
   *  instead of recreating it every minute. */
  gpuFallback: { mode: AgentGpuMode; message: string; until: number } | null;
  cleanupDone: boolean;
  cleanupRetryAt: number;
  lastSweepAt: number;
}

/** Errors while pulling the agent image: never mistaken for a GPU failure (the image name may
 *  contain "nvidia"). */
class PullError extends Error {
  constructor(message: string, public statusCode: number | null) {
    super(message);
    this.name = 'PullError';
  }
}

const states = new Map<number, EngineAgentState>();
const listeners = new Set<SampleListener>();
const pullInflight = new Map<string, Promise<void>>();
const touchTimers = new Map<number, NodeJS.Timeout>();
// Engines being deleted: the periodic reconcile must not recreate the agent that teardown removed.
const suppressedUntil = new Map<number, number>();
let loopTimer: NodeJS.Timeout | null = null;
let started = false;
let stopped = false;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function short(text: string): string {
  const t = text.trim();
  return t.length > MESSAGE_MAX ? t.slice(0, MESSAGE_MAX) + '…' : t;
}

function statusCodeOf(err: unknown): number | null {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === 'number' ? code : null;
}

function stallMs(): number {
  return Math.max(45_000, config.hostAgentIntervalSeconds * 1000 * 5);
}

function newState(mode: HostAgentMode): EngineAgentState {
  return {
    mode, state: 'not-needed', message: 'Checking…', gpuMode: 'none', containerId: null, stream: null,
    streamStartedAt: 0, streamsWithoutSample: 0, lastSample: null, prevSample: null, lastReceivedSample: null, seenSampleAts: [],
    cpuPercent: null, lastSampleAt: null, backoffUntil: 0, backoffMs: 0, followBackoffMs: FOLLOW_BACKOFF_MIN_MS,
    inflight: null, retryTimer: null, gpuFallback: null, cleanupDone: false, cleanupRetryAt: 0, lastSweepAt: 0,
  };
}

function ensureState(engineId: number, mode?: HostAgentMode): EngineAgentState {
  let st = states.get(engineId);
  if (!st) {
    st = newState(mode ?? 'auto');
    states.set(engineId, st);
  }
  if (mode) st.mode = mode;
  return st;
}

function setState(st: EngineAgentState, state: HostAgentState, message: string | null): void {
  st.state = state;
  st.message = message;
}

function backoffError(st: EngineAgentState, message: string): void {
  st.backoffMs = st.backoffMs ? Math.min(ERROR_BACKOFF_MAX_MS, st.backoffMs * 2) : ERROR_BACKOFF_MIN_MS;
  st.backoffUntil = Date.now() + st.backoffMs;
  setState(st, 'error', short(message));
}

function markUnsupported(st: EngineAgentState, message: string): void {
  st.backoffUntil = Date.now() + UNSUPPORTED_BACKOFF_MS;
  setState(st, 'unsupported', short(message));
}

function destroyQuietly(stream: FollowStream | null | undefined): void {
  if (!stream) return;
  // A destroyed stream may still emit 'error'; without a listener that would crash the process.
  stream.on('error', () => { /* ignored: the stream is being discarded */ });
  try { stream.destroy?.(); } catch { /* already closed */ }
}

function dropStream(st: EngineAgentState): void {
  const s = st.stream;
  st.stream = null;
  destroyQuietly(s);
}

function clearRetryTimer(st: EngineAgentState): void {
  if (st.retryTimer) clearTimeout(st.retryTimer);
  st.retryTimer = null;
}

/**
 * The agent is no longer wanted here (Off, not needed, engine disabled): no sample will ever follow,
 * so the last one would be served forever and flag the host as stale with "No host agent sample for
 * N s". `seenSampleAts` is kept on purpose: when an agent that still exists is followed again, `tail`
 * replays blocks already seen, and those must not come back as a fresh reading. `lastReceivedSample`
 * is kept too: it is the reboot baseline, not a displayed reading.
 */
function clearSamples(st: EngineAgentState): void {
  st.lastSample = null;
  st.prevSample = null;
  st.lastSampleAt = null;
  st.cpuPercent = null;
}

function forgetEngine(engineId: number): void {
  const st = states.get(engineId);
  if (st) {
    clearRetryTimer(st);
    dropStream(st);
    states.delete(engineId);
  }
  const t = touchTimers.get(engineId);
  if (t) clearTimeout(t);
  touchTimers.delete(engineId);
}

function streamIsHealthy(st: EngineAgentState): boolean {
  if (!st.stream) return false;
  return Date.now() - (st.lastSampleAt ?? st.streamStartedAt) < stallMs();
}

function gpuEnv(mode: AgentGpuMode, capabilities: string): string[] {
  if (mode === 'none') return [];
  const env = [`NVIDIA_DRIVER_CAPABILITIES=${capabilities}`];
  if (mode === 'runtime') env.unshift('NVIDIA_VISIBLE_DEVICES=all');
  return env;
}

function gpuHostConfig(mode: AgentGpuMode): Docker.HostConfig {
  switch (mode) {
    case 'runtime': return { Runtime: 'nvidia' };
    case 'cdi': return { DeviceRequests: [{ Driver: 'cdi', DeviceIDs: ['nvidia.com/gpu=all'] }] };
    case 'device-request': return { DeviceRequests: [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }] };
    default: return {};
  }
}

/** GPU access for a container on this engine: the nvidia runtime, else CDI, else (only when the
 *  admin chose `always`) Docker's own nvidia device driver as a last attempt. */
function gpuModeFor(mode: HostAgentMode, facts: Pick<EngineFacts, 'nvidiaRuntime' | 'cdiNvidia'>): AgentGpuMode {
  if (facts.nvidiaRuntime) return 'runtime';
  if (facts.cdiNvidia) return 'cdi';
  return mode === 'always' ? 'device-request' : 'none';
}

/** Whether the engine wants an agent, and with which GPU access. Pure (exported for checks). */
export function desiredAgent(
  engine: Pick<DockerEngine, 'type' | 'hostAgentMode'>,
  facts: Pick<EngineFacts, 'nvidiaRuntime' | 'cdiNvidia'>,
  localGpuAvailable: boolean,
): { want: boolean; gpuMode: AgentGpuMode; reason: string | null } {
  const mode = engine.hostAgentMode ?? 'auto';
  if (mode === 'off') return { want: false, gpuMode: 'none', reason: AGENT_OFF_MESSAGE };
  const gpuMode = gpuModeFor(mode, facts);
  if (mode === 'always') return { want: true, gpuMode, reason: null };
  if (!facts.nvidiaRuntime && !facts.cdiNvidia) return { want: false, gpuMode: 'none', reason: NO_GPU_MESSAGE };
  if (engine.type === 'local' && localGpuAvailable) {
    return { want: false, gpuMode: 'none', reason: 'nvidia-smi works inside Oblihub: the local engine needs no agent' };
  }
  return { want: true, gpuMode, reason: null };
}

function agentLabels(gpuMode: AgentGpuMode): Record<string, string> {
  return {
    [OBLIHUB_INTERNAL_LABEL]: 'true',
    [OBLIHUB_ROLE_LABEL]: ROLE_AGENT,
    [AGENT_VERSION_LABEL]: AGENT_VERSION,
    [AGENT_GPU_LABEL]: gpuMode,
    [AGENT_IMAGE_LABEL]: config.hostAgentImage,
    [AGENT_INTERVAL_LABEL]: String(config.hostAgentIntervalSeconds),
  };
}

/** The agent is created through dockerode, never by compose: a compose container carrying the
 *  agent's name and labels was made by a tenant and is not ours to adopt, follow or remove. */
function isOurAgent(labels: Record<string, string>): boolean {
  return labels[OBLIHUB_INTERNAL_LABEL] === 'true' && labels[OBLIHUB_ROLE_LABEL] === ROLE_AGENT && !hasComposeProject(labels);
}

function agentLabelsMatch(labels: Record<string, string>, gpuMode: AgentGpuMode): boolean {
  const want = agentLabels(gpuMode);
  return [AGENT_VERSION_LABEL, AGENT_GPU_LABEL, AGENT_IMAGE_LABEL, AGENT_INTERVAL_LABEL]
    .every((k) => labels[k] === want[k]);
}

function agentCreateOptions(gpuMode: AgentGpuMode): Docker.ContainerCreateOptions {
  return {
    name: HOST_AGENT_NAME,
    Image: config.hostAgentImage,
    // The image's ENTRYPOINT would receive the script as arguments (and could swallow or wrap it):
    // the agent must behave the same whatever OBLIHUB_AGENT_IMAGE points at.
    Entrypoint: ['/bin/sh', '-c'],
    Cmd: [buildAgentScript(NVIDIA_QUERY)],
    // Raw log lines (no stdout/stderr multiplexing headers) are what the follower parses.
    Tty: true,
    Env: [`OBLIHUB_AGENT_INTERVAL=${config.hostAgentIntervalSeconds}`, ...gpuEnv(gpuMode, 'utility')],
    Labels: agentLabels(gpuMode),
    // No ReadonlyRootfs: the NVIDIA toolkit's ldconfig hook writes into the rootfs when it injects
    // the driver libraries, and the container would fail to start.
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: 64 * MiB,
      NanoCpus: 2e8,
      PidsLimit: 64,
      // Explicit: the follower needs a driver `docker logs` can read, and the log must stay small.
      LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      ...gpuHostConfig(gpuMode),
    },
  };
}

/** pullImage re-joins name and tag with ':', so splitting at the last ':' after the last '/'
 *  round-trips tags (`ubuntu:24.04`) and digests (`ubuntu@sha256:…`) alike. */
function splitImageRef(ref: string): { name: string; tag: string } {
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > slash) return { name: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { name: ref, tag: 'latest' };
}

async function ensureImage(docker: Docker, engineId: number): Promise<void> {
  const image = config.hostAgentImage;
  try {
    await withTimeout(docker.getImage(image).inspect(), DOCKER_CALL_TIMEOUT_MS, 'image inspect');
    return;
  } catch (err) {
    if (statusCodeOf(err) !== 404) throw err;
  }
  const key = `${engineId}|${image}`;
  let pull = pullInflight.get(key);
  if (!pull) {
    const { name, tag } = splitImageRef(image);
    logger.info({ engineId, image }, 'Pulling the host agent image');
    const p = withTimeout(dockerService.pullImage(name, tag, engineId), PULL_TIMEOUT_MS, `pull ${image}`);
    pull = p;
    pullInflight.set(key, p);
    const clear = () => { if (pullInflight.get(key) === p) pullInflight.delete(key); };
    p.then(clear, clear);
  }
  try {
    await pull;
  } catch (err) {
    throw new PullError(
      `Cannot pull ${image} on this engine: ${short(errMessage(err))}. Pre-pull it on the host or set OBLIHUB_AGENT_IMAGE.`,
      statusCodeOf(err),
    );
  }
}

async function findAgentContainer(docker: Docker): Promise<Docker.ContainerInfo | null> {
  const list = await withTimeout(
    docker.listContainers({ all: true, filters: { name: [HOST_AGENT_NAME] } }),
    DOCKER_CALL_TIMEOUT_MS, 'list host agent',
  );
  // The name filter is a substring match: only the exact reserved name counts.
  return list.find((c) => containerNameOf(c) === HOST_AGENT_NAME) ?? null;
}

async function removeContainer(docker: Docker, id: string): Promise<void> {
  await withTimeout(docker.getContainer(id).remove({ force: true }), DOCKER_CALL_TIMEOUT_MS, 'remove container');
}

async function removeOurAgent(docker: Docker): Promise<boolean> {
  const existing = await findAgentContainer(docker);
  if (!existing || !isOurAgent(labelsOf(existing))) return false;
  await removeContainer(docker, existing.Id);
  return true;
}

/** One-shot helpers left behind by a crash (label AND name prefix). */
async function removeOneshotLeftovers(
  docker: Docker,
  opts: { olderThanMs: number; includeRunning: boolean },
): Promise<{ removed: number; errors: string[] }> {
  const list = await withTimeout(
    docker.listContainers({ all: true, filters: { label: [`${OBLIHUB_INTERNAL_LABEL}=true`, `${OBLIHUB_ROLE_LABEL}=${ROLE_ONESHOT}`] } }),
    DOCKER_CALL_TIMEOUT_MS, 'list one-shot helpers',
  );
  const cutoff = Date.now() - opts.olderThanMs;
  let removed = 0;
  const errors: string[] = [];
  for (const c of list) {
    const name = containerNameOf(c);
    const labels = labelsOf(c);
    // A compose one-shot lookalike belongs to a tenant: the sweep never removes it.
    if (!name.startsWith(ONESHOT_NAME_PREFIX) || labels[OBLIHUB_ROLE_LABEL] !== ROLE_ONESHOT || hasComposeProject(labels)) continue;
    if (!opts.includeRunning && c.State === 'running') continue;
    if (typeof c.Created === 'number' && c.Created * 1000 > cutoff) continue;
    try {
      await removeContainer(docker, c.Id);
      removed++;
    } catch (err) {
      errors.push(`${name}: ${short(errMessage(err))}`);
    }
  }
  return { removed, errors };
}

async function maybeSweepOneshots(engineId: number, st: EngineAgentState, docker: Docker | null): Promise<void> {
  if (Date.now() - st.lastSweepAt < SWEEP_EVERY_MS) return;
  st.lastSweepAt = Date.now();
  try {
    const client = docker ?? await dockerService.forEngine(engineId);
    const { removed, errors } = await removeOneshotLeftovers(client, { olderThanMs: ONESHOT_LEFTOVER_AGE_MS, includeRunning: false });
    if (removed > 0) logger.info({ engineId, removed }, 'Removed leftover one-shot helper containers');
    if (errors.length > 0) logger.warn({ engineId, errors }, 'Could not remove some one-shot helper containers');
  } catch (err) {
    logger.debug({ engineId, err: errMessage(err) }, 'One-shot leftover sweep failed');
  }
}

/** Agent no longer wanted: remove ours (never a foreign container) once per transition. */
async function cleanupUnwanted(engineId: number, st: EngineAgentState): Promise<void> {
  if (st.cleanupDone || Date.now() < st.cleanupRetryAt) return;
  try {
    const docker = await dockerService.forEngine(engineId);
    if (await removeOurAgent(docker)) logger.info({ engineId }, 'Removed the host agent (no longer needed on this engine)');
    await removeOneshotLeftovers(docker, { olderThanMs: ONESHOT_LEFTOVER_AGE_MS, includeRunning: false });
    st.cleanupDone = true;
  } catch (err) {
    st.cleanupRetryAt = Date.now() + SWEEP_EVERY_MS;
    logger.debug({ engineId, err: errMessage(err) }, 'Host agent cleanup failed');
  }
}

function cpuPercentBetween(prev: AgentSample | null, cur: AgentSample): number | null {
  if (!prev) return null;
  const dTotal = cur.cpuTotal - prev.cpuTotal;
  const dIdle = cur.cpuIdle - prev.cpuIdle;
  // Counters restart at a host reboot: a negative delta is not a measurement.
  if (!(dTotal > 0) || dIdle < 0) return null;
  return Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
}

function notifyListeners(engineId: number, sample: AgentSample, prev: AgentSample | null): void {
  for (const listener of listeners) {
    try {
      const result: unknown = listener(engineId, sample, prev);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        (result as Promise<unknown>).then(undefined, (err: unknown) => {
          logger.warn({ engineId, err: errMessage(err) }, 'Host agent sample listener failed');
        });
      }
    } catch (err) {
      logger.warn({ engineId, err: errMessage(err) }, 'Host agent sample listener failed');
    }
  }
}

function handleSample(engineId: number, st: EngineAgentState, sample: AgentSample): void {
  // `tail` replays the last blocks after every (re)attach.
  if (st.seenSampleAts.includes(sample.at)) return;
  st.seenSampleAts.push(sample.at);
  if (st.seenSampleAts.length > SEEN_SAMPLES_KEPT) st.seenSampleAts.shift();

  const prev = st.lastSample;
  const received = st.lastReceivedSample;
  st.lastReceivedSample = sample;
  st.prevSample = prev;
  st.lastSample = sample;
  // Only against the displayed sample: after a gap, a delta over hours is not a current CPU reading.
  st.cpuPercent = cpuPercentBetween(prev, sample);
  st.lastSampleAt = Date.now();
  setState(st, 'running', st.gpuFallback ? short(`Running without GPU access: ${st.gpuFallback.message}`) : null);
  st.backoffMs = 0;
  st.backoffUntil = 0;
  st.followBackoffMs = FOLLOW_BACKOFF_MIN_MS;
  st.streamsWithoutSample = 0;
  notifyListeners(engineId, sample, received);
}

function scheduleFollowRetry(engineId: number, st: EngineAgentState, reason: string): void {
  if (stopped || st.retryTimer || states.get(engineId) !== st) return;
  if (st.streamsWithoutSample >= NO_SAMPLE_STREAMS_BEFORE_ERROR) {
    setState(st, 'error', short(`The host agent produced no sample. ${config.hostAgentImage} must be a glibc image with /bin/sh; `
      + 'check `docker logs oblihub-host-agent` on the engine host.'));
  }
  const delay = st.followBackoffMs;
  st.followBackoffMs = Math.min(FOLLOW_BACKOFF_MAX_MS, st.followBackoffMs * 2);
  logger.debug({ engineId, reason, delay }, 'Host agent log stream ended; reattaching');
  st.retryTimer = setTimeout(() => {
    st.retryTimer = null;
    void reconcileById(engineId);
  }, delay);
  st.retryTimer.unref();
}

async function follow(engineId: number, st: EngineAgentState, container: Docker.Container, containerId: string): Promise<void> {
  dropStream(st);
  if (stopped) return;
  const pending = container.logs({ follow: true, stdout: true, stderr: true, tail: LOG_TAIL_LINES });
  let stream: FollowStream;
  try {
    stream = await withTimeout(pending, DOCKER_CALL_TIMEOUT_MS, 'host agent logs') as FollowStream;
  } catch (err) {
    // A stream that shows up after the timeout would otherwise stay open forever.
    pending.then((late) => destroyQuietly(late as FollowStream), () => { /* nothing to close */ });
    throw err;
  }
  if (stopped || states.get(engineId) !== st) {
    destroyQuietly(stream);
    return;
  }
  st.stream = stream;
  st.containerId = containerId;
  st.streamStartedAt = Date.now();

  const decoder = new StringDecoder('utf8');
  let partial = '';
  let block: string[] | null = null;
  let gotSample = false;

  const onLine = (raw: string) => {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('@@BEGIN')) {
      block = [line];
      return;
    }
    if (!block) return;
    block.push(line);
    if (line.trim() === '@@END') {
      const sample = parseAgentSample(block);
      block = null;
      if (sample) {
        gotSample = true;
        handleSample(engineId, st, sample);
      }
    } else if (block.length > MAX_BLOCK_LINES) {
      block = null;
    }
  };

  stream.on('data', (chunk: Buffer | string) => {
    if (st.stream !== stream) return;
    partial += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    if (partial.length > MAX_PARTIAL_LINE) partial = '';
    for (const line of lines) onLine(line);
  });
  let ended = false;
  const onEnd = (reason: string) => {
    if (ended) return;
    ended = true;
    if (st.stream !== stream) return;
    st.stream = null;
    destroyQuietly(stream);
    if (!gotSample) st.streamsWithoutSample++;
    scheduleFollowRetry(engineId, st, reason);
  };
  stream.on('end', () => onEnd('end'));
  stream.on('close', () => onEnd('close'));
  stream.on('error', (err: unknown) => onEnd(errMessage(err)));
}

/** Makes the agent container exist, run and be followed. Throws Docker errors to the caller. */
async function ensureAgentRunning(engineId: number, st: EngineAgentState, docker: Docker, gpuMode: AgentGpuMode): Promise<void> {
  const existing = await findAgentContainer(docker);
  let containerId: string | null = null;
  if (existing) {
    if (!isOurAgent(labelsOf(existing))) {
      // Someone else's container under the agent's name (nothing stops a tenant from using it,
      // labels included): report it, never adopt, follow or touch it.
      dropStream(st);
      backoffError(st, FOREIGN_AGENT_MESSAGE);
      return;
    }
    if (existing.State === 'dead') {
      // A dead container cannot be started again, only replaced.
      await removeContainer(docker, existing.Id);
    } else if (agentLabelsMatch(labelsOf(existing), gpuMode)) {
      containerId = existing.Id;
      const c = docker.getContainer(existing.Id);
      // Host agent = Off is the switch for "no agent here": a stopped agent is started again.
      if (existing.State === 'paused') {
        await withTimeout(c.unpause(), DOCKER_CALL_TIMEOUT_MS, 'unpause host agent');
      } else if (existing.State !== 'running' && existing.State !== 'restarting') {
        await withTimeout(c.start(), DOCKER_CALL_TIMEOUT_MS, 'start host agent');
      }
    } else {
      logger.info({ engineId, labels: labelsOf(existing) }, 'Recreating the host agent (version, GPU mode, image or interval changed)');
      await removeContainer(docker, existing.Id);
    }
  }
  if (!containerId) {
    setState(st, 'creating', 'Creating the host agent…');
    await ensureImage(docker, engineId);
    const created = await withTimeout(docker.createContainer(agentCreateOptions(gpuMode)), DOCKER_CALL_TIMEOUT_MS, 'create host agent');
    containerId = created.id;
    await withTimeout(created.start(), DOCKER_CALL_TIMEOUT_MS, 'start host agent');
    logger.info({ engineId, gpuMode, image: config.hostAgentImage }, 'Host agent started');
  }
  st.gpuMode = gpuMode;
  if (st.state !== 'running') {
    if (st.streamsWithoutSample < NO_SAMPLE_STREAMS_BEFORE_ERROR) setState(st, 'creating', 'Waiting for the first sample…');
  }
  await follow(engineId, st, docker.getContainer(containerId), containerId);
}

async function doReconcile(engine: DockerEngine, st: EngineAgentState): Promise<void> {
  const engineId = engine.id;
  const mode = engine.hostAgentMode ?? 'auto';
  if (!engine.enabled) {
    // No Docker call: the client of a disabled engine is unavailable.
    dropStream(st);
    clearSamples(st);
    setState(st, 'disabled', 'Engine is disabled');
    return;
  }
  // Every local-type row talks to the same daemon and would fight over one container name.
  if (engine.type === 'local') {
    const primary = await engineFactsService.resolveLocalEngineId();
    if (primary != null && primary !== engineId) {
      dropStream(st);
      clearSamples(st);
      setState(st, 'not-needed', 'Same Docker daemon as the primary local engine');
      return;
    }
  }

  const facts = await engineFactsService.get(engineId, { timeoutMs: FACTS_TIMEOUT_MS });
  if (!facts) {
    forgetEngine(engineId);
    return;
  }
  if (facts.fetchedAt == null) {
    if (streamIsHealthy(st)) return;
    dropStream(st);
    backoffError(st, `Engine unreachable: ${facts.error ?? 'no docker info yet'}`);
    return;
  }

  let localGpuAvailable = false;
  if (engine.type === 'local' && mode === 'auto') {
    const q = await queryLocalGpus(60_000);
    localGpuAvailable = q.available && q.ok && q.gpus.length > 0;
  }
  const desired = desiredAgent(engine, facts, localGpuAvailable);
  if (!desired.want) {
    dropStream(st);
    clearSamples(st);
    st.gpuFallback = null;
    setState(st, mode === 'off' ? 'disabled' : 'not-needed', desired.reason);
    await cleanupUnwanted(engineId, st);
    return;
  }
  st.cleanupDone = false;

  let gpuMode = desired.gpuMode;
  const fallback = st.gpuFallback;
  if (fallback && fallback.until > Date.now() && fallback.mode === gpuMode) gpuMode = 'none';
  else if (fallback) st.gpuFallback = null;

  if (streamIsHealthy(st) && st.gpuMode === gpuMode) {
    await maybeSweepOneshots(engineId, st, null);
    return;
  }
  // Stalled stream (dead SSH session, frozen daemon) or GPU access changed: start over.
  dropStream(st);

  let docker: Docker;
  try {
    docker = await dockerService.forEngine(engineId);
  } catch (err) {
    backoffError(st, errMessage(err));
    return;
  }
  try {
    await ensureAgentRunning(engineId, st, docker, gpuMode);
  } catch (err) {
    await handleAgentError(engineId, mode, st, docker, gpuMode, err);
  }
  await maybeSweepOneshots(engineId, st, docker);
}

async function handleAgentError(
  engineId: number, mode: HostAgentMode, st: EngineAgentState, docker: Docker, gpuMode: AgentGpuMode, err: unknown,
): Promise<void> {
  const msg = short(errMessage(err));
  const code = err instanceof PullError ? err.statusCode : statusCodeOf(err);
  if (code === 403) {
    logger.warn({ engineId, err: msg }, 'Host agent: container creation refused by the engine API proxy');
    markUnsupported(st, FORBIDDEN_MESSAGE);
    return;
  }
  if (!(err instanceof PullError) && gpuMode !== 'none' && GPU_ERROR_RE.test(msg)) {
    logger.warn({ engineId, gpuMode, err: msg }, 'Host agent: GPU access failed');
    await removeOurAgent(docker).catch(() => false);
    if (mode === 'always') {
      // The admin asked for an agent on this engine: keep host stats, drop GPU access for a while.
      st.gpuFallback = { mode: gpuMode, message: msg, until: Date.now() + GPU_FALLBACK_MS };
      try {
        await ensureAgentRunning(engineId, st, docker, 'none');
        return;
      } catch (err2) {
        const msg2 = short(errMessage(err2));
        const code2 = err2 instanceof PullError ? err2.statusCode : statusCodeOf(err2);
        if (code2 === 403) markUnsupported(st, FORBIDDEN_MESSAGE);
        else backoffError(st, msg2);
        return;
      }
    }
    markUnsupported(st, `The host agent cannot access the GPUs: ${msg}`);
    return;
  }
  logger.warn({ engineId, err: msg }, 'Host agent reconcile failed');
  backoffError(st, msg);
}

function reconcileEngine(engine: DockerEngine): Promise<void> {
  const st = ensureState(engine.id, engine.hostAgentMode ?? 'auto');
  if (st.inflight) return st.inflight;
  if (Date.now() < st.backoffUntil) return Promise.resolve();
  if ((suppressedUntil.get(engine.id) ?? 0) > Date.now()) return Promise.resolve();
  const run = doReconcile(engine, st).catch((err: unknown) => {
    logger.warn({ engineId: engine.id, err: errMessage(err) }, 'Host agent reconcile failed');
    backoffError(st, errMessage(err));
  });
  st.inflight = run;
  run.then(() => { if (st.inflight === run) st.inflight = null; });
  return run;
}

async function reconcileById(engineId: number): Promise<void> {
  if (stopped) return;
  let engine: DockerEngine | null;
  try {
    engine = await engineService.getById(engineId);
  } catch (err) {
    logger.debug({ engineId, err: errMessage(err) }, 'Host agent: engine lookup failed');
    return;
  }
  if (!engine) {
    forgetEngine(engineId);
    return;
  }
  await reconcileEngine(engine);
}

async function reconcileAll(): Promise<void> {
  if (stopped) return;
  let engines: DockerEngine[];
  try {
    engines = await engineService.getAll();
  } catch (err) {
    logger.warn({ err: errMessage(err) }, 'Host agent: cannot list engines');
    return;
  }
  const ids = new Set(engines.map((e) => e.id));
  for (const id of [...states.keys()]) if (!ids.has(id)) forgetEngine(id);
  // Each engine has its own single-flight: a slow pull on one engine never delays the others.
  await Promise.allSettled(engines.map((e) => reconcileEngine(e)));
}

function refused(error: string): OneShotResult {
  return { ok: false, exitCode: null, output: '', refused: true, error };
}

async function readOutput(container: Docker.Container): Promise<string> {
  try {
    const buf = await withTimeout(
      container.logs({ follow: false, stdout: true, stderr: true }),
      DOCKER_CALL_TIMEOUT_MS, 'one-shot logs',
    );
    const text = (Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)).replace(/\r/g, '').trim();
    return text.length > 8000 ? '…' + text.slice(-8000) : text;
  } catch (err) {
    return `(could not read the helper's output: ${short(errMessage(err))})`;
  }
}

export const hostAgentService = {
  /** Idempotent: reconcile every engine now and every 60 s (timers unref'd). */
  start(): void {
    if (started && !stopped) return;
    started = true;
    stopped = false;
    void reconcileAll();
    loopTimer = setInterval(() => { void reconcileAll(); }, RECONCILE_INTERVAL_MS);
    loopTimer.unref();
  },

  /** Stops timers and closes every log stream. Never removes containers: the agents keep running
   *  and are picked up again at the next boot. */
  stop(): void {
    stopped = true;
    started = false;
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = null;
    for (const t of touchTimers.values()) clearTimeout(t);
    touchTimers.clear();
    for (const st of states.values()) {
      clearRetryTimer(st);
      dropStream(st);
    }
  },

  /** After an engine update: its client or credentials may have changed, so the current stream and
   *  every backoff are dropped before reconciling. */
  async reconcileNow(engineId: number): Promise<void> {
    suppressedUntil.delete(engineId);
    const st = states.get(engineId);
    if (st) {
      if (st.inflight) await withTimeout(st.inflight, RECONCILE_NOW_WAIT_MS).catch(() => { /* still running */ });
      st.backoffUntil = 0;
      st.backoffMs = 0;
      st.followBackoffMs = FOLLOW_BACKOFF_MIN_MS;
      st.streamsWithoutSample = 0;
      st.gpuFallback = null;
      st.cleanupDone = false;
      st.cleanupRetryAt = 0;
      clearRetryTimer(st);
      dropStream(st);
    }
    await reconcileById(engineId);
  },

  /**
   * Engine deletion (WP-26): stop following, forget the state, then remove Oblihub's agent and every
   * one-shot helper on that engine (label AND name, any state). `client` lets the caller pass the
   * engine's client while it still works.
   */
  async teardownEngine(engineId: number, client?: Docker): Promise<{ agentRemoved: boolean; oneshotsRemoved: number; errors: string[] }> {
    suppressedUntil.set(engineId, Date.now() + TEARDOWN_SUPPRESS_MS);
    const st = states.get(engineId);
    if (st?.inflight) await withTimeout(st.inflight, 20_000).catch(() => { /* proceed anyway */ });
    forgetEngine(engineId);

    const result = { agentRemoved: false, oneshotsRemoved: 0, errors: [] as string[] };
    try {
      const engine = await engineService.getById(engineId);
      if (engine?.type === 'local') {
        const primary = await engineFactsService.resolveLocalEngineId();
        // A secondary local-type row shares the daemon: the agent there belongs to the primary.
        if (primary != null && primary !== engineId) return result;
      }
    } catch { /* the row may already be gone: proceed with the given client */ }

    let docker: Docker;
    try {
      docker = client ?? await dockerService.forEngine(engineId);
    } catch (err) {
      result.errors.push(`Engine client: ${short(errMessage(err))}`);
      return result;
    }
    try {
      const list = await withTimeout(
        docker.listContainers({ all: true, filters: { label: [`${OBLIHUB_INTERNAL_LABEL}=true`] } }),
        DOCKER_CALL_TIMEOUT_MS, 'list Oblihub helpers',
      );
      for (const c of list) {
        const name = containerNameOf(c);
        const labels = labelsOf(c);
        if (labels[OBLIHUB_INTERNAL_LABEL] !== 'true') continue;
        // Names and labels can be copied; a compose project cannot come from our own helpers.
        if (hasComposeProject(labels)) continue;
        const isAgent = name === HOST_AGENT_NAME && labels[OBLIHUB_ROLE_LABEL] === ROLE_AGENT;
        const isOneshot = name.startsWith(ONESHOT_NAME_PREFIX) && labels[OBLIHUB_ROLE_LABEL] === ROLE_ONESHOT;
        if (!isAgent && !isOneshot) continue;
        try {
          await removeContainer(docker, c.Id);
          if (isAgent) result.agentRemoved = true;
          else result.oneshotsRemoved++;
        } catch (err) {
          result.errors.push(`${name}: ${short(errMessage(err))}`);
        }
      }
    } catch (err) {
      result.errors.push(`List containers: ${short(errMessage(err))}`);
    }
    return result;
  },

  /** Sync: from the last reconcile. `engine` (the current row) gives the authoritative mode. */
  getAgent(engineId: number, engine?: Pick<DockerEngine, 'hostAgentMode' | 'enabled'>): EngineHostAgentInfo {
    const st = states.get(engineId);
    const mode: HostAgentMode = engine?.hostAgentMode ?? st?.mode ?? 'auto';
    if (engine && !engine.enabled) return { mode, state: 'disabled', message: 'Engine is disabled', gpuEnabled: false };
    if (!st) {
      return mode === 'off'
        ? { mode, state: 'disabled', message: AGENT_OFF_MESSAGE, gpuEnabled: false }
        : { mode, state: 'not-needed', message: 'Checking…', gpuEnabled: false };
    }
    return {
      mode,
      state: st.state,
      message: st.message,
      gpuEnabled: (st.state === 'running' || st.state === 'creating') && st.gpuMode !== 'none',
    };
  },

  async retry(engineId: number): Promise<EngineHostAgentInfo> {
    await hostAgentService.reconcileNow(engineId);
    const engine = await engineService.getById(engineId).catch(() => null);
    return hostAgentService.getAgent(engineId, engine ?? undefined);
  },

  /** Debounced first reconcile for an engine nobody has reconciled yet (e.g. just created). */
  touch(engineId: number): void {
    if (stopped || states.has(engineId) || touchTimers.has(engineId)) return;
    const t = setTimeout(() => {
      touchTimers.delete(engineId);
      void reconcileById(engineId);
    }, TOUCH_DEBOUNCE_MS);
    t.unref();
    touchTimers.set(engineId, t);
  },

  onSample(listener: SampleListener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },

  getLatestSample(engineId: number): { sample: AgentSample; receivedAt: number; cpuPercent: number | null } | null {
    const st = states.get(engineId);
    if (!st?.lastSample || st.lastSampleAt == null) return null;
    // Guard: no agent is wanted in these states, so a leftover reading is never "current".
    if (st.state === 'disabled' || st.state === 'not-needed') return null;
    return { sample: st.lastSample, receivedAt: st.lastSampleAt, cpuPercent: st.cpuPercent };
  },

  /**
   * Short-lived hardened helper container. Refused ({ ok: false, refused: true }) BEFORE any
   * Docker call when the engine is missing or disabled, when its hostAgentMode is 'off' (any helper),
   * or when it is https-apikey, the spec is privileged (capAdd) and the mode is not 'always'.
   */
  async runOneShot(engineId: number, spec: OneShotSpec): Promise<OneShotResult> {
    let engine: DockerEngine | null;
    try {
      engine = await engineService.getById(engineId);
    } catch (err) {
      return { ok: false, exitCode: null, output: '', error: `Cannot load engine ${engineId}: ${short(errMessage(err))}` };
    }
    if (!engine) return refused(`Engine ${engineId} not found`);
    if (!engine.enabled) return refused(`Engine "${engine.name}" is disabled`);
    const mode = engine.hostAgentMode ?? 'auto';
    // HostAgentMode promises "off = never create containers" (the Engines page says so, and
    // https-apikey engines default to it). The power-limit fallback and the MPS probe used to
    // create containers anyway.
    if (mode === 'off') return refused(ONESHOT_OFF_MESSAGE);
    const privileged = (spec.capAdd?.length ?? 0) > 0;
    // Plain HTTP to a socket proxy that most likely ignores the API key: a privileged container there
    // needs an explicit opt-in.
    if (engine.type === 'https-apikey' && privileged && mode !== 'always') return refused(ONESHOT_HTTPS_MESSAGE);
    if (!Array.isArray(spec.cmd) || spec.cmd.length === 0) {
      return { ok: false, exitCode: null, output: '', error: 'One-shot helper without a command' };
    }

    let gpuMode: AgentGpuMode = 'none';
    if (spec.gpu) {
      const facts = await engineFactsService.get(engineId, { timeoutMs: 8_000 });
      gpuMode = facts ? gpuModeFor(mode, facts) : 'none';
      if (gpuMode === 'none') return { ok: false, exitCode: null, output: '', unsupported: true, error: NO_GPU_MESSAGE };
    }

    const name = `${ONESHOT_NAME_PREFIX}${spec.purpose}-${randomBytes(3).toString('hex')}`;
    const timeoutMs = spec.timeoutMs ?? 60_000;
    let container: Docker.Container | null = null;
    try {
      const docker = await dockerService.forEngine(engineId);
      await ensureImage(docker, engineId);
      container = await withTimeout(docker.createContainer({
        name,
        Image: config.hostAgentImage,
        // Pinning the Entrypoint: Docker would otherwise run the image's own ENTRYPOINT with spec.cmd
        // as its arguments, so image-controlled code (nvidia/cuda ships a wrapper script, a tampered
        // mirror anything) would run with CAP_SYS_ADMIN before the absolute nvidia-smi path.
        Entrypoint: [spec.cmd[0]],
        Cmd: spec.cmd.slice(1),
        Tty: true,
        Env: [...(spec.env ?? []), ...(spec.gpu ? gpuEnv(gpuMode, spec.driverCapabilities ?? 'utility') : [])],
        Labels: {
          [OBLIHUB_INTERNAL_LABEL]: 'true',
          [OBLIHUB_ROLE_LABEL]: ROLE_ONESHOT,
          [ONESHOT_PURPOSE_LABEL]: spec.purpose,
        },
        HostConfig: {
          NetworkMode: 'none',
          CapDrop: ['ALL'],
          CapAdd: spec.capAdd ?? [],
          SecurityOpt: ['no-new-privileges:true'],
          Memory: 64 * MiB,
          PidsLimit: 64,
          // Mounts, never Binds: a bind whose source is missing would make the daemon create an
          // empty directory on the host.
          Mounts: (spec.mounts ?? []).map((m) => ({ Type: 'bind' as const, Source: m.Source, Target: m.Target, ReadOnly: m.ReadOnly ?? false })),
          // Removed explicitly after reading the output (AutoRemove would race the logs call).
          AutoRemove: false,
          LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
          ...(spec.gpu ? gpuHostConfig(gpuMode) : {}),
        },
      }), DOCKER_CALL_TIMEOUT_MS, 'create one-shot helper');
      await withTimeout(container.start(), DOCKER_CALL_TIMEOUT_MS, 'start one-shot helper');

      let exitCode: number | null = null;
      let timedOut = false;
      try {
        const res = await withTimeout(container.wait() as Promise<{ StatusCode?: unknown }>, timeoutMs, `${spec.purpose} helper`);
        exitCode = typeof res?.StatusCode === 'number' ? res.StatusCode : null;
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
        timedOut = true;
        await withTimeout(container.kill(), 10_000, 'kill one-shot helper').catch(() => { /* removed below */ });
      }
      const output = await readOutput(container);
      if (timedOut) {
        return { ok: false, exitCode: null, output, error: `The helper container timed out after ${Math.round(timeoutMs / 1000)} s` };
      }
      if (exitCode === 0) return { ok: true, exitCode, output, error: null };
      return { ok: false, exitCode, output, error: output ? short(output) : `The helper container exited with code ${exitCode ?? 'unknown'}` };
    } catch (err) {
      const msg = short(errMessage(err));
      const code = err instanceof PullError ? err.statusCode : statusCodeOf(err);
      if (code === 403) return { ok: false, exitCode: null, output: '', unsupported: true, error: FORBIDDEN_MESSAGE };
      if (MOUNT_MISSING_RE.test(msg)) return { ok: false, exitCode: null, output: '', mountMissing: true, error: msg };
      logger.warn({ engineId, purpose: spec.purpose, err: msg }, 'One-shot helper failed');
      return { ok: false, exitCode: null, output: '', error: msg };
    } finally {
      if (container) {
        const c = container;
        await withTimeout(c.remove({ force: true }), DOCKER_CALL_TIMEOUT_MS, 'remove one-shot helper').catch((err: unknown) => {
          // The periodic sweep removes it later (label + name prefix, older than 5 min).
          logger.warn({ engineId, name, err: errMessage(err) }, 'Could not remove a one-shot helper container');
        });
      }
    }
  },
};
