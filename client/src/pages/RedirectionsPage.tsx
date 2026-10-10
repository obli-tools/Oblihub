import { useEffect, useState } from 'react';
import { RefreshCw, Plus, Trash2, Edit2, ArrowRight, Power, PowerOff } from 'lucide-react';
import { proxyApi } from '@/api/proxy.api';
import type { RedirectionHost, Certificate } from '@oblihub/shared';
import toast from 'react-hot-toast';

export function RedirectionsPage() {
  const [hosts, setHosts] = useState<RedirectionHost[]>([]);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<RedirectionHost> | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [domainInput, setDomainInput] = useState('');

  const load = async () => {
    try {
      const [h, c] = await Promise.all([proxyApi.listRedirections(), proxyApi.listCertificates()]);
      setHosts(h); setCerts(c);
    } catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const startCreate = () => {
    setEditing({ domainNames: [], forwardScheme: 'https', forwardDomain: '', forwardPath: '/', preservePath: true, sslForced: false, http2Support: false, hstsEnabled: false, blockExploits: false, enabled: true });
    setEditId(null); setDomainInput('');
  };

  const addDomain = () => {
    const d = domainInput.trim().toLowerCase();
    if (!d || editing?.domainNames?.includes(d)) return;
    setEditing(e => e ? { ...e, domainNames: [...(e.domainNames || []), d] } : null);
    setDomainInput('');
  };

  const handleSave = async () => {
    if (!editing?.domainNames?.length) { toast.error('At least one domain required'); return; }
    if (!editing.forwardDomain) { toast.error('Forward domain required'); return; }
    try {
      if (editId) { await proxyApi.updateRedirection(editId, editing); toast.success('Updated'); }
      else { await proxyApi.createRedirection(editing); toast.success('Created'); }
      setEditing(null); setEditId(null); load();
    } catch { toast.error('Failed to save'); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><ArrowRight size={20} /> Redirection Hosts</h1>
        <div className="flex gap-2">
          <button onClick={startCreate} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover"><Plus size={14} /> Add</button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover"><RefreshCw size={14} /></button>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50" onClick={() => setEditing(null)}>
          <div className="rounded-xl border border-border bg-bg-primary w-full max-w-lg max-h-[80vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-text-primary">{editId ? 'Edit' : 'New'} Redirection</h2>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Domain Names</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {(editing.domainNames || []).map(d => (
                    <span key={d} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/10 text-accent text-xs font-mono">
                      {d} <button onClick={() => setEditing(e => e ? { ...e, domainNames: (e.domainNames || []).filter(x => x !== d) } : null)} className="hover:text-status-down">&times;</button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input value={domainInput} onChange={e => setDomainInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addDomain())} placeholder="old-domain.com"
                    className="flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                  <button onClick={addDomain} className="px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Add</button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <select value={editing.forwardScheme || 'https'} onChange={e => setEditing(h => h ? { ...h, forwardScheme: e.target.value as 'http' | 'https' } : null)}
                  className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                  <option value="http">http</option><option value="https">https</option>
                </select>
                <input value={editing.forwardDomain || ''} onChange={e => setEditing(h => h ? { ...h, forwardDomain: e.target.value } : null)} placeholder="new-domain.com"
                  className="col-span-2 rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                  <input type="checkbox" checked={editing.preservePath !== false} onChange={e => setEditing(h => h ? { ...h, preservePath: e.target.checked } : null)} className="rounded" />
                  Preserve path
                </label>
              </div>
              <select value={editing.certificateId || ''} onChange={e => setEditing(h => h ? { ...h, certificateId: parseInt(e.target.value) || null } : null)}
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                <option value="">No SSL</option>
                {certs.filter(c => c.status === 'valid').map(c => (<option key={c.id} value={c.id}>{c.domainNames.join(', ')}</option>))}
              </select>
            </div>
            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button onClick={() => { setEditing(null); setEditId(null); }} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
              <button onClick={handleSave} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Save</button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {hosts.map(host => (
          <div key={host.id} className={`rounded-xl border bg-bg-secondary px-4 py-3 flex items-center gap-4 ${host.enabled ? 'border-border' : 'border-border opacity-50'}`}>
            <div className="h-2.5 w-2.5 rounded-full shrink-0 bg-status-pending" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary">{host.domainNames.join(', ')}</div>
              <div className="text-xs text-text-muted flex items-center gap-1">
                <ArrowRight size={10} /> {host.forwardScheme}://{host.forwardDomain}{host.forwardPath}
                {host.preservePath && <span className="text-[9px] px-1 rounded bg-bg-tertiary">+path</span>}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => { setEditing({ ...host }); setEditId(host.id); setDomainInput(''); }} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover"><Edit2 size={14} /></button>
              <button onClick={async () => { if (confirm('Delete?')) { await proxyApi.deleteRedirection(host.id); toast.success('Deleted'); load(); } }} className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-bg-hover"><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
        {hosts.length === 0 && <div className="text-center py-12 text-text-muted">No redirections configured</div>}
      </div>
    </div>
  );
}
