import { useEffect, useState, useCallback, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Cpu, MemoryStick, Zap, AlertTriangle, Trash2, Save, RefreshCw, Server, Lock, Clock, X, ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { stacksApi } from '@/api/stacks.api';
import { fetchStacksCached, invalidateStacksCache } from '@/hooks/useStacksList';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import type {
  CriticalStackRef,
  EngineSummary,
  GpuInfo,
  MpsClientInfo,
  MpsEngineStatus,
  MpsSettings,
  ResourceApplyMode,
  ResourceApplyResult,
  ResourceLimits,
  Stack,
  StackPriority,
  StackResourceCapabilities,
  StackResourcesInfo,
  YieldMode,
} from '@oblihub/shared';

interface Props { stackId: number }

const PRIORITY_DESCRIPTIONS: Record<StackPriority, string> = {
  critical: 'Always up. First pick on CPU / GPU. Yields nothing.',
  normal: 'Always up. Reduces CPU share when a Critical is contending, never paused.',
  opportunistic: 'Pauses or stops when a Critical you yield to becomes busy. Resumes after idle timeout.',
};

const APPLY_MODE_LABEL: Record<ResourceApplyMode, string> = {
  compose: 'Compose override',
  'docker-update': 'Live docker update (CPU/RAM only)',
  none: 'Not applicable',
};

// Slider floor: a cap below 5% starves a container rather than limiting it.
const MIN_PERCENT = 5;

function defaultLimits(): ResourceLimits {
  return {
    priority: 'normal',
    cpuPercent: null,
    ramPercent: null,
    cpuShares: null,
    visibleGpuIds: null,
    powerLimitWatts: null,
    yieldsToStackIds: null,
    yieldSignalSource: 'nginx-traffic',
    yieldIdleTimeoutSeconds: 30,
    yieldMode: 'stop',
  };
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// Used only when the server predates capability reporting (client upgraded first): today's
// behaviour, everything editable.
const LEGACY_CAPABILITIES: StackResourceCapabilities = {
  applyMode: 'compose',
  reason: null,
  cpuRamCaps: true,
  cpuShares: true,
  gpuVisibility: true,
  gpuVisibilityReason: null,
  mps: false,
  mpsReason: null,
  standaloneWarning: false,
  requiresAdmin: false,
  canEdit: true,
  canEditReason: null,
};

/** The info as this tab uses it. `engine` undefined means the server predates engine reporting,
 *  which must not read as null (an orphaned stack whose engine was deleted). */
type ResourcesInfo = Omit<StackResourcesInfo, 'engine'> & { engine: EngineSummary | null | undefined };

function normalizeInfo(raw: StackResourcesInfo): ResourcesInfo {
  const legacyRamBytes = isNum(raw.hostRamGb) && raw.hostRamGb > 0 ? raw.hostRamGb * 1024 ** 3 : null;
  const hostGpus = raw.hostGpus ?? [];
  return {
    ...raw,
    // Kept as sent: undefined (older server) must stay apart from null (orphan).
    engine: raw.engine,
    capacity: raw.capacity ?? { cpuCount: isNum(raw.hostCpuCount) && raw.hostCpuCount > 0 ? raw.hostCpuCount : null, ramBytes: legacyRamBytes },
    hostGpus,
    gpuStatus: raw.gpuStatus ?? { source: 'none', status: hostGpus.length > 0 ? 'ok' : 'no-gpu', message: null },
    currentPowerLimits: raw.currentPowerLimits ?? {},
    capabilities: { ...LEGACY_CAPABILITIES, ...(raw.capabilities ?? {}) },
    criticalStacks: raw.criticalStacks ?? [],
    pendingApply: raw.pendingApply === true,
    mps: raw.mps ?? null,
    mpsClients: raw.mpsClients ?? null,
  };
}

/** GPU ids as indices, so '1' and 'GPU-…' of the same card compare equal. null (unrestricted)
 *  counts as every GPU of the engine: a service requesting a GPU then sees all of them. */
function gpuIndexSet(ids: string[] | null | undefined, hostGpus: GpuInfo[]): Set<string> {
  if (ids == null) return new Set(hostGpus.map(g => g.index));
  const out = new Set<string>();
  for (const id of ids) {
    const g = hostGpus.find(h => h.index === id || (h.uuid != null && h.uuid === id));
    out.add(g ? g.index : id);
  }
  return out;
}

function criticalSignalLabel(cs: CriticalStackRef): string {
  return cs.signalSource === 'gpu-util' ? 'nginx + gpu-util' : 'nginx';
}

function EngineBadge({ engine }: { engine: EngineSummary | null }) {
  if (engine === null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-status-warning/40 bg-status-warning/10 px-2 py-0.5 text-[11px] text-status-warning" title="This stack's engine was deleted">
        <Server size={11} /> Unknown engine
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary" title="Limits are sized from this engine's capacity">
      <Server size={11} /> {engine.name}
      {!engine.isLocal && <span className="text-text-muted">· remote</span>}
      {engine.enabled === false && <span className="text-text-muted">(disabled)</span>}
    </span>
  );
}

function noGpuText(info: ResourcesInfo): string {
  const name = info.engine?.name ?? 'this engine';
  const msg = info.gpuStatus?.message ? `: ${info.gpuStatus.message}` : '';
  switch (info.gpuStatus?.status) {
    case 'no-gpu': return `No NVIDIA runtime on ${name} — there is no GPU to restrict.`;
    case 'starting': return `GPU detection on ${name} is starting…`;
    case 'disabled': return `GPU stats are off on ${name} (host agent off).`;
    case 'unsupported': return `GPU stats are unsupported on ${name}${msg}`;
    case 'error': return `GPU stats are unavailable on ${name}${msg}`;
    default: return `No NVIDIA GPUs found on ${name}.`;
  }
}

/** Toasts that never claim success for a failed apply: the server answers 200 with ok=false. */
function reportApply(apply: ResourceApplyResult | null, fallbackSuccess: string): void {
  if (!apply) {
    toast.success(fallbackSuccess);
    return;
  }
  if (!apply.ok) {
    toast.error(apply.message || 'The limits were saved but could not be applied', { duration: 10_000 });
  } else if (apply.deferred) {
    toast(apply.message, { icon: <Clock size={16} className="shrink-0 text-accent" />, duration: 8_000 });
  } else {
    toast.success(apply.message || fallbackSuccess);
  }
  const warnings = apply.warnings ?? [];
  if (warnings.length > 0) {
    toast(
      <div className="text-xs">
        <div className="mb-1 font-medium">{warnings.length === 1 ? 'Warning' : 'Warnings'}</div>
        <ul className="list-disc space-y-0.5 pl-4">
          {warnings.slice(0, 3).map((w, i) => <li key={i}>{w}</li>)}
          {warnings.length > 3 && <li>…</li>}
        </ul>
      </div>,
      { icon: <AlertTriangle size={16} className="shrink-0 text-status-warning" />, duration: 12_000 },
    );
  }
}

/** What the last Save/Clear did, kept on screen because toasts vanish: failure output, per-container
 *  failures and the containers that were deliberately left alone. */
function ApplyResultPanel({ apply, onDismiss }: { apply: ResourceApplyResult; onDismiss: () => void }) {
  const containers = apply.containers ?? [];
  const failed = containers.filter(c => !c.ok && !c.skipped);
  const skipped = containers.filter(c => c.skipped);
  const warnings = apply.warnings ?? [];
  if (apply.ok && failed.length === 0 && skipped.length === 0 && warnings.length === 0) return null;
  const tone = !apply.ok
    ? 'border-status-down/40 bg-status-down/5'
    : warnings.length > 0 ? 'border-status-warning/40 bg-status-warning/5' : 'border-border bg-bg-tertiary';
  return (
    <div className={`space-y-2 rounded-lg border p-3 text-xs ${tone}`}>
      <div className="flex items-start justify-between gap-2">
        <div className={apply.ok ? 'text-text-primary' : 'text-status-down'}>{apply.message}</div>
        <button type="button" onClick={onDismiss} className="shrink-0 text-text-muted hover:text-text-primary" title="Dismiss">
          <X size={12} />
        </button>
      </div>
      {!apply.ok && apply.details && (
        <details>
          <summary className="cursor-pointer text-text-muted hover:text-text-primary">Output</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-border bg-bg-primary p-2 font-mono text-[11px] text-text-secondary">{apply.details}</pre>
        </details>
      )}
      {warnings.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-status-warning">
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      {failed.length > 0 && (
        <div>
          <div className="mb-0.5 text-text-muted">Failed</div>
          <ul className="space-y-0.5 font-mono text-[11px]">
            {failed.map(c => <li key={c.dockerId || c.name} className="text-status-down">{c.name}{c.error ? ` — ${c.error}` : ''}</li>)}
          </ul>
        </div>
      )}
      {skipped.length > 0 && (
        <div>
          <div className="mb-0.5 text-text-muted">Left alone</div>
          <ul className="space-y-0.5 font-mono text-[11px] text-text-secondary">
            {skipped.map(c => <li key={c.dockerId || c.name}>{c.name} — {c.skipped}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

export function StackResourcesTab({ stackId }: Props) {
  const [info, setInfo] = useState<ResourcesInfo | null>(null);
  const [limits, setLimits] = useState<ResourceLimits>(defaultLimits());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshingGpus, setRefreshingGpus] = useState(false);
  const [lastApply, setLastApply] = useState<ResourceApplyResult | null>(null);
  const [otherStacks, setOtherStacks] = useState<Stack[] | null>(null);
  const [refreshingMps, setRefreshingMps] = useState(false);
  const [mpsPolls, setMpsPolls] = useState(0);
  const isAdmin = useAuthStore(s => s.user?.role === 'admin');

  const load = useCallback(async (): Promise<ResourcesInfo | null> => {
    try {
      const r = normalizeInfo(await stacksApi.getStackResources(stackId));
      setInfo(r);
      setLimits(r.limits || defaultLimits());
      // A Save can point MPS at another directory: its probe gets a fresh round of polls.
      setMpsPolls(0);
      return r;
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to load resources'));
      return null;
    }
  }, [stackId]);

  // Only the MPS part of the payload: a full load() resets the form and would drop unsaved edits.
  const refreshMps = useCallback(async (quiet: boolean) => {
    if (!quiet) setRefreshingMps(true);
    try {
      const r = normalizeInfo(await stacksApi.getStackResources(stackId));
      setInfo(prev => (prev ? { ...prev, mps: r.mps, mpsClients: r.mpsClients } : prev));
    } catch (err) {
      if (!quiet) toast.error(apiErrorMessage(err, 'Failed to refresh the MPS status'));
    } finally {
      if (!quiet) setRefreshingMps(false);
    }
  }, [stackId]);

  // A GET only starts the daemon probe (a helper container on the engine) and answers 'Checking…':
  // fetch the verdict a few times instead of making the operator reload.
  const mpsProbePending = info?.mps != null && info.mps.checkedAt == null && info.mps.message === 'Checking…';
  useEffect(() => {
    if (!mpsProbePending || mpsPolls >= 6) return;
    const t = setTimeout(() => {
      setMpsPolls(n => n + 1);
      void refreshMps(true);
    }, 5_000);
    return () => clearTimeout(t);
  }, [mpsProbePending, mpsPolls, refreshMps]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [load]);

  // The shared-GPU hint needs the Opportunistic stacks of this engine; only fetched once the
  // form is on Critical, from the short-lived shared stacks cache.
  const isCritical = limits.priority === 'critical';
  useEffect(() => {
    if (!isCritical || otherStacks) return;
    let alive = true;
    fetchStacksCached()
      .then(s => { if (alive) setOtherStacks(s); })
      .catch(() => { /* advisory only: no hint rather than an error */ });
    return () => { alive = false; };
  }, [isCritical, otherStacks]);

  const sharesGpuWithOpportunistic = useMemo(() => {
    if (!info || !isCritical || !otherStacks || !info.engine) return false;
    const engineId = info.engine.id;
    const mine = gpuIndexSet(limits.visibleGpuIds, info.hostGpus);
    if (mine.size === 0) return false;
    // Probed GPU-less (a CPU-only miner): the server never counts it as sharing a GPU, so it must
    // not trigger the shared-GPU warning either. Absent from older servers.
    const gpuLess = new Set(info.gpuLessOpportunisticStackIds ?? []);
    // The GPUs each Opportunistic stack's containers were actually granted, which is what the
    // server's gpu-util compares: a missing key or null there is every GPU. Absent on older
    // servers: keep the stored ids. Unmatched ids (lower-cased uuid copies) stay as they are and
    // never equal an index, so they are harmless.
    const granted = info.opportunisticGpuSets;
    return otherStacks.some(s => {
      if (s.id === stackId || s.engineId !== engineId || s.resourceLimits?.priority !== 'opportunistic') return false;
      if (gpuLess.has(s.id)) return false;
      const theirs = granted ? (granted[s.id] ?? null) : s.resourceLimits.visibleGpuIds;
      for (const idx of gpuIndexSet(theirs, info.hostGpus)) if (mine.has(idx)) return true;
      return false;
    });
  }, [info, isCritical, otherStacks, limits.visibleGpuIds, stackId]);

  const refreshGpus = async () => {
    setRefreshingGpus(true);
    try {
      if (await load()) toast.success('GPU detection refreshed');
    } finally {
      setRefreshingGpus(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      // Power limits are strictly host-wide (nvidia-smi -pl affects any container using the
      // GPU). Editing them from the per-stack tab was misleading UX — two stacks would show
      // the same value and appear to "own" it. The slider on this tab is now read-only, and
      // we strip powerLimitWatts from the save payload so nothing here can mutate host state.
      // Edits happen on /resources dashboard exclusively.
      const { powerLimitWatts: _stripped, ...payload } = limits;
      void _stripped;
      const { apply } = await stacksApi.setStackResources(stackId, payload as ResourceLimits);
      invalidateStacksCache();
      reportApply(apply, 'Resource limits saved');
      setLastApply(apply);
      await load();
    } catch (err) {
      // 400 (invalid value, Oblihub's own stack), 403 (Standalone needs an admin), 409 (engine
      // deleted) carry a message written for the operator.
      toast.error(apiErrorMessage(err, 'Failed to save limits'));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    const mode = info?.capabilities.applyMode ?? 'compose';
    const question = mode === 'compose'
      ? 'Clear the resource limits? Oblihub\'s override is removed and running services will be recreated (stopped ones stay stopped).'
      : mode === 'docker-update'
        ? 'Clear the resource limits? CPU/RAM caps lifted live with docker update — containers keep running.'
        : 'Clear the stored resource limits? Nothing is applied to containers.';
    if (!confirm(question)) return;
    setSaving(true);
    try {
      const apply = await stacksApi.clearStackResources(stackId);
      invalidateStacksCache();
      reportApply(apply, 'Resource limits cleared');
      setLastApply(apply);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to clear'));
    } finally {
      setSaving(false);
    }
  };

  if (loading || !info) {
    return <div className="rounded-xl border border-border bg-bg-secondary p-6 text-center text-xs text-text-muted">Loading resources…</div>;
  }

  return (
    <StackResourcesView
      info={info}
      limits={limits}
      onChange={setLimits}
      saving={saving}
      refreshingGpus={refreshingGpus}
      lastApply={lastApply}
      onDismissApply={() => setLastApply(null)}
      onSave={save}
      onClear={clear}
      onRefreshGpus={refreshGpus}
      sharesGpuWithOpportunistic={sharesGpuWithOpportunistic}
      isAdmin={isAdmin}
      refreshingMps={refreshingMps}
      onRefreshMps={() => { void refreshMps(false); }}
    />
  );
}

/** The tab's body as a pure function of its props; loading, saving and the edited limits live in
 *  StackResourcesTab. */
export function StackResourcesView({
  info,
  limits,
  onChange: setLimits,
  saving,
  refreshingGpus,
  lastApply,
  onDismissApply,
  onSave,
  onClear,
  onRefreshGpus,
  sharesGpuWithOpportunistic,
  isAdmin,
  refreshingMps = false,
  onRefreshMps,
}: {
  info: ResourcesInfo;
  limits: ResourceLimits;
  onChange: (limits: ResourceLimits) => void;
  saving: boolean;
  refreshingGpus: boolean;
  lastApply: ResourceApplyResult | null;
  onDismissApply: () => void;
  onSave: () => void;
  onClear: () => void;
  onRefreshGpus: () => void;
  sharesGpuWithOpportunistic: boolean;
  /** Viewer role. Omitted: inferred from capabilities.mps, which the server only grants to admins. */
  isAdmin?: boolean;
  refreshingMps?: boolean;
  onRefreshMps?: () => void;
}) {
  const caps = info.capabilities;
  const readOnly = !caps.canEdit;
  const cpuRamDisabled = readOnly || !caps.cpuRamCaps;
  const gpuDisabled = readOnly || !caps.gpuVisibility;
  const showMps = caps.mps || limits.mps?.enabled === true || info.limits?.mps?.enabled === true;
  const pauseVramCapGb = limits.mps?.enabled ? mpsPauseCapGb(limits, info.hostGpus) : null;

  const toggleGpuVisible = (g: GpuInfo, checked: boolean) => {
    const cur = limits.visibleGpuIds == null ? info.hostGpus.map(h => h.index) : [...limits.visibleGpuIds];
    const without = cur.filter(id => id !== g.index && id !== g.uuid);
    setLimits({ ...limits, visibleGpuIds: checked ? [...without, g.index] : without });
  };
  const gpuChecked = (g: GpuInfo) =>
    limits.visibleGpuIds == null || limits.visibleGpuIds.includes(g.index) || (g.uuid != null && limits.visibleGpuIds.includes(g.uuid));

  // Absolute figures come from the stack's OWN engine; with unknown capacity only the percentage
  // is meaningful (the hub's numbers would be wrong for a remote engine).
  const cpuCount = isNum(info.capacity?.cpuCount) && info.capacity.cpuCount > 0 ? info.capacity.cpuCount : null;
  const ramGb = isNum(info.capacity?.ramBytes) && info.capacity.ramBytes > 0 ? info.capacity.ramBytes / 1024 ** 3 : null;
  const cpuPercent = limits.cpuPercent ?? 100;
  const ramPercent = limits.ramPercent ?? 100;
  const cpuLabel = cpuCount != null
    ? <>{Math.round((cpuPercent / 100) * cpuCount * 10) / 10} / {cpuCount} vCPU <span className="text-text-muted">({cpuPercent}%)</span></>
    : <>{cpuPercent}% <span className="text-text-muted">· capacity unknown</span></>;
  const ramLabel = ramGb != null
    ? <>{Math.round((ramPercent / 100) * ramGb * 10) / 10} / {Math.round(ramGb)} GB <span className="text-text-muted">({ramPercent}%)</span></>
    : <>{ramPercent}% <span className="text-text-muted">· capacity unknown</span></>;

  const subtitle: ReactNode = caps.applyMode === 'compose'
    ? <>Managed via <code className="font-mono">docker-compose.override.oblihub.yml</code> — your base compose file is never modified.</>
    : caps.applyMode === 'docker-update'
      ? <>Applied live with <code className="font-mono">docker update</code> on this stack's containers — no compose file involved.</>
      : <>Stored only — nothing is applied to containers.</>;

  const labelCls = (disabled: boolean) => (disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer');

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4 space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-secondary flex items-center gap-1.5">
            <Zap size={14} /> Resource Limits
          </h2>
          <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {info.engine !== undefined && <EngineBadge engine={info.engine} />}
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${
                caps.applyMode === 'none' ? 'border-border bg-bg-tertiary text-text-muted' : 'border-accent/30 bg-accent/10 text-accent'
              }`}
              title="How Save applies the limits to this stack"
            >
              {APPLY_MODE_LABEL[caps.applyMode] ?? caps.applyMode}
            </span>
            {info.pendingApply && (
              <span className="inline-flex items-center gap-1 rounded-full border border-status-warning/40 bg-status-warning/10 px-2 py-0.5 text-[11px] text-status-warning">
                <Clock size={11} /> Will apply when the watchdog resumes this stack
              </span>
            )}
          </div>
          {caps.reason && <p className="mt-1.5 text-[11px] text-text-muted">{caps.reason}</p>}
        </div>
        {!readOnly && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={onClear}
              disabled={saving || !info.limits}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-status-down/40 text-status-down hover:bg-status-down/10 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Remove the stored limits and lift them from the containers"
            >
              <Trash2 size={12} /> Clear
            </button>
            <button
              onClick={onSave}
              disabled={saving}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-40"
            >
              <Save size={12} /> {saving ? 'Applying…' : caps.applyMode === 'none' ? 'Save' : 'Save & Apply'}
            </button>
          </div>
        )}
      </div>

      {caps.standaloneWarning && (
        <div className="flex items-start gap-1.5 rounded-lg border border-status-warning/40 bg-status-warning/10 p-2.5 text-xs text-status-warning">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <span>Standalone groups every container without a compose project on this engine — limits apply to all of them</span>
        </div>
      )}

      {readOnly && (
        <div className="flex items-start gap-1.5 rounded-lg border border-border bg-bg-tertiary p-2.5 text-xs text-text-secondary">
          <Lock size={13} className="shrink-0 mt-0.5" />
          <span>Read-only{caps.canEditReason ? `: ${caps.canEditReason}` : ''}</span>
        </div>
      )}

      {lastApply && <ApplyResultPanel apply={lastApply} onDismiss={onDismissApply} />}

      {/* Priority */}
      <div>
        <div className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">Priority</div>
        <div className="space-y-1.5">
          {(['critical', 'normal', 'opportunistic'] as StackPriority[]).map(p => (
            <label key={p} className={`block rounded-lg border p-3 transition-colors ${labelCls(readOnly)} ${limits.priority === p ? 'border-accent bg-accent/5' : `border-border ${readOnly ? '' : 'hover:bg-bg-hover'}`}`}>
              <div className="flex items-start gap-2.5">
                <input
                  type="radio"
                  name="priority"
                  checked={limits.priority === p}
                  onChange={() => setLimits({ ...limits, priority: p })}
                  disabled={readOnly}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-primary capitalize">{p}</div>
                  <div className="text-xs text-text-muted mt-0.5">{PRIORITY_DESCRIPTIONS[p]}</div>
                </div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {!caps.cpuRamCaps && (
        <div className="text-[11px] text-text-muted">
          CPU and RAM caps cannot be applied to this stack{caps.reason ? ` — ${caps.reason}` : '.'}
        </div>
      )}

      {/* CPU */}
      <div className={cpuRamDisabled ? 'opacity-60' : ''}>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-text-muted uppercase tracking-wider flex items-center gap-1.5">
            <Cpu size={12} /> CPU cap
          </div>
          <div className="text-xs font-mono text-text-primary">{cpuLabel}</div>
        </div>
        <input
          type="range"
          min={MIN_PERCENT}
          max={100}
          step={5}
          value={Math.max(MIN_PERCENT, cpuPercent)}
          onChange={e => setLimits({ ...limits, cpuPercent: parseInt(e.target.value, 10) })}
          disabled={cpuRamDisabled}
          className={`w-full ${cpuRamDisabled ? 'cursor-not-allowed' : ''}`}
        />
        <button
          onClick={() => setLimits({ ...limits, cpuPercent: null })}
          disabled={cpuRamDisabled}
          className="text-[10px] text-text-muted hover:text-text-primary mt-1 disabled:cursor-not-allowed disabled:hover:text-text-muted"
        >
          {limits.cpuPercent === null ? 'No cap (uncapped)' : 'Reset to uncapped'}
        </button>
      </div>

      {/* RAM */}
      <div className={cpuRamDisabled ? 'opacity-60' : ''}>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-text-muted uppercase tracking-wider flex items-center gap-1.5">
            <MemoryStick size={12} /> RAM cap
          </div>
          <div className="text-xs font-mono text-text-primary">{ramLabel}</div>
        </div>
        <input
          type="range"
          min={MIN_PERCENT}
          max={100}
          step={5}
          value={Math.max(MIN_PERCENT, ramPercent)}
          onChange={e => setLimits({ ...limits, ramPercent: parseInt(e.target.value, 10) })}
          disabled={cpuRamDisabled}
          className={`w-full ${cpuRamDisabled ? 'cursor-not-allowed' : ''}`}
        />
        <button
          onClick={() => setLimits({ ...limits, ramPercent: null })}
          disabled={cpuRamDisabled}
          className="text-[10px] text-text-muted hover:text-text-primary mt-1 disabled:cursor-not-allowed disabled:hover:text-text-muted"
        >
          {limits.ramPercent === null ? 'No cap (uncapped)' : 'Reset to uncapped'}
        </button>
      </div>

      {/* GPU visibility — per-stack, on the stack's own engine. Power limit shown for reference only (edit on /resources). */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-text-muted uppercase tracking-wider">GPU visibility</div>
          <button
            onClick={onRefreshGpus}
            disabled={refreshingGpus}
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-40"
            title="Reload this engine's GPU information"
          >
            <RefreshCw size={11} className={refreshingGpus ? 'animate-spin' : ''} /> Refresh detection
          </button>
        </div>

        {info.hostGpus.length === 0 ? (
          <div className="rounded-lg border border-border bg-bg-tertiary p-3 text-xs text-text-muted space-y-1">
            <div>{noGpuText(info)}</div>
            {limits.visibleGpuIds != null && (
              <div className="flex flex-wrap items-center gap-2">
                <span>Stored restriction: {limits.visibleGpuIds.length === 0 ? 'no GPU' : limits.visibleGpuIds.map(id => `GPU ${id}`).join(', ')}</span>
                <button
                  type="button"
                  onClick={() => setLimits({ ...limits, visibleGpuIds: null })}
                  disabled={readOnly}
                  className="text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:no-underline"
                >
                  Reset to unrestricted
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="text-[11px] text-text-muted mb-2 leading-relaxed">
              Restricts which GPUs the services that request a GPU can see. Unrestricted (all checked, default) = as declared in compose; Oblihub never grants GPUs.
            </div>
            {!caps.gpuVisibility && (
              <div className="mb-2 flex items-start gap-1.5 rounded border border-border bg-bg-tertiary p-2 text-[11px] text-text-muted">
                <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                <span>{caps.gpuVisibilityReason ?? 'GPU visibility cannot be controlled for this stack.'}</span>
              </div>
            )}
            <div className="mb-2 flex items-center gap-2 text-[11px]">
              <span className="text-text-muted">
                {limits.visibleGpuIds == null ? 'Unrestricted' : limits.visibleGpuIds.length === 0 ? 'No GPU visible' : 'Restricted'}
              </span>
              {limits.visibleGpuIds != null && (
                <button
                  type="button"
                  onClick={() => setLimits({ ...limits, visibleGpuIds: null })}
                  disabled={gpuDisabled}
                  className="text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:no-underline"
                >
                  Reset to unrestricted
                </button>
              )}
            </div>
            <div className="rounded-lg border border-border bg-bg-tertiary p-3 space-y-3">
              {info.hostGpus.map(g => {
                const cpl = info.currentPowerLimits ?? {};
                const appliedWatts = (g.uuid ? cpl[g.uuid] : undefined) ?? cpl[g.index] ?? cpl[`idx:${g.index}`] ?? g.powerLimitCurrentWatts;
                const minW = Math.max(1, Math.round(g.powerLimitMinWatts || 0));
                const maxW = Math.max(minW + 1, Math.round(g.powerLimitMaxWatts || 0));
                return (
                  <div key={g.uuid || g.index} className="pb-3 last:pb-0 border-b border-border last:border-0 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <label className={`flex items-center gap-2 ${labelCls(gpuDisabled)}`}>
                        <input
                          type="checkbox"
                          checked={gpuChecked(g)}
                          onChange={e => toggleGpuVisible(g, e.target.checked)}
                          disabled={gpuDisabled}
                        />
                        <span className="font-mono text-accent">GPU {g.index}</span>
                        <span className="text-text-primary">{g.name}</span>
                      </label>
                      <div className="font-mono text-text-muted">
                        {(g.memoryTotalMb / 1024).toFixed(1)} GB · range {minW}–{maxW}W
                      </div>
                    </div>
                    <div className="flex items-center gap-2 opacity-70" title="Read-only here — edit in Resources dashboard">
                      <input
                        type="range"
                        min={minW}
                        max={maxW}
                        step={5}
                        value={Math.max(minW, Math.min(maxW, Math.round(appliedWatts || 0)))}
                        readOnly
                        disabled
                        className="flex-1 cursor-not-allowed"
                      />
                      <div className="w-16 text-right font-mono text-xs text-text-primary">
                        {Math.round(appliedWatts || 0)}W
                      </div>
                    </div>
                    <div className="flex items-start gap-1.5 text-[10px] text-text-muted">
                      <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                      <span>Host-wide power limit — configured in <Link to="/resources" className="text-accent hover:underline">Resources dashboard</Link>.</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Critical-only: what counts as activity for the stacks yielding to this one */}
      {limits.priority === 'critical' && (
        <div className="rounded-lg border border-border bg-bg-tertiary p-3 space-y-2">
          <div className="text-xs font-medium text-text-muted uppercase tracking-wider">Activity signal</div>
          <label className={`flex items-center gap-2 text-xs ${labelCls(readOnly)}`}>
            <input
              type="checkbox"
              checked={limits.yieldSignalSource === 'gpu-util'}
              onChange={e => setLimits({ ...limits, yieldSignalSource: e.target.checked ? 'gpu-util' : 'nginx-traffic' })}
              disabled={readOnly}
            />
            <span className="text-text-primary">Also treat GPU utilization as activity (gpu-util)</span>
          </label>
          <div className="text-[11px] text-text-muted">Proxied traffic and the busy webhook always count.</div>
          {sharesGpuWithOpportunistic && (
            <div className="flex items-start gap-1.5 rounded border border-status-warning/40 bg-status-warning/10 p-2 text-[11px] text-status-warning">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span>On shared GPUs, gpu-util only keeps miners yielded; the first yield comes from traffic or the webhook.</span>
            </div>
          )}
        </div>
      )}

      {/* Opportunistic-only settings */}
      {limits.priority === 'opportunistic' && (
        <div className="rounded-lg border border-border bg-bg-tertiary p-3 space-y-4">
          <div className="text-xs font-medium text-text-muted uppercase tracking-wider">Yield behavior</div>

          {/* Yields to — the busy signal belongs to each Critical stack, shown next to it */}
          <div>
            <div className="text-xs font-medium text-text-primary mb-1.5">Yields to</div>
            {info.criticalStacks.length === 0 ? (
              <div className="text-xs text-text-muted italic">No Critical stacks configured yet — set another stack's priority to Critical first.</div>
            ) : (
              <div className="space-y-1">
                {info.criticalStacks.map(cs => {
                  const checked = (limits.yieldsToStackIds || []).includes(cs.id);
                  // null = orphaned Critical stack; undefined = an older server that sends no engine.
                  const engineText = cs.engineId === null ? 'Unknown engine'
                    : cs.engineId === undefined ? null : `engine ${cs.engineName ?? `#${cs.engineId}`}`;
                  return (
                    <label key={cs.id} className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs ${labelCls(readOnly)}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={readOnly}
                        onChange={e => {
                          const cur = limits.yieldsToStackIds || [];
                          setLimits({
                            ...limits,
                            yieldsToStackIds: e.target.checked
                              ? [...cur, cs.id]
                              : cur.filter(id => id !== cs.id),
                          });
                        }}
                      />
                      <span className="text-text-primary">{cs.name}</span>
                      <span
                        className={`text-[11px] ${cs.engineId === null ? 'text-status-warning' : 'text-text-muted'}`}
                        title={cs.sameEngine === false ? 'This Critical stack runs on another engine than this stack' : undefined}
                      >
                        (signal: {criticalSignalLabel(cs)}{engineText != null ? `, ${engineText}` : ''})
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {limits.yieldSignalSource === 'gpu-util' && (
              <div className="mt-2 text-[11px] text-text-muted">
                Legacy setting: this stack was saved with the gpu-util signal, which Opportunistic stacks no longer use.
                Enable gpu-util on the Critical stacks it yields to instead.
              </div>
            )}
          </div>

          {/* Idle timeout */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium text-text-primary">Idle timeout</div>
              <div className="text-[10px] text-text-muted">Resume this stack after the Critical is quiet for this long.</div>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={86400}
                value={limits.yieldIdleTimeoutSeconds ?? 30}
                onChange={e => setLimits({ ...limits, yieldIdleTimeoutSeconds: parseInt(e.target.value, 10) || 30 })}
                disabled={readOnly}
                className="w-20 rounded border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary text-right focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
              />
              <span className="text-xs text-text-muted">sec</span>
            </div>
          </div>

          {/* Yield mode */}
          <div>
            <div className="text-xs font-medium text-text-primary mb-1.5">Yield mode</div>
            <div className="flex gap-3 text-xs">
              {(['pause', 'stop'] as YieldMode[]).map(m => (
                <label key={m} className={`flex items-center gap-1.5 ${labelCls(readOnly)}`}>
                  <input
                    type="radio"
                    name="yield-mode"
                    checked={limits.yieldMode === m}
                    onChange={() => setLimits({ ...limits, yieldMode: m })}
                    disabled={readOnly}
                  />
                  <span className="text-text-primary">{m}</span>
                </label>
              ))}
            </div>
            {limits.yieldMode === 'pause' && (
              <div className="mt-2 flex items-start gap-1.5 rounded border border-status-warning/40 bg-status-warning/10 p-2 text-[11px] text-status-warning">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                {pauseVramCapGb != null ? (
                  <span>
                    Pause keeps up to {pauseVramCapGb} GB of GPU VRAM allocated (the MPS VRAM cap, applied while the MPS daemon answers).
                    If the Critical needs that memory, use <code>stop</code> instead.
                  </span>
                ) : (
                  <span>Pause keeps GPU VRAM allocated. If the Critical shares the same GPU, use <code>stop</code> instead.</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {showMps && (
        <MpsCard
          info={info}
          limits={limits}
          onChange={setLimits}
          readOnly={readOnly}
          isAdmin={isAdmin ?? caps.mps}
          refreshing={refreshingMps}
          onRefresh={onRefreshMps}
        />
      )}
    </div>
  );
}

// ── NVIDIA MPS: experimental, admin-only, Opportunistic Oblihub-managed compose stacks ──────

const MPS_PIPE_DIRS = ['/tmp/nvidia-mps', '/run/nvidia-mps', '/var/run/nvidia-mps'] as const;
const DEFAULT_MPS_PIPE_DIR = MPS_PIPE_DIRS[0];
const EMPTY_MPS: MpsSettings = { enabled: false, activeThreadPercentage: null, pinnedMemLimitGb: null, pipeDirectory: null };
const EXCLUSIVE_PROCESS = 'Exclusive_Process';

/** Largest VRAM the MPS cap leaves a paused miner holding, when every visible GPU has a cap; null
 *  otherwise (an uncapped visible GPU can keep all of its memory). */
function mpsPauseCapGb(limits: ResourceLimits, hostGpus: GpuInfo[]): number | null {
  const pinned = limits.mps?.pinnedMemLimitGb;
  if (!pinned) return null;
  const visible = hostGpus.filter(g => limits.visibleGpuIds == null || limits.visibleGpuIds.includes(g.index) || (g.uuid != null && limits.visibleGpuIds.includes(g.uuid)));
  if (visible.length === 0) return null;
  const caps = visible.map(g => (g.uuid ? pinned[g.uuid] : undefined));
  if (caps.some(c => !isNum(c) || c <= 0)) return null;
  return Math.max(...(caps as number[]));
}

/** Floor to one decimal: the server accepts at most the card's memory. */
function gpuMemoryGb(g: GpuInfo): number {
  return Math.floor((g.memoryTotalMb / 1024) * 10) / 10;
}

function formatCheckedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString();
}

/** GB field that keeps what is being typed ('0', '0.') until it is a valid cap: a controlled number
 *  input would clear itself on the leading 0 of '0.5'. Empty = no cap. */
function VramCapInput({ value, maxGb, disabled, label, onCommit }: {
  value: number | undefined;
  maxGb: number;
  disabled: boolean;
  /** Accessible name: the visible "GPU n" caption is a sibling span, not a <label>. */
  label: string;
  onCommit: (gb: number | null) => void;
}) {
  const shown = value != null ? String(value) : '';
  const [draft, setDraft] = useState(shown);
  useEffect(() => { setDraft(shown); }, [shown]);
  return (
    <input
      type="number"
      aria-label={label}
      min={0.1}
      max={maxGb}
      step={0.5}
      value={draft}
      placeholder="no cap"
      onChange={e => {
        const raw = e.target.value;
        setDraft(raw);
        if (raw.trim() === '') { onCommit(null); return; }
        const v = parseFloat(raw);
        const gb = Math.min(maxGb, Math.round(v * 10) / 10);
        if (Number.isFinite(gb) && gb > 0) onCommit(gb);
      }}
      onBlur={() => setDraft(shown)}
      disabled={disabled}
      className="w-20 rounded border border-border bg-bg-primary px-2 py-1 text-right text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed"
    />
  );
}

function MpsDaemonBadge({ status }: { status: MpsEngineStatus | null }) {
  const daemon = status?.daemon ?? 'unknown';
  const cls = daemon === 'detected'
    ? 'border-status-up/40 bg-status-up/10 text-status-up'
    : daemon === 'not-detected'
      ? 'border-status-warning/40 bg-status-warning/10 text-status-warning'
      : 'border-border bg-bg-tertiary text-text-muted';
  const label = daemon === 'detected' ? 'Detected' : daemon === 'not-detected' ? 'Not detected' : 'Unknown';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${cls}`} title={status?.message ?? undefined}>
      Daemon: {label}
    </span>
  );
}

/** Collapsed by default: experimental and admin-only. The summary line still shows the daemon state
 *  and a crash-loop warning. Exported for the render check (with `defaultOpen`). */
export function MpsCard({
  info,
  limits,
  onChange,
  readOnly,
  isAdmin,
  refreshing,
  onRefresh,
  defaultOpen = false,
}: {
  info: ResourcesInfo;
  limits: ResourceLimits;
  onChange: (limits: ResourceLimits) => void;
  readOnly: boolean;
  isAdmin: boolean;
  refreshing: boolean;
  onRefresh?: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const caps = info.capabilities;
  const mps = limits.mps ?? EMPTY_MPS;
  const enabled = mps.enabled === true;
  const status = info.mps;
  const formDir = mps.pipeDirectory ?? DEFAULT_MPS_PIPE_DIR;
  const statusDir = status?.pipeDirectory ?? (info.limits?.mps?.pipeDirectory ?? DEFAULT_MPS_PIPE_DIR);
  const clients: MpsClientInfo[] = info.mpsClients ?? [];
  const restarting = clients.some(c => c.restartCount > 0);

  // Turning MPS off stays possible for an admin when the gate no longer passes; turning it on needs the gate.
  const toggleDisabled = readOnly || !isAdmin || (!caps.mps && !enabled);
  const settingsDisabled = readOnly || !isAdmin || !enabled || !caps.mps;
  const setMps = (patch: Partial<MpsSettings>) => onChange({ ...limits, mps: { ...mps, ...patch } });

  const visibleGpus = info.hostGpus.filter(g =>
    limits.visibleGpuIds == null || limits.visibleGpuIds.includes(g.index) || (g.uuid != null && limits.visibleGpuIds.includes(g.uuid)));
  const setVramCap = (uuid: string, gb: number | null) => {
    const next: Record<string, number> = { ...(mps.pinnedMemLimitGb ?? {}) };
    if (gb == null) delete next[uuid];
    else next[uuid] = gb;
    setMps({ pinnedMemLimitGb: Object.keys(next).length > 0 ? next : null });
  };

  const modeGpus = status && status.gpus.length > 0
    ? status.gpus
    : info.hostGpus.map(g => ({ index: g.index, uuid: g.uuid ?? null, computeMode: g.computeMode ?? null }));
  const exclusive = modeGpus.some(g => g.computeMode === EXCLUSIVE_PROCESS);
  const checkedAt = formatCheckedAt(status?.checkedAt ?? null);
  const disabledCls = (disabled: boolean) => (disabled ? 'cursor-not-allowed opacity-60' : '');

  return (
    <div className="rounded-lg border border-border bg-bg-tertiary">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full flex-wrap items-center gap-2 p-3 text-left"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} className="text-text-muted" /> : <ChevronRight size={12} className="text-text-muted" />}
        <Layers size={12} className="text-text-muted" />
        <span className="text-xs font-medium text-text-muted uppercase tracking-wider">GPU sharing (NVIDIA MPS) — experimental</span>
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${enabled ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border text-text-muted'}`}>
          {enabled ? 'On' : 'Off'}
        </span>
        <MpsDaemonBadge status={status} />
        {restarting && (
          <span className="inline-flex items-center gap-1 rounded-full border border-status-warning/40 bg-status-warning/10 px-2 py-0.5 text-[11px] text-status-warning">
            <AlertTriangle size={11} /> Restarting
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-4 border-t border-border p-3 text-xs">
          <p className="text-[11px] text-text-muted leading-relaxed">
            Makes this stack's GPU services clients of an NVIDIA MPS daemon you run on the host. The main value is a hard
            VRAM cap per client; the SM percentage is static. Oblihub never starts or stops the daemon and never changes the
            compute mode.
          </p>

          {!caps.mps && caps.mpsReason && (
            <div className="flex items-start gap-1.5 rounded border border-border bg-bg-secondary p-2 text-[11px] text-text-muted">
              <Lock size={11} className="shrink-0 mt-0.5" />
              <span>{caps.mpsReason}</span>
            </div>
          )}
          {enabled && !isAdmin && (
            <div className="flex items-start gap-1.5 rounded border border-status-warning/40 bg-status-warning/10 p-2 text-[11px] text-status-warning">
              <AlertTriangle size={11} className="shrink-0 mt-0.5" />
              <span>MPS is enabled on this stack: only an admin can change its MPS settings.</span>
            </div>
          )}
          {enabled && limits.priority !== 'opportunistic' && (
            <div className="flex items-start gap-1.5 rounded border border-status-warning/40 bg-status-warning/10 p-2 text-[11px] text-status-warning">
              <AlertTriangle size={11} className="shrink-0 mt-0.5" />
              <span>MPS is only for Opportunistic stacks — set the priority back to Opportunistic or turn MPS off before saving.</span>
            </div>
          )}
          {enabled && limits.visibleGpuIds != null && limits.visibleGpuIds.length === 0 && (
            <div className="flex items-start gap-1.5 rounded border border-status-warning/40 bg-status-warning/10 p-2 text-[11px] text-status-warning">
              <AlertTriangle size={11} className="shrink-0 mt-0.5" />
              <span>MPS needs at least one visible GPU.</span>
            </div>
          )}

          {/* Daemon status */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <MpsDaemonBadge status={status} />
              <span className="font-mono text-[11px] text-text-secondary">{statusDir}</span>
              {checkedAt && <span className="text-[11px] text-text-muted">checked {checkedAt}</span>}
              {onRefresh && (
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={refreshing}
                  className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
                  title="Reload the daemon status and the restart counts"
                >
                  <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} /> Refresh
                </button>
              )}
            </div>
            <div className="text-[11px] text-text-muted">
              {status?.message ?? (status ? null : `Daemon status unavailable: ${noGpuText(info)}`)}
            </div>
            {formDir !== statusDir && (
              <div className="text-[11px] text-text-muted">Status shown for {statusDir}; {formDir} is checked after Save.</div>
            )}
          </div>

          {/* Compute mode per GPU */}
          {modeGpus.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-1.5">
                {modeGpus.map(g => (
                  <span
                    key={g.uuid || g.index}
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[11px] ${
                      g.computeMode === EXCLUSIVE_PROCESS
                        ? 'border-status-down/40 bg-status-down/10 text-status-down'
                        : g.computeMode === 'Prohibited'
                          ? 'border-status-warning/40 bg-status-warning/10 text-status-warning'
                          : 'border-border bg-bg-secondary text-text-secondary'
                    }`}
                  >
                    GPU {g.index}: {g.computeMode ?? 'unknown'}
                  </span>
                ))}
              </div>
              {exclusive && (
                <div className="flex items-start gap-1.5 text-[11px] text-status-down">
                  <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                  <span>Exclusive_Process: non-MPS stacks (your Critical AI) cannot start on this GPU while the MPS server exists — keep Default</span>
                </div>
              )}
            </div>
          )}

          {/* Enable */}
          <label className={`flex items-center gap-2 ${toggleDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`} title={toggleDisabled && !isAdmin ? 'Admins only' : undefined}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => setMps({ enabled: e.target.checked })}
              disabled={toggleDisabled}
            />
            <span className="text-text-primary">Make this stack's GPU services MPS clients</span>
          </label>
          {enabled && status?.daemon !== 'detected' && (
            <div className="flex items-start gap-1.5 rounded border border-status-warning/40 bg-status-warning/10 p-2 text-[11px] text-status-warning">
              <AlertTriangle size={11} className="shrink-0 mt-0.5" />
              <span>Oblihub will not apply MPS settings until it sees the daemon answer in {formDir}.</span>
            </div>
          )}

          {/* Settings */}
          <div className={`space-y-3 ${disabledCls(settingsDisabled)}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium text-text-primary">Pipe directory</div>
                <div className="text-[10px] text-text-muted">Must match the daemon's CUDA_MPS_PIPE_DIRECTORY.</div>
              </div>
              <select
                aria-label="MPS pipe directory"
                value={formDir}
                onChange={e => setMps({ pipeDirectory: e.target.value })}
                disabled={settingsDisabled}
                className="rounded border border-border bg-bg-primary px-2 py-1 font-mono text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed"
              >
                {MPS_PIPE_DIRS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <div>
                  <div className="font-medium text-text-primary">SM share</div>
                  <div className="text-[10px] text-text-muted">CUDA_MPS_ACTIVE_THREAD_PERCENTAGE — can only lower the daemon's value.</div>
                </div>
                <div className="font-mono text-text-primary">{mps.activeThreadPercentage == null ? 'not set' : `${mps.activeThreadPercentage}%`}</div>
              </div>
              {/* The thumb sits at 100 when unset; aria-valuetext keeps assistive tech from announcing "100". */}
              <input
                type="range"
                aria-label="SM share (CUDA_MPS_ACTIVE_THREAD_PERCENTAGE)"
                aria-valuetext={mps.activeThreadPercentage == null ? 'not set' : `${mps.activeThreadPercentage}%`}
                min={1}
                max={100}
                step={1}
                value={mps.activeThreadPercentage ?? 100}
                onChange={e => setMps({ activeThreadPercentage: parseInt(e.target.value, 10) })}
                disabled={settingsDisabled}
                className={`w-full ${settingsDisabled ? 'cursor-not-allowed' : ''}`}
              />
              <button
                type="button"
                onClick={() => setMps({ activeThreadPercentage: null })}
                disabled={settingsDisabled || mps.activeThreadPercentage == null}
                className="mt-1 text-[10px] text-text-muted hover:text-text-primary disabled:cursor-not-allowed disabled:hover:text-text-muted"
              >
                {mps.activeThreadPercentage == null ? "Daemon's value" : "Reset to the daemon's value"}
              </button>
            </div>

            <div>
              <div className="font-medium text-text-primary">VRAM cap per GPU</div>
              <div className="mb-1.5 text-[10px] text-text-muted">CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: allocations above it fail inside the miner. Empty = no cap.</div>
              {visibleGpus.length === 0 ? (
                <div className="text-[11px] text-text-muted">No visible GPU of this engine is known — VRAM caps need the engine's GPU list.</div>
              ) : (
                <div className="space-y-1">
                  {visibleGpus.map(g => {
                    const maxGb = gpuMemoryGb(g);
                    const uuid = g.uuid ?? null;
                    const value = uuid ? mps.pinnedMemLimitGb?.[uuid] : undefined;
                    return (
                      <div key={uuid || g.index} className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-accent">GPU {g.index}</span>
                        <span className="text-text-secondary">{g.name}</span>
                        {uuid ? (
                          <span className="ml-auto flex items-center gap-1">
                            <VramCapInput
                              value={value}
                              maxGb={maxGb}
                              disabled={settingsDisabled}
                              label={`VRAM cap for GPU ${g.index} in GB`}
                              onCommit={gb => setVramCap(uuid, gb)}
                            />
                            <span className="text-text-muted">/ {maxGb} GB</span>
                          </span>
                        ) : (
                          <span className="ml-auto text-[11px] text-text-muted">no UUID reported — cannot be capped</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Restart visibility */}
          {info.mpsClients != null && (
            <div className="space-y-1.5">
              <div className="font-medium text-text-primary">Containers</div>
              {clients.length === 0 ? (
                <div className="text-[11px] text-text-muted">No container of this stack could be inspected on its engine.</div>
              ) : (
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-text-muted">
                      <th className="py-0.5 font-normal">Name</th>
                      <th className="py-0.5 font-normal">State</th>
                      <th className="py-0.5 text-right font-normal">Restarts</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {clients.map(c => (
                      <tr key={c.dockerId || c.name} className={c.restartCount > 0 ? 'text-status-warning' : 'text-text-secondary'}>
                        <td className="py-0.5">{c.name}</td>
                        <td className="py-0.5">{c.state}</td>
                        <td className="py-0.5 text-right">{c.restartCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {restarting && (
                <div className="flex items-start gap-1.5 text-[11px] text-status-warning">
                  <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                  <span>Restarting — a VRAM cap below the miner's working set makes it crash-loop</span>
                </div>
              )}
            </div>
          )}

          {/* Prerequisites */}
          <div className="space-y-1">
            <div className="font-medium text-text-primary">Prerequisites on the host</div>
            <ul className="list-disc space-y-1 pl-4 text-[11px] text-text-muted">
              <li>Keep the compute mode Default: <code className="font-mono text-text-secondary">nvidia-smi -i &lt;idx&gt; -c DEFAULT</code></li>
              <li>
                Run the daemon as a systemd unit: <code className="font-mono text-text-secondary">nvidia-cuda-mps-control -d</code> with{' '}
                <code className="font-mono text-text-secondary">CUDA_VISIBLE_DEVICES=&lt;shareable GPU uuids&gt;</code> and{' '}
                <code className="font-mono text-text-secondary">CUDA_MPS_PIPE_DIRECTORY</code> set to the directory above.
              </li>
              <li>Prefer <code className="font-mono text-text-secondary">/run/nvidia-mps</code>: host processes that use the default /tmp/nvidia-mps are then not captured by the daemon.</li>
            </ul>
          </div>

          {/* Risks */}
          <div className="space-y-1">
            <div className="font-medium text-text-primary">Risks</div>
            <ul className="list-disc space-y-1 pl-4 text-[11px] text-text-muted">
              <li><code className="font-mono">ipc: host</code> gives the miner's containers the host's IPC namespace (shared memory).</li>
              <li>Settings are applied only while Oblihub sees a live daemon (checked at most 60 s before each deploy or Save); otherwise the miner runs as a plain CUDA process.</li>
              <li>A VRAM cap below the miner's working set makes it crash-loop — watch the restart counts.</li>
              <li>Changing any MPS setting recreates the miner's containers.</li>
              <li>The Critical stack is not an MPS client: it keeps VRAM isolation but no concurrent SM sharing — GPU time-slicing between them remains.</li>
              <li>gpu-util is ambiguous on a shared GPU: it cannot tell the Critical's load from the miner's.</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
