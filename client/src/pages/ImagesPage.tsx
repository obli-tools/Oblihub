import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Trash2, Download, HardDrive, Eraser, ChevronDown, Server } from 'lucide-react';
import { dockerApi, type WithEngine, type EngineTarget, type PruneAllRecap } from '@/api/docker.api';
import { enginesApi } from '@/api/engines.api';
import type { DockerImage, DockerEngine } from '@oblihub/shared';
import { EngineFilterBar, type EngineFilterValue } from '@/components/EngineFilterBar';
import toast from 'react-hot-toast';

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function ImagesPage() {
  const [images, setImages] = useState<WithEngine<DockerImage>[]>([]);
  const [engines, setEngines] = useState<DockerEngine[]>([]);
  // null = "All". Default to "All" so multi-engine setups see everything at first glance.
  const [engineFilter, setEngineFilter] = useState<EngineFilterValue>(null);
  const [loading, setLoading] = useState(true);
  const [pullInput, setPullInput] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pruneOpen, setPruneOpen] = useState(false);

  // The backend treats `?engineId=all` differently from omitting the param. We convert here.
  const apiTarget: EngineTarget = engineFilter == null ? 'all' : engineFilter;

  const load = async () => {
    try {
      setImages(await dockerApi.listImages(apiTarget));
    } catch { toast.error('Failed to load images'); }
    finally { setLoading(false); }
  };

  // Reload whenever the filter changes — separate effect so the engines fetch doesn't trigger it.
  useEffect(() => { void load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [engineFilter]);
  useEffect(() => {
    enginesApi.list().then(setEngines).catch(() => { /* non-admin */ });
  }, []);

  const handlePull = async () => {
    if (!pullInput.trim()) return;
    setPulling(true);
    try {
      const [image, tag] = pullInput.includes(':') ? pullInput.split(':') : [pullInput, 'latest'];
      // Anchor pull to a specific engine. "All" doesn't make sense for a pull — pull to the
      // currently filtered engine, or to local if "All" is selected.
      const target: EngineTarget = engineFilter == null ? null : engineFilter;
      await dockerApi.pullImage(image, tag, target);
      toast.success(`Pulling ${pullInput}…`);
      setTimeout(load, 5000);
    } catch { toast.error('Failed to pull image'); }
    finally { setPulling(false); setPullInput(''); }
  };

  const handleRemove = async (img: WithEngine<DockerImage>) => {
    const name = img.repoTags[0] || img.id;
    if (!confirm(`Remove image ${name} on ${img.engineName}?`)) return;
    try {
      await dockerApi.removeImage(img.id, true, img.engineId ?? null);
      toast.success(`Image ${name} removed from ${img.engineName}`);
      load();
    } catch { toast.error('Failed to remove image. It may be in use.'); }
  };

  const runPrune = async (target: EngineTarget, label: string) => {
    if (!confirm(`Remove all unused images on ${label}? This cannot be undone.`)) return;
    try {
      const result = await dockerApi.pruneImages(target);
      if (result && 'perEngine' in (result as PruneAllRecap<{ deleted: string[]; spaceReclaimed: number }>)) {
        const recap = result as PruneAllRecap<{ deleted: string[]; spaceReclaimed: number }>;
        const totalDeleted = recap.perEngine.reduce((s, b) => s + (b.result?.deleted.length || 0), 0);
        const totalSpace = recap.perEngine.reduce((s, b) => s + (b.result?.spaceReclaimed || 0), 0);
        const failed = recap.perEngine.filter(b => !b.ok);
        toast.success(`Pruned ${totalDeleted} image(s) across ${recap.perEngine.length} engine(s), reclaimed ${formatSize(totalSpace)}${failed.length ? ` (${failed.length} engine(s) failed)` : ''}`);
      } else {
        const r = result as { deleted: string[]; spaceReclaimed: number };
        toast.success(`Pruned ${r.deleted.length} image(s), reclaimed ${formatSize(r.spaceReclaimed)}`);
      }
      load();
    } catch { toast.error('Prune failed'); }
    finally { setPruneOpen(false); }
  };

  // Per-engine counts for the filter bar badges.
  const counts = useMemo(() => {
    const c: Record<number, number> = {};
    for (const img of images) if (img.engineId != null) c[img.engineId] = (c[img.engineId] || 0) + 1;
    return c;
  }, [images]);

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><HardDrive size={20} /> Images</h1>
        <div className="flex gap-2 relative">
          {/* Prune dropdown — only useful when there are multiple engines */}
          {engines.filter(e => e.enabled).length > 1 ? (
            <div className="relative">
              <button
                onClick={() => setPruneOpen(o => !o)}
                className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-status-down/30 text-status-down hover:bg-status-down/10"
              >
                <Eraser size={14} /> Prune <ChevronDown size={12} />
              </button>
              {pruneOpen && (
                <div className="absolute right-0 top-full mt-1 z-10 min-w-[200px] rounded-lg border border-border bg-bg-secondary shadow-lg py-1">
                  <button
                    onClick={() => runPrune('all', 'all engines')}
                    className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover flex items-center gap-2"
                  >
                    <Server size={11} /> Prune on <strong>all engines</strong>
                  </button>
                  <div className="border-t border-border my-1" />
                  {engines.filter(e => e.enabled).map((e) => (
                    <button
                      key={e.id}
                      onClick={() => runPrune(e.id, e.name)}
                      className="w-full text-left px-3 py-2 text-xs text-text-secondary hover:bg-bg-hover flex items-center gap-2"
                    >
                      <Server size={11} /> Prune on {e.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={() => runPrune(null, 'this engine')}
              className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-status-down/30 text-status-down hover:bg-status-down/10"
            >
              <Eraser size={14} /> Prune
            </button>
          )}
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      <EngineFilterBar engines={engines} selected={engineFilter} onSelect={setEngineFilter} counts={counts} totalCount={images.length} className="mb-4" />

      {/* Pull image */}
      <div className="flex gap-2 mb-6">
        <input
          value={pullInput}
          onChange={e => setPullInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handlePull()}
          placeholder={engineFilter != null
            ? `nginx:latest — pulls on ${engines.find(e => e.id === engineFilter)?.name || 'selected engine'}`
            : 'nginx:latest — pulls on default engine (filter to target a specific one)'}
          className="flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <button
          onClick={handlePull}
          disabled={pulling || !pullInput.trim()}
          className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
        >
          <Download size={14} /> Pull
        </button>
      </div>

      {/* Images table */}
      <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-tertiary">
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Repository:Tag</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">ID</th>
              {engineFilter == null && <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Engine</th>}
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-text-muted">Size</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-text-muted">Created</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-text-muted w-16"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {images.map((img) => (
              <tr key={`${img.engineId ?? 'local'}:${img.id}`} className="hover:bg-bg-hover/50">
                <td className="px-4 py-2.5">
                  <div className="space-y-0.5">
                    {(img.repoTags.length > 0 ? img.repoTags : ['<none>:<none>']).map((tag, i) => (
                      <div key={i} className="text-text-primary font-mono text-xs">{tag}</div>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-text-muted">{img.id}</td>
                {engineFilter == null && (
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-bg-tertiary text-text-secondary border border-border">
                      <Server size={9} /> {img.engineName}
                    </span>
                  </td>
                )}
                <td className="px-4 py-2.5 text-right text-text-secondary text-xs">{formatSize(img.size)}</td>
                <td className="px-4 py-2.5 text-right text-text-muted text-xs">{new Date(img.created * 1000).toLocaleDateString()}</td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => handleRemove(img)} className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-status-down" title={`Remove on ${img.engineName}`}>
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {images.length === 0 && (
              <tr><td colSpan={engineFilter == null ? 6 : 5} className="px-4 py-8 text-center text-text-muted">No images found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
