import { useEffect, useState } from 'react';
import { RefreshCw, Plus, Trash2, Edit2, Radio } from 'lucide-react';
import { proxyApi } from '@/api/proxy.api';
import type { StreamHost } from '@oblihub/shared';
import toast from 'react-hot-toast';

export function StreamsPage() {
  const [streams, setStreams] = useState<StreamHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<StreamHost> | null>(null);
  const [editId, setEditId] = useState<number | null>(null);

  const load = async () => {
    try { setStreams(await proxyApi.listStreams()); }
    catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const startCreate = () => {
    setEditing({ incomingPort: 0, forwardingHost: '', forwardingPort: 0, tcpForwarding: true, udpForwarding: false, enabled: true });
    setEditId(null);
  };

  const handleSave = async () => {
    if (!editing?.incomingPort || !editing.forwardingHost || !editing.forwardingPort) { toast.error('All fields required'); return; }
    try {
      if (editId) { await proxyApi.updateStream(editId, editing); toast.success('Updated'); }
      else { await proxyApi.createStream(editing); toast.success('Created'); }
      setEditing(null); setEditId(null); load();
    } catch { toast.error('Failed to save'); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Radio size={20} /> Streams</h1>
        <div className="flex gap-2">
          <button onClick={startCreate} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover"><Plus size={14} /> Add</button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover"><RefreshCw size={14} /></button>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50" onClick={() => setEditing(null)}>
          <div className="rounded-xl border border-border bg-bg-primary w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-text-primary">{editId ? 'Edit' : 'New'} Stream</h2>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Incoming Port</label>
                <input type="number" value={editing.incomingPort || ''} onChange={e => setEditing(h => h ? { ...h, incomingPort: parseInt(e.target.value) || 0 } : null)}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-text-secondary block mb-1.5">Forward Host</label>
                  <input value={editing.forwardingHost || ''} onChange={e => setEditing(h => h ? { ...h, forwardingHost: e.target.value } : null)}
                    className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
                <div>
                  <label className="text-xs font-medium text-text-secondary block mb-1.5">Forward Port</label>
                  <input type="number" value={editing.forwardingPort || ''} onChange={e => setEditing(h => h ? { ...h, forwardingPort: parseInt(e.target.value) || 0 } : null)}
                    className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                  <input type="checkbox" checked={editing.tcpForwarding !== false} onChange={e => setEditing(h => h ? { ...h, tcpForwarding: e.target.checked } : null)} className="rounded" /> TCP
                </label>
                <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                  <input type="checkbox" checked={!!editing.udpForwarding} onChange={e => setEditing(h => h ? { ...h, udpForwarding: e.target.checked } : null)} className="rounded" /> UDP
                </label>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button onClick={() => { setEditing(null); setEditId(null); }} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
              <button onClick={handleSave} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Save</button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-tertiary">
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Incoming Port</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Forward To</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Protocol</th>
              <th className="w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {streams.map(s => (
              <tr key={s.id} className="hover:bg-bg-hover/50">
                <td className="px-4 py-2.5 font-mono text-text-primary">{s.incomingPort}</td>
                <td className="px-4 py-2.5 font-mono text-text-muted">{s.forwardingHost}:{s.forwardingPort}</td>
                <td className="px-4 py-2.5">
                  {s.tcpForwarding && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent mr-1">TCP</span>}
                  {s.udpForwarding && <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-pending/10 text-status-pending">UDP</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center gap-1 justify-end">
                    <button onClick={() => { setEditing({ ...s }); setEditId(s.id); }} className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary"><Edit2 size={14} /></button>
                    <button onClick={async () => { if (confirm('Delete?')) { await proxyApi.deleteStream(s.id); toast.success('Deleted'); load(); } }} className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-status-down"><Trash2 size={14} /></button>
                  </div>
                </td>
              </tr>
            ))}
            {streams.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-text-muted">No streams configured</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
