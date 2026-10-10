import type { GpuInfo, GpuLiveStat } from '@oblihub/shared';

/**
 * Wire format of the host agent and the nvidia-smi CSV parser, shared by the in-process GPU query
 * (gpuDetection.service) and the agent log stream (hostAgent.service).
 *
 * Pure on purpose: no Node APIs and no imports besides shared types, so the check scripts can
 * exercise it without Docker, and a parsing bug can never take a service down with it.
 */

/** Bump when the script or the agent container spec changes: a label mismatch makes Oblihub
 *  remove and recreate the agent on every engine. */
export const AGENT_VERSION = '1';

/** One query for both the catalog (GpuInfo) and the live sample (GpuLiveStat): one exec per poll
 *  instead of three. Order matters: parseNvidiaSmiGpuCsv reads the fields after `name` from the end. */
export const NVIDIA_QUERY = [
  'index', 'uuid', 'name', 'memory.total', 'memory.used', 'utilization.gpu', 'utilization.memory',
  'power.draw', 'power.limit', 'power.default_limit', 'power.min_limit', 'power.max_limit',
  'temperature.gpu', 'fan.speed', 'compute_mode',
].join(',');

const NVIDIA_FIELD_COUNT = 15;
// Fields after `name`; `name` is whatever sits between uuid and them (it may contain commas).
const NVIDIA_TAIL_FIELDS = 12;

/** '[N/A]', 'N/A', '[Not Supported]', '[Unknown Error]', '' → null. */
function optNumber(raw: string | undefined): number | null {
  if (raw == null) return null;
  const v = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function reqNumber(raw: string | undefined): number {
  return optNumber(raw) ?? 0;
}

function optString(raw: string | undefined): string | null {
  if (raw == null) return null;
  const v = raw.trim();
  if (!v || /^\[?(N\/A|Not Supported|Unknown Error|Insufficient Permissions)\]?$/i.test(v)) return null;
  return v;
}

/**
 * Parses `nvidia-smi --query-gpu=<NVIDIA_QUERY> --format=csv,noheader,nounits`. A line that is not a
 * GPU row (too few fields or a non-numeric index, e.g. "NVIDIA-SMI has failed because…") is kept in
 * `errors` so the caller can show the driver's own message instead of "no GPU".
 */
export function parseNvidiaSmiGpuCsv(text: string): { gpus: GpuInfo[]; live: GpuLiveStat[]; errors: string[] } {
  const gpus: GpuInfo[] = [];
  const live: GpuLiveStat[] = [];
  const errors: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < NVIDIA_FIELD_COUNT || !/^\d+$/.test(parts[0])) {
      errors.push(line.length > 300 ? line.slice(0, 300) + '…' : line);
      continue;
    }
    const n = parts.length;
    const tail = (i: number) => parts[n - NVIDIA_TAIL_FIELDS + i];
    const index = parts[0];
    const uuid = optString(parts[1]);
    const name = parts.slice(2, n - NVIDIA_TAIL_FIELDS).join(', ');
    const memoryTotalMb = Math.round(reqNumber(tail(0)));
    const powerLimit = reqNumber(tail(5));

    gpus.push({
      index,
      uuid,
      name,
      memoryTotalMb,
      powerLimitCurrentWatts: powerLimit,
      powerLimitDefaultWatts: optNumber(tail(6)),
      powerLimitMinWatts: reqNumber(tail(7)),
      powerLimitMaxWatts: reqNumber(tail(8)),
      computeMode: optString(tail(11)),
    });
    live.push({
      index,
      uuid,
      utilizationGpuPercent: reqNumber(tail(2)),
      utilizationMemoryPercent: reqNumber(tail(3)),
      memoryUsedMb: Math.round(reqNumber(tail(1))),
      memoryTotalMb,
      powerDrawWatts: reqNumber(tail(4)),
      powerLimitWatts: powerLimit,
      temperatureCelsius: optNumber(tail(9)),
      fanSpeedPercent: optNumber(tail(10)),
    });
  }
  return { gpus, live, errors };
}

