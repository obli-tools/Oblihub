import * as os from 'os';
import * as fs from 'fs';
import { logger } from '../utils/logger';
import { queryLocalGpus } from './gpuDetection.service';

/**
 * Snapshot of the Docker host's resource state — CPU %, RAM used/total, disk used/total on
 * the Docker root partition. Used by the header indicator to warn the operator BEFORE a build
 * saturates the host.
 *
 * Everything is measured from inside the Oblihub server container. That's a compromise:
 *   - RAM: `os.totalmem()` / `os.freemem()` read the host's /proc/meminfo (MemTotal /
 *     MemAvailable), not the container's cgroup limit, so they describe the host even when the
 *     Oblihub container itself is memory-capped.
 *   - CPU: sampled twice ~250ms apart via `os.cpus()` cumulative user/nice/sys/idle times.
 *     Delta idle vs total yields a % that's accurate for the container's CPU view (again,
 *     usually the host when uncapped).
 *   - Disk: `fs.statfsSync('/')` reports the container's rootfs — which is the OVERLAY on top
 *     of Docker's data-root. Free/used bytes on that FS ARE the free/used bytes on the host's
 *     docker-root partition. That's the partition that fills up when the operator does big
 *     builds, so this is what we want to warn on.
 *
 * All fields are best-effort; failures return null values so the UI can render gracefully.
 */

export interface HostGpuStat {
  index: string;
  name: string;
  utilPercent: number | null;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryPercent: number | null;
  powerDrawWatts: number | null;
  powerLimitWatts: number | null;
  /** Core temp in °C. Null when nvidia-smi returned [N/A] — rare on modern cards. */
  temperatureCelsius: number | null;
  /** Fan speed %. Null on passively-cooled datacenter cards (L40S / A100 / H100) — not a
   *  failure, just no fan. */
  fanSpeedPercent: number | null;
}

export interface HostStats {
  cpu: {
    percent: number | null;
    cores: number;
    /** Best-effort model name from /proc/cpuinfo. Null when unreadable (rare — the pseudo-fs
     *  is usually mounted even in containers). */
    model: string | null;
    /** °C, hottest CPU thermal zone available. Null on VMs and other environments where
     *  /sys/class/thermal exposes no zone with a CPU-shaped label (or all read 0). */
    temperatureCelsius: number | null;
  };
  ram: { used: number; total: number; percent: number | null };
  disk: { used: number; total: number; percent: number | null; path: string };
  gpus: HostGpuStat[];
  loadAvg: [number, number, number];
  measuredAt: string;
}

async function sampleCpuTimes(): Promise<{ total: number; idle: number }> {
  const cpus = os.cpus();
  let total = 0, idle = 0;
  for (const c of cpus) {
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    idle += c.times.idle;
  }
  return { total, idle };
}

/**
 * Best-effort CPU temperature via /sys/class/thermal. Requires the kernel thermal-zone driver
 * to expose a "cpu-shaped" zone type (x86_pkg_temp on Intel, k10temp/k8temp on AMD, cpu_thermal
 * on ARM boards). On VMs and other environments where no such zone exists — or where all zones
 * read 0 — we return null so the UI hides the readout instead of showing a nonsense 0°C.
 *
 * We pick the HOTTEST matching zone as a conservative "package temperature" proxy. Different
 * distros expose the same die under different names; grabbing the max lets us reflect thermal
 * stress no matter which zone the operator's kernel populates.
 */
function readCpuTemperature(): number | null {
  try {
    const root = '/sys/class/thermal';
    if (!fs.existsSync(root)) return null;
    const entries = fs.readdirSync(root).filter(e => e.startsWith('thermal_zone'));
    let hottest: number | null = null;
    let hottestCpuLike: number | null = null;
    const cpuNameRe = /pkg|core|cpu|k1[0-9]temp|k8temp/i;
    for (const e of entries) {
      const typePath = `${root}/${e}/type`;
      const tempPath = `${root}/${e}/temp`;
      if (!fs.existsSync(typePath) || !fs.existsSync(tempPath)) continue;
      const type = fs.readFileSync(typePath, 'utf8').trim();
      const raw = fs.readFileSync(tempPath, 'utf8').trim();
      const milliC = parseInt(raw, 10);
      if (!Number.isFinite(milliC) || milliC <= 0) continue;
      const celsius = milliC / 1000;
      if (celsius < 5 || celsius > 150) continue; // filter obvious bogus readings
      if (cpuNameRe.test(type)) {
        if (hottestCpuLike == null || celsius > hottestCpuLike) hottestCpuLike = celsius;
      }
      if (hottest == null || celsius > hottest) hottest = celsius;
    }
    // Prefer a CPU-labeled zone when present; otherwise fall back to the hottest zone which is
    // usually the CPU package on server boards. On pure-VM environments both are null.
    return hottestCpuLike ?? hottest;
  } catch {
    return null;
  }
}

