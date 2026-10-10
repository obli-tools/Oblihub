import { useEffect, useState } from 'react';
import { RefreshCw, Plus, Trash2, Activity, Power, PowerOff, ChevronDown, ChevronRight } from 'lucide-react';
import { uptimeApi } from '@/api/uptime.api';
import { Sparkline } from '@/components/Sparkline';
import type { UptimeMonitor } from '@oblihub/shared';
import toast from 'react-hot-toast';

export function UptimeMonitorsPage() {
  const [monitors, setMonitors] = useState<UptimeMonitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', url: '', type: 'http', intervalSeconds: 60, timeoutMs: 5000, expectedStatus: 200, keyword: '' });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [heartbeatData, setHeartbeatData] = useState<Record<number, number[]>>({});

  const load = async () => {
    try { setMonitors(await uptimeApi.listMonitors()); }
    catch { toast.error('Failed to load monitors'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleCreate = async () => {
    if (!form.name.trim() || !form.url.trim()) { toast.error('Name and URL required'); return; }
    try {
      await uptimeApi.createMonitor(form);
      toast.success('Monitor created');
      setShowCreate(false); setForm({ name: '', url: '', type: 'http', intervalSeconds: 60, timeoutMs: 5000, expectedStatus: 200, keyword: '' });
      load();
    } catch { toast.error('Failed to create'); }
  };

  const toggleExpand = async (id: number) => {
    const next = new Set(expanded);
    if (next.has(id)) { next.delete(id); } else {
      next.add(id);
      // Load heartbeats for sparkline
      try {
        const hb = await uptimeApi.getHeartbeats(id, '1h');
        setHeartbeatData(prev => ({ ...prev, [id]: hb.map(h => h.responseTimeMs || 0).reverse() }));
      } catch { /* ignore */ }
    }
    setExpanded(next);
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Activity size={20} /> Uptime Monitors</h1>
        <div className="flex gap-2">
          <button onClick={async () => {
            try { const r = await uptimeApi.syncProxyHosts(); toast.success(`${r.created} monitor(s) created from proxy hosts`); load(); }
            catch { toast.error('Sync failed'); }
          }} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-accent/50 text-accent hover:bg-accent/10">Sync Proxy Hosts</button>
          <button onClick={() => setShowCreate(v => !v)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover"><Plus size={14} /> Add Monitor</button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover"><RefreshCw size={14} /></button>
        </div>
      </div>

      {showCreate && (
        <div className="rounded-xl border border-border bg-bg-secondary p-4 mb-6 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Monitor name" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://example.com" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
              <option value="http">HTTP(S)</option><option value="tcp">TCP</option><option value="keyword">Keyword</option>
            </select>
            <input type="number" value={form.intervalSeconds} onChange={e => setForm(f => ({ ...f, intervalSeconds: parseInt(e.target.value) || 60 }))} placeholder="Interval (sec)" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
          {form.type === 'keyword' && (
            <input value={form.keyword} onChange={e => setForm(f => ({ ...f, keyword: e.target.value }))} placeholder="Keyword to search in response" className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
          )}
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Create</button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {monitors.map(m => (
          <div key={m.id} className={`rounded-xl border bg-bg-secondary overflow-hidden ${m.enabled ? 'border-border' : 'border-border opacity-50'}`}>
            <div className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-bg-hover/50" onClick={() => toggleExpand(m.id)}>
              {expanded.has(m.id) ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
              <div className={`h-3 w-3 rounded-full shrink-0 ${m.currentStatus === 'up' ? 'bg-status-up' : m.currentStatus === 'down' ? 'bg-status-down animate-pulse' : 'bg-text-muted'}`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-primary">{m.name}</div>
                <div className="text-[10px] text-text-muted font-mono truncate">{m.url}</div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className={`text-xs font-medium ${m.currentStatus === 'up' ? 'text-status-up' : m.currentStatus === 'down' ? 'text-status-down' : 'text-text-muted'}`}>
                  {m.uptimePercent?.toFixed(1)}%
                </span>
                <span className="text-[10px] text-text-muted">{m.avgResponseTime}ms</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">{m.intervalSeconds}s</span>
              </div>
              <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                <button onClick={async () => { await uptimeApi.toggleMonitor(m.id); load(); }} className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover">
                  {m.enabled ? <Power size={14} /> : <PowerOff size={14} />}
                </button>
                <button onClick={async () => { if (confirm('Delete?')) { await uptimeApi.deleteMonitor(m.id); toast.success('Deleted'); load(); } }} className="p-1 rounded text-text-muted hover:text-status-down hover:bg-bg-hover">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            {expanded.has(m.id) && heartbeatData[m.id] && (
              <div className="border-t border-border px-4 py-3">
                <div className="text-[10px] text-text-muted mb-1">Response time (last hour)</div>
                <Sparkline data={heartbeatData[m.id]} width={600} height={40} color={m.currentStatus === 'up' ? '#3fb950' : '#ff4a4a'} />
              </div>
            )}
          </div>
        ))}
        {monitors.length === 0 && <div className="text-center py-12 text-text-muted">No monitors configured</div>}
      </div>
    </div>
  );
}
