import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Cpu, MemoryStick, Zap, RefreshCw, Activity, Pause, Play, Ban, ExternalLink, Save, Server, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { resourcesApi } from '@/api/resources.api';
import { useAuthStore } from '@/store/authStore';
import { EngineFilterBar, type EngineFilterValue } from '@/components/EngineFilterBar';
import { apiErrorMessage } from '@/utils/apiError';
import type {
  StackPriority,
  GpuInfo,
  GpuLiveStat,
  DashStackState,
  EngineSummary,
  EngineHostSnapshot,
  EngineHostLive,
  ResourcesDashboard,
  ResourcesDashStack,
} from '@oblihub/shared';

const POLL_MS = 5000;
const TAB_STORAGE_KEY = 'oblihub.resources.engineTab';

// The selected engine tab survives reloads. Storage can be unavailable (private mode, blocked
// site data), so every access is guarded and the page simply starts on "All" without it.
function readStoredTab(): EngineFilterValue {
  try {
    const raw = localStorage.getItem(TAB_STORAGE_KEY);
    const id = raw ? Number(raw) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function storeTab(value: EngineFilterValue): void {
  try {
    if (value == null) localStorage.removeItem(TAB_STORAGE_KEY);
    else localStorage.setItem(TAB_STORAGE_KEY, String(value));
  } catch { /* not remembered, nothing else depends on it */ }
}

function priorityBadge(p: StackPriority) {
  const styles: Record<StackPriority, string> = {
    critical: 'bg-status-up/15 text-status-up border-status-up/30',
    normal: 'bg-accent/15 text-accent border-accent/30',
    opportunistic: 'bg-status-warning/15 text-status-warning border-status-warning/30',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider ${styles[p]}`}>
      {p}
    </span>
  );
}

function stateBadge(state: DashStackState) {
  const map: Record<DashStackState, { label: string; cls: string; icon: ReactNode }> = {
    running:              { label: 'Running',            cls: 'bg-status-up/10 text-status-up',           icon: <Play size={11} /> },
    'paused-by-watchdog': { label: 'Paused (watchdog)',  cls: 'bg-status-warning/15 text-status-warning', icon: <Pause size={11} /> },
    stopped:              { label: 'Stopped',            cls: 'bg-status-down/10 text-status-down',       icon: <Ban size={11} /> },
    mixed:                { label: 'Partial',            cls: 'bg-bg-tertiary text-text-muted',           icon: <Activity size={11} /> },
  };
  const m = map[state] ?? map.mixed;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${m.cls}`}>
      {m.icon}
      {m.label}
    </span>
  );
}

function Bar({ value, max = 100, tone = 'accent' }: { value: number; max?: number; tone?: 'accent' | 'up' | 'warning' | 'down' }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const toneMap: Record<string, string> = {
    accent: 'bg-accent',
    up: 'bg-status-up',
    warning: 'bg-status-warning',
    down: 'bg-status-down',
  };
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
      <div className={`h-full ${toneMap[tone]} transition-[width] duration-500 ease-out`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function GpuChip({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center rounded border border-border bg-bg-tertiary px-1.5 py-[1px] font-mono text-[10px] text-text-secondary">
      GPU {id}
    </span>
  );
}

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function sortStacks(stacks: ResourcesDashStack[]): ResourcesDashStack[] {
  // Critical > Opportunistic > Normal, then busy first, then name.
  const rank: Record<StackPriority, number> = { critical: 0, opportunistic: 1, normal: 2 };
  return [...stacks].sort((a, b) => {
    const r = (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3);
    if (r !== 0) return r;
    if (!!b.isBusyNow !== !!a.isBusyNow) return (b.isBusyNow ? 1 : 0) - (a.isBusyNow ? 1 : 0);
    return a.name.localeCompare(b.name);
  });
}

/** How a stack's engine is shown everywhere on this page: an orphaned row is never
 *  presented as the local engine, and a disabled engine is flagged since it has no host card. */
function EngineLabel({ engineId, engine, fallbackName }: { engineId: number | null | undefined; engine: EngineSummary | undefined; fallbackName?: string | null }) {
  // Only an explicit null is an orphan; an absent field means the server sent no engine info.
  if (engineId === null) {
    return <span className="text-status-warning" title="This stack's engine was deleted">Unknown engine</span>;
  }
  if (engineId === undefined) return <span className="text-text-muted">—</span>;
  const name = engine?.name ?? fallbackName ?? `Engine #${engineId}`;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-text-secondary">{name}</span>
      {engine?.enabled === false && (
        <span className="rounded border border-border bg-bg-tertiary px-1 py-[1px] text-[10px] text-text-muted" title="This engine is disabled: no host card, no live data">
          (disabled)
        </span>
      )}
    </span>
  );
}

// The server's freshness window scales with OBLIHUB_AGENT_INTERVAL (engineHost.service agentFreshMs:
// max(15 s, 2.5 x interval)) and the client never learns the interval, so the tooltips state the
// rule rather than a fixed number that would be wrong for any non-default interval.
const AGENT_STALE_TITLE = 'The newest host-agent sample is older than 2.5 x the agent interval (at least 15 s)';

/** 'host' = whole-machine figures (the hub's OS or the engine's host agent); 'containers only' =
 *  the sum of container stats, because nothing on that engine reports host totals. */
function liveSourceHint(live: EngineHostLive | undefined): { label: string; title: string } | null {
  if (!live) return null;
  if (live.stale) return { label: 'agent stale', title: `${AGENT_STALE_TITLE}: figures may be outdated` };
  switch (live.source) {
    case 'local-os':
    case 'agent':
      return { label: 'host', title: 'Whole-host figures' };
    case 'containers-aggregate':
      return { label: 'containers only', title: 'Sum of the containers on this engine: no host agent reports whole-host figures here' };
    default:
      return null;
  }
}

function liveSummary(live: EngineHostLive | undefined): string | null {
  if (!live) return null;
  const parts: string[] = [];
  if (isNum(live.cpuPercent)) parts.push(`CPU ${Math.round(live.cpuPercent)}%`);
  if (isNum(live.ramPercent)) parts.push(`RAM ${Math.round(live.ramPercent)}%`);
  if (live.loadAvg && isNum(live.loadAvg[0])) parts.push(`load ${live.loadAvg[0].toFixed(1)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

const AGENT_STATE_LABEL: Record<string, string> = {
  disabled: 'off',
  'not-needed': 'not needed',
  creating: 'starting',
  running: 'running',
  error: 'error',
  unsupported: 'unsupported',
};

function agentNeedsRetry(host: EngineHostSnapshot): boolean {
  return host.agent?.state === 'error' || host.agent?.state === 'unsupported';
}

/** One sentence per engine whose GPUs cannot be shown as cards. */
function gpuStatusText(host: EngineHostSnapshot): string {
  const name = host.engine.name;
  const msg = host.gpu?.message;
  switch (host.gpu?.status) {
    case 'no-gpu': return `No NVIDIA runtime on ${name}`;
    case 'unsupported': return `${name} — agent unsupported${msg ? `: ${msg}` : ''}`;
    case 'starting': return `${name} — starting…`;
    case 'disabled': return `${name} — disabled (host agent off)`;
    case 'error': return `${name} — GPU stats unavailable${msg ? `: ${msg}` : ''}`;
    default: return `${name} — no GPUs reported`;
  }
}

function gpuStatusShort(host: EngineHostSnapshot): string {
  switch (host.gpu?.status) {
    case 'no-gpu': return 'no NVIDIA runtime';
    case 'unsupported': return 'agent unsupported';
    case 'starting': return 'starting…';
    case 'disabled': return 'host agent off';
    case 'error': return 'GPU stats error';
    default: return host.gpu?.gpus?.length ? host.gpu.gpus[0].name : 'no GPUs';
  }
}

/** The `host` object a server older than this client sends in place of `engines`/`hosts`. The
 *  client container is recreated before the server self-updates, so this payload is really seen. */
interface LegacyDashHost {
  cpuCount?: number;
  ramBytes?: number;
  gpus?: GpuInfo[];
  gpuLive?: GpuLiveStat[];
  currentPowerLimits?: Record<string, number>;
  platform?: string;
  arch?: string;
  cpuModel?: string | null;
  cpuTemperatureCelsius?: number | null;
}

type DashboardPayload = ResourcesDashboard & { host?: LegacyDashHost };

/** An older server only knows the hub, so its `host` becomes the single host card. Id 0 is never a
 *  real engine id; it is never sent to the server because the power limits stay locked (the old
 *  server has no per-engine power-limit endpoint and cannot reset to default). */
function legacyHostSnapshot(raw: LegacyDashHost | undefined): EngineHostSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const gpus = (Array.isArray(raw.gpus) ? raw.gpus : []).map(g => ({
    ...g,
    // The old GpuInfo.powerLimitCurrentWatts held the DEFAULT limit; the applied one came in
    // currentPowerLimits, else GpuCard falls back to the live sample.
    powerLimitCurrentWatts: firstPositive(raw.currentPowerLimits?.[g.index]) ?? 0,
  }));
  return {
    engine: { id: 0, name: 'Local', type: 'local', isDefault: true, enabled: true, isLocal: true },
    reachable: true,
    error: null,
    facts: {
      hostname: null,
      cpuCount: isNum(raw.cpuCount) ? raw.cpuCount : null,
      ramBytes: isNum(raw.ramBytes) ? raw.ramBytes : null,
      os: raw.platform ?? null,
      kernel: null,
      arch: raw.arch ?? null,
      dockerVersion: null,
      containersRunning: null,
      containersTotal: null,
      nvidiaRuntime: gpus.length > 0,
      fetchedAt: null,
    },
    live: {
      source: 'none',
      cpuPercent: null,
      ramUsedBytes: null,
      ramPercent: null,
      loadAvg: null,
      disk: null,
      cpuModel: raw.cpuModel ?? null,
      cpuTemperatureCelsius: isNum(raw.cpuTemperatureCelsius) ? raw.cpuTemperatureCelsius : null,
      uptimeSeconds: null,
      measuredAt: null,
      stale: false,
    },
    gpu: {
      source: 'local-nvidia-smi',
      // 'ok' even without GPUs: the old server did not tell "no runtime" apart from "no GPU".
      status: 'ok',
      message: null,
      gpus,
      live: Array.isArray(raw.gpuLive) ? raw.gpuLive : [],
      desiredPowerLimits: {},
      powerLimitEditable: false,
      measuredAt: null,
    },
    agent: { mode: 'auto', state: 'not-needed', message: null, gpuEnabled: false },
  };
}

export function ResourcesDashboardPage() {
  const [data, setData] = useState<ResourcesDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [tab, setTab] = useState<EngineFilterValue>(() => readStoredTab());
  const isAdmin = useAuthStore(s => s.user?.role === 'admin');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const load = async () => {
      try {
        const d = await resourcesApi.getResourcesDashboard();
        if (cancelled || !mounted.current) return;
        setData(d);
        setError(null);
        setLastAt(Date.now());
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => { cancelled = true; mounted.current = false; clearInterval(t); };
  }, []);

  // Manual reload trigger — fired after a power-limit save or an agent retry so the UI reflects
  // the new state without waiting for the next poll tick.
  const forceReload = async () => {
    try {
      const d = await resourcesApi.getResourcesDashboard();
      if (!mounted.current) return;
      setData(d);
      setLastAt(Date.now());
    } catch { /* soft — next poll will retry */ }
  };

  const selectTab = (value: EngineFilterValue) => {
    setTab(value);
    storeTab(value);
  };

  if (!data && !error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Resources</h1>
          <p className="text-sm text-text-muted">Live view of what's running, on which GPUs, and who's currently yielded.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <RefreshCw size={12} className="animate-spin-slow" />
          Auto-refresh every {POLL_MS / 1000}s
          {lastAt && <span className="ml-2 font-mono">· {new Date(lastAt).toLocaleTimeString()}</span>}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-status-down/40 bg-status-down/10 p-3 text-sm text-status-down">
          {error}
        </div>
      )}

      {data && <ResourcesDashboardView data={data} tab={tab} onSelectTab={selectTab} isAdmin={isAdmin} onChanged={forceReload} />}
    </div>
  );
}

/** Everything under the page header, as a pure function of the dashboard payload and the
 *  remembered tab (the polling and storage live in ResourcesDashboardPage). */
export function ResourcesDashboardView({
  data,
  tab,
  onSelectTab,
  isAdmin,
  onChanged,
}: {
  data: ResourcesDashboard;
  tab: EngineFilterValue;
  onSelectTab: (value: EngineFilterValue) => void;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const selectTab = onSelectTab;
  const forceReload = onChanged;

  const view = useMemo(() => {
    if (!data) return null;
    // A server older than the client sends `{ host, stacks, activity }`: no engines, no hosts and
    // stacks without engineId. Those stacks all run on the hub, they are not orphans, so the
    // page shows the single-host view built from `host`, without an Engine column.
    const legacy = !Array.isArray(data.engines);
    const engines = legacy ? [] : data.engines;
    const stacks = data.stacks ?? [];
    const enginesById = new Map(engines.map(e => [e.id, e] as const));
    const enabledEngines = engines.filter(e => e.enabled);
    const enabledIds = new Set(enabledEngines.map(e => e.id));
    const legacyHost = legacy ? legacyHostSnapshot((data as DashboardPayload).host) : null;
    // Host cards and tabs exist for enabled engines only.
    const hosts = legacy
      ? (legacyHost ? [legacyHost] : [])
      : (data.hosts ?? []).filter(h => enabledIds.has(h.engine.id));
    const multiEngine = enabledEngines.length >= 2;
    // A remembered engine that was disabled, deleted or hidden falls back to All.
    const activeTab = multiEngine && tab != null && enabledIds.has(tab) ? tab : null;
    const counts: Record<number, number> = {};
    for (const e of enabledEngines) counts[e.id] = 0;
    for (const s of stacks) if (s.engineId != null) counts[s.engineId] = (counts[s.engineId] ?? 0) + 1;
    return { legacy, engines, stacks, enginesById, enabledEngines, hosts, multiEngine, activeTab, counts };
  }, [data, tab]);

  return (
    <>
      {view && (
        <>
          <EngineFilterBar
            engines={view.engines}
            selected={view.activeTab}
            onSelect={selectTab}
            counts={view.counts}
            totalCount={view.stacks.length}
          />

          {!view.multiEngine && (() => {
            // Single engine: today's page. The Engine column only appears when a row does not
            // belong to that engine (orphaned, or on a disabled engine).
            const host = view.hosts[0];
            const showEngine = !view.legacy && view.stacks.some(s =>
              s.engineId === null || (s.engineId != null && view.enginesById.get(s.engineId)?.enabled === false));
            // Legacy stacks carry no engineId: every one of them runs on the only host.
            const hostStacks = host && !view.legacy ? view.stacks.filter(s => s.engineId === host.engine.id) : view.stacks;
            return (
              <>
                {host && <HostSummary host={host} stacks={hostStacks} />}
                <StacksTable stacks={sortStacks(view.stacks)} showEngine={showEngine} enginesById={view.enginesById} />
                <GpuSection hosts={host ? [host] : []} grouped={false} isAdmin={isAdmin} serverOutdated={view.legacy} onChanged={forceReload} />
              </>
            );
          })()}

          {view.multiEngine && view.activeTab == null && (
            <>
              <TotalsStrip hosts={view.hosts} enabledCount={view.enabledEngines.length} stacks={view.stacks} />
              <HostCards hosts={view.hosts} stacks={view.stacks} onSelect={selectTab} />
              <StacksTable stacks={sortStacks(view.stacks)} showEngine enginesById={view.enginesById} />
              <GpuSection hosts={view.hosts} grouped isAdmin={isAdmin} onChanged={forceReload} />
            </>
          )}

          {view.multiEngine && view.activeTab != null && (() => {
            const engineId = view.activeTab;
            const host = view.hosts.find(h => h.engine.id === engineId);
            const engineStacks = view.stacks.filter(s => s.engineId === engineId);
            const name = view.enginesById.get(engineId)?.name ?? `Engine #${engineId}`;
            return (
              <>
                {host
                  ? <HostSummary host={host} stacks={engineStacks} title={`Host — ${name}`} />
                  : <div className="rounded-lg border border-border bg-bg-secondary p-4 text-sm text-text-muted">No host data for {name}.</div>}
                <StacksTable stacks={sortStacks(engineStacks)} showEngine={false} enginesById={view.enginesById} />
                <GpuSection hosts={host ? [host] : []} grouped={false} isAdmin={isAdmin} onChanged={forceReload} />
              </>
            );
          })()}
        </>
      )}
    </>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-sm font-mono uppercase tracking-[0.14em] text-text-muted">{children}</h2>;
}

