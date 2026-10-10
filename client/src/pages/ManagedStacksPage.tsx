import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, RefreshCw, Layers, Play, Square, RotateCcw, Trash2, XCircle, Server } from 'lucide-react';
import { managedStacksApi } from '@/api/managed-stacks.api';
import { stacksApi } from '@/api/stacks.api';
import { useEngineSummaries } from '@/hooks/useEngineSummaries';
import { EngineFilterBar } from '@/components/EngineFilterBar';
import { PortChips } from '@/components/PortChips';
import type { ManagedStack, ManagedStackStatus, Stack, ContainerPort } from '@oblihub/shared';
import toast from 'react-hot-toast';
import { apiErrorMessage } from '@/utils/apiError';

const STATUS_STYLES: Record<ManagedStackStatus, string> = {
  draft: 'bg-bg-tertiary text-text-muted',
  deploying: 'bg-accent/10 text-accent',
  deployed: 'bg-status-up/10 text-status-up',
  stopped: 'bg-status-pending/10 text-status-pending',
  error: 'bg-status-down/10 text-status-down',
};

const STATUS_LABELS: Record<ManagedStackStatus, string> = {
  draft: 'Draft',
  deploying: 'Deploying...',
  deployed: 'Deployed',
  stopped: 'Stopped',
  error: 'Error',
};

