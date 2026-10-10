import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Docker from 'dockerode';
import type {
  Container, CriticalStackRef, DockerEngine, EngineHostSnapshot, MpsClientInfo, MpsEngineStatus, MpsSettings,
  ResourceApplyMode, ResourceApplyResult, ResourceLimits, Stack, StackPriority, StackResourceCapabilities,
  StackResourcesInfo, YieldMode, YieldSignalSource,
} from '@oblihub/shared';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { filterStacksByTeam } from '../middleware/permissions';
import { logger } from '../utils/logger';
import { mapWithConcurrency, withTimeout } from '../utils/withTimeout';
import { containerNameOf, isOblihubHiddenContainer, labelsOf, oblihubInfraReason } from '../utils/oblihubContainers';
import { parseComposeYaml } from '../utils/composeYaml';
import { stackEvents } from '../state/stackEvents';
import { stackService } from './stack.service';
import { dockerService } from './docker.service';
import { engineService } from './engine.service';
import { engineFactsService, type EngineFacts } from './engineFacts.service';
import { engineHostService } from './engineHost.service';
import { selfProjectService } from './selfProject.service';
import { composeRunner, type ComposeRunResult, type ComposeTarget } from './composeRunner.service';
import { composeService } from './compose.service';
import {
  VISIBLE_GPU_ID_RE, defaultCpuShares, inspectComposeServices, type ComposeServiceInfo,
} from './composeResources.service';
import {
  DEFAULT_MPS_PIPE_DIR, MPS_PIPE_DIRS, MPS_PLAIN_UNKNOWN_MESSAGES, mpsDetectionService, normalizeMpsPipeDir,
} from './mpsDetection.service';

/**
 * Per-stack resource limits: validation, who may change them, and applying them to the stack's
 * containers on the stack's OWN engine.
 *
 * Apply modes:
 *  - compose: a compose target (managed stack or adopted stacks-dir folder). The runner re-renders
 *    docker-compose.override.oblihub.yml from the database before every command, so this module only
 *    decides WHICH services to recreate and how, never writes the override itself.
 *  - docker-update: no compose target (Standalone, not compose-manageable, https-apikey engine):
 *    live `docker update` of CPU/RAM/shares on the existing containers.
 *  - none: stored only (orphaned stack, disabled engine, Oblihub's own stack).
 */

export interface CapabilitiesContext {
  capabilities: StackResourceCapabilities;
  target: ComposeTarget | null;
  engine: DockerEngine | null;
  facts: EngineFacts | null;
  services: ComposeServiceInfo[];
  orphan: boolean;
  isSelf: boolean;
}

type ContainerResult = ResourceApplyResult['containers'][number];

export interface DockerResourceUpdate {
  NanoCpus?: number;
  Memory?: number;
  MemorySwap?: number;
  CpuShares?: number;
}

const PRIORITIES: readonly StackPriority[] = ['critical', 'normal', 'opportunistic'];
const SIGNAL_SOURCES: readonly YieldSignalSource[] = ['nginx-traffic', 'gpu-util', 'webhook'];
const YIELD_MODES: readonly YieldMode[] = ['pause', 'stop'];

const SERVICE_LABEL = 'com.docker.compose.service';
const PROJECT_LABEL = 'com.docker.compose.project';
const ONEOFF_LABEL = 'com.docker.compose.oneoff';
// Compose service names; also keeps a crafted label from ever reaching the CLI as an option.
const SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MIN_MEMORY_BYTES = 6 * 1024 * 1024;
const DETAILS_MAX_CHARS = 4000;
const LIST_TIMEOUT_MS = 15_000;
const INSPECT_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 15_000;
const QUIET_IDLE_TIMEOUT_MS = 180_000;
const DOCKER_CONCURRENCY = 4;
const SNAPSHOT_TIMEOUT_MS = 2_000;
const MPS_INSPECT_TIMEOUT_MS = 5_000;
const GPU_UUID_RE = /^GPU-[0-9a-fA-F-]{8,64}$/;
const MAX_PINNED_ENTRIES = 64;

const STANDALONE_ADMIN_ONLY = 'Only admins can change resource limits or the priority of a Standalone stack: they apply to every container without a compose project on this engine.';
const ORPHAN_SET = "This stack's engine was deleted — limits cannot be applied.";
const SELF_SET = "Oblihub's own stack cannot have resource limits or a priority tier (only its own update helper recreates it).";
const BUSY_MESSAGE = 'A compose command is already running for this stack; limits were saved — Save again once it finishes.';
const DEFERRED_MESSAGE = 'Saved. The stack is currently yielded by the priority watchdog; limits will be applied when it resumes.';
const DOCKER_UPDATE_LASTS = 'docker update lasts until the container is recreated outside Oblihub — Save again after a manual compose up';
const MPS_ADMIN_ONLY = 'Only admins can enable MPS or change its settings (ipc: host exposes host shared memory to the container)';
const MPS_PIPE_DIR_INVALID = `MPS pipe directory must be one of ${MPS_PIPE_DIRS.join(', ')}`;
const MPS_REFUSED_PREFIX = 'MPS requires an Oblihub-managed compose stack whose services request a GPU, on an engine with an NVIDIA GPU';

// In memory on purpose: after a restart the next compose command of the stack renders the stored
// limits anyway (the runner re-renders the override before every command).
const pending = new Set<number>();

// 'watchdog:resumed' only fires for stacks the watchdog resumes. A stack can stop being yielded
// without it: a yield that ended up acting on nothing, a failed yield that was in flight when the
// Save was deferred, or a stack that stopped being Opportunistic with nothing journalled. Its apply
// would stay pending for good, so a slow sweep runs it once the stack is seen un-yielded twice in a
// row. Twice: a single look can fall inside the watchdog's shutdown resume (which emits no event on
// purpose, so no compose work starts while the process exits).
const PENDING_SWEEP_MS = 30_000;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
let sweeping = false;
const unyieldedAtLastSweep = new Set<number>();

// composeApply results refused because another compose command held the stack (a UI Pull, the
// Effective-config view, Stop). A deferred apply that meets one is queued again instead of being lost.
// Tracked here, not in ResourceApplyResult: that type is shared with the client.
const busyResults = new WeakSet<ResourceApplyResult>();

function markBusy(r: ResourceApplyResult): ResourceApplyResult {
  busyResults.add(r);
  return r;
}

// Bumped by every Save and Clear. A deferred apply that met a busy runner is only queued again when
// none ran meanwhile: that Save or Clear applied, deferred or reported the newer limits itself.
const saveGeneration = new Map<number, number>();

function supersedePending(stackId: number): void {
  pending.delete(stackId);
  saveGeneration.set(stackId, (saveGeneration.get(stackId) ?? 0) + 1);
}