/**
 * A single summed "host" card would be misleading across heterogeneous machines (the hub's
 * cores plus a GPU box's cores are not one bigger host, and a stack only ever gets its own
 * engine's capacity), so the sums stay a one-line strip and each engine keeps its own card below.
 */
function TotalsStrip({ hosts, enabledCount, stacks }: { hosts: EngineHostSnapshot[]; enabledCount: number; stacks: ResourcesDashStack[] }) {
  // '—' when no engine reports the figure, '+' when only some do (the real total is higher).
  const sum = (values: Array<number | null | undefined>, fmt: (n: number) => string): string => {
    const known = values.filter((v): v is number => isNum(v) && v > 0);
    if (known.length === 0) return '—';
    const total = known.reduce((a, b) => a + b, 0);
    return `${fmt(total)}${known.length < values.length ? '+' : ''}`;
  };
  const cores = sum(hosts.map(h => h.facts?.cpuCount), n => String(n));
  const ram = sum(hosts.map(h => h.facts?.ramBytes), fmtBytes);
  const gpus = hosts.reduce((n, h) => n + (h.gpu?.gpus?.length ?? 0), 0);
  const running = stacks.filter(s => s.state === 'running').length;
  const item = (icon: ReactNode, value: string, label: string, title?: string) => (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <span className="text-text-muted">{icon}</span>
      <span className="font-mono text-text-primary">{value}</span>
      <span className="text-text-muted">{label}</span>
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border border-border bg-bg-secondary px-4 py-2.5 text-xs">
      {item(<Server size={12} />, String(enabledCount), enabledCount === 1 ? 'engine' : 'engines')}
      {item(<Cpu size={12} />, cores, 'cores', 'Sum over the enabled engines')}
      {item(<MemoryStick size={12} />, ram, 'RAM', 'Sum over the enabled engines')}
      {item(<Zap size={12} />, String(gpus), gpus === 1 ? 'GPU' : 'GPUs')}
      {item(<Activity size={12} />, `${running}/${stacks.length}`, 'stacks running')}
    </div>
  );
}

