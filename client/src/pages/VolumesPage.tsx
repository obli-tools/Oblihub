import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Trash2, Plus, Database, Eraser, ChevronDown, Server } from 'lucide-react';
import { dockerApi, type WithEngine, type EngineTarget, type PruneAllRecap } from '@/api/docker.api';
import { enginesApi } from '@/api/engines.api';
import type { DockerVolume, DockerEngine, VolumeSpec } from '@oblihub/shared';
import { VolumeForm, emptyVolumeSpec } from '@/components/VolumeForm';
import { apiErrorMessage } from '@/utils/apiError';
import { EngineFilterBar, type EngineFilterValue } from '@/components/EngineFilterBar';
import toast from 'react-hot-toast';

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes < 0) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function VolumesPage() {
  const [volumes, setVolumes] = useState<WithEngine<DockerVolume>[]>([]);
  const [engines, setEngines] = useState<DockerEngine[]>([]);
  const [engineFilter, setEngineFilter] = useState<EngineFilterValue>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createSpec, setCreateSpec] = useState<VolumeSpec>(emptyVolumeSpec());
  const [creating, setCreating] = useState(false);
  const [pruneOpen, setPruneOpen] = useState(false);

  const apiTarget: EngineTarget = engineFilter == null ? 'all' : engineFilter;

  const load = async () => {
    try {
      setVolumes(await dockerApi.listVolumes(apiTarget));
    } catch { toast.error('Failed to load volumes'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [engineFilter]);
  useEffect(() => { enginesApi.list().then(setEngines).catch(() => {}); }, []);

  // Create on the selected engine; defaults to local when "All" is active.
  const createTarget: number | null = engineFilter == null ? null : engineFilter;

  const handleCreate = async () => {
    if (!createSpec.name.trim()) return;
    setCreating(true);
    try {
      await dockerApi.createVolumeFromSpec({ ...createSpec, name: createSpec.name.trim() }, createTarget);
      toast.success(`Volume ${createSpec.name} created`);
      setCreateSpec(emptyVolumeSpec());
      setShowCreate(false);
      load();
    } catch (err) { toast.error(apiErrorMessage(err, 'Failed to create volume')); }
    finally { setCreating(false); }
  };

  const handleRemove = async (vol: WithEngine<DockerVolume>) => {
    const warning = vol.bindDevice
      ? `Remove volume "${vol.name}" on ${vol.engineName}?\n\nIt is bound to the host folder ${vol.bindDevice}: only the Docker reference is removed, the data in that folder is KEPT` +
        (vol.bindDevice.includes('/.volumes/')
          ? ` (a managed stack reattaches it on its next deploy — wipe it with that stack's Down or Delete + remove volumes).`
          : ` — delete that folder by hand to free the space.`)
      : `Remove volume "${vol.name}" on ${vol.engineName}? This will delete all data in this volume!`;
    if (!confirm(warning)) return;
    try {
      await dockerApi.removeVolume(vol.name, true, vol.engineId ?? null);
      toast.success(`Volume ${vol.name} removed from ${vol.engineName}`);
      load();
    } catch { toast.error('Failed to remove volume. It may be in use.'); }
  };

  const runPrune = async (target: EngineTarget, label: string) => {
    if (!confirm(`Remove all unused volumes on ${label}? This will DELETE all data in unused volumes!`)) return;
    try {
      const result = await dockerApi.pruneVolumes(target);
      if (result && 'perEngine' in (result as PruneAllRecap<{ deleted: string[]; spaceReclaimed: number }>)) {
        const recap = result as PruneAllRecap<{ deleted: string[]; spaceReclaimed: number }>;
        const total = recap.perEngine.reduce((s, b) => s + (b.result?.deleted.length || 0), 0);
        const space = recap.perEngine.reduce((s, b) => s + (b.result?.spaceReclaimed || 0), 0);
        const failed = recap.perEngine.filter(b => !b.ok);
        toast.success(`Pruned ${total} volume(s) across ${recap.perEngine.length} engine(s), reclaimed ${formatSize(space)}${failed.length ? ` (${failed.length} failed)` : ''}`);
      } else {
        const r = result as { deleted: string[]; spaceReclaimed: number };
        toast.success(`Pruned ${r.deleted.length} volume(s), reclaimed ${formatSize(r.spaceReclaimed)}`);
      }
      load();
    } catch { toast.error('Prune failed'); }
    finally { setPruneOpen(false); }
  };

  const counts = useMemo(() => {
    const c: Record<number, number> = {};
    for (const v of volumes) if (v.engineId != null) c[v.engineId] = (c[v.engineId] || 0) + 1;
    return c;
  }, [volumes]);

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Database size={20} /> Volumes</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowCreate(v => !v)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Create
          </button>
          {engines.filter(e => e.enabled).length > 1 ? (
            <div className="relative">
              <button onClick={() => setPruneOpen(o => !o)} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-status-down/30 text-status-down hover:bg-status-down/10">
                <Eraser size={14} /> Prune <ChevronDown size={12} />
              </button>
              {pruneOpen && (
                <div className="absolute right-0 top-full mt-1 z-10 min-w-[200px] rounded-lg border border-border bg-bg-secondary shadow-lg py-1">
                  <button onClick={() => runPrune('all', 'all engines')} className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover flex items-center gap-2">
                    <Server size={11} /> Prune on <strong>all engines</strong>
                  </button>
                  <div className="border-t border-border my-1" />
                  {engines.filter(e => e.enabled).map((e) => (
                    <button key={e.id} onClick={() => runPrune(e.id, e.name)} className="w-full text-left px-3 py-2 text-xs text-text-secondary hover:bg-bg-hover flex items-center gap-2">
                      <Server size={11} /> Prune on {e.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button onClick={() => runPrune(null, 'this engine')} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-status-down/30 text-status-down hover:bg-status-down/10">
              <Eraser size={14} /> Prune
            </button>
          )}
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      <EngineFilterBar engines={engines} selected={engineFilter} onSelect={setEngineFilter} counts={counts} totalCount={volumes.length} className="mb-4" />

      {/* Create form */}
      {showCreate && (
        <div className="rounded-xl border border-border bg-bg-secondary p-4 mb-6 space-y-3">
          <h3 className="text-sm font-semibold text-text-secondary">Create Volume{engineFilter == null ? ' (local engine)' : ''}</h3>
          <VolumeForm spec={createSpec} onChange={setCreateSpec} engineId={createTarget} />
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={creating || !createSpec.name.trim()} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50">Create</button>
            <button onClick={() => { setShowCreate(false); setCreateSpec(emptyVolumeSpec()); }} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          </div>
        </div>
      )}

      {/* Volumes table */}
      <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-tertiary">
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Name</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Driver</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Stack</th>
              {engineFilter == null && <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Engine</th>}
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-text-muted">Size</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-text-muted">Created</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-text-muted w-16"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {volumes.map((vol) => (
              <tr key={`${vol.engineId ?? 'local'}:${vol.name}`} className="hover:bg-bg-hover/50">
                <td className="px-4 py-2.5">
                  <div className="text-text-primary font-mono text-xs truncate max-w-xs" title={vol.name}>{vol.name}</div>
                </td>
                <td className="px-4 py-2.5 text-text-muted text-xs">{vol.driver}</td>
                <td className="px-4 py-2.5">
                  {vol.composeProject ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">{vol.composeProject}</span>
                  ) : (
                    <span className="text-text-muted text-xs">-</span>
                  )}
                </td>
                {engineFilter == null && (
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-bg-tertiary text-text-secondary border border-border">
                      <Server size={9} /> {vol.engineName}
                    </span>
                  </td>
                )}
                <td className="px-4 py-2.5 text-right text-text-secondary text-xs">{formatSize(vol.usageSize)}</td>
                <td className="px-4 py-2.5 text-right text-text-muted text-xs">{vol.created ? new Date(vol.created).toLocaleDateString() : '-'}</td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => handleRemove(vol)} className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-status-down" title={`Remove on ${vol.engineName}`}>
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {volumes.length === 0 && (
              <tr><td colSpan={engineFilter == null ? 7 : 6} className="px-4 py-8 text-center text-text-muted">No volumes found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
