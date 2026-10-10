import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GpuInfo, GpuLiveStat } from '@oblihub/shared';
import { logger } from '../utils/logger';
import { NVIDIA_QUERY, parseNvidiaSmiGpuCsv } from '../utils/hostAgentProtocol';

// Defined in the pure protocol module (the host agent parses the same CSV); re-exported for callers
// that only know this service.
export { NVIDIA_QUERY, parseNvidiaSmiGpuCsv } from '../utils/hostAgentProtocol';
// Both lines are needed: the re-export alone creates no local binding for LocalGpuQuery below.
export type { GpuLiveStat };

const execFileP = promisify(execFile);

// The same validation as the power-limit route: '-i' must never receive something nvidia-smi could
// read as an option.
const GPU_KEY_RE = /^([0-9]{1,3}|GPU-[0-9a-fA-F-]{8,64})$/;

export interface LocalGpuQuery {
  /** false when nvidia-smi is not callable inside this container (binary missing / not executable). */
  available: boolean;
  /** false when nvidia-smi ran but failed (driver not loaded, timeout…); `error` says why. */
  ok: boolean;
  error: string | null;
  gpus: GpuInfo[];
  live: GpuLiveStat[];
  at: number;
}

let lastQuery: LocalGpuQuery | null = null;
let inflightQuery: Promise<LocalGpuQuery> | null = null;
// Bumped by setPowerLimit: a query started before the change must not cache the old limit.
let queryGeneration = 0;

function execErrorText(err: unknown): string {
  const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown; killed?: boolean; signal?: unknown };
  if (e?.killed && e.signal) return 'nvidia-smi timed out';
  const out = [e?.stdout, e?.stderr].filter((v): v is string => typeof v === 'string' && v.trim() !== '').join('\n').trim();
  return out || (typeof e?.message === 'string' ? e.message : String(err));
}

function isMissingBinary(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'EACCES';
}

async function runLocalQuery(): Promise<LocalGpuQuery> {
  try {
    const { stdout } = await execFileP(
      'nvidia-smi',
      ['--query-gpu=' + NVIDIA_QUERY, '--format=csv,noheader,nounits'],
      { timeout: 10_000 },
    );
    const parsed = parseNvidiaSmiGpuCsv(stdout);
    const error = parsed.errors.length > 0 ? parsed.errors.join('; ') : null;
    return { available: true, ok: parsed.gpus.length > 0 || !error, error, gpus: parsed.gpus, live: parsed.live, at: Date.now() };
  } catch (err) {
    if (isMissingBinary(err)) {
      return { available: false, ok: false, error: 'nvidia-smi is not available inside Oblihub', gpus: [], live: [], at: Date.now() };
    }
    const error = execErrorText(err);
    logger.debug({ err: error }, 'nvidia-smi query failed');
    return { available: true, ok: false, error, gpus: [], live: [], at: Date.now() };
  }
}

/**
 * GPUs of THIS host via the in-process nvidia-smi: catalog and live sample from ONE exec,
 * single-flight, reused for `maxAgeMs`. Never throws. Remote engines go through the host agent.
 */
export function queryLocalGpus(maxAgeMs = 1500): Promise<LocalGpuQuery> {
  if (lastQuery && Date.now() - lastQuery.at < maxAgeMs) return Promise.resolve(lastQuery);
  if (inflightQuery) return inflightQuery;
  const gen = queryGeneration;
  const run = runLocalQuery().then((result) => {
    if (gen === queryGeneration) lastQuery = result;
    return result;
  });
  inflightQuery = run;
  const clear = () => { if (inflightQuery === run) inflightQuery = null; };
  run.then(clear, clear);
  return run;
}

/** Last completed query, whatever its age (never execs). Lets a caller with a tight time budget
 *  fall back to a recent reading while a slow nvidia-smi (no persistence mode) is still running. */
export function peekLocalGpus(): LocalGpuQuery | null {
  return lastQuery;
}

function invalidateLocalGpuCache(): void {
  queryGeneration++;
  lastQuery = null;
  inflightQuery = null;
}

/**
 * Apply a host-wide power cap on a single GPU (index or uuid). Requires nvidia-smi in PATH,
 * root/admin on the host, and (when running inside a container) the container must be started with
 * sufficient capabilities and access to the NVIDIA management library — typically `--gpus all` and
 * the NVIDIA container runtime. Failure returns { ok:false, error } rather than throwing so the
 * caller can surface a friendly message or fall back to a helper container (`permissionDenied`,
 * `unavailable`).
 */
export async function setPowerLimit(
  gpuKey: string,
  watts: number,
): Promise<{ ok: boolean; error?: string; permissionDenied?: boolean; unavailable?: boolean }> {
  if (!GPU_KEY_RE.test(gpuKey)) return { ok: false, error: `Invalid GPU id "${gpuKey.slice(0, 80)}"` };
  if (!Number.isFinite(watts) || watts <= 0) return { ok: false, error: 'watts must be a positive number' };
  try {
    await execFileP('nvidia-smi', ['-i', gpuKey, '-pl', String(watts)], { timeout: 15_000 });
    return { ok: true };
  } catch (err: unknown) {
    if (isMissingBinary(err)) {
      return { ok: false, error: 'nvidia-smi is not available inside Oblihub', unavailable: true };
    }
    const msg = execErrorText(err);
    const fullMessage = `${msg}\n${err instanceof Error ? err.message : ''}`;
    logger.warn({ gpuKey, watts, err: msg }, 'nvidia-smi -pl failed');
    return {
      ok: false,
      error: msg,
      ...(/Insufficient Permissions|not permitted|root/i.test(fullMessage) ? { permissionDenied: true } : {}),
    };
  } finally {
    // The next read must show what the driver applied, not the value cached before the change.
    invalidateLocalGpuCache();
  }
}