export function ManagedStacksPage() {
  const navigate = useNavigate();
  const [stacks, setStacks] = useState<ManagedStack[]>([]);
  const [liveStacks, setLiveStacks] = useState<Stack[]>([]);
  // Summaries, not the admin-only engine list, so non-admins get badges and the filter too.
  const { engines, byId: enginesById, localEngineId } = useEngineSummaries();
  const [loading, setLoading] = useState(true);
  // `null` = "all engines" selected. A number = filter to that engine only.
  const [engineFilter, setEngineFilter] = useState<number | null>(null);

  const load = async () => {
    try {
      const [managed, live] = await Promise.all([
        managedStacksApi.list(),
        stacksApi.list().catch(() => [] as Stack[]),
      ]);
      setStacks(managed);
      setLiveStacks(live);
    } catch { toast.error('Failed to load managed stacks'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // A managed stack without an engine predates multi-engine support and deploys through the
  // local socket, so it belongs to the local engine (unlike an orphaned discovered stack).
  const engineOf = (s: ManagedStack): number | null => s.engineId ?? localEngineId;
  const visibleStacks = useMemo(
    () => engineFilter == null ? stacks : stacks.filter(s => (s.engineId ?? localEngineId) === engineFilter),
    [stacks, engineFilter, localEngineId]
  );
  const countsByEngine = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const s of stacks) {
      const id = s.engineId ?? localEngineId;
      if (id != null) counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }, [stacks, localEngineId]);

  // The same project name can run on several engines: only the live stack on this managed
  // stack's own engine describes its ports. One list per container: compacted together, adjacent
  // ports of different containers would read as one container publishing a range.
  const portsForProject = (composeProject: string, engineId: number | null): ContainerPort[][] => {
    const live = liveStacks.find(s => {
      if (s.composeProject !== composeProject) return false;
      if (engineId != null) return s.engineId === engineId;
      return s.engineId != null && enginesById.get(s.engineId)?.isLocal === true;
    });
    return live ? live.containers.map(c => c.ports || []) : [];
  };

  // Poll while any stack is deploying
  useEffect(() => {
    if (!stacks.some(s => s.status === 'deploying')) return;
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [stacks]);

  const handleDeploy = async (e: React.MouseEvent, s: ManagedStack) => {
    e.stopPropagation();
    try {
      await managedStacksApi.deploy(s.id);
      toast.success(`Deploying ${s.name}...`);
      load();
    } catch (err) { toast.error(apiErrorMessage(err, 'Deploy failed')); }
  };

  const handleStop = async (e: React.MouseEvent, s: ManagedStack) => {
    e.stopPropagation();
    try {
      await managedStacksApi.stop(s.id);
      toast.success(`${s.name} stopped`);
      load();
    } catch (err) { toast.error(apiErrorMessage(err, 'Stop failed')); }
  };

  const handleRedeploy = async (e: React.MouseEvent, s: ManagedStack) => {
    e.stopPropagation();
    try {
      await managedStacksApi.redeploy(s.id);
      toast.success(`Redeploying ${s.name}...`);
      load();
    } catch (err) { toast.error(apiErrorMessage(err, 'Redeploy failed')); }
  };

  const handleRecreate = async (e: React.MouseEvent, s: ManagedStack) => {
    e.stopPropagation();
    if (!confirm(`Recreate every container of "${s.name}"? They are all stopped and recreated, even unchanged ones.`)) return;
    try {
      await managedStacksApi.redeploy(s.id, { forceRecreate: true });
      toast.success(`Recreating ${s.name}...`);
      load();
    } catch (err) { toast.error(apiErrorMessage(err, 'Recreate failed')); }
  };

  const handleCancel = async (e: React.MouseEvent, s: ManagedStack) => {
    e.stopPropagation();
    if (!confirm(`Cancel deployment of "${s.name}"? Any in-progress compose command will be killed.`)) return;
    try {
      const { killed } = await managedStacksApi.cancel(s.id);
      toast.success(killed ? `${s.name} deploy cancelled` : `${s.name} status reset`);
      load();
    } catch { toast.error('Cancel failed'); }
  };

  const handleDelete = async (e: React.MouseEvent, s: ManagedStack) => {
    e.stopPropagation();
    if (!confirm(`Delete "${s.name}"?\n\nThis stops & removes its containers if deployed.`)) return;
    // Second prompt for the destructive step — explicit so a typo on the first dialog never
    // accidentally wipes a database.
    const dataPaths = s.volumePlacements.flatMap(p => p.hostPath ? [p.hostPath] : []);
    const wipeVolumes = confirm(
      `Also remove "${s.name}"'s volumes ?\n\n` +
      `[OK]     = WIPE all data the stack wrote (databases, uploads, caches…).\n` +
      (dataPaths.length > 0
        ? `[Cancel] = keep the data on the server, in:\n  ${dataPaths.join('\n  ')}`
        : `[Cancel] = keep volumes orphaned on the engine (you can ` +
          `clean them up later from the Volumes page).`)
    );
    try {
      const r = await managedStacksApi.delete(s.id, wipeVolumes);
      if (wipeVolumes && !r.removedVolumes) {
        // A stack that is not deployed still gets deleted when its `down -v` fails (disabled or
        // unreachable engine) as long as it has no .volumes data to protect, so its named volumes
        // are still on the engine. Saying "purged" would make the operator believe the data is gone.
        toast.error(
          `${s.name} deleted, but its volumes could not be removed (docker compose down -v failed) — remove them from the Volumes page`,
          { duration: 10_000 },
        );
      } else {
        toast.success(wipeVolumes ? `${s.name} purged (containers + volumes)` : `${s.name} deleted (volumes preserved)`);
      }
      load();
    } catch (err) {
      // Force is only offered once the server said why the down failed, never up front.
      if (managedStacksApi.isDownFailedRefusal(err) && confirm(
        `${apiErrorMessage(err, 'docker compose down failed')}\n\n` +
        `Delete "${s.name}" anyway? Its containers are left as they are on the engine and Oblihub stops managing them.` +
        (wipeVolumes
          ? `\n\nIts volumes and the data under .volumes are KEPT: compose cannot run on that engine to remove them.`
          : ''),
      )) {
        try {
          // Never retry with the volume wipe: the server only purges after a successful `down -v`,
          // which just failed, so a forced wipe would be refused again (and a stack without
          // .volumes data would be deleted with its volumes silently left on the engine).
          const r = await managedStacksApi.delete(s.id, false, undefined, true);
          const base = r.containersLeftRunning ? `${s.name} deleted — its containers may still be running on the engine` : `${s.name} deleted`;
          toast.success(wipeVolumes
            ? `${base}; volumes kept${r.keptVolumeData.length > 0 ? ` — data left on the server in: ${r.keptVolumeData.join(', ')}` : ''}`
            : base);
        } catch (err2) { toast.error(apiErrorMessage(err2, 'Delete failed')); }
        load();
        return;
      }
      toast.error(apiErrorMessage(err, 'Delete failed')); load();
    }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Layers size={20} /> Managed Stacks</h1>
        <div className="flex gap-2">
          <button onClick={() => navigate('/stack-editor/new')} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> New Stack
          </button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      <EngineFilterBar
        engines={engines}
        selected={engineFilter}
        onSelect={setEngineFilter}
        counts={countsByEngine}
        totalCount={stacks.length}
        className="mb-4"
      />

      {stacks.length === 0 ? (
        <div className="text-center py-20">
          <Layers size={40} className="mx-auto mb-3 text-text-muted" />
          <p className="text-text-muted">No managed stacks yet</p>
          <p className="text-xs text-text-muted mt-1">Create one with a docker-compose.yml</p>
          <button onClick={() => navigate('/stack-editor/new')} className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Create Stack
          </button>
        </div>
      ) : (
        visibleStacks.length === 0 ? (
          <div className="text-center py-16 text-text-muted text-sm">
            No managed stacks on this engine.
          </div>
        ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {visibleStacks.map(s => {
            const engineId = engineOf(s);
            const engine = engineId != null ? enginesById.get(engineId) : null;
            return (
            <div key={s.id} onClick={() => navigate(`/stack-editor/${s.id}`)}
              className="rounded-xl border border-border bg-bg-secondary p-4 hover:border-accent/30 cursor-pointer transition-colors">
              <div className="flex items-center justify-between mb-2 gap-2">
                <h3 className="text-sm font-semibold text-text-primary truncate">{s.name}</h3>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[s.status]} flex-shrink-0`}>
                  {STATUS_LABELS[s.status]}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                {/* Summaries carry no host (non-admins may read them), so the tooltip names the transport. */}
                {engine && (
                  <span
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-bg-tertiary text-text-secondary border border-border"
                    title={engine.isLocal ? 'Local Docker engine' : `Remote engine (${engine.type})`}
                  >
                    <Server size={9} /> {engine.enabled ? engine.name : `${engine.name} (disabled)`}
                  </span>
                )}
              </div>
              <div className="text-xs text-text-muted mb-2">
                Project: <code className="bg-bg-tertiary px-1 py-0.5 rounded">{s.composeProject}</code>
              </div>
              <PortChips portGroups={portsForProject(s.composeProject, s.engineId)} showInternal size="xs" max={8} className="mb-2" />
              <div className="flex items-center gap-2 mt-2">
                {(s.status === 'draft' || s.status === 'stopped' || s.status === 'error') && (
                  <button onClick={e => handleDeploy(e, s)} className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-status-up/10 text-status-up hover:bg-status-up/20">
                    <Play size={10} /> Deploy
                  </button>
                )}
                {s.status === 'deploying' && (
                  <button onClick={e => handleCancel(e, s)} className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-status-down/10 text-status-down hover:bg-status-down/20">
                    <XCircle size={10} /> Cancel
                  </button>
                )}
                {s.status === 'deployed' && (
                  <>
                    <button onClick={e => handleRedeploy(e, s)} className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-accent/10 text-accent hover:bg-accent/20">
                      <RotateCcw size={10} /> Redeploy
                    </button>
                    <button onClick={e => handleRecreate(e, s)} title="docker compose up --force-recreate: recreate every container, even unchanged ones" className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-text-muted hover:text-accent">
                      <RefreshCw size={10} /> Recreate
                    </button>
                    <button onClick={e => handleStop(e, s)} className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-text-muted hover:text-status-pending">
                      <Square size={10} /> Stop
                    </button>
                  </>
                )}
                <button onClick={e => handleDelete(e, s)} className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-text-muted hover:text-status-down ml-auto">
                  <Trash2 size={10} />
                </button>
              </div>
              <p className="text-[10px] text-text-muted mt-2">Updated: {new Date(s.updatedAt).toLocaleString()}</p>
            </div>
            );
          })}
        </div>
        )
      )}
    </div>
  );
}