/**
 * POSIX sh loop printed to the agent's stdout (a TTY, so `docker logs` returns raw lines). Each
 * iteration is one `@@BEGIN <epoch>` … `@@END` block. /proc and /sys inside a container describe the
 * HOST (no lxcfs), and `df /` on the overlay rootfs reports the Docker data-root partition.
 *
 * Built from single-quoted JS strings on purpose: a template literal would turn every `$` meant for
 * the shell into a hazard.
 */
export function buildAgentScript(nvidiaQuery: string): string {
  // The query ends up inside a shell command line: only the characters nvidia-smi field names use.
  if (!/^[A-Za-z0-9_.,]+$/.test(nvidiaQuery)) throw new Error('Invalid nvidia-smi query');
  return [
    'while true; do',
    'echo @@BEGIN $(date +%s)',
    'echo @@stat; head -n 1 /proc/stat',
    "echo @@meminfo; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
    'echo @@loadavg; cat /proc/loadavg',
    'echo @@uptime; cat /proc/uptime',
    "echo @@nproc; grep -c '^processor' /proc/cpuinfo",
    "echo @@cpumodel; grep -m1 '^model name' /proc/cpuinfo",
    'echo @@df; df -kP / | tail -n 1',
    'echo @@thermal; for z in /sys/class/thermal/thermal_zone*; do [ -r $z/temp ] && echo $(cat $z/type 2>/dev/null):$(cat $z/temp 2>/dev/null); done',
    'if command -v nvidia-smi >/dev/null 2>&1; then echo @@gpu; nvidia-smi --query-gpu=' + nvidiaQuery
      + ' --format=csv,noheader,nounits 2>&1; else echo @@nogpu; fi',
    'echo @@END',
    // A missing or bad interval must not turn the loop into a busy spin.
    'sleep $OBLIHUB_AGENT_INTERVAL || sleep 3',
    'done',
  ].join('\n');
}

export interface AgentSample {
  /** Engine clock at the start of the block, in ms. */
  at: number;
  /** Sum of the first 8 fields of the `cpu` line of /proc/stat (jiffies since boot). */
  cpuTotal: number;
  /** idle + iowait jiffies. */
  cpuIdle: number;
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
  loadAvg: [number, number, number] | null;
  uptimeSeconds: number | null;
  nproc: number | null;
  cpuModel: string | null;
  disk: { totalBytes: number; usedBytes: number } | null;
  cpuTemperatureCelsius: number | null;
  gpu: { present: boolean; error: string | null; gpus: GpuInfo[]; live: GpuLiveStat[] };
}

const CPU_ZONE_RE = /pkg|core|cpu|k1[0-9]temp|k8temp/i;

function numbersOf(line: string): number[] {
  return line.trim().split(/\s+/).map((t) => Number(t)).filter((n) => Number.isFinite(n));
}

function parseStat(lines: string[]): { cpuTotal: number; cpuIdle: number } {
  const line = lines.find((l) => /^cpu\s/.test(l));
  if (!line) return { cpuTotal: 0, cpuIdle: 0 };
  const fields = line.trim().split(/\s+/).slice(1, 9).map((t) => Number(t));
  if (fields.length < 4 || fields.some((n) => !Number.isFinite(n))) return { cpuTotal: 0, cpuIdle: 0 };
  const cpuTotal = fields.reduce((a, b) => a + b, 0);
  return { cpuTotal, cpuIdle: fields[3] + (fields[4] ?? 0) };
}

function parseMeminfo(lines: string[], key: string): number | null {
  const line = lines.find((l) => l.startsWith(key + ':'));
  if (!line) return null;
  const m = /:\s*(\d+)\s*kB/i.exec(line);
  return m ? Number(m[1]) * 1024 : null;
}