/** Indirection so a check script can stand in for the watchdog without loading it. */
const hooks = {
  async yieldedStackIds(): Promise<Set<number>> {
    const { getYieldedStackIds } = await import('../workers/PriorityWatchdogWorker');
    return getYieldedStackIds();
  },
  /** Dynamic like yieldedStackIds: the poller pulls in the watchdog worker, which must not become a
   *  static dependency of this service. In-memory, never blocks. */
  async gpuLessStackIds(): Promise<Set<number>> {
    const { getGpuLessStackIds } = await import('../workers/GpuUtilPoller');
    return getGpuLessStackIds();
  },
  /** Same poller, same reason for the dynamic import: the GPUs each Opportunistic stack was granted. */
  async opportunisticGpuSets(): Promise<Record<number, string[] | null>> {
    const { getOpportunisticGpuSets } = await import('../workers/GpuUtilPoller');
    return getOpportunisticGpuSets();
  },
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Engine errors are raw dockerode/ssh2 text that names the engine's address ("connect ECONNREFUSED
 * 192.0.2.5:2376", a registry resolver), and that address is admin-only: EngineSummary omits the
 * host, and engineHostService.forViewer redacts host snapshots the same way. `rawErrors` is true for
 * admins and for results that only reach the server log; anyone else gets `generic`, and the raw
 * text goes to the server log instead.
 */
function engineError(err: unknown, rawErrors: boolean, generic: string, log: { stackId: number; step: string; container?: string }): string {
  const raw = errMessage(err);
  if (rawErrors) return raw;
  logger.warn({ ...log, err: raw }, `Resource apply: ${log.step} failed`);
  return generic;
}

// MPS_PLAIN_UNKNOWN_MESSAGES comes from mpsDetection.service so the two cannot drift: every other
// 'unknown' message quotes the probe's raw failure. 'Checking…' must stay in it: the Resources tab
// polls while it sees it.
const MPS_CHECK_UNAVAILABLE = 'MPS daemon check unavailable';

/** The MPS daemon state as this viewer may see it (same rule as engineHostService.forViewer). */
function mpsForViewer(status: MpsEngineStatus | null, isAdmin: boolean): MpsEngineStatus | null {
  if (!status || isAdmin || status.daemon !== 'unknown' || status.message == null || MPS_PLAIN_UNKNOWN_MESSAGES.has(status.message)) {
    return status;
  }
  return { ...status, message: MPS_CHECK_UNAVAILABLE };
}

// The prefixes composeResources.mpsInputsFor gives its daemon-check warnings.
const MPS_CHECK_LINE = 'MPS daemon check: ';
const MPS_CHECK_UNFINISHED_LINE = 'MPS daemon check did not finish (';
const MPS_CHECK_REDACTED = `${MPS_CHECK_LINE}${MPS_CHECK_UNAVAILABLE} (details in the server log)`;
const MPS_CHECK_UNFINISHED_REDACTED = `${MPS_CHECK_UNFINISHED_LINE}details in the server log)`;

/**
 * The override preview's warnings as a caller without `rawErrors` may see them. For a creating verb
 * the preview runs the MPS daemon check and quotes its status message, and an 'unknown' one carries
 * the probe's raw Docker/ssh failure, which can name the engine's address (the mpsForViewer rule).
 * The warning alone does not say which state produced it, so this fails closed: a daemon-check line
 * is kept only when its text is a fixed 'unknown' line, or the 'detected'/'not-detected' message the
 * probe cache holds for that directory (those only name an allow-listed directory). Any other one is
 * replaced and its raw text logged; a cache that changed since the preview only over-redacts.
 */
function previewWarningsForViewer(
  warnings: string[],
  rawErrors: boolean,
  ctx: { stackId: number; engineId: number | null; pipeDirectory: string | null | undefined },
): string[] {
  if (rawErrors) return warnings;
  let fixedCached: string | null | undefined;
  const fixedCachedMessage = (): string | null => {
    if (fixedCached === undefined) {
      const st = ctx.engineId != null ? mpsDetectionService.peek(ctx.engineId, ctx.pipeDirectory ?? DEFAULT_MPS_PIPE_DIR) : null;
      fixedCached = st != null && st.daemon !== 'unknown' ? st.message ?? null : null;
    }
    return fixedCached;
  };
  return warnings.map((w) => {
    if (w === MPS_CHECK_REDACTED || w === MPS_CHECK_UNFINISHED_REDACTED) return w;
    const checkLine = w.startsWith(MPS_CHECK_LINE);
    if (checkLine) {
      const text = w.slice(MPS_CHECK_LINE.length);
      if (MPS_PLAIN_UNKNOWN_MESSAGES.has(text) || text === fixedCachedMessage()) return w;
    } else if (!w.startsWith(MPS_CHECK_UNFINISHED_LINE)) {
      return w;
    }
    logger.warn({ stackId: ctx.stackId, engineId: ctx.engineId, warning: w }, 'Resource apply: MPS daemon check failed');
    return checkLine ? MPS_CHECK_REDACTED : MPS_CHECK_UNFINISHED_REDACTED;
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function result(mode: ResourceApplyResult['mode'], ok: boolean, message: string, extra: Partial<ResourceApplyResult> = {}): ResourceApplyResult {
  return { mode, ok, deferred: false, message, warnings: [], details: null, containers: [], appliedAt: nowIso(), ...extra };
}

function clamp(v: unknown, min: number, max: number): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

// ── Pure helpers (exported for the check scripts) ────────────────────────────

/**
 * True when the limits do nothing on a normal stack. The yield signal / timeout / mode fields are
 * ignored: only Opportunistic stacks yield and only a Critical stack's signal source is read, and the
 * Resources tab's default form always sends them ('nginx-traffic' / 30 / 'stop').
 */
export function isInertLimits(limits: ResourceLimits): boolean {
  return limits.priority === 'normal'
    && !((limits.cpuPercent ?? 0) > 0)
    && !((limits.ramPercent ?? 0) > 0)
    && limits.cpuShares == null
    && limits.visibleGpuIds == null
    && !(limits.yieldsToStackIds?.length)
    && !limits.mps?.enabled;
}

export interface EngineCapacity {
  cpuCount: number | null;
  memTotalBytes: number | null;
}

/**
 * The NanoCpus / Memory a Save of `limits` writes with docker update at this capacity; null when the
 * limits do not ask for that cap or the capacity is unknown. Also rebuilds what the PREVIOUS Save
 * wrote, so a cap is only ever lifted when it is still Oblihub's own.
 */
export function requestedCaps(limits: ResourceLimits | null, capacity: EngineCapacity): { nano: number | null; mem: number | null } {
  const cpuPercent = limits?.cpuPercent ?? 0;
  const ramPercent = limits?.ramPercent ?? 0;
  const { cpuCount, memTotalBytes } = capacity;
  return {
    nano: cpuPercent > 0 && cpuCount ? Math.max(1e7, Math.round((cpuPercent / 100) * cpuCount * 1e9)) : null,
    mem: ramPercent > 0 && memTotalBytes ? Math.max(MIN_MEMORY_BYTES, Math.floor((ramPercent / 100) * memTotalBytes)) : null,
  };
}

function formatCpus(nano: number): string {
  const cpus = Math.round((nano / 1e9) * 100) / 100;
  return `${cpus} CPU${cpus === 1 ? '' : 's'}`;
}

function formatRam(bytes: number): string {
  if (bytes >= 2 ** 30) return `${Math.round((bytes / 2 ** 30) * 100) / 100} GiB`;
  return `${Math.round((bytes / 2 ** 20) * 10) / 10} MiB`;
}

type CapKind = 'cpu' | 'ram';

/**
 * Whether a container's cap is `cap` (a value a Save writes, or the whole engine a lift writes).
 * `cap` is rebuilt from the engine's CURRENT capacity, but MemTotal moves by a few MB across reboots
 * (kernel, firmware or crashkernel reservations) while the value docker update wrote stays in the
 * container: exact equality would take Oblihub's own cap for the operator's after such a reboot and
 * never lift it. 1% of the cap (at least 4 MiB of RAM / 0.01 CPU) absorbs that drift; an operator's
 * cap that close to Oblihub's restricts the container the same way.
 */
function sameCap(kind: CapKind, current: number, cap: number | null): boolean {
  if (cap == null) return false;
  return Math.abs(current - cap) <= Math.max(cap * 0.01, kind === 'cpu' ? 1e7 : 4 * 2 ** 20);
}

/** A cap that restricts the container: set, and below the whole engine (an earlier lift restricts nothing). */
function restricts(kind: CapKind, current: number, whole: number): boolean {
  return current > 0 && current < whole && !sameCap(kind, current, whole);
}

/**
 * A cap on the container that a requested one overwrites and that is not Oblihub's: not what the
 * previous Save wrote, and below the whole engine (which is what a lift writes, and restricts nothing).
 */
function isForeignCap(kind: CapKind, current: number, requested: number, previous: number | null, whole: number): boolean {
  return restricts(kind, current, whole) && !sameCap(kind, current, requested) && !sameCap(kind, current, previous);
}

/**
 * The `docker update` body for a container: caps sized from the stack's engine capacity, shares from
 * the priority. The containers of a docker-update stack were started by the operator, often with their
 * own --cpus / --memory / mem_limit, so a cap that is no longer requested is lifted (to the whole
 * engine: docker update cannot unset NanoCpus or Memory with 0) only when it is still the one the
 * previous Save (`prev`) wrote; any other cap is left in place. `notes` say which caps were replaced
 * or left in place.
 */
export function dockerUpdateFor(
  limits: ResourceLimits,
  current: { NanoCpus?: number | null; Memory?: number | null },
  capacity: EngineCapacity,
  prev: ResourceLimits | null,
): { update: DockerResourceUpdate; notes: string[] } {
  const { cpuCount, memTotalBytes } = capacity;
  const want = requestedCaps(limits, capacity);
  const had = requestedCaps(prev, capacity);
  const curNano = current.NanoCpus ?? 0;
  const curMem = current.Memory ?? 0;
  const update: DockerResourceUpdate = { CpuShares: limits.cpuShares ?? defaultCpuShares(limits.priority) };
  const notes: string[] = [];

  if (want.nano != null) {
    update.NanoCpus = want.nano;
    if (isForeignCap('cpu', curNano, want.nano, had.nano, (cpuCount as number) * 1e9)) {
      notes.push(`its CPU cap (${formatCpus(curNano)}) is replaced by Oblihub's (${formatCpus(want.nano)})`);
    }
  } else if (curNano > 0 && had.nano != null) {
    // A cap of the whole engine (an earlier lift) restricts nothing: not worth a note.
    if (sameCap('cpu', curNano, had.nano)) update.NanoCpus = (cpuCount as number) * 1e9;
    else if (restricts('cpu', curNano, (cpuCount as number) * 1e9)) notes.push(`its CPU cap (${formatCpus(curNano)}) is not the one Oblihub set — left in place`);
  }

  if (want.mem != null) {
    update.Memory = want.mem;
    // docker's own default when only --memory is given: swap allowance equal to the memory limit.
    update.MemorySwap = want.mem * 2;
    if (isForeignCap('ram', curMem, want.mem, had.mem, memTotalBytes as number)) {
      notes.push(`its RAM cap (${formatRam(curMem)}) is replaced by Oblihub's (${formatRam(want.mem)})`);
    }
  } else if (curMem > 0 && had.mem != null) {
    if (sameCap('ram', curMem, had.mem)) {
      update.Memory = memTotalBytes as number;
      update.MemorySwap = -1;
    } else if (restricts('ram', curMem, memTotalBytes as number)) {
      notes.push(`its RAM cap (${formatRam(curMem)}) is not the one Oblihub set — left in place`);
    }
  }
  return { update, notes };
}

/**
 * Clearing with docker update: lift the caps the previous limits (`prev`) wrote and reset the shares
 * they set on every container (those that differ from docker's default). A cap Oblihub did not set —
 * none requested, or a different value (beyond sameCap's drift tolerance), e.g. after a manual compose
 * up — is left in place: it is the operator's. Without previous limits nothing is touched.
 */
export function dockerLiftFor(
  current: { NanoCpus?: number | null; Memory?: number | null; CpuShares?: number | null },
  capacity: EngineCapacity,
  prev: ResourceLimits | null,
): { update: DockerResourceUpdate | null; capacityUnknown: boolean; notes: string[] } {
  const had = requestedCaps(prev, capacity);
  const curNano = current.NanoCpus ?? 0;
  const curMem = current.Memory ?? 0;
  const update: DockerResourceUpdate = { CpuShares: 1024 };
  const notes: string[] = [];
  let lifted = false;
  let capacityUnknown = false;

  if (curNano > 0 && (prev?.cpuPercent ?? 0) > 0) {
    // Without the capacity the previous cap cannot be rebuilt, nor the whole engine written.
    if (had.nano == null) capacityUnknown = true;
    else if (sameCap('cpu', curNano, had.nano)) { update.NanoCpus = (capacity.cpuCount as number) * 1e9; lifted = true; }
    // A cap of the whole engine (an earlier lift) restricts nothing: not worth a note.
    else if (restricts('cpu', curNano, (capacity.cpuCount as number) * 1e9)) notes.push(`its CPU cap (${formatCpus(curNano)}) is not the one Oblihub set — left in place`);
  }
  if (curMem > 0 && (prev?.ramPercent ?? 0) > 0) {
    if (had.mem == null) capacityUnknown = true;
    else if (sameCap('ram', curMem, had.mem)) {
      update.Memory = capacity.memTotalBytes as number;
      update.MemorySwap = -1;
      lifted = true;
    } else if (restricts('ram', curMem, capacity.memTotalBytes as number)) {
      notes.push(`its RAM cap (${formatRam(curMem)}) is not the one Oblihub set — left in place`);
    }
  }
  const shares = current.CpuShares ?? 0;
  const oddShares = prev != null && shares !== 0 && shares !== 1024;
  if (!lifted && !oddShares && !capacityUnknown) return { update: null, capacityUnknown: false, notes };
  return { update, capacityUnknown, notes };
}

export interface ComposeServicePlan {
  /** Services with at least one running (or restarting) container: `up -d --no-deps`. */
  running: string[];
  /** Services whose containers all exist but none runs: `up --no-start --no-deps`. */
  stopped: string[];
  /** Services left alone, with the reason. */
  skipped: Map<string, string>;
}

type LiveContainer = Pick<Docker.ContainerInfo, 'Id' | 'Names' | 'Labels' | 'State' | 'Image'>;

/**
 * The compose service of one of the service's own containers; null for a container without the
 * service label and for a `docker compose run` one-off. A one-off carries its service's label too
 * (plus oneoff=True), but compose's `up` ignores it and recreates / starts the service's regular
 * container: a running one-off must not make a stopped or sleeping service count as running, nor
 * an exited one turn a job-only service into a "stopped" one that `up --no-start` would create.
 */
function composeServiceOf(info: Pick<Docker.ContainerInfo, 'Labels'>): string | null {
  const labels = labelsOf(info);
  if ((labels[ONEOFF_LABEL] ?? '').toLowerCase() === 'true') return null;
  return labels[SERVICE_LABEL] || null;
}

/**
 * Splits a project's live containers by compose service (containers without the service label and
 * `compose run` one-offs are ignored). A service is left alone when any of its containers is excluded,
 * Oblihub plumbing or paused: recreating the service would recreate — and for `up -d` start —
 * that container too. `declared` = services of the compose file(s): naming a service the file no
 * longer has (an orphan container of a removed service) would fail the whole command.
 */
export function planComposeServices(
  live: LiveContainer[],
  dbRows: Array<Pick<Container, 'dockerId' | 'containerName' | 'excluded'>>,
  declared: Set<string>,
): ComposeServicePlan {
  const byId = new Map(dbRows.map((r) => [r.dockerId, r]));
  const byName = new Map(dbRows.map((r) => [r.containerName, r]));
  const groups = new Map<string, LiveContainer[]>();
  for (const info of live) {
    const svc = composeServiceOf(info);
    if (!svc) continue;
    const list = groups.get(svc);
    if (list) list.push(info); else groups.set(svc, [info]);
  }
  const plan: ComposeServicePlan = { running: [], stopped: [], skipped: new Map() };
  for (const [svc, members] of groups) {
    const excluded = members.some((info) => {
      const row = byId.get(info.Id.slice(0, 12)) ?? byName.get(containerNameOf(info));
      return row?.excluded === true;
    });
    const states = members.map((info) => (info.State || '').toLowerCase());
    if (!SERVICE_NAME_RE.test(svc)) plan.skipped.set(svc, 'not a valid compose service name — left alone');
    else if (!declared.has(svc)) plan.skipped.set(svc, 'not in the compose file — left alone');
    else if (excluded) plan.skipped.set(svc, 'excluded — limits apply when it is next recreated');
    else if (members.some((info) => oblihubInfraReason(info) != null)) plan.skipped.set(svc, 'Oblihub infrastructure');
    else if (states.includes('paused')) plan.skipped.set(svc, 'paused — limits apply when it is next recreated');
    // A restarting container has a restart policy and is meant to run: `--no-start` would leave it down.
    else if (states.some((s) => s === 'running' || s === 'restarting')) plan.running.push(svc);
    else plan.stopped.push(svc);
  }
  return plan;
}

/** A number, or a numeric string as the old PUT bodies sent; NaN for anything else. */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/**
 * Validates the `mps` block of a PUT body. Missing/null → null. An enabled block needs an
 * Opportunistic stack (a Critical client would share the MPS server's fault domain and queue behind
 * the miner) and at least one visible GPU. That enabling is admin-only (the clients get `ipc: host`)
 * is checked in apply() (mpsChangeRefused), which knows the stored block. The settings of a disabled
 * block are kept (validated) so toggling MPS off and on again keeps them.
 */
function normalizeMps(
  raw: unknown,
  ctx: { priority: StackPriority; visibleGpuIds: string[] | null },
): MpsSettings | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'mps must be an object or null');
  const m = raw as Record<string, unknown>;
  const enabled = m.enabled === true;
  if (enabled) {
    if (ctx.priority !== 'opportunistic') {
      throw new AppError(400, 'MPS is only available for Opportunistic stacks (Oblihub never makes a Critical or Normal stack an MPS client)');
    }
    if (ctx.visibleGpuIds != null && ctx.visibleGpuIds.length === 0) {
      throw new AppError(400, 'MPS needs at least one visible GPU (GPU visibility is set to no GPU)');
    }
  }

  let activeThreadPercentage: number | null = null;
  if (m.activeThreadPercentage != null) {
    const n = toNumber(m.activeThreadPercentage);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new AppError(400, 'MPS SM percentage must be an integer from 1 to 100');
    activeThreadPercentage = n;
  }

  // Allow-list only: the directory is bind-mounted into the containers.
  let pipeDirectory: string | null = null;
  if (m.pipeDirectory != null) {
    const dir = normalizeMpsPipeDir(m.pipeDirectory);
    if (dir == null) throw new AppError(400, MPS_PIPE_DIR_INVALID);
    pipeDirectory = dir;
  }

  let pinnedMemLimitGb: Record<string, number> | null = null;
  if (m.pinnedMemLimitGb != null) {
    const p = m.pinnedMemLimitGb;
    if (typeof p !== 'object' || Array.isArray(p)) throw new AppError(400, 'MPS VRAM caps must map GPU UUIDs to a number of GB');
    const entries = Object.entries(p as Record<string, unknown>);
    if (entries.length > MAX_PINNED_ENTRIES) throw new AppError(400, 'Too many MPS VRAM caps');
    const out: Record<string, number> = {};
    for (const [uuid, v] of entries) {
      // Keys end up in CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: only real GPU UUIDs.
      if (!GPU_UUID_RE.test(uuid)) throw new AppError(400, `MPS VRAM cap: "${uuid.slice(0, 72)}" is not a GPU UUID (GPU-…)`);
      const gb = Math.round(toNumber(v) * 10) / 10;
      if (!Number.isFinite(gb) || gb <= 0) throw new AppError(400, `MPS VRAM cap for ${uuid} must be a number of GB greater than 0`);
      out[uuid] = gb;
    }
    pinnedMemLimitGb = entries.length > 0 ? out : null;
  }

  if (!enabled && activeThreadPercentage == null && pinnedMemLimitGb == null && pipeDirectory == null) return null;
  return { enabled, activeThreadPercentage, pinnedMemLimitGb, pipeDirectory };
}

/** Same settings as the renderer reads them: a null pipe directory is the daemon's default one. */
function sameMpsSettings(a: MpsSettings, b: MpsSettings): boolean {
  if ((a.activeThreadPercentage ?? null) !== (b.activeThreadPercentage ?? null)) return false;
  if ((a.pipeDirectory ?? DEFAULT_MPS_PIPE_DIR) !== (b.pipeDirectory ?? DEFAULT_MPS_PIPE_DIR)) return false;
  const pa = a.pinnedMemLimitGb ?? {};
  const pb = b.pinnedMemLimitGb ?? {};
  const keys = Object.keys(pa);
  return keys.length === Object.keys(pb).length
    && keys.every((k) => Object.prototype.hasOwnProperty.call(pb, k) && Number(pb[k]) === pa[k]);
}

/**
 * Whether a non-admin's Save changes MPS in a way only an admin may: enabling it, or changing
 * the settings of an enabled block. The Resources tab sends the stored block back on every Save, so
 * an admin's enabled block re-sent unchanged is not a change: refusing it would block every other
 * edit of the stack. Turning MPS off (a disabled or no block) is the safe direction and stays open.
 */
function mpsChangeRefused(requested: MpsSettings | null, stored: MpsSettings | null | undefined): boolean {
  if (!requested?.enabled) return false;
  return !(stored?.enabled === true && sameMpsSettings(requested, stored));
}

/**
 * Whether MPS may be enabled on this stack, shared by apply() and getInfo() so the tab and the
 * PUT never disagree. The first failing rule gives the reason. applyMode 'compose' also covers
 * adopted stacks-dir folders, which MPS excludes: Oblihub must own the compose to add `ipc: host`.
 * GPU-capable needs a POSITIVE signal: a GPU catalog ('ok') or an nvidia runtime / CDI in docker
 * info. 'starting', 'error', 'unsupported' or 'disabled' alone prove nothing.
 * The engine must also be able to run the MPS daemon check: the renderer emits MPS settings only
 * after that probe saw a live daemon, and the probe is a GPU helper container (hostAgentService
 * runOneShot). Off forbids it; without an nvidia runtime or CDI it only gets a GPU through --gpus,
 * which runOneShot tries under Always only. A gate looser than the probe would accept MPS settings
 * that can never take effect on that engine.
 */
export function mpsGate(caps: CapabilitiesContext, snap: EngineHostSnapshot | null): { ok: boolean; reason: string | null } {
  if (caps.capabilities.applyMode !== 'compose') return { ok: false, reason: 'MPS needs a compose-managed stack' };
  if (caps.target?.kind !== 'managed') {
    return { ok: false, reason: 'MPS is only available for Oblihub-managed stacks (this is an adopted stacks-dir folder)' };
  }
  if (!caps.capabilities.gpuVisibility) {
    return { ok: false, reason: caps.capabilities.gpuVisibilityReason ?? 'GPU access of this stack cannot be controlled' };
  }
  const engineName = caps.engine?.name ?? snap?.engine.name ?? 'this engine';
  const runtimeGpu = caps.facts?.nvidiaRuntime === true || caps.facts?.cdiNvidia === true;
  if (!runtimeGpu && snap?.gpu.status !== 'ok') {
    return { ok: false, reason: `No NVIDIA GPU detected on ${engineName}` };
  }
  // Same default as runOneShot.
  const agentMode = caps.engine?.hostAgentMode ?? 'auto';
  if (agentMode === 'off') {
    return { ok: false, reason: `Host agent is Off on ${engineName}: the MPS daemon check runs a helper container there, which Off forbids` };
  }
  if (!runtimeGpu && agentMode !== 'always') {
    return {
      ok: false,
      reason: `The MPS daemon check needs an nvidia runtime or a CDI NVIDIA device in docker info of ${engineName}, or its Host agent set to Always`,
    };
  }
  return { ok: true, reason: null };
}

// ── Capabilities ─────────────────────────────────────────────────────────────

function capabilitiesFor(p: {
  applyMode: ResourceApplyMode;
  reason: string | null;
  standalone: boolean;
  services: ComposeServiceInfo[];
  orphan: boolean;
  isSelf: boolean;
}): StackResourceCapabilities {
  const requestsGpu = p.services.some((s) => s.requestsGpu);
  const uncontrollable = p.services.filter((s) => s.requestsGpu && !s.gpuControllable);
  const gpuVisibility = p.applyMode === 'compose' && requestsGpu && uncontrollable.length === 0;
  let gpuVisibilityReason: string | null = null;
  if (p.applyMode !== 'compose') {
    gpuVisibilityReason = 'GPU visibility needs a compose-managed stack';
  } else if (!requestsGpu) {
    gpuVisibilityReason = 'No service in this stack requests a GPU in its compose file';
  } else if (uncontrollable.length > 0) {
    // Privileged / nvidia device mappings / `gpus:` expose GPUs through channels the override cannot restrict.
    const reasons = [...new Set(uncontrollable.map((s) => s.gpuUncontrollableReason ?? 'not controllable'))];
    gpuVisibilityReason = `GPU access of ${uncontrollable.map((s) => s.name).join(', ')} cannot be restricted (${reasons.join('; ')})`;
  }
  return {
    applyMode: p.applyMode,
    reason: p.reason,
    cpuRamCaps: p.applyMode !== 'none',
    cpuShares: p.applyMode !== 'none',
    gpuVisibility,
    gpuVisibilityReason,
    // Placeholder: resolveCapabilities replaces it with mpsGate (target kind, GPU signal), and getInfo
    // with the host snapshot and the viewer's role.
    mps: false,
    mpsReason: null,
    standaloneWarning: p.standalone,
    requiresAdmin: p.standalone,
    canEdit: !p.orphan && !p.isSelf,
    canEditReason: p.orphan ? "This stack's engine was deleted"
      : p.isSelf ? "Oblihub's own stack cannot have resource limits"
        : null,
  };
}

/** Services of the target's compose file plus the operator's own override (the one compose would auto-load). */
function readComposeServices(target: ComposeTarget): ComposeServiceInfo[] {
  const base = readText(path.join(target.composeDir, target.composeFile));
  if (base == null) return [];
  const baseDoc = parseComposeYaml(base).doc;
  if (!baseDoc) return [];
  const operator = composeRunner.describeOverrideFile(target).operator;
  const operatorDoc = operator ? parseComposeYaml(operator.content).doc : null;
  return inspectComposeServices([baseDoc, operatorDoc]);
}

async function isSelfStack(stack: Stack): Promise<boolean> {
  if (stack.engineId == null || stack.composeProject == null) return false;
  return selfProjectService.isSelfProject(stack.composeProject, await engineFactsService.daemonKey(stack.engineId));
}

async function isYieldedByWatchdog(stackId: number): Promise<boolean> {
  return (await hooks.yieldedStackIds()).has(stackId);
}

function deferApply(stackId: number): void {
  pending.add(stackId);
  // The stack is yielded right now: an earlier un-yielded sighting no longer counts.
  unyieldedAtLastSweep.delete(stackId);
  schedulePendingSweep();
}

// ── Engine host view (GPU catalog, capacity) ─────────────────────────────────

/** The engine's host snapshot within 2 s, or null (timeout, error, unknown engine). */
async function snapshotOf(engineId: number): Promise<EngineHostSnapshot | null> {
  try {
    return await withTimeout(engineHostService.getSnapshot(engineId), SNAPSHOT_TIMEOUT_MS, `host snapshot of engine ${engineId}`);
  } catch (err) {
    logger.debug({ engineId, err: errMessage(err) }, 'Engine host snapshot unavailable');
    return null;
  }
}

/**
 * Every requested GPU must exist on the stack's OWN engine — an index typed from the hub's GPU list
 * would silently select another card (or none) on a remote engine. Only checked when that engine's
 * catalog is known right now (GPU status 'ok'); otherwise (agent starting, engine slow or disabled)
 * the ids are stored as they are.
 */
async function assertGpusExist(stack: Stack, limits: ResourceLimits, snapshot: () => Promise<EngineHostSnapshot | null>): Promise<void> {
  const ids = limits.visibleGpuIds;
  if (stack.engineId == null || !ids || ids.length === 0) return;
  const snap = await snapshot();
  if (!snap || snap.gpu.status !== 'ok' || snap.gpu.gpus.length === 0) return;
  for (const id of ids) {
    const lower = id.toLowerCase();
    const found = snap.gpu.gpus.some((g) => g.index === id || (g.uuid != null && g.uuid.toLowerCase() === lower));
    if (!found) throw new AppError(400, `GPU ${id} not found on ${snap.engine.name}`);
  }
}

/**
 * MPS checks that need the engine, run before anything is stored: the shared gate, then (when the
 * engine's GPU catalog is known) every VRAM cap must name a GPU of that engine and fit its memory.
 */
function assertMpsAllowed(caps: CapabilitiesContext, mps: MpsSettings, snap: EngineHostSnapshot | null): void {
  const gate = mpsGate(caps, snap);
  if (!gate.ok) throw new AppError(400, `${MPS_REFUSED_PREFIX}: ${gate.reason}`);
  const pinned = mps.pinnedMemLimitGb;
  if (!pinned || !snap || snap.gpu.status !== 'ok' || snap.gpu.gpus.length === 0) return;
  for (const [uuid, gb] of Object.entries(pinned)) {
    const lower = uuid.toLowerCase();
    const gpu = snap.gpu.gpus.find((g) => g.uuid != null && g.uuid.toLowerCase() === lower);
    if (!gpu) throw new AppError(400, `MPS VRAM cap: GPU ${uuid} not found on ${snap.engine.name}`);
    if (gpu.memoryTotalMb > 0) {
      // One-decimal ceiling: the tab offers the card's memory rounded to one decimal as its maximum.
      const maxGb = Math.ceil((gpu.memoryTotalMb / 1024) * 10) / 10;
      if (gb > maxGb) throw new AppError(400, `MPS VRAM cap for GPU ${gpu.index} (${gb} GB) exceeds its memory (${maxGb} GB)`);
    }
  }
}

/**
 * Restart visibility for MPS clients: a VRAM cap below the miner's working set makes it
 * crash-loop, which only the restart counter shows. Read-only inspects on the stack's engine;
 * orphaned rows and failures are left out.
 */
async function mpsClientsOf(stack: Stack): Promise<MpsClientInfo[]> {
  const rows = stack.containers.filter((c): c is Container & { engineId: number } => c.engineId != null);
  const settled = await mapWithConcurrency(rows, DOCKER_CONCURRENCY, (c) =>
    withTimeout(dockerService.inspectContainer(c.dockerId, c.engineId), MPS_INSPECT_TIMEOUT_MS, `inspect ${c.containerName}`));
  const out: MpsClientInfo[] = [];
  rows.forEach((c, i) => {
    const r = settled[i];
    if (r.status !== 'fulfilled') return;
    out.push({
      dockerId: c.dockerId,
      name: c.containerName,
      state: r.value.State?.Status ?? 'unknown',
      restartCount: r.value.RestartCount ?? 0,
    });
  });
  return out;
}

function parseLimitsColumn(raw: unknown): ResourceLimits | null {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ResourceLimits : null;
}

/** Critical stacks this viewer can see (the stack itself excluded), as yield targets for the tab. */
async function criticalStackRefs(stack: Stack, viewer: { userId: number; role: string }): Promise<CriticalStackRef[]> {
  const rows = await db('stacks')
    .select('id', 'name', 'engine_id', 'resource_limits')
    .whereRaw("resource_limits->>'priority' = ?", ['critical'])
    .whereNot('id', stack.id)
    .orderBy('name') as Array<{ id: number; name: string; engine_id: number | null; resource_limits: unknown }>;
  if (rows.length === 0) return [];
  const visible = await filterStacksByTeam(viewer.userId, viewer.role, rows) as typeof rows;
  if (visible.length === 0) return [];
  const summaries = await engineService.getSummaries();
  const nameById = new Map(summaries.map((e) => [e.id, e.name]));
  // Two local-type engine rows are the same daemon: compare daemon keys, not ids. Orphans (NULL
  // engine) are never "the same engine" as anything.
  const ownKey = stack.engineId != null ? await engineFactsService.daemonKey(stack.engineId) : null;
  return Promise.all(visible.map(async (r): Promise<CriticalStackRef> => {
    const limits = parseLimitsColumn(r.resource_limits);
    const sameEngine = ownKey != null && r.engine_id != null && (await engineFactsService.daemonKey(r.engine_id)) === ownKey;
    return {
      id: r.id,
      name: r.name,
      engineId: r.engine_id,
      engineName: r.engine_id != null ? nameById.get(r.engine_id) ?? null : null,
      sameEngine,
      signalSource: limits?.yieldSignalSource ?? null,
      visibleGpuIds: limits?.visibleGpuIds ?? null,
    };
  }));
}

/**
 * The yield targets a Save may store. The watchdog tails the proxy traffic of every target, stamps
 * its activity (which every user can read) and pauses this stack in step with it, so a target must be
 * a Critical stack the caller can see: the list the Resources tab offers (criticalStackRefs). A link
 * already stored is kept while its target is still Critical, even when the caller cannot see it (an
 * admin may have set it, and the tab sends the stored list back on every Save). Anything else is
 * dropped rather than refused, so a target demoted since the last Save does not block every Save.
 */
async function allowedYieldTargets(
  stack: Stack,
  requested: number[],
  viewer: { role: string; userId: number | null },
): Promise<{ kept: number[]; dropped: number[] }> {
  if (requested.length === 0) return { kept: [], dropped: [] };
  const rows = await db('stacks')
    .whereIn('id', requested)
    .select('id', 'resource_limits') as Array<{ id: number; resource_limits: unknown }>;
  const critical = rows
    .filter((r) => parseLimitsColumn(r.resource_limits)?.priority === 'critical')
    .map((r) => ({ id: Number(r.id) }));
  let allowed: Set<number>;
  if (viewer.role === 'admin') {
    allowed = new Set(critical.map((r) => r.id));
  } else {
    const stored = new Set((stack.resourceLimits?.yieldsToStackIds ?? []).map(Number));
    const added = critical.filter((r) => !stored.has(r.id));
    const visible = viewer.userId != null && added.length > 0
      ? await filterStacksByTeam(viewer.userId, viewer.role, added) as typeof added
      : [];
    allowed = new Set([...critical.filter((r) => stored.has(r.id)), ...visible].map((r) => r.id));
  }
  return {
    kept: requested.filter((id) => allowed.has(id)),
    dropped: requested.filter((id) => !allowed.has(id)),
  };
}

// ── Compose mode ────────────────────────────────────────────────────────

/** The project's containers on the target daemon, in every state, Oblihub's hidden helpers removed. */
async function listLive(target: ComposeTarget): Promise<Docker.ContainerInfo[]> {
  const list = async (): Promise<Docker.ContainerInfo[]> => {
    if (target.engineId != null) return dockerService.listProjectContainers(target.projectName, target.engineId);
    // No local engine row (legacy install): the managed stack lives on Oblihub's own socket.
    const docker = await dockerService.forEngine(null);
    const all = await docker.listContainers({ all: true, filters: { label: [`${PROJECT_LABEL}=${target.projectName}`] } });
    return all.filter((c) => !isOblihubHiddenContainer(c));
  };
  return withTimeout(list(), LIST_TIMEOUT_MS, `list containers of ${target.projectName}`);
}

function runFailure(r: ComposeRunResult): string {
  if (r.busy || r.refused) return r.stderr || 'Another compose command is running for this stack';
  return `docker compose exited with code ${r.exitCode}`;
}

/** `rawErrors`: see engineError — false for a non-admin's Save/Clear. */
async function composeApply(stack: Stack, caps: CapabilitiesContext, clearing: boolean, rawErrors: boolean): Promise<ResourceApplyResult> {
  const target = caps.target;
  if (!target) return result('stored-only', false, caps.capabilities.reason ?? 'Not compose-manageable');

  // An `up` now would start a miner while its Critical stack is busy.
  if (await isYieldedByWatchdog(stack.id)) {
    deferApply(stack.id);
    return result('compose', true, DEFERRED_MESSAGE, { deferred: true });
  }
  if (composeRunner.isBusy(target.daemonKey, target.projectName)) {
    return markBusy(result('compose', false, BUSY_MESSAGE));
  }

  const warnings: string[] = [];
  // 'up': the preview must size caps from the same source the command will (engine facts, <= 8 s);
  // without a verb it reads the cache only and could warn about caps the command does apply.
  try {
    const preview = await composeRunner.previewResources(target, 'up');
    warnings.push(...previewWarningsForViewer(preview.warnings, rawErrors, {
      stackId: stack.id,
      engineId: target.engineId,
      pipeDirectory: preview.limits?.mps?.pipeDirectory,
    }));
  } catch (err) {
    warnings.push(`Could not preview the resource override (${engineError(err, rawErrors, 'details in the server log', { stackId: stack.id, step: 'override preview' })})`);
  }

  let live: Docker.ContainerInfo[];
  try {
    live = await listLive(target);
  } catch (err) {
    // Without the containers' states a run could start services the operator stopped.
    const reason = engineError(err, rawErrors, 'Engine unreachable', { stackId: stack.id, step: 'container listing' });
    return result('compose', false, `Could not list this stack's containers on its engine (${reason}) — limits saved but not applied; Save again`, { warnings });
  }

  const plan = planComposeServices(live, stack.containers, new Set(caps.services.map((s) => s.name)));
  for (const [svc, reason] of plan.skipped) warnings.push(`Service "${svc}" left alone: ${reason}`);

  // One-offs are not part of any service apply: they are neither recreated nor reported.
  const labelled = live.filter((info) => composeServiceOf(info) != null);
  if (plan.running.length === 0 && plan.stopped.length === 0) {
    let message: string;
    if (labelled.length === 0) {
      message = clearing
        ? 'Limits cleared. No container of this stack exists on its engine — the next deploy runs without them.'
        : 'Saved. No container of this stack exists on its engine — limits apply at the next deploy.';
    } else {
      message = clearing
        ? 'Limits cleared. Every service was left alone (see the list) — they lose their caps when next recreated.'
        : 'Saved. Every service was left alone (see the list) — limits apply when they are next recreated.';
    }
    return result('compose', true, message, { warnings, containers: containerResults(labelled, plan, null, null) });
  }

  // The preview and the listing can take seconds: the watchdog may have yielded the stack meanwhile.
  if (await isYieldedByWatchdog(stack.id)) {
    deferApply(stack.id);
    return result('compose', true, DEFERRED_MESSAGE, { deferred: true, warnings });
  }

  // `up -d` of the whole project used to start services the operator stopped and wake sleeping
  // ones. Running services are recreated with `up -d`; stopped ones with `up --no-start`, which
  // recreates them with the new caps without starting them. `--no-deps` keeps dependencies untouched.
  const runOpts = { mode: 'quiet' as const, idleTimeoutMs: QUIET_IDLE_TIMEOUT_MS, purpose: 'resources' };
  const r1 = plan.running.length > 0
    ? await composeRunner.execCompose(target, ['up', '-d', '--no-deps', ...plan.running], runOpts)
    : null;
  const r2 = plan.stopped.length > 0
    ? await composeRunner.execCompose(target, ['up', '--no-start', '--no-deps', ...plan.stopped], runOpts)
    : null;
  const runs = [r1, r2].filter((r): r is ComposeRunResult => r != null);
  const ok = runs.every((r) => r.exitCode === 0);

  if (runs.some((r) => r.exitCode === 0)) {
    const composeText = readText(path.join(target.composeDir, target.composeFile));
    if (target.kind === 'managed') {
      // Compose recreates a service with only its declared networks; attach-only: a background
      // apply never detaches anything.
      try {
        await composeService.reconcileProxyMembership(target.projectName, target.managedEngineId, {
          allowDetach: false,
          composeContent: composeText ?? undefined,
        });
      } catch (err) {
        warnings.push(`Proxy network re-attach failed: ${engineError(err, rawErrors, 'details in the server log', { stackId: stack.id, step: 'proxy network re-attach' })}`);
      }
    } else if (composeText != null) {
      // An adopted folder is never attached automatically. Compose recreated its services with only
      // their declared networks, so a hand-made attachment is gone: say so when a proxy host targets them.
      try {
        const recreated = new Set([
          ...(r1?.exitCode === 0 ? plan.running : []),
          ...(r2?.exitCode === 0 ? plan.stopped : []),
        ]);
        const detected = await composeService._detectProxiedServices(target.projectName, composeText);
        const hit = detected.services.filter((s) => recreated.has(s));
        if (hit.length > 0 && !detected.userOwnsProxyNetwork) {
          const networks = new Set<string>();
          for (const s of hit) for (const n of detected.servicesToNetworks?.get(s) ?? []) networks.add(n);
          const network = networks.size > 0 ? [...networks].join(' / ') : await dockerService.getProxyNetworkName();
          warnings.push(`Proxy host(s) target ${hit.join(', ')} of this stack, but it is not an Oblihub-managed stack: Oblihub does not attach it to the proxy network. If it was attached by hand, the recreate removed that attachment — declare the network in its compose file or run docker network connect ${network} <container>.`);
        }
      } catch {
        // Advisory only.
      }
    }
  }

  // Recreated containers have new ids: report the project as it is now.
  let after: Docker.ContainerInfo[] = live;
  let relisted = false;
  try {
    after = await listLive(target);
    relisted = true;
  } catch { /* keep the listing taken before the runs */ }
  if (relisted && runs.some((r) => r.exitCode === 0)) await reassociateRecreated(stack, after);

  const busy = runs.some((r) => r.busy || r.refused);
  let message: string;
  if (!ok) {
    if (busy) message = BUSY_MESSAGE;
    else message = clearing
      ? 'docker compose failed — limits cleared but not (fully) removed from the containers'
      : 'docker compose failed — limits saved but not (fully) applied';
  } else if (r1 && r2) {
    message = clearing
      ? 'Limits cleared — running services were recreated without them; stopped services were updated without being started'
      : 'Applied through the compose override — running services were recreated; stopped services were updated without being started';
  } else if (r1) {
    message = clearing
      ? 'Limits cleared — running services were recreated without them'
      : 'Applied through the compose override — running services were recreated';
  } else {
    message = clearing
      ? 'Limits cleared on stopped services without starting them'
      : 'Applied to stopped services without starting them';
  }
  const failedRuns = runs.filter((r) => r.exitCode !== 0);
  const failedOutput = failedRuns.map((r) => r.stderr || r.stdout).filter(Boolean).join('\n');
  let details = failedOutput ? failedOutput.slice(-DETAILS_MAX_CHARS) : null;
  // Busy / refused runs only carry the runner's own line. Anything else is compose CLI output, and
  // the CLI targets the engine by address: a connection or pull failure prints it.
  if (details != null && !rawErrors && failedRuns.some((r) => !r.busy && !r.refused)) {
    logger.warn({ stackId: stack.id, output: details }, 'Resource apply: docker compose failed');
    details = null;
    message += ' (compose output in the server log)';
  }
  const out = result('compose', ok, message, {
    warnings,
    details,
    containers: containerResults(after.filter((info) => composeServiceOf(info) != null), plan, r1, r2),
  });
  return !ok && busy ? markBusy(out) : out;
}

/**
 * Points the stack's container rows at the containers compose just recreated, matched by name as
 * discovery does. Until the next discovery pass (up to its interval) the rows would otherwise name the
 * removed containers, and a wake of a stop-mode sleeping service recreated by `up --no-start` would
 * start a container that no longer exists and end in wake_failed.
 */
async function reassociateRecreated(stack: Stack, after: Docker.ContainerInfo[]): Promise<void> {
  const liveIds = new Set(after.map((info) => info.Id.slice(0, 12)));
  const staleByName = new Map<string, Container>();
  for (const c of stack.containers) {
    if (c.engineId != null && !liveIds.has(c.dockerId)) staleByName.set(c.containerName, c);
  }
  if (staleByName.size === 0) return;
  const rowIds = new Set(stack.containers.map((c) => c.dockerId));
  for (const info of after) {
    const newId = info.Id.slice(0, 12);
    const row = staleByName.get(containerNameOf(info));
    if (!row || rowIds.has(newId)) continue;
    staleByName.delete(row.containerName);
    try {
      await stackService.updateContainerDockerId(row.id, newId);
    } catch (err) {
      // docker_id is unique: a discovery pass may have re-associated the row first.
      logger.warn({ stackId: stack.id, containerId: row.id, newDockerId: newId, err: errMessage(err) },
        'Resource apply: container row not re-associated with its recreated container; the next discovery pass will');
    }
  }
}

function containerResults(
  infos: Docker.ContainerInfo[],
  plan: ComposeServicePlan,
  r1: ComposeRunResult | null,
  r2: ComposeRunResult | null,
): ContainerResult[] {
  const out: ContainerResult[] = [];
  for (const info of infos) {
    const svc = composeServiceOf(info);
    if (svc == null) continue;
    const base = { dockerId: info.Id.slice(0, 12), name: containerNameOf(info) };
    const skip = plan.skipped.get(svc);
    const run = plan.running.includes(svc) ? r1 : plan.stopped.includes(svc) ? r2 : null;
    if (skip != null) out.push({ ...base, ok: true, error: null, skipped: skip });
    else if (run) out.push({ ...base, ok: run.exitCode === 0, error: run.exitCode === 0 ? null : runFailure(run), skipped: null });
    // A service first seen after the runs was not part of this apply.
  }
  return out;
}

// ── docker-update mode ───────────────────────────────────────────────

async function engineCapacity(caps: CapabilitiesContext, daemonKey: string): Promise<EngineCapacity> {
  let cpuCount = caps.facts?.cpuCount ?? null;
  let memTotalBytes = caps.facts?.memTotalBytes ?? null;
  // The local daemon is this host; a remote engine's unknown capacity stays unknown.
  if (daemonKey === 'local') {
    if (cpuCount == null) cpuCount = os.cpus().length || null;
    if (memTotalBytes == null) memTotalBytes = os.totalmem() || null;
  }
  return { cpuCount, memTotalBytes };
}

/**
 * The stack's DB containers that docker update may touch, inspected on their engine. Skips orphans,
 * excluded containers, vanished ones and Oblihub's own plumbing / container / project.
 */
async function collectUpdatable(stack: Stack, daemonKey: string): Promise<{
  updatable: Array<{ c: Container & { engineId: number }; info: Docker.ContainerInspectInfo }>;
  skipped: ContainerResult[];
}> {
  const local = daemonKey === 'local';
  const selfId = local ? selfProjectService.getSelfContainerId() : null;
  const selfProjects = local ? await selfProjectService.getSelfProjects() : new Set<string>();
  // Ids are compared as prefixes: the DB and HOSTNAME hold 12 chars, inspect the full 64.
  const isSelfId = (id: string) => selfId != null && id.length > 0 && (id.startsWith(selfId) || selfId.startsWith(id));
  const skipped: ContainerResult[] = [];
  const skip = (c: Container, reason: string) => skipped.push({ dockerId: c.dockerId, name: c.containerName, ok: true, error: null, skipped: reason });

  const toInspect: Array<Container & { engineId: number }> = [];
  for (const c of stack.containers) {
    if (c.engineId == null) skip(c, 'orphaned engine');
    else if (c.excluded) skip(c, 'excluded');
    else if (isSelfId(c.dockerId)) skip(c, 'Oblihub infrastructure');
    else toInspect.push(c as Container & { engineId: number });
  }
  const inspected = await mapWithConcurrency(toInspect, DOCKER_CONCURRENCY, (c) =>
    withTimeout(dockerService.inspectContainer(c.dockerId, c.engineId), INSPECT_TIMEOUT_MS, `inspect ${c.containerName}`));

  const updatable: Array<{ c: Container & { engineId: number }; info: Docker.ContainerInspectInfo }> = [];
  toInspect.forEach((c, i) => {
    const r = inspected[i];
    if (r.status === 'rejected') { skip(c, 'gone'); return; }
    const info = r.value;
    const project = info.Config?.Labels?.[PROJECT_LABEL];
    if (oblihubInfraReason(info) != null || isSelfId(info.Id ?? '') || (project && selfProjects.has(project))) {
      skip(c, 'Oblihub infrastructure');
      return;
    }
    updatable.push({ c, info });
  });
  return { updatable, skipped };
}

async function runUpdates(
  stackId: number,
  items: Array<{ c: Container & { engineId: number }; update: DockerResourceUpdate; note: string | null }>,
  rawErrors: boolean,
): Promise<ContainerResult[]> {
  const settled = await mapWithConcurrency(items, DOCKER_CONCURRENCY, ({ c, update }) =>
    withTimeout(dockerService.updateContainerResources(c.dockerId, c.engineId, update), UPDATE_TIMEOUT_MS, 'docker update'));
  return items.map(({ c, note }, i) => {
    const r = settled[i];
    const base = { dockerId: c.dockerId, name: c.containerName, skipped: null };
    // e.g. 'Conflicting options: Nano CPUs and CPU Period' for a container capped with --cpu-quota.
    if (r.status === 'rejected') {
      return { ...base, ok: false, error: engineError(r.reason, rawErrors, 'docker update failed (details in the server log)', { stackId, step: 'docker update', container: c.containerName }) };
    }
    return { ...base, ok: note == null, error: note };
  });
}

/** `prev`: the limits stored before this Save — only the caps they wrote are ever lifted. */
async function dockerUpdateApply(
  stack: Stack,
  caps: CapabilitiesContext,
  limits: ResourceLimits,
  prev: ResourceLimits | null,
  rawErrors: boolean,
): Promise<ResourceApplyResult> {
  const daemonKey = await engineFactsService.daemonKey(stack.engineId as number);
  const capacity = await engineCapacity(caps, daemonKey);
  const warnings: string[] = [];
  const standalone = stack.composeProject == null;
  if (!standalone && caps.capabilities.reason) warnings.push(caps.capabilities.reason);
  if (limits.visibleGpuIds != null) warnings.push('GPU visibility needs a compose-managed stack — stored, not applied');
  if (standalone) warnings.push('Standalone groups every container without a compose project on this engine');
  const capUnknown = (l: ResourceLimits | null) =>
    ((l?.cpuPercent ?? 0) > 0 && !capacity.cpuCount) || ((l?.ramPercent ?? 0) > 0 && !capacity.memTotalBytes);
  if (capUnknown(limits)) {
    warnings.push("This engine's capacity is unknown — only CPU shares were applied");
  } else if (capUnknown(prev)) {
    warnings.push("This engine's capacity is unknown — the CPU/RAM caps of the previous Save were left in place");
  }
  warnings.push(DOCKER_UPDATE_LASTS);

  const { updatable, skipped } = await collectUpdatable(stack, daemonKey);
  const applied = await runUpdates(stack.id, updatable.map(({ c, info }) => {
    const planned = dockerUpdateFor(limits, { NanoCpus: info.HostConfig?.NanoCpus, Memory: info.HostConfig?.Memory }, capacity, prev);
    for (const note of planned.notes) warnings.push(`Container "${c.containerName}": ${note}`);
    return { c, update: planned.update, note: null };
  }), rawErrors);
  const ok = applied.every((r) => r.ok);
  let message: string;
  if (!ok) message = 'docker update failed on some containers — see the list';
  else if (applied.length > 0) message = 'Applied live with docker update (CPU/RAM)';
  else if (stack.containers.length === 0) message = 'Saved. This stack has no container on its engine yet — Save again once it has one (docker update only changes existing containers).';
  else message = 'Saved. Every container was skipped (see the list).';
  return result('docker-update', ok, message, { warnings, containers: [...applied, ...skipped] });
}

/** `prev`: the limits stored before the clear — only the caps and shares they wrote are undone. */
async function dockerUpdateClear(stack: Stack, caps: CapabilitiesContext, prev: ResourceLimits | null, rawErrors: boolean): Promise<ResourceApplyResult> {
  const daemonKey = await engineFactsService.daemonKey(stack.engineId as number);
  const capacity = await engineCapacity(caps, daemonKey);
  const warnings: string[] = [];
  if (stack.composeProject == null) warnings.push('Standalone groups every container without a compose project on this engine');

  const { updatable, skipped } = await collectUpdatable(stack, daemonKey);
  const items: Array<{ c: Container & { engineId: number }; update: DockerResourceUpdate; note: string | null }> = [];
  let capacityUnknown = false;
  for (const { c, info } of updatable) {
    const lift = dockerLiftFor(
      { NanoCpus: info.HostConfig?.NanoCpus, Memory: info.HostConfig?.Memory, CpuShares: info.HostConfig?.CpuShares },
      capacity,
      prev,
    );
    for (const note of lift.notes) warnings.push(`Container "${c.containerName}": ${note}`);
    if (!lift.update) {
      // A cap of the whole engine is an earlier lift, not a cap.
      const below = (kind: CapKind, v: number | undefined, whole: number | null) =>
        (v ?? 0) > 0 && (whole == null || restricts(kind, v as number, whole));
      const capped = below('cpu', info.HostConfig?.NanoCpus, capacity.cpuCount ? capacity.cpuCount * 1e9 : null)
        || below('ram', info.HostConfig?.Memory, capacity.memTotalBytes);
      skipped.push({
        dockerId: c.dockerId, name: c.containerName, ok: true, error: null,
        skipped: capped ? 'its CPU/RAM caps were not set by Oblihub — left in place' : 'no caps to lift',
      });
      continue;
    }
    if (lift.capacityUnknown) capacityUnknown = true;
    items.push({
      c,
      update: lift.update,
      note: lift.capacityUnknown ? "Engine capacity unknown — its CPU/RAM cap could not be lifted (shares were reset)" : null,
    });
  }
  if (capacityUnknown) warnings.push("This engine's capacity is unknown — some CPU/RAM caps could not be lifted");

  const applied = await runUpdates(stack.id, items, rawErrors);
  const ok = applied.every((r) => r.ok);
  const message = !ok
    ? 'docker update failed on some containers — see the list'
    : applied.length > 0 ? 'Limits cleared — caps lifted live with docker update' : 'Limits cleared';
  return result('docker-update', ok, message, { warnings, containers: [...applied, ...skipped] });
}

// ── Service ──────────────────────────────────────────────────────────────────

export const resourceLimitsService = {
  /**
   * Validates and normalises a PUT body. Throws AppError 400. The role checks that need the stored
   * limits (MPS, yield targets) run in apply().
   */
  normalize(body: unknown, ctx: { stackId: number; role: string }): ResourceLimits {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'Body required');
    const b = body as Record<string, unknown>;
    if (typeof b.priority !== 'string' || !PRIORITIES.includes(b.priority as StackPriority)) {
      throw new AppError(400, 'priority must be critical | normal | opportunistic');
    }

    let visibleGpuIds: string[] | null = null;
    if (Array.isArray(b.visibleGpuIds)) {
      visibleGpuIds = [];
      for (const raw of b.visibleGpuIds) {
        const id = String(raw).trim();
        // The ids end up in the override and in NVIDIA_VISIBLE_DEVICES: anything but an index or a uuid is refused.
        if (!VISIBLE_GPU_ID_RE.test(id)) {
          throw new AppError(400, `Invalid GPU id "${id.slice(0, 64)}" (expected an index like 0 or a UUID like GPU-…)`);
        }
        if (!visibleGpuIds.includes(id)) visibleGpuIds.push(id);
      }
    }

    let yieldsToStackIds: number[] | null = null;
    if (Array.isArray(b.yieldsToStackIds)) {
      yieldsToStackIds = [];
      for (const raw of b.yieldsToStackIds) {
        if (typeof raw !== 'number' && typeof raw !== 'string') continue;
        const n = Number(raw);
        // A stack never yields to itself.
        if (!Number.isSafeInteger(n) || n <= 0 || n === ctx.stackId || yieldsToStackIds.includes(n)) continue;
        yieldsToStackIds.push(n);
      }
    }

    const cpuShares = clamp(b.cpuShares, 2, 262144);
    const mps = normalizeMps(b.mps, { priority: b.priority as StackPriority, visibleGpuIds });
    return {
      priority: b.priority as StackPriority,
      cpuPercent: clamp(b.cpuPercent, 0, 100),
      ramPercent: clamp(b.ramPercent, 0, 100),
      // Docker and compose only take whole shares.
      cpuShares: cpuShares == null ? null : Math.round(cpuShares),
      visibleGpuIds,
      // Power limits are host-wide and admin-only on /resources; this per-stack path bypassed both
      // the admin gate and the min/max check, so whatever the body says is dropped.
      powerLimitWatts: null,
      yieldsToStackIds,
      yieldSignalSource: typeof b.yieldSignalSource === 'string' && SIGNAL_SOURCES.includes(b.yieldSignalSource as YieldSignalSource)
        ? b.yieldSignalSource as YieldSignalSource
        : null,
      yieldIdleTimeoutSeconds: clamp(b.yieldIdleTimeoutSeconds, 1, 86400),
      yieldMode: typeof b.yieldMode === 'string' && YIELD_MODES.includes(b.yieldMode as YieldMode) ? b.yieldMode as YieldMode : null,
      // Body-level MPS rules here (Opportunistic, visible GPU, allow-listed directory); the admin rule
      // and the engine-level ones (managed compose stack, GPU-capable engine, VRAM caps within the
      // cards) run in apply().
      mps,
    };
  },

  /**
   * 403 Standalone non-admin (set and clear), 409 orphan (set), 400 Oblihub's own stack (set).
   * apply() turns an inert body on the self stack into clear() before calling this.
   */
  async assertEditable(stack: Stack, ctx: { role: string }, op: 'set' | 'clear'): Promise<void> {
    // Docker update on a Standalone stack touches every container without a compose project on the engine.
    if (stack.composeProject == null && ctx.role !== 'admin') throw new AppError(403, STANDALONE_ADMIN_ONLY);
    if (op !== 'set') return;
    // A NULL engine is a deleted engine, never the local daemon.
    if (stack.engineId == null) throw new AppError(409, ORPHAN_SET);
    if (await isSelfStack(stack)) throw new AppError(400, SELF_SET);
  },

  /** How limits reach this stack's containers, and which knobs are meaningful. `cacheOnly`: never wait on Docker for engine facts. */
  async resolveCapabilities(stack: Stack, opts: { cacheOnly?: boolean } = {}): Promise<CapabilitiesContext> {
    const standalone = stack.composeProject == null;
    // Without a host snapshot the MPS gate's GPU signal is docker info only; getInfo refines it.
    const withMpsGate = (ctx: CapabilitiesContext): CapabilitiesContext => {
      const gate = mpsGate(ctx, null);
      ctx.capabilities.mps = gate.ok;
      ctx.capabilities.mpsReason = gate.reason;
      return ctx;
    };
    const none = (reason: string, extra: { engine?: DockerEngine | null; orphan?: boolean; isSelf?: boolean } = {}): CapabilitiesContext => {
      const orphan = extra.orphan ?? false;
      const isSelf = extra.isSelf ?? false;
      return withMpsGate({
        capabilities: capabilitiesFor({ applyMode: 'none', reason, standalone, services: [], orphan, isSelf }),
        target: null,
        engine: extra.engine ?? null,
        facts: null,
        services: [],
        orphan,
        isSelf,
      });
    };

    const orphanReason = "This stack's engine was deleted — nothing can be applied";
    if (stack.engineId == null) return none(orphanReason, { orphan: true });
    const engine = await engineService.getById(stack.engineId);
    if (!engine) return none(orphanReason, { orphan: true });
    if (!engine.enabled) {
      return none(`Engine ${engine.name} is disabled — limits are stored; Save again once it is enabled`, { engine });
    }
    const daemonKey = await engineFactsService.daemonKey(engine.id);
    if (await selfProjectService.isSelfProject(stack.composeProject, daemonKey)) {
      return none("Oblihub's own stack cannot be capped from inside Oblihub", { engine, isSelf: true });
    }

    const facts = opts.cacheOnly
      ? engineFactsService.peek(engine.id)
      : await engineFactsService.get(engine.id, { timeoutMs: 8_000 });
    const target = stack.composeProject
      ? await composeRunner.resolveTarget({ stackId: stack.id }, { requireComposeFile: true })
      : null;

    let applyMode: ResourceApplyMode;
    let reason: string | null = null;
    if (target && engine.type !== 'https-apikey') {
      applyMode = 'compose';
    } else {
      applyMode = 'docker-update';
      if (standalone) reason = 'Standalone containers have no compose file — CPU/RAM applied live with docker update';
      else if (engine.type === 'https-apikey') reason = 'This engine uses the HTTP socket-proxy transport, which the compose CLI cannot target — CPU/RAM applied with docker update';
      else reason = 'Not compose-manageable here (not a managed stack on this engine, nor an Oblihub stacks-dir folder) — CPU/RAM applied live with docker update';
    }
    const services = target ? readComposeServices(target) : [];
    return withMpsGate({
      capabilities: capabilitiesFor({ applyMode, reason, standalone, services, orphan: false, isSelf: false }),
      target,
      engine,
      facts,
      services,
      orphan: false,
      isSelf: false,
    });
  },

  async apply(
    stackId: number,
    limits: ResourceLimits,
    ctx: { role: string; userId: number | null },
  ): Promise<{ stack: Stack; apply: ResourceApplyResult }> {
    const stack = await stackService.getById(stackId);
    if (!stack) throw new AppError(404, 'Stack not found');
    // Enabling MPS is admin-only. Checked against the stored block, which normalize() does not
    // know: a non-admin re-sending an admin's block unchanged keeps it exactly as stored. The body
    // rules (Opportunistic, visible GPU) already ran in normalize(), so a non-admin demoting an MPS
    // stack gets that 400, and the engine-level gate below still runs for a kept block.
    if (ctx.role !== 'admin' && limits.mps?.enabled) {
      const storedMps = stack.resourceLimits?.mps ?? null;
      if (mpsChangeRefused(limits.mps, storedMps)) throw new AppError(403, MPS_ADMIN_ONLY);
      limits = { ...limits, mps: storedMps };
    }
    // normalize() has no stored limits: the yield targets are checked here, before anything else
    // looks at the limits (an invalid target alone must not make the self stack's Save a 400).
    let yieldWarning: string | null = null;
    if (limits.yieldsToStackIds) {
      const targets = await allowedYieldTargets(stack, limits.yieldsToStackIds, ctx);
      if (targets.dropped.length > 0) {
        logger.info({ stackId, userId: ctx.userId, dropped: targets.dropped }, 'Resource limits: yield targets dropped');
        yieldWarning = `Yield target(s) ${targets.dropped.map((id) => `#${id}`).join(', ')} ignored: not a Critical stack you can access`;
        limits = { ...limits, yieldsToStackIds: targets.kept };
      }
    }
    const withYieldWarning = (apply: ResourceApplyResult): ResourceApplyResult =>
      (yieldWarning ? { ...apply, warnings: [yieldWarning, ...apply.warnings] } : apply);

    // The self stack refuses limits and any priority other than normal — a Save that asks for
    // neither (the Resources tab's default form) is a no-op, not an error: it just clears.
    if (isInertLimits(limits) && await isSelfStack(stack)) {
      const apply = await resourceLimitsService.clear(stackId, ctx);
      const saved = await stackService.getById(stackId);
      if (!saved) throw new AppError(404, 'Stack not found');
      return { stack: saved, apply: withYieldWarning(apply) };
    }
    await resourceLimitsService.assertEditable(stack, ctx, 'set');
    // One bounded host snapshot shared by the GPU catalog check and the MPS gate.
    let snapPromise: Promise<EngineHostSnapshot | null> | null = null;
    const snapshot = (): Promise<EngineHostSnapshot | null> =>
      (snapPromise ??= stack.engineId != null ? snapshotOf(stack.engineId) : Promise.resolve(null));
    await assertGpusExist(stack, limits, snapshot);

    let caps: CapabilitiesContext | null = null;
    if (limits.mps?.enabled) {
      // A refused MPS request must not store anything, so the engine-level checks run before
      // the save; the context is reused for the apply below.
      caps = await resourceLimitsService.resolveCapabilities(stack);
      assertMpsAllowed(caps, limits.mps, await snapshot());
    }

    await stackService.saveResourceLimits(stackId, limits);
    supersedePending(stackId);
    caps ??= await resourceLimitsService.resolveCapabilities(stack);
    const saved = await stackService.getById(stackId);
    if (!saved) throw new AppError(404, 'Stack not found');

    let apply: ResourceApplyResult;
    const mode = caps.capabilities.applyMode;
    const rawErrors = ctx.role === 'admin';
    if (mode === 'none') apply = result('stored-only', false, caps.capabilities.reason ?? 'Stored only');
    else if (mode === 'compose') apply = await composeApply(saved, caps, false, rawErrors);
    // `stack` was read before the save: its limits say which caps the previous Save wrote.
    else apply = await dockerUpdateApply(saved, caps, limits, stack.resourceLimits, rawErrors);
    logger.info({ stackId, userId: ctx.userId, mode: apply.mode, ok: apply.ok, deferred: apply.deferred }, `Resource limits saved: ${apply.message}`);
    return { stack: saved, apply: withYieldWarning(apply) };
  },

  async clear(stackId: number, ctx: { role: string; userId: number | null }): Promise<ResourceApplyResult> {
    const stack = await stackService.getById(stackId);
    if (!stack) throw new AppError(404, 'Stack not found');
    await resourceLimitsService.assertEditable(stack, ctx, 'clear');

    await stackService.saveResourceLimits(stackId, null);
    supersedePending(stackId);
    const caps = await resourceLimitsService.resolveCapabilities(stack);

    let apply: ResourceApplyResult;
    const mode = caps.capabilities.applyMode;
    const rawErrors = ctx.role === 'admin';
    if (mode === 'none') apply = result('stored-only', true, 'Limits cleared');
    // The override now renders nothing and the runner removes it, so compose reverts the services.
    else if (mode === 'compose') apply = await composeApply(stack, caps, true, rawErrors);
    else apply = await dockerUpdateClear(stack, caps, stack.resourceLimits, rawErrors);
    logger.info({ stackId, userId: ctx.userId, mode: apply.mode, ok: apply.ok, deferred: apply.deferred }, `Resource limits cleared: ${apply.message}`);
    return apply;
  },

  /** A compose apply is waiting for the priority watchdog to resume the stack. */
  isPending(stackId: number): boolean {
    return pending.has(stackId);
  },

  /**
   * GET /api/stacks/:id/resources. Everything describes the stack's OWN engine: capacity, GPUs and
   * power limits come from that engine, never from the hub (an orphaned stack gets none). The tab
   * polls this, so it reads engine facts from the cache and bounds the host snapshot to 2 s.
   */
  async getInfo(stackId: number, viewer: { userId: number; role: string }): Promise<StackResourcesInfo> {
    const stack = Number.isSafeInteger(stackId) && stackId > 0 ? await stackService.getById(stackId) : null;
    if (!stack) throw new AppError(404, 'Stack not found');
    const caps = await resourceLimitsService.resolveCapabilities(stack, { cacheOnly: true });
    const engine = caps.engine;

    const [snap, criticalStacks] = await Promise.all([
      engine && engine.enabled ? snapshotOf(engine.id) : Promise.resolve(null),
      criticalStackRefs(stack, viewer),
    ]);

    // The local daemon is this host; a remote engine's unknown capacity stays unknown.
    const localDaemon = engine?.type === 'local';
    const capacity = {
      cpuCount: caps.facts?.cpuCount ?? snap?.facts.cpuCount ?? (localDaemon ? os.cpus().length || null : null),
      ramBytes: caps.facts?.memTotalBytes ?? snap?.facts.ramBytes ?? (localDaemon ? os.totalmem() || null : null),
    };

    const hostGpus = snap?.gpu.gpus ?? [];
    let gpuStatus: StackResourcesInfo['gpuStatus'];
    // The raw text can carry host paths or SSH errors: non-admins get the redacted one. The raw
    // snapshot stays in use below (mpsGate, GPU checks).
    if (snap) gpuStatus = { source: snap.gpu.source, status: snap.gpu.status, message: engineHostService.forViewer(snap, viewer.role === 'admin').gpu.message };
    else if (caps.orphan || !engine) gpuStatus = { source: 'none', status: 'error', message: "This stack's engine was deleted" };
    else if (!engine.enabled) gpuStatus = { source: 'none', status: 'disabled', message: `Engine ${engine.name} is disabled` };
    // The snapshot did not answer within 2 s: unknown, which is not "no GPU".
    else gpuStatus = { source: 'none', status: 'error', message: `GPU stats of ${engine.name} did not answer in time` };

    const currentPowerLimits: Record<string, number> = {};
    for (const g of hostGpus) currentPowerLimits[g.index] = g.powerLimitCurrentWatts;

    const capabilities: StackResourceCapabilities = { ...caps.capabilities };
    if (snap?.gpu.status === 'no-gpu') {
      const reason = `No NVIDIA GPU detected on ${snap.engine.name}`;
      capabilities.gpuVisibility = false;
      capabilities.gpuVisibilityReason = reason;
    }
    // A Standalone stack's limits hit every container without a compose project on the engine.
    if (capabilities.requiresAdmin && viewer.role !== 'admin' && capabilities.canEdit) {
      capabilities.canEdit = false;
      capabilities.canEditReason = "Only admins can change a Standalone stack's limits";
    }
    // The same gate apply() enforces, with this GET's snapshot; enabling is admin-only.
    const gate = mpsGate(caps, snap);
    const isAdmin = viewer.role === 'admin';
    capabilities.mps = gate.ok && isAdmin;
    capabilities.mpsReason = !gate.ok ? gate.reason : isAdmin ? null : 'Admins only';

    // A GET never waits for a probe (cacheOnly answers from the cache and probes in the background).
    // The probe is a helper container on the engine, so it is only started for the viewers of the
    // MPS card (it can be enabled here, or already is); everyone else gets the cached answer, if any.
    const mpsSettings = stack.resourceLimits?.mps ?? null;
    const mpsDir = mpsSettings?.pipeDirectory ?? DEFAULT_MPS_PIPE_DIR;
    const mpsCardShown = capabilities.mps || mpsSettings?.enabled === true;
    const [mps, mpsClients] = await Promise.all([
      engine && snap?.gpu.status === 'ok'
        ? (mpsCardShown
          ? mpsDetectionService.getStatus(engine.id, mpsDir, { cacheOnly: true })
          : Promise.resolve(mpsDetectionService.peek(engine.id, mpsDir)))
        : Promise.resolve<MpsEngineStatus | null>(null),
      // A disabled or deleted engine cannot be inspected: an empty list, not a wait on a dead client.
      mpsSettings?.enabled
        ? (engine?.enabled ? mpsClientsOf(stack) : Promise.resolve<MpsClientInfo[]>([]))
        : Promise.resolve(null),
    ]);

    return {
      limits: stack.resourceLimits,
      engine: engine ? engineService.toSummary(engine) : null,
      capacity,
      hostGpus,
      gpuStatus,
      currentPowerLimits,
      capabilities,
      criticalStacks,
      pendingApply: resourceLimitsService.isPending(stack.id),
      // The probe's failures are cached and peek() returns them to every viewer of the engine.
      mps: mpsForViewer(mps, isAdmin),
      mpsClients,
      // The client's shared-GPU hint skips these, as gpu-util's ambiguity guard does.
      gpuLessOpportunisticStackIds: [...(await hooks.gpuLessStackIds())],
      // And compares these granted GPUs, not the stored ids, as gpu-util does.
      opportunisticGpuSets: await hooks.opportunisticGpuSets(),
      hostCpuCount: capacity.cpuCount ?? 0,
      hostRamGb: Math.round((capacity.ramBytes ?? 0) / 2 ** 30),
    };
  },
};

async function runDeferredApply(stackId: number, trigger: string): Promise<void> {
  // Checked and cleared synchronously: the resume event and the sweep never both run one apply.
  if (!pending.has(stackId)) return;
  pending.delete(stackId);
  unyieldedAtLastSweep.delete(stackId);
  const generation = saveGeneration.get(stackId) ?? 0;
  const stack = await stackService.getById(stackId);
  if (!stack) return;
  const caps = await resourceLimitsService.resolveCapabilities(stack);
  if (caps.capabilities.applyMode !== 'compose') {
    logger.info({ stackId, applyMode: caps.capabilities.applyMode }, 'Deferred resource apply dropped: the stack is no longer compose-applicable');
    return;
  }
  // composeApply checks the watchdog again: a stack yielded meanwhile is simply deferred again. Its
  // result only reaches the server log, so it keeps the raw engine errors.
  const apply = await composeApply(stack, caps, stack.resourceLimits == null, true);
  logger.info({ stackId, ok: apply.ok, deferred: apply.deferred, warnings: apply.warnings, details: apply.details },
    `Deferred resource apply after ${trigger}: ${apply.message}`);
  // The operator was told the limits apply on resume, and nobody reads BUSY_MESSAGE here: keep the
  // apply pending so the sweep retries it (two un-yielded sightings, ~1 min) once the other compose
  // command is done. Not when a Save or Clear ran meanwhile (see saveGeneration).
  if (busyResults.has(apply) && (saveGeneration.get(stackId) ?? 0) === generation && !pending.has(stackId)) {
    pending.add(stackId);
    schedulePendingSweep();
  }
}

async function sweepPending(): Promise<void> {
  if (pending.size === 0) {
    unyieldedAtLastSweep.clear();
    return;
  }
  const yielded = await hooks.yieldedStackIds();
  const seenBefore = new Set(unyieldedAtLastSweep);
  unyieldedAtLastSweep.clear();
  for (const stackId of [...pending]) {
    if (yielded.has(stackId)) continue;
    if (!seenBefore.has(stackId)) {
      unyieldedAtLastSweep.add(stackId);
      continue;
    }
    try {
      await runDeferredApply(stackId, 'the watchdog stopped yielding the stack');
    } catch (err) {
      logger.warn({ stackId, err: errMessage(err) }, 'Deferred resource apply failed');
    }
  }
}

function schedulePendingSweep(): void {
  if (sweepTimer != null || pending.size === 0) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    // A sweep can outlast the interval (a compose run each): one at a time, the next one waits.
    if (sweeping) { schedulePendingSweep(); return; }
    sweeping = true;
    sweepPending()
      .catch((err) => logger.warn({ err: errMessage(err) }, 'Deferred resource apply sweep failed'))
      .finally(() => { sweeping = false; schedulePendingSweep(); });
  }, PENDING_SWEEP_MS);
  // A pending apply never keeps the process alive (shutdown, check scripts).
  sweepTimer.unref();
}

// Deferred applies run when the watchdog resumes the stack; the sweep above covers the other ways a
// stack stops being yielded. The set is in memory: after a restart the next compose command of the
// stack renders the stored limits anyway.
stackEvents.on('watchdog:resumed', ({ stackId }) => runDeferredApply(stackId, 'watchdog resume'));

/** Test seams: the watchdog lookup, the pending set and one sweep pass. */
export const __test_only = { hooks, pending, sweepPending, previewWarningsForViewer };
