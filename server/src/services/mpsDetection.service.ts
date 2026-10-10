import * as path from 'node:path';
import type { EngineHostSnapshot, MpsEngineStatus } from '@oblihub/shared';
import { withTimeout } from '../utils/withTimeout';
import type { OneShotResult, OneShotSpec } from './hostAgent.service';

/**
 * NVIDIA MPS daemon detection per (engine, pipe directory).
 *
 * Oblihub never starts, stops or configures the MPS control daemon; it only checks whether one
 * ANSWERS in the directory a stack points its clients at. A socket file alone proves nothing: after
 * a daemon crash the socket stays behind, and clients pointed at it would fail (or, without the
 * pipe directory, silently run uncapped). The renderer emits MPS client settings only after a live
 * answer within the last 60 s.
 *
 * Top-level imports stay pure (types, withTimeout, node:path) so composeResources.service can import
 * the allow-list without pulling in the DB or Docker; the engine host and host agent services are
 * loaded lazily when a probe actually runs.
 */

/** The only directories a stack may bind into its containers. `null` in the settings = the first one,
 *  the daemon's own default. Anything else would let a stack bind an arbitrary host path. */
export const MPS_PIPE_DIRS = ['/tmp/nvidia-mps', '/run/nvidia-mps', '/var/run/nvidia-mps'] as const;
export const DEFAULT_MPS_PIPE_DIR: string = MPS_PIPE_DIRS[0];

const DEFAULT_MAX_AGE_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 2_000;
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_MOUNT = '/mps';
const MESSAGE_MAX = 300;

const UNSUPPORTED_DIR_MESSAGE = 'unsupported pipe directory';
const CHECKING_MESSAGE = 'Checking…';
const NO_GPU_MESSAGE = 'No NVIDIA GPU on this engine';
const STALE_MESSAGE = 'Control socket present but the daemon does not answer (stale socket)';
const NOTOOL_MESSAGE = 'Control socket present, but liveness cannot be verified (nvidia-cuda-mps-control is not injected into the probe)';

/**
 * The fixed lines of an 'unknown' verdict. Every other 'unknown' message quotes the probe's raw
 * failure (Docker, ssh or image-pull text), which can name the engine's address, so viewers who may
 * not see engine hosts only get these verbatim (resourceLimits.service mpsForViewer).
 */
export const MPS_PLAIN_UNKNOWN_MESSAGES: ReadonlySet<string> = new Set([
  CHECKING_MESSAGE,
  NO_GPU_MESSAGE,
  NOTOOL_MESSAGE,
  UNSUPPORTED_DIR_MESSAGE,
]);

// Plain single-quoted lines on purpose: no template literal, so no JS interpolation can ever reach
// the shell. `timeout 5` keeps a wedged daemon from holding the helper until its own timeout.
const PROBE_SCRIPT = [
  'if [ ! -S /mps/control ]; then echo MPS:NOSOCKET; exit 0; fi',
  'if command -v nvidia-cuda-mps-control >/dev/null 2>&1; then',
  '  if echo get_server_list | timeout 5 nvidia-cuda-mps-control >/dev/null 2>&1; then echo MPS:LIVE; else echo MPS:STALE; fi',
  'else echo MPS:NOTOOL; fi',
].join('\n');

const MARKER_RE = /^MPS:(LIVE|STALE|NOSOCKET|NOTOOL)$/gm;

type ProbeVerdict = Pick<MpsEngineStatus, 'daemon' | 'message'>;