function Meter({ label, pct, detail }: { label: string; pct: number | null | undefined; detail?: string | null }) {
  const known = isNum(pct);
  const tone = !known ? 'accent' : pct > 90 ? 'down' : pct > 70 ? 'warning' : 'accent';
  return (
    <div>
      <div className="mb-0.5 flex justify-between font-mono text-[10px] text-text-muted">
        <span>{label}</span>
        <span>
          {known ? `${pct.toFixed(0)}%` : '—'}
          {detail && <span className="ml-1">· {detail}</span>}
        </span>
      </div>
      <Bar value={known ? pct : 0} tone={tone} />
    </div>
  );
}

function HostCards({ hosts, stacks, onSelect }: { hosts: EngineHostSnapshot[]; stacks: ResourcesDashStack[]; onSelect: (id: number) => void }) {
  if (hosts.length === 0) return null;
  return (
    <section>
      <SectionTitle>Hosts</SectionTitle>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {hosts.map(h => {
          const own = stacks.filter(s => s.engineId === h.engine.id);
          return <HostCard key={h.engine.id} host={h} stackCount={own.length} runningCount={own.filter(s => s.state === 'running').length} onSelect={onSelect} />;
        })}
      </div>
    </section>
  );
}

function HostCard({ host, stackCount, runningCount, onSelect }: { host: EngineHostSnapshot; stackCount: number; runningCount: number; onSelect: (id: number) => void }) {
  const { engine, facts, live, gpu, agent } = host;
  const hint = liveSourceHint(live);
  const gpuCount = gpu?.gpus?.length ?? 0;
  const ramDetail = isNum(live?.ramUsedBytes) && isNum(facts?.ramBytes) && facts.ramBytes > 0
    ? `${fmtBytes(live.ramUsedBytes)} / ${fmtBytes(facts.ramBytes)}`
    : null;
  return (
    <button
      type="button"
      onClick={() => onSelect(engine.id)}
      title={`Show only ${engine.name}`}
      className="rounded-lg border border-border bg-bg-secondary p-4 text-left transition-colors hover:border-accent/50 hover:bg-bg-hover/40"
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <Server size={13} className="text-text-muted" />
        <span className="truncate text-sm font-medium text-text-primary">{engine.name}</span>
        <span className="rounded border border-border bg-bg-tertiary px-1.5 py-[1px] font-mono text-[10px] text-text-muted">
          {engine.isLocal ? 'local' : 'remote'}
        </span>
        {!host.reachable && (
          <span className="rounded bg-status-down/10 px-1.5 py-[1px] text-[10px] font-medium text-status-down" title={host.error ?? 'Engine not reachable'}>
            unreachable
          </span>
        )}
        {live?.stale && (
          <span className="rounded bg-status-warning/15 px-1.5 py-[1px] text-[10px] font-medium text-status-warning" title={AGENT_STALE_TITLE}>
            stale
          </span>
        )}
      </div>
      <div className="mb-3 font-mono text-[10px] text-text-muted">
        {isNum(facts?.cpuCount) ? facts.cpuCount : '—'} cores · {isNum(facts?.ramBytes) && facts.ramBytes > 0 ? fmtBytes(facts.ramBytes) : '—'} RAM · {runningCount}/{stackCount} stacks running
      </div>
      <div className="space-y-1.5">
        <Meter label="CPU" pct={live?.cpuPercent} />
        <Meter label="RAM" pct={live?.ramPercent} detail={ramDetail} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-text-muted">
        {hint && <span title={hint.title}>source: {hint.label}</span>}
        <span className="inline-flex items-center gap-1" title={gpu?.message ?? undefined}>
          <Zap size={10} />
          {gpu?.status === 'ok'
            ? `${gpuCount} GPU${gpuCount === 1 ? '' : 's'}`
            : gpu?.status === 'no-gpu' ? 'no NVIDIA runtime' : `GPU ${gpu?.status ?? 'unknown'}`}
        </span>
        {agent && (
          <span title={agent.message ?? undefined}>
            agent: {AGENT_STATE_LABEL[agent.state] ?? agent.state}
          </span>
        )}
      </div>
    </button>
  );
}

