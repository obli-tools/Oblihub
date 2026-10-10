import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Trash2, Plus, Network, Link, Unlink, ChevronDown, ChevronRight, Eraser, Server } from 'lucide-react';
import { dockerApi, type WithEngine, type EngineTarget, type PruneAllRecap } from '@/api/docker.api';
import { stacksApi } from '@/api/stacks.api';
import { enginesApi } from '@/api/engines.api';
import type { DockerNetwork, Stack, DockerEngine } from '@oblihub/shared';
import { EngineFilterBar, type EngineFilterValue } from '@/components/EngineFilterBar';
import toast from 'react-hot-toast';

export function NetworksPage() {
  const [networks, setNetworks] = useState<WithEngine<DockerNetwork>[]>([]);
  const [engines, setEngines] = useState<DockerEngine[]>([]);
  const [engineFilter, setEngineFilter] = useState<EngineFilterValue>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [createForm, setCreateForm] = useState({ name: '', driver: 'bridge', subnet: '', gateway: '', internal: false, attachable: true });
  const [connectForm, setConnectForm] = useState<{ networkId: string; networkName: string; engineId: number | null; selectedContainers: Set<string> } | null>(null);
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [pruneOpen, setPruneOpen] = useState(false);

  const apiTarget: EngineTarget = engineFilter == null ? 'all' : engineFilter;

  const load = async () => {
    try {
      setNetworks(await dockerApi.listNetworks(apiTarget));
    } catch { toast.error('Failed to load networks'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [engineFilter]);
  useEffect(() => {
    stacksApi.list().then(setStacks).catch(() => {});
    enginesApi.list().then(setEngines).catch(() => {});
  }, []);

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!createForm.name.trim()) return;
    try {
      // Create on the currently-filtered engine (defaults to local when "All" is selected —
      // creating "everywhere" doesn't make sense for networks, the user must pick a target).
      const target: EngineTarget = engineFilter == null ? null : engineFilter;
      await dockerApi.createNetwork(createForm, target);
      toast.success(`Network ${createForm.name} created`);
      setCreateForm({ name: '', driver: 'bridge', subnet: '', gateway: '', internal: false, attachable: true });
      setShowCreate(false);
      load();
    } catch { toast.error('Failed to create network'); }
  };

  const handleRemove = async (net: WithEngine<DockerNetwork>) => {
    if (!confirm(`Remove network "${net.name}" on ${net.engineName}?`)) return;
    try {
      await dockerApi.removeNetwork(net.id, net.engineId ?? null);
      toast.success(`Network ${net.name} removed from ${net.engineName}`);
      load();
    } catch { toast.error('Failed to remove network. It may be in use.'); }
  };

  const handleDisconnect = async (networkId: string, containerId: string, containerName: string, engineId: number | null) => {
    try {
      await dockerApi.disconnectNetwork(networkId, containerId, engineId);
      toast.success(`${containerName} disconnected`);
      load();
    } catch { toast.error('Failed to disconnect'); }
  };

  const handleConnect = async () => {
    if (!connectForm || connectForm.selectedContainers.size === 0) return;
    try {
      for (const dockerId of connectForm.selectedContainers) {
        await dockerApi.connectNetwork(connectForm.networkId, dockerId, undefined, connectForm.engineId);
      }
      toast.success(`${connectForm.selectedContainers.size} container(s) connected`);
      setConnectForm(null);
      load();
    } catch { toast.error('Failed to connect containers'); }
  };

  const runPrune = async (target: EngineTarget, label: string) => {
    if (!confirm(`Remove all unused networks on ${label}?`)) return;
    try {
      const result = await dockerApi.pruneNetworks(target);
      if (result && 'perEngine' in (result as PruneAllRecap<{ deleted: string[] }>)) {
        const recap = result as PruneAllRecap<{ deleted: string[] }>;
        const total = recap.perEngine.reduce((s, b) => s + (b.result?.deleted.length || 0), 0);
        const failed = recap.perEngine.filter(b => !b.ok);
        toast.success(`Pruned ${total} network(s) across ${recap.perEngine.length} engine(s)${failed.length ? ` (${failed.length} failed)` : ''}`);
      } else {
        const r = result as { deleted: string[] };
        toast.success(`Pruned ${r.deleted.length} network(s)`);
      }
      load();
    } catch { toast.error('Prune failed'); }
    finally { setPruneOpen(false); }
  };

  const counts = useMemo(() => {
    const c: Record<number, number> = {};
    for (const n of networks) if (n.engineId != null) c[n.engineId] = (c[n.engineId] || 0) + 1;
    return c;
  }, [networks]);

  const toggleStackContainers = (stack: Stack) => {
    if (!connectForm) return;
    const ids = stack.containers.map(c => c.dockerId);
    const allSelected = ids.every(id => connectForm.selectedContainers.has(id));
    setConnectForm(f => {
      if (!f) return null;
      const next = new Set(f.selectedContainers);
      ids.forEach(id => allSelected ? next.delete(id) : next.add(id));
      return { ...f, selectedContainers: next };
    });
  };

  const toggleContainer = (dockerId: string) => {
    setConnectForm(f => {
      if (!f) return null;
      const next = new Set(f.selectedContainers);
      next.has(dockerId) ? next.delete(dockerId) : next.add(dockerId);
      return { ...f, selectedContainers: next };
    });
  };

  const isSystemNetwork = (name: string) => ['bridge', 'host', 'none'].includes(name);

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Network size={20} /> Networks</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowCreate(v => !v)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Create
          </button>
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

      <EngineFilterBar engines={engines} selected={engineFilter} onSelect={setEngineFilter} counts={counts} totalCount={networks.length} className="mb-4" />

      {/* Create form */}
      {showCreate && (
        <div className="rounded-xl border border-border bg-bg-secondary p-4 mb-6 space-y-3">
          <h3 className="text-sm font-semibold text-text-secondary">Create Network</h3>
          <div className="grid grid-cols-2 gap-3">
            <input value={createForm.name} onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))} placeholder="Network name" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <select value={createForm.driver} onChange={e => setCreateForm(f => ({ ...f, driver: e.target.value }))} className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
              <option value="bridge">bridge</option>
              <option value="overlay">overlay</option>
              <option value="macvlan">macvlan</option>
              <option value="ipvlan">ipvlan</option>
            </select>
            <input value={createForm.subnet} onChange={e => setCreateForm(f => ({ ...f, subnet: e.target.value }))} placeholder="Subnet (e.g. 172.20.0.0/16)" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <input value={createForm.gateway} onChange={e => setCreateForm(f => ({ ...f, gateway: e.target.value }))} placeholder="Gateway (e.g. 172.20.0.1)" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
          <div className="flex items-center gap-4 text-xs">
            <button onClick={() => setCreateForm(f => ({ ...f, internal: !f.internal }))}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors ${createForm.internal ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-text-secondary hover:bg-bg-hover'}`}>
              <div className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors shrink-0 ${createForm.internal ? 'bg-accent' : 'bg-bg-tertiary'}`}>
                <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${createForm.internal ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
              </div>
              Internal
            </button>
            <button onClick={() => setCreateForm(f => ({ ...f, attachable: !f.attachable }))}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors ${createForm.attachable ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-text-secondary hover:bg-bg-hover'}`}>
              <div className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors shrink-0 ${createForm.attachable ? 'bg-accent' : 'bg-bg-tertiary'}`}>
                <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${createForm.attachable ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
              </div>
              Attachable
            </button>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Create</button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          </div>
        </div>
      )}

      {/* Connect container modal */}
      {connectForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setConnectForm(null)}>
          <div className="rounded-xl border border-border bg-bg-primary p-6 w-[480px] max-h-[70vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-text-primary mb-1">
              Connect Containers to <code className="font-mono text-accent">{connectForm.networkName}</code>
            </h3>
            <p className="text-xs text-text-muted mb-4">Select stacks or individual containers</p>
            {/* Warn specifically when the operator targets Oblihub's shared `proxy` network:
                a manual attach here is transient (any container recreate = attach lost) and
                doesn't produce a docker-compose.override.yml. Persistent proxy wiring goes
                through the Proxy Hosts page — Oblihub then writes the override on deploy. */}
            {connectForm.networkName === 'proxy' && (
              <div className="mb-4 rounded-lg border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-[11px] text-status-warning">
                <div className="font-semibold mb-1">⚠️ Manual attach — not persistent</div>
                <div className="text-status-warning/90 leading-relaxed">
                  Connecting here works right now, but is <strong>lost on the next container
                  recreation</strong> (rebuild, redeploy, docker restart). For a permanent
                  attach, create a <strong>Proxy Host</strong> targeting the service — Oblihub
                  auto-generates a compose override that survives every rebuild.
                </div>
                <a
                  href="/proxy"
                  className="inline-block mt-2 px-2 py-1 rounded bg-status-warning text-bg-primary font-medium hover:opacity-90"
                >
                  Go to Proxy Hosts →
                </a>
              </div>
            )}
            <div className="space-y-2 mb-4">
              {stacks.filter(s => s.containers.length > 0).map(s => {
                const allSelected = s.containers.every(c => connectForm.selectedContainers.has(c.dockerId));
                const someSelected = s.containers.some(c => connectForm.selectedContainers.has(c.dockerId));
                return (
                  <div key={s.id} className="rounded-lg border border-border overflow-hidden">
                    <button onClick={() => toggleStackContainers(s)}
                      className={`w-full text-left px-3 py-2 flex items-center gap-2 text-xs transition-colors ${allSelected ? 'bg-accent/10' : 'hover:bg-bg-hover'}`}>
                      <div className={`h-3 w-3 rounded border flex items-center justify-center shrink-0 ${allSelected ? 'bg-accent border-accent' : someSelected ? 'border-accent bg-accent/30' : 'border-border'}`}>
                        {allSelected && <span className="text-white text-[8px]">✓</span>}
                        {someSelected && !allSelected && <span className="text-white text-[8px]">-</span>}
                      </div>
                      <span className="font-medium text-text-primary">{s.name}</span>
                      <span className="text-text-muted ml-auto">{s.containers.length} containers</span>
                    </button>
                    <div className="border-t border-border/50">
                      {s.containers.map(c => {
                        const selected = connectForm.selectedContainers.has(c.dockerId);
                        return (
                          <button key={c.id} onClick={() => toggleContainer(c.dockerId)}
                            className={`w-full text-left px-3 py-1.5 pl-8 flex items-center gap-2 text-[11px] transition-colors ${selected ? 'bg-accent/5' : 'hover:bg-bg-hover/50'}`}>
                            <div className={`h-2.5 w-2.5 rounded border flex items-center justify-center shrink-0 ${selected ? 'bg-accent border-accent' : 'border-border'}`}>
                              {selected && <span className="text-white text-[7px]">✓</span>}
                            </div>
                            <span className="text-text-secondary">{c.containerName}</span>
                            <span className="text-text-muted font-mono text-[10px] ml-auto">{c.image}:{c.imageTag}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-muted">{connectForm.selectedContainers.size} selected</span>
              <div className="flex gap-2">
                <button onClick={() => setConnectForm(null)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
                <button onClick={handleConnect} disabled={connectForm.selectedContainers.size === 0} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50">Connect</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Networks list */}
      <div className="space-y-2">
        {networks.map((net) => (
          <div key={`${net.engineId ?? 'local'}:${net.id}`} className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
            <div className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-bg-hover/50" onClick={() => toggleExpand(net.id)}>
              {expanded.has(net.id) ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{net.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">{net.driver}</span>
                  {net.internal && <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-pending/10 text-status-pending">internal</span>}
                  {net.composeProject && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">{net.composeProject}</span>}
                  {engineFilter == null && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary border border-border inline-flex items-center gap-1">
                      <Server size={9} /> {net.engineName}
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-text-muted mt-0.5">
                  {net.id} &middot; {net.containers.length} container{net.containers.length !== 1 ? 's' : ''}
                  {net.ipam[0]?.subnet && <> &middot; {net.ipam[0].subnet}</>}
                </div>
              </div>
              {!isSystemNetwork(net.name) && (
                <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                  <button onClick={() => setConnectForm({ networkId: net.id, networkName: net.name, engineId: net.engineId ?? null, selectedContainers: new Set() })} className="p-1.5 rounded-md text-text-muted hover:text-accent hover:bg-bg-hover" title="Connect container">
                    <Link size={14} />
                  </button>
                  <button onClick={() => handleRemove(net)} className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-bg-hover" title={`Remove on ${net.engineName}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>

            {/* Expanded: show containers */}
            {expanded.has(net.id) && net.containers.length > 0 && (
              <div className="border-t border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-bg-tertiary">
                      <th className="text-left px-4 py-1.5 text-text-muted font-medium">Container</th>
                      <th className="text-left px-4 py-1.5 text-text-muted font-medium">IPv4</th>
                      <th className="text-left px-4 py-1.5 text-text-muted font-medium">IPv6</th>
                      <th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {net.containers.map(c => (
                      <tr key={c.id} className="hover:bg-bg-hover/30">
                        <td className="px-4 py-1.5 text-text-primary font-medium">{c.name}</td>
                        <td className="px-4 py-1.5 text-text-muted font-mono">{c.ipv4 || '-'}</td>
                        <td className="px-4 py-1.5 text-text-muted font-mono">{c.ipv6 || '-'}</td>
                        <td className="px-4 py-1.5">
                          {!isSystemNetwork(net.name) && (
                            <button onClick={() => handleDisconnect(net.id, c.id, c.name, net.engineId ?? null)} className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-status-down" title="Disconnect">
                              <Unlink size={12} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
        {networks.length === 0 && (
          <div className="text-center py-12 text-text-muted">No networks found</div>
        )}
      </div>
    </div>
  );
}