/** Best-effort CPU model from /proc/cpuinfo. Container-safe (procfs is mounted by default). */
function readCpuModel(): string | null {
  try {
    const raw = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const line = raw.split('\n').find(l => l.startsWith('model name'));
    if (!line) return null;
    const idx = line.indexOf(':');
    if (idx < 0) return null;
    return line.slice(idx + 1).trim() || null;
  } catch {
    return null;
  }
}

async function readDiskStats(pathToCheck: string): Promise<{ used: number; total: number; percent: number | null; path: string }> {
  try {
    // fs.statfsSync is Node ≥ 18.15 / 20+; returns block counts + block size.
    const st = fs.statfsSync(pathToCheck);
    const total = Number(st.blocks) * st.bsize;
    const free = Number(st.bfree) * st.bsize;
    const used = total - free;
    return { used, total, percent: total > 0 ? (used / total) * 100 : null, path: pathToCheck };
  } catch (err) {
    logger.debug({ pathToCheck, err: err instanceof Error ? err.message : String(err) }, 'statfs failed');
    return { used: 0, total: 0, percent: null, path: pathToCheck };
  }
}

let cache: { at: number; snap: HostStats } | null = null;
let inflight: Promise<HostStats> | null = null;
// Clients poll every 5 s; with 3 s the cache had always expired and every poll paid the 250 ms
// CPU sample plus an nvidia-smi exec.
const TTL_MS = 4_000;

export const hostStatsService = {
  /** Cached snapshot; second caller within TTL gets the memoized value. Sampling CPU takes
   *  ~250ms, so we don't want every UI poll to eat that cost. Concurrent callers (header,
   *  dashboard, engine snapshots) share one sampling run. */
  get(): Promise<HostStats> {
    if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.snap);
    if (inflight) return inflight;
    const run = sampleHost();
    inflight = run;
    const clear = () => { if (inflight === run) inflight = null; };
    run.then(clear, clear);
    return run;
  },

  /** Cached snapshot when younger than `maxAgeMs`, without sampling (for tight time budgets). */
  peek(maxAgeMs: number): HostStats | null {
    return cache && Date.now() - cache.at < maxAgeMs ? cache.snap : null;
  },
};

async function sampleHost(): Promise<HostStats> {
  // Started first so the nvidia-smi exec overlaps the 250 ms CPU sampling window.
  const gpuQuery = queryLocalGpus(1500);

  const cores = os.cpus().length;
  let cpuPercent: number | null = null;
  try {
    const s1 = await sampleCpuTimes();
    await new Promise(r => setTimeout(r, 250));
    const s2 = await sampleCpuTimes();
    const dTotal = s2.total - s1.total;
    const dIdle = s2.idle - s1.idle;
    cpuPercent = dTotal > 0 ? Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)) : null;
  } catch { /* leave null */ }

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const disk = await readDiskStats('/');
  const loadAvg = os.loadavg() as [number, number, number];

  // GPUs — nvidia-smi live snapshot when available. Empty array on hosts without GPUs OR
  // when nvidia-smi isn't callable from this container (missing runtime: nvidia, missing
  // libc compat, etc.). The header indicator omits GPU bars entirely on empty. One query gives
  // both the live values and the names.
  let gpus: HostGpuStat[] = [];
  try {
    const { live, gpus: catalog } = await gpuQuery;
    const nameByIndex = new Map(catalog.map(g => [g.index, g.name] as const));
    gpus = live.map(g => ({
      index: g.index,
      name: nameByIndex.get(g.index) || `GPU ${g.index}`,
      utilPercent: g.utilizationGpuPercent,
      memoryUsedMb: g.memoryUsedMb,
      memoryTotalMb: g.memoryTotalMb,
      memoryPercent: g.memoryTotalMb > 0 ? (g.memoryUsedMb / g.memoryTotalMb) * 100 : null,
      powerDrawWatts: g.powerDrawWatts,
      powerLimitWatts: g.powerLimitWatts,
      temperatureCelsius: g.temperatureCelsius,
      fanSpeedPercent: g.fanSpeedPercent,
    }));
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'GPU live stats unavailable');
  }

  const snap: HostStats = {
    cpu: {
      percent: cpuPercent,
      cores,
      model: readCpuModel(),
      temperatureCelsius: readCpuTemperature(),
    },
    ram: { used: usedMem, total: totalMem, percent: totalMem > 0 ? (usedMem / totalMem) * 100 : null },
    disk,
    gpus,
    loadAvg,
    measuredAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), snap };
  return snap;
}