function HostSummary({ host, stacks, title = 'Host' }: { host: EngineHostSnapshot; stacks: ResourcesDashStack[]; title?: string }) {
  const { facts, live, gpu, agent } = host;
  const hint = liveSourceHint(live);
  const line = liveSummary(live);
  const temp = live?.cpuTemperatureCelsius;
  const ramBytes = isNum(facts?.ramBytes) && facts.ramBytes > 0 ? facts.ramBytes : null;
  const gpus = gpu?.gpus ?? [];
  const cpuSub = live?.cpuModel || [facts?.arch, facts?.os].filter(Boolean).join(' · ') || '—';
  const showAgent = agent && agent.state !== 'running' && agent.state !== 'not-needed';
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="mb-1 flex items-center gap-2 text-xs text-text-muted"><Cpu size={13} /> CPU cores</div>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-semibold text-text-primary">{isNum(facts?.cpuCount) ? facts.cpuCount : '—'}</div>
            {isNum(temp) && (
              <div className={`font-mono text-sm ${
                temp >= 85 ? 'text-status-down'
                : temp >= 75 ? 'text-status-warning'
                : 'text-text-muted'
              }`}>
                🌡 {temp.toFixed(0)}°C
              </div>
            )}
          </div>
          <div className="mt-1 font-mono text-[11px] text-text-muted truncate" title={live?.cpuModel || undefined}>
            {cpuSub}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="mb-1 flex items-center gap-2 text-xs text-text-muted"><MemoryStick size={13} /> Total RAM</div>
          <div className="text-2xl font-semibold text-text-primary">{ramBytes != null ? `${Math.round(ramBytes / 1024 ** 3)} GB` : '—'}</div>
          <div className="mt-1 font-mono text-[11px] text-text-muted">{ramBytes != null ? fmtBytes(ramBytes) : 'capacity unknown'}</div>
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="mb-1 flex items-center gap-2 text-xs text-text-muted"><Zap size={13} /> GPUs detected</div>
          <div className="text-2xl font-semibold text-text-primary">{gpus.length}</div>
          <div className="mt-1 truncate font-mono text-[11px] text-text-muted" title={gpu?.message ?? undefined}>
            {gpus.length > 0 ? gpus[0].name : gpuStatusShort(host)}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="mb-1 flex items-center gap-2 text-xs text-text-muted"><Activity size={13} /> Running stacks</div>
          <div className="text-2xl font-semibold text-text-primary">
            {stacks.filter(s => s.state === 'running').length}
            <span className="ml-1 text-base font-normal text-text-muted">/ {stacks.length}</span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-text-muted">
            {stacks.filter(s => s.state === 'paused-by-watchdog').length} yielded
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Activity size={11} />
          {line ?? 'No live host metrics'}
        </span>
        {hint && (
          <span className="rounded border border-border bg-bg-tertiary px-1.5 py-[1px] text-[10px]" title={hint.title}>{hint.label}</span>
        )}
        {!host.reachable && (
          <span className="text-status-down" title={host.error ?? undefined}>unreachable{host.error ? `: ${host.error}` : ''}</span>
        )}
      </div>
      {showAgent && (
        <div className="mt-1 font-mono text-[11px] text-text-muted">
          Host agent ({agent.mode}): {AGENT_STATE_LABEL[agent.state] ?? agent.state}{agent.message ? ` — ${agent.message}` : ''}
        </div>
      )}
    </section>
  );
}