function parseDf(lines: string[]): { totalBytes: number; usedBytes: number } | null {
  // `df -kP` columns: Filesystem 1024-blocks Used Available Capacity Mounted-on. Read from the end:
  // the filesystem name is the only column that can contain spaces.
  for (let i = lines.length - 1; i >= 0; i--) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length < 6 || !/%$/.test(parts[parts.length - 2])) continue;
    const blocks = Number(parts[parts.length - 5]);
    const used = Number(parts[parts.length - 4]);
    if (!Number.isFinite(blocks) || !Number.isFinite(used) || blocks <= 0) continue;
    return { totalBytes: blocks * 1024, usedBytes: used * 1024 };
  }
  return null;
}

/** Same rule as the local header indicator: prefer CPU-shaped zones (hottest), else the hottest zone;
 *  drop readings outside 5-150 °C (VMs and broken sensors report 0 or absurd values). */
function parseThermal(lines: string[]): number | null {
  let hottest: number | null = null;
  let hottestCpuLike: number | null = null;
  for (const line of lines) {
    const sep = line.lastIndexOf(':');
    if (sep <= 0) continue;
    const type = line.slice(0, sep).trim();
    const milli = Number(line.slice(sep + 1).trim());
    if (!Number.isFinite(milli)) continue;
    const celsius = milli / 1000;
    if (celsius < 5 || celsius > 150) continue;
    if (CPU_ZONE_RE.test(type) && (hottestCpuLike == null || celsius > hottestCpuLike)) hottestCpuLike = celsius;
    if (hottest == null || celsius > hottest) hottest = celsius;
  }
  return hottestCpuLike ?? hottest;
}

/**
 * Parses one `@@BEGIN <epoch>` … `@@END` block (the lines of the last complete block are used).
 * null when either marker is missing or the epoch is not a number: a truncated block is dropped
 * rather than reported as zeros.
 */
export function parseAgentSample(lines: string[]): AgentSample | null {
  let begin = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith('@@BEGIN')) { begin = i; break; }
  }
  if (begin < 0) return null;
  let end = -1;
  for (let i = begin + 1; i < lines.length; i++) {
    if (lines[i].trim() === '@@END') { end = i; break; }
  }
  if (end < 0) return null;
  const epoch = Number(lines[begin].trim().slice('@@BEGIN'.length).trim());
  if (!Number.isFinite(epoch) || epoch <= 0) return null;

  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of lines.slice(begin + 1, end)) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('@@')) {
      current = [];
      sections.set(line.slice(2).trim(), current);
      continue;
    }
    if (current && line.trim()) current.push(line);
  }
  const section = (name: string): string[] => sections.get(name) ?? [];

  const { cpuTotal, cpuIdle } = parseStat(section('stat'));

  const load = section('loadavg').map(numbersOf).find((n) => n.length >= 3);
  const uptime = section('uptime').map(numbersOf).find((n) => n.length >= 1);
  const nprocLine = section('nproc').find((l) => /^\s*\d+\s*$/.test(l));
  const nproc = nprocLine ? Number(nprocLine.trim()) : null;
  const modelLine = section('cpumodel').find((l) => l.includes(':'));
  const cpuModel = modelLine ? modelLine.slice(modelLine.indexOf(':') + 1).trim() || null : null;

  let gpu: AgentSample['gpu'] = { present: false, error: null, gpus: [], live: [] };
  if (sections.has('gpu')) {
    const parsed = parseNvidiaSmiGpuCsv(section('gpu').join('\n'));
    gpu = {
      present: true,
      error: parsed.errors.length > 0 ? parsed.errors.join('; ') : null,
      gpus: parsed.gpus,
      live: parsed.live,
    };
  }

  return {
    at: epoch * 1000,
    cpuTotal,
    cpuIdle,
    memTotalBytes: parseMeminfo(section('meminfo'), 'MemTotal'),
    memAvailableBytes: parseMeminfo(section('meminfo'), 'MemAvailable'),
    loadAvg: load ? [load[0], load[1], load[2]] : null,
    uptimeSeconds: uptime ? uptime[0] : null,
    nproc: nproc != null && nproc > 0 ? nproc : null,
    cpuModel,
    disk: parseDf(section('df')),
    cpuTemperatureCelsius: parseThermal(section('thermal')),
    gpu,
  };
}
