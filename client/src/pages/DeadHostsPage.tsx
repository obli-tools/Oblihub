import { useEffect, useState } from 'react';
import { RefreshCw, Plus, Trash2, Ban } from 'lucide-react';
import { proxyApi } from '@/api/proxy.api';
import type { DeadHost } from '@oblihub/shared';
import toast from 'react-hot-toast';

export function DeadHostsPage() {
  const [hosts, setHosts] = useState<DeadHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [domainInput, setDomainInput] = useState('');
  const [newDomains, setNewDomains] = useState<string[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const load = async () => {
    try { setHosts(await proxyApi.listDeadHosts()); }
    catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const addDomain = () => {
    const d = domainInput.trim().toLowerCase();
    if (d && !newDomains.includes(d)) { setNewDomains(prev => [...prev, d]); setDomainInput(''); }
  };

  const handleCreate = async () => {
    if (!newDomains.length) { toast.error('At least one domain required'); return; }
    try {
      await proxyApi.createDeadHost({ domainNames: newDomains });
      toast.success('404 host created');
      setShowCreate(false); setNewDomains([]); load();
    } catch { toast.error('Failed to create'); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Ban size={20} /> 404 Hosts</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowCreate(v => !v)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover"><Plus size={14} /> Add</button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover"><RefreshCw size={14} /></button>
        </div>
      </div>

      {showCreate && (
        <div className="rounded-xl border border-border bg-bg-secondary p-4 mb-6 space-y-3">
          <div className="flex flex-wrap gap-1.5 mb-2">
            {newDomains.map(d => (
              <span key={d} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/10 text-accent text-xs font-mono">
                {d} <button onClick={() => setNewDomains(prev => prev.filter(x => x !== d))} className="hover:text-status-down">&times;</button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={domainInput} onChange={e => setDomainInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addDomain())} placeholder="blocked-domain.com"
              className="flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <button onClick={addDomain} className="px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Add</button>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Create</button>
            <button onClick={() => { setShowCreate(false); setNewDomains([]); }} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {hosts.map(host => (
          <div key={host.id} className="rounded-xl border border-border bg-bg-secondary px-4 py-3 flex items-center gap-4">
            <div className="h-2.5 w-2.5 rounded-full shrink-0 bg-status-down" />
            <div className="flex-1"><span className="text-sm font-medium text-text-primary">{host.domainNames.join(', ')}</span></div>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-down/10 text-status-down">404</span>
            <button onClick={async () => { if (confirm('Delete?')) { await proxyApi.deleteDeadHost(host.id); toast.success('Deleted'); load(); } }}
              className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-bg-hover"><Trash2 size={14} /></button>
          </div>
        ))}
        {hosts.length === 0 && <div className="text-center py-12 text-text-muted">No 404 hosts configured</div>}
      </div>
    </div>
  );
}