interface CacheEntry {
  status: MpsEngineStatus;
  /** Epoch ms of the probe's completion (same instant as status.checkedAt). */
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<MpsEngineStatus>>();

/** Lazy dependencies, replaceable by a check script. */
const hooks = {
  async snapshot(engineId: number): Promise<EngineHostSnapshot | null> {
    const { engineHostService } = await import('./engineHost.service');
    return engineHostService.getSnapshot(engineId);
  },
  async runOneShot(engineId: number, spec: OneShotSpec): Promise<OneShotResult> {
    const { hostAgentService } = await import('./hostAgent.service');
    return hostAgentService.runOneShot(engineId, spec);
  },
  now(): number {
    return Date.now();
  },
};

function short(text: string): string {
  const t = text.trim();
  return t.length > MESSAGE_MAX ? t.slice(0, MESSAGE_MAX) + '…' : t;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The allow-listed directory `raw` designates, or null when it is not one of them. Trailing slashes
 * and `.`/`..` segments are resolved first, so '/run/nvidia-mps/' is accepted while
 * '/tmp/../etc' is not.
 */
export function normalizeMpsPipeDir(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let normalized = path.posix.normalize(trimmed);
  while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return (MPS_PIPE_DIRS as readonly string[]).includes(normalized) ? normalized : null;
}

/**
 * Maps the probe helper's result to a daemon state. Only a helper that completed normally AND
 * printed MPS:LIVE (the control client got an answer) counts as detected. Pure, for the check script.
 */
export function interpretProbe(r: OneShotResult, dir: string): ProbeVerdict {
  if (r.refused || r.unsupported) {
    // e.g. Host agent Off: the probe is a container too, and Off forbids every Oblihub container there.
    return { daemon: 'unknown', message: short(r.error ?? 'The probe helper was refused on this engine') };
  }
  if (r.mountMissing) {
    // Mounts (not Binds) make the daemon refuse a missing source instead of creating an empty directory.
    return { daemon: 'not-detected', message: `No MPS control socket in ${dir} (the directory does not exist on the host)` };
  }
  const markers = r.exitCode === 0 ? [...(r.output ?? '').matchAll(MARKER_RE)].map((m) => m[1]) : [];
  const marker = markers.length > 0 ? markers[markers.length - 1] : null;
  switch (marker) {
    case 'LIVE': return { daemon: 'detected', message: `MPS control daemon answered in ${dir}` };
    case 'NOSOCKET': return { daemon: 'not-detected', message: `No MPS control socket in ${dir}` };
    case 'STALE': return { daemon: 'not-detected', message: STALE_MESSAGE };
    case 'NOTOOL': return { daemon: 'unknown', message: NOTOOL_MESSAGE };
    default: {
      const reason = r.error ?? (r.output ? `unexpected output: ${r.output}` : `exit code ${r.exitCode ?? 'unknown'}`);
      return { daemon: 'unknown', message: short(`The MPS probe gave no answer (${reason})`) };
    }
  }
}

function keyOf(engineId: number, dir: string): string {
  return `${engineId}:${dir}`;
}

function gpusOf(snap: EngineHostSnapshot | null): MpsEngineStatus['gpus'] {
  return (snap?.gpu.gpus ?? []).map((g) => ({ index: g.index, uuid: g.uuid ?? null, computeMode: g.computeMode ?? null }));
}

async function probe(engineId: number, dir: string): Promise<MpsEngineStatus> {
  let snap: EngineHostSnapshot | null = null;
  try {
    snap = await withTimeout(hooks.snapshot(engineId), SNAPSHOT_TIMEOUT_MS, `host snapshot of engine ${engineId}`);
  } catch {
    // Unknown GPU state is not "no GPU": the probe itself tells.
    snap = null;
  }
  const gpus = gpusOf(snap);
  let verdict: ProbeVerdict;
  if (snap?.gpu.status === 'no-gpu') {
    verdict = { daemon: 'unknown', message: NO_GPU_MESSAGE };
  } else {
    let r: OneShotResult;
    try {
      r = await hooks.runOneShot(engineId, {
        purpose: 'mps-probe',
        cmd: ['/bin/sh', '-c', PROBE_SCRIPT],
        // 'compute' makes the toolkit inject nvidia-cuda-mps-control; 'utility' keeps nvidia-smi.
        gpu: true,
        driverCapabilities: 'compute,utility',
        // HostConfig.Mounts (runOneShot never uses Binds), read-only: the probe only connects.
        mounts: [{ Type: 'bind', Source: dir, Target: PROBE_MOUNT, ReadOnly: true }],
        env: [`CUDA_MPS_PIPE_DIRECTORY=${PROBE_MOUNT}`],
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    } catch (err) {
      r = { ok: false, exitCode: null, output: '', error: errMessage(err) };
    }
    verdict = interpretProbe(r, dir);
  }
  const at = hooks.now();
  const status: MpsEngineStatus = {
    engineId,
    pipeDirectory: dir,
    daemon: verdict.daemon,
    message: verdict.message,
    checkedAt: new Date(at).toISOString(),
    gpus,
  };
  // Every outcome is cached, refusals and errors included: a probe is a container on the engine, so
  // it runs at most once a minute per (engine, directory) whatever the answer.
  cache.set(keyOf(engineId, dir), { status, at });
  return status;
}

/** Single-flight per (engine, directory): concurrent callers share one helper container. */
function probeOnce(engineId: number, dir: string): Promise<MpsEngineStatus> {
  const key = keyOf(engineId, dir);
  const running = inflight.get(key);
  if (running) return running;
  const p = probe(engineId, dir).finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

function unsupportedDir(engineId: number, raw: unknown): MpsEngineStatus {
  return {
    engineId,
    pipeDirectory: String(raw ?? '').slice(0, 64),
    daemon: 'unknown',
    message: UNSUPPORTED_DIR_MESSAGE,
    checkedAt: null,
    gpus: [],
  };
}

export const mpsDetectionService = {
  /**
   * The daemon state in `pipeDirectory` on that engine. A cached answer younger than `maxAgeMs` is
   * returned as is. `cacheOnly` (GET paths) never waits: it returns the cached answer, however old,
   * or 'Checking…', and starts a background probe. Otherwise a probe runs (shared with any in flight).
   */
  async getStatus(
    engineId: number,
    pipeDirectory: string,
    opts: { maxAgeMs?: number; cacheOnly?: boolean } = {},
  ): Promise<MpsEngineStatus> {
    const dir = normalizeMpsPipeDir(pipeDirectory);
    if (dir == null) return unsupportedDir(engineId, pipeDirectory);
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const cached = cache.get(keyOf(engineId, dir));
    if (cached && hooks.now() - cached.at <= maxAgeMs) return cached.status;
    if (opts.cacheOnly) {
      probeOnce(engineId, dir).catch(() => { /* probe() never rejects; belt and braces */ });
      return cached?.status ?? { engineId, pipeDirectory: dir, daemon: 'unknown', message: CHECKING_MESSAGE, checkedAt: null, gpus: [] };
    }
    return probeOnce(engineId, dir);
  },

  /** Cache only: a LIVE daemon was seen in that exact directory within `withinMs`. */
  isLive(engineId: number, pipeDirectory: string, withinMs: number = DEFAULT_MAX_AGE_MS): boolean {
    const dir = normalizeMpsPipeDir(pipeDirectory);
    if (dir == null) return false;
    const cached = cache.get(keyOf(engineId, dir));
    return cached != null && cached.status.daemon === 'detected' && hooks.now() - cached.at <= withinMs;
  },

  /** Cache only, never probes: the last answer for (engine, directory), however old, or null. */
  peek(engineId: number, pipeDirectory: string): MpsEngineStatus | null {
    const dir = normalizeMpsPipeDir(pipeDirectory);
    if (dir == null) return null;
    return cache.get(keyOf(engineId, dir))?.status ?? null;
  },
};

/** Test seams: lazy dependencies, the cache and the probe script. */
export const __test_only = { hooks, cache, inflight, PROBE_SCRIPT };