function StacksTable({ stacks, showEngine, enginesById }: { stacks: ResourcesDashStack[]; showEngine: boolean; enginesById: Map<number, EngineSummary> }) {
  const columns = showEngine ? 10 : 9;
  return (
    <section>
      <SectionTitle>Stacks</SectionTitle>
      <div className="overflow-x-auto rounded-lg border border-border bg-bg-secondary">
        <table className="w-full min-w-[1100px] text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-tertiary/50 text-left">
              <Th>Stack</Th>
              {showEngine && <Th>Engine</Th>}
              <Th>Priority</Th>
              <Th>State</Th>
              <Th className="text-right">CPU cap</Th>
              <Th className="text-right">RAM cap</Th>
              <Th>GPUs</Th>
              <Th>Signal</Th>
              <Th>Busy</Th>
              <Th className="min-w-[180px]">Live conso</Th>
            </tr>
          </thead>
          <tbody>
            {stacks.length === 0 && (
              <tr>
                <td colSpan={columns} className="p-8 text-center text-text-muted">No stacks discovered.</td>
              </tr>
            )}
            {stacks.map(s => (
              <StackRow
                key={s.id}
                s={s}
                engineCell={showEngine
                  ? <EngineLabel engineId={s.engineId} engine={s.engineId != null ? enginesById.get(s.engineId) : undefined} fallbackName={s.engineName} />
                  : null}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-[11px] font-mono uppercase tracking-wider text-text-muted ${className}`}>{children}</th>;
}

/** Critical stacks are woken by proxied traffic and the busy webhook, optionally by GPU
 *  utilization; Opportunistic stacks show how they yield. */
function signalCell(s: ResourcesDashStack): ReactNode {
  if (s.priority === 'critical') {
    return (
      <span className="font-mono text-[11px] text-text-secondary" title="Proxied traffic and the busy webhook always count">
        {s.yieldSignalSource === 'gpu-util' ? 'nginx + gpu-util' : 'nginx'}
      </span>
    );
  }
  if (s.priority === 'opportunistic' && s.yieldMode) {
    return (
      <span
        className="font-mono text-[11px] text-text-secondary"
        title={isNum(s.yieldIdleTimeoutSeconds) ? `Yields by ${s.yieldMode}; resumes after ${s.yieldIdleTimeoutSeconds}s idle` : `Yields by ${s.yieldMode}`}
      >
        {s.yieldMode}
      </span>
    );
  }
  return <span className="text-text-muted">—</span>;
}

function StackRow({ s, engineCell }: { s: ResourcesDashStack; engineCell: ReactNode | null }) {
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-bg-hover/40">
      <td className="px-3 py-2">
        <Link to={`/stack/${s.id}`} className="group inline-flex items-center gap-1.5 text-text-primary hover:text-accent">
          <span className="font-medium">{s.name}</span>
          <ExternalLink size={11} className="opacity-0 transition-opacity group-hover:opacity-100" />
        </Link>
        <div className="font-mono text-[10px] text-text-muted">
          {s.runningContainerCount}/{s.containerCount} containers
        </div>
      </td>
      {engineCell != null && <td className="px-3 py-2 text-[12px]">{engineCell}</td>}
      <td className="px-3 py-2">{priorityBadge(s.priority)}</td>
      <td className="px-3 py-2">{stateBadge(s.state)}</td>
      <td className="px-3 py-2 text-right font-mono text-[12px] text-text-secondary">
        {s.cpuCapPercent != null ? `${s.cpuCapPercent}%` : <span className="text-text-muted">—</span>}
      </td>
      <td className="px-3 py-2 text-right font-mono text-[12px] text-text-secondary">
        {s.ramCapPercent != null ? `${s.ramCapPercent}%` : <span className="text-text-muted">—</span>}
      </td>
      <td className="px-3 py-2">
        {s.visibleGpuIds == null && <span className="text-[11px] text-text-muted" title="As declared in the stack's compose">unrestricted</span>}
        {s.visibleGpuIds && s.visibleGpuIds.length === 0 && <span className="text-[11px] text-text-muted">none</span>}
        {s.visibleGpuIds && s.visibleGpuIds.length > 0 && (
          <div className="flex flex-wrap gap-1">{s.visibleGpuIds.map(id => <GpuChip key={id} id={id} />)}</div>
        )}
      </td>
      <td className="px-3 py-2">{signalCell(s)}</td>
      <td className="px-3 py-2">
        {s.isBusyNow === true && (
          <span className="inline-flex items-center gap-1 rounded-full bg-status-up/15 px-2 py-0.5 text-[11px] font-medium text-status-up">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-up" /> Busy
          </span>
        )}
        {s.isBusyNow === false && <span className="text-[11px] text-text-muted">Idle</span>}
        {s.isBusyNow == null && <span className="text-text-muted">—</span>}
      </td>
      <td className="px-3 py-2">
        <ConsoBars s={s} />
      </td>
    </tr>
  );
}

function ConsoBars({ s }: { s: ResourcesDashStack }) {
  // "% of host" is relative to the stack's OWN engine: cpuShareOfEngine / ramShareOfEngine are null
  // when that engine's capacity is unknown or the stack is orphaned, never silently measured against
  // the hub. The deprecated *PercentOfHost fields send 0 in that case, so they are only read from an
  // older server that does not send *ShareOfEngine yet.
  // Typed as possibly partial: the payload may come from a server that predates those keys.
  const conso: Partial<ResourcesDashStack['conso']> | undefined = s.conso;
  const cpuUsed = conso && 'cpuShareOfEngine' in conso
    ? (isNum(conso.cpuShareOfEngine) ? conso.cpuShareOfEngine : null)
    : (isNum(conso?.cpuPercentOfHost) ? conso.cpuPercentOfHost : null);
  const ramUsed = conso && 'ramShareOfEngine' in conso
    ? (isNum(conso.ramShareOfEngine) ? conso.ramShareOfEngine : null)
    : (isNum(conso?.ramPercentOfHost) ? conso.ramPercentOfHost : null);
  const cpuOfCap = isNum(s.conso?.cpuPercentOfCap) ? s.conso.cpuPercentOfCap : null;
  const ramOfCap = isNum(s.conso?.ramPercentOfCap) ? s.conso.ramPercentOfCap : null;
  const cpuTone = cpuOfCap != null && cpuOfCap > 90 ? 'down' : cpuOfCap != null && cpuOfCap > 70 ? 'warning' : 'accent';
  const ramTone = ramOfCap != null && ramOfCap > 90 ? 'down' : ramOfCap != null && ramOfCap > 70 ? 'warning' : 'accent';
  return (
    <div className="space-y-1.5">
      <div>
        <div className="mb-0.5 flex justify-between font-mono text-[10px] text-text-muted">
          <span>CPU</span>
          <span>
            {cpuUsed != null ? `${cpuUsed.toFixed(1)}% of host` : '—'}
            {cpuOfCap != null && <span className="ml-1 text-accent">· {cpuOfCap.toFixed(0)}% of cap</span>}
          </span>
        </div>
        <Bar value={cpuOfCap ?? cpuUsed ?? 0} tone={cpuTone} />
      </div>
      <div title={ramUsed != null ? `${ramUsed.toFixed(1)}% of the engine's RAM` : "Engine RAM unknown: no % of host"}>
        <div className="mb-0.5 flex justify-between font-mono text-[10px] text-text-muted">
          <span>RAM</span>
          <span>
            {fmtBytes(s.conso?.ramBytes ?? 0)}
            {ramOfCap != null && <span className="ml-1 text-accent">· {ramOfCap.toFixed(0)}% of cap</span>}
          </span>
        </div>
        <Bar value={ramOfCap ?? ramUsed ?? 0} tone={ramTone} />
      </div>
    </div>
  );
}

function firstPositive(...values: Array<number | null | undefined>): number | null {
  for (const v of values) if (isNum(v) && v > 0) return v;
  return null;
}

/** Per-GPU card. Kept as its own component because it holds local state for the editable
 *  power-limit slider (pending wattage before Save + saving-in-flight flag). */
function GpuCard({
  gpu,
  live,
  engineId,
  editable,
  lockedReason,
  reappliedAfterReboot,
  onSaved,
}: {
  gpu: GpuInfo;
  live: GpuLiveStat | undefined;
  engineId: number;
  editable: boolean;
  lockedReason: string | null;
  reappliedAfterReboot: boolean;
  onSaved: () => void;
}) {
  // powerLimitCurrentWatts is the applied limit (power.limit) since the multi-engine work; the
  // live sample carries the same value and covers a card whose static reading is missing.
  const appliedWatts = firstPositive(gpu.powerLimitCurrentWatts, live?.powerLimitWatts) ?? 0;
  const minW = Math.max(1, Math.round(gpu.powerLimitMinWatts || 0));
  const maxW = Math.max(minW + 1, Math.round(gpu.powerLimitMaxWatts || 0));
  const clamp = (w: number) => Math.max(minW, Math.min(maxW, w));
  const [pending, setPending] = useState<number>(clamp(Math.round(appliedWatts)));
  const [saving, setSaving] = useState(false);

  // Re-sync pending whenever the applied wattage moves (fresh poll or external change).
  const lastApplied = useRef<number>(Math.round(appliedWatts));
  useEffect(() => {
    if (Math.round(appliedWatts) !== lastApplied.current) {
      lastApplied.current = Math.round(appliedWatts);
      setPending(clamp(Math.round(appliedWatts)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedWatts]);

  // Compared with the clamped value: an applied limit outside the slider range (N/A readings
  // stored as 0) must not read as an edit the admin never made.
  const dirty = pending !== clamp(Math.round(appliedWatts));
  // Same test as the server's powerRange(): without a max, every set/reset is refused with 409,
  // so the controls are locked here rather than offered and left to fail.
  const hasRange = gpu.powerLimitMaxWatts > 0;
  const cardEditable = editable && hasRange;
  const cardLockedReason = hasRange ? lockedReason : 'This GPU does not report an adjustable power limit';
  // The uuid survives index renumbering (driver reload, GPU added), so it is the key the server
  // persists and re-applies by.
  const gpuKey = gpu.uuid || gpu.index;

  const send = async (watts: number | null) => {
    setSaving(true);
    try {
      const r = await resourcesApi.setGpuPowerLimit(engineId, gpuKey, watts);
      if (watts == null) {
        toast.success(`GPU ${gpu.index} power limit reset to its default`);
      } else {
        const shown = r?.appliedWatts ?? r?.requestedWatts ?? watts;
        toast.success(`GPU ${gpu.index} power limit set to ${Math.round(shown)}W`);
      }
      if (r?.message) toast(r.message, { duration: 10_000 });
      onSaved();
    } catch (e) {
      // 409 (helper refused, engine unreachable) and 502 (nvidia-smi failed) carry the exact host
      // command to run by hand, so the toast stays long enough to copy it.
      toast.error(apiErrorMessage(e, `Failed to set the power limit of GPU ${gpu.index}`), { duration: 15_000 });
    } finally {
      setSaving(false);
    }
  };

  const util = live?.utilizationGpuPercent ?? 0;
  const memUsed = live?.memoryUsedMb ?? 0;
  const memTotal = live?.memoryTotalMb ?? gpu.memoryTotalMb;
  const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
  const powerDraw = live?.powerDrawWatts ?? 0;
  const powerPct = appliedWatts > 0 ? (powerDraw / appliedWatts) * 100 : 0;
  const utilTone: 'accent' | 'warning' | 'down' = util > 90 ? 'down' : util > 60 ? 'warning' : 'accent';

  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <GpuChip id={gpu.index} />
            <span className="text-sm font-medium text-text-primary">{gpu.name}</span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-text-muted">
            {memTotal} MB VRAM · applied {appliedWatts.toFixed(0)}W ({(gpu.powerLimitMinWatts || 0).toFixed(0)}–{(gpu.powerLimitMaxWatts || 0).toFixed(0)}W range)
          </div>
          {/* Temp + fan on their own line — only shown when nvidia-smi returned a value. Passive
           *  L40S/A100 cards show temp but no fan (null), silently omitted. */}
          {(live?.temperatureCelsius != null || live?.fanSpeedPercent != null) && (
            <div className="mt-1 flex items-center gap-3 font-mono text-[11px]">
              {live?.temperatureCelsius != null && (
                <span className={
                  live.temperatureCelsius >= 85 ? 'text-status-down'
                  : live.temperatureCelsius >= 75 ? 'text-status-warning'
                  : 'text-text-muted'
                }>
                  🌡 {live.temperatureCelsius.toFixed(0)}°C
                </span>
              )}
              {live?.fanSpeedPercent != null && (
                <span className="text-text-muted">🌀 {live.fanSpeedPercent.toFixed(0)}%</span>
              )}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className={`text-2xl font-semibold ${util > 90 ? 'text-status-down' : util > 60 ? 'text-status-warning' : 'text-accent'}`}>
            {util.toFixed(0)}%
          </div>
          <div className="text-[10px] font-mono text-text-muted">GPU util</div>
        </div>
      </div>

      <div className="space-y-2">
        <div>
          <div className="mb-0.5 flex justify-between font-mono text-[10px] text-text-muted">
            <span>Compute</span><span>{util.toFixed(0)}%</span>
          </div>
          <Bar value={util} tone={utilTone} />
        </div>
        <div>
          <div className="mb-0.5 flex justify-between font-mono text-[10px] text-text-muted">
            <span>VRAM</span><span>{memUsed}/{memTotal} MB · {memPct.toFixed(0)}%</span>
          </div>
          <Bar value={memPct} tone={memPct > 90 ? 'warning' : 'accent'} />
        </div>
        <div>
          <div className="mb-0.5 flex justify-between font-mono text-[10px] text-text-muted">
            <span>Power draw</span><span>{powerDraw.toFixed(0)}W / {appliedWatts.toFixed(0)}W · {powerPct.toFixed(0)}%</span>
          </div>
          <Bar value={powerPct} tone={powerPct > 95 ? 'down' : powerPct > 80 ? 'warning' : 'up'} />
        </div>
      </div>

      {/* Editable host-wide power limit. Live throughout the app: any container using this GPU
       *  is throttled the moment nvidia-smi -pl returns. Discourage micro-tuning by requiring
       *  an explicit Save (avoids driver spam during slider drag). */}
      <div className="mt-4 border-t border-border pt-3">
        <div className="mb-1.5 flex items-center justify-between text-[11px] font-mono uppercase tracking-wider text-text-muted">
          <span>Host-wide power limit</span>
          <span className="text-text-primary">
            {hasRange ? `${pending}W` : 'N/A'} {cardEditable && dirty && <span className="text-status-warning">(unsaved)</span>}
          </span>
        </div>
        <div className="flex items-center gap-2" title={cardEditable ? undefined : cardLockedReason ?? undefined}>
          <input
            type="range"
            min={minW}
            max={maxW}
            step={5}
            value={pending}
            onChange={e => setPending(parseInt(e.target.value, 10))}
            disabled={!cardEditable || saving}
            className={`flex-1 ${cardEditable ? '' : 'cursor-not-allowed opacity-60'}`}
          />
          {cardEditable ? (
            <>
              <button
                type="button"
                onClick={() => send(pending)}
                disabled={!dirty || saving}
                className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
                title="Apply via nvidia-smi -pl on the host"
              >
                <Save size={11} /> {saving ? 'Applying…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => send(null)}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                title="Restore the GPU's default limit and stop re-applying a custom one"
              >
                <RotateCcw size={11} /> Reset to default
              </button>
            </>
          ) : (
            <span className="text-[11px] text-text-muted">{cardLockedReason}</span>
          )}
        </div>
        <div className="mt-1 text-[10px] text-text-muted">
          {hasRange && <>Range {minW}–{maxW}W. </>}Affects any container using this GPU — including stacks not managed by Oblihub.
          {reappliedAfterReboot && <span className="ml-1 text-text-secondary">Oblihub re-applies this after a host reboot.</span>}
        </div>
      </div>
    </div>
  );
}

function GpuGrid({ host, isAdmin, serverOutdated = false, onChanged }: { host: EngineHostSnapshot; isAdmin: boolean; serverOutdated?: boolean; onChanged: () => void }) {
  const { gpu } = host;
  const live = gpu.live ?? [];
  const desired = gpu.desiredPowerLimits ?? {};
  const liveFor = (g: GpuInfo) => (g.uuid ? live.find(l => l.uuid === g.uuid) : undefined) ?? live.find(l => l.index === g.index);
  const editable = isAdmin && gpu.powerLimitEditable === true;
  const lockedReason = !isAdmin
    ? 'Admins only'
    : serverOutdated
      ? 'Available once the Oblihub server is updated'
      : 'Not adjustable on this engine — run nvidia-smi -pl on the host';
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {gpu.gpus.map(g => (
        <GpuCard
          key={`${host.engine.id}:${g.uuid || g.index}`}
          gpu={g}
          live={liveFor(g)}
          engineId={host.engine.id}
          editable={editable}
          lockedReason={editable ? null : lockedReason}
          reappliedAfterReboot={(g.uuid != null && desired[g.uuid] != null) || desired[`idx:${g.index}`] != null}
          onSaved={onChanged}
        />
      ))}
    </div>
  );
}

function RetryAgentButton({ host, onChanged }: { host: EngineHostSnapshot; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      const info = await resourcesApi.retryAgent(host.engine.id);
      const state = info ? (AGENT_STATE_LABEL[info.state] ?? info.state) : 'retrying';
      toast.success(`Host agent on ${host.engine.name}: ${state}`);
      onChanged();
    } catch (e) {
      toast.error(apiErrorMessage(e, `Failed to retry the host agent on ${host.engine.name}`));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={retry}
      disabled={busy}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
      title={host.agent?.message ?? undefined}
    >
      <RefreshCw size={11} className={busy ? 'animate-spin' : ''} /> Retry agent
    </button>
  );
}

function GpuStatusLine({ host, isAdmin, onChanged }: { host: EngineHostSnapshot; isAdmin: boolean; onChanged: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-text-muted">
      <span title={host.gpu?.message ?? undefined}>{gpuStatusText(host)}</span>
      {isAdmin && agentNeedsRetry(host) && <RetryAgentButton host={host} onChanged={onChanged} />}
    </div>
  );
}

function GpuSection({ hosts, grouped, isAdmin, serverOutdated = false, onChanged }: { hosts: EngineHostSnapshot[]; grouped: boolean; isAdmin: boolean; serverOutdated?: boolean; onChanged: () => void }) {
  const hasCards = (h: EngineHostSnapshot) => h.gpu?.status === 'ok' && (h.gpu.gpus?.length ?? 0) > 0;

  if (!grouped) {
    const host = hosts[0];
    return (
      <section>
        <SectionTitle>GPU utilization</SectionTitle>
        {host && hasCards(host) ? (
          <GpuGrid host={host} isAdmin={isAdmin} serverOutdated={serverOutdated} onChanged={onChanged} />
        ) : (
          <div className="rounded-lg border border-border bg-bg-secondary">
            {host
              ? <GpuStatusLine host={host} isAdmin={isAdmin} onChanged={onChanged} />
              : <div className="p-6 text-center text-sm text-text-muted">No enabled Docker engine.</div>}
          </div>
        )}
      </section>
    );
  }

  const withCards = hosts.filter(hasCards);
  const others = hosts.filter(h => !hasCards(h));
  return (
    <section>
      <SectionTitle>GPU utilization</SectionTitle>
      <div className="space-y-4">
        {withCards.map(h => (
          <div key={h.engine.id}>
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-text-primary">
              <Server size={13} className="text-text-muted" /> {h.engine.name}
            </h3>
            <GpuGrid host={h} isAdmin={isAdmin} onChanged={onChanged} />
          </div>
        ))}
        {others.length > 0 && (
          <div className="divide-y divide-border rounded-lg border border-border bg-bg-secondary">
            {others.map(h => <GpuStatusLine key={h.engine.id} host={h} isAdmin={isAdmin} onChanged={onChanged} />)}
          </div>
        )}
        {hosts.length === 0 && (
          <div className="rounded-lg border border-border bg-bg-secondary p-6 text-center text-sm text-text-muted">No enabled Docker engine.</div>
        )}
      </div>
    </section>
  );
}
