import { useEffect, useMemo, useState } from 'react';
import { Ban, RefreshCw, Trash2, Plus, Search, Globe, Shield, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import type { BannedIp, BanSourceType } from '@oblihub/shared';
import { bansApi } from '@/api/bans.api';

/**
 * Bans management page. Shows the current wall of banned IPs — the visible surface of the
 * honeypot + manual ban machinery. Every row carries enough context (source, hit count, when,
 * where, GeoIP, reason) to decide whether the ban stays or gets lifted.
 *
 * Design bias: this page is read the day of an incident with the on-call operator half-panicked.
 * Every action needs to be one click and every column needs to answer a question they'd ask.
 */
export function BansPage() {
  const [bans, setBans] = useState<BannedIp[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'' | BanSourceType>('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newIp, setNewIp] = useState('');
  const [newReason, setNewReason] = useState('');

  const load = async () => {
    try {
      const b = await bansApi.list({ activeOnly, sourceType: sourceFilter || undefined });
      setBans(b);
    } catch { toast.error('Failed to load bans'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [activeOnly, sourceFilter]);

  const filtered = useMemo(() => {
    if (!search.trim()) return bans;
    const q = search.trim().toLowerCase();
    return bans.filter(b =>
      b.ip.toLowerCase().includes(q) ||
      (b.reason || '').toLowerCase().includes(q) ||
      (b.sourceProxyHostDomain || '').toLowerCase().includes(q) ||
      (b.geo?.city || '').toLowerCase().includes(q) ||
      (b.geo?.countryName || '').toLowerCase().includes(q) ||
      (b.geo?.org || '').toLowerCase().includes(q),
    );
  }, [bans, search]);

  const unban = async (id: number) => {
    try {
      await bansApi.unban(id);
      toast.success('IP unbanned');
      await load();
    } catch { toast.error('Unban failed'); }
  };

  const createManual = async () => {
    if (!newIp.trim()) { toast.error('IP required'); return; }
    try {
      await bansApi.create({ ip: newIp.trim(), reason: newReason.trim() || undefined, banDurationSeconds: null });
      toast.success('IP banned');
      setCreating(false); setNewIp(''); setNewReason('');
      await load();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Ban failed'); }
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2">
          <Ban size={20} /> Banned IPs
        </h1>
        <div className="flex items-center gap-2">
          <button onClick={() => setCreating(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Ban IP
          </button>
          <button onClick={load} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover" title="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-1 min-w-[240px] max-w-md rounded-lg border border-border bg-bg-tertiary px-3 py-1.5">
          <Search size={12} className="text-text-muted" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search IP, city, org, reason..."
            className="flex-1 bg-transparent text-sm text-text-primary focus:outline-none" />
        </div>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value as '' | BanSourceType)}
          className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary">
          <option value="">All sources</option>
          <option value="honeypot-path">Honeypot path</option>
          <option value="honeypot-acl">ACL violation</option>
          <option value="manual">Manual</option>
          <option value="obliguard-sync">Obliguard sync</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} />
          Active only
        </label>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-bg-tertiary/60">
                <tr className="text-[10px] text-text-muted uppercase tracking-wider text-left">
                  <th className="py-2 px-3 font-normal">IP</th>
                  <th className="py-2 px-3 font-normal">Location</th>
                  <th className="py-2 px-3 font-normal">Source</th>
                  <th className="py-2 px-3 font-normal">Reason</th>
                  <th className="py-2 px-3 font-normal text-right">Hits</th>
                  <th className="py-2 px-3 font-normal">First seen</th>
                  <th className="py-2 px-3 font-normal">Until</th>
                  <th className="py-2 px-3 font-normal">Obliguard</th>
                  <th className="py-2 px-3 font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(b => (
                  <tr key={b.id} className={`border-t border-border/40 hover:bg-bg-tertiary/40 ${!b.isActive ? 'opacity-50' : ''}`}>
                    <td className="py-1.5 px-3">
                      <div className="flex items-center gap-1.5">
                        {b.geo?.countryCode && <span>{countryFlag(b.geo.countryCode)}</span>}
                        <span className="font-mono text-text-primary">{b.ip}</span>
                      </div>
                    </td>
                    <td className="py-1.5 px-3 text-text-secondary max-w-[220px]">
                      {b.geo ? (
                        <div className="truncate">
                          {[b.geo.city, b.geo.countryName].filter(Boolean).join(', ') || '-'}
                          {b.geo.org && <div className="text-[10px] text-text-muted truncate">{b.geo.org}</div>}
                        </div>
                      ) : <span className="text-text-muted">-</span>}
                    </td>
                    <td className="py-1.5 px-3">
                      <SourceChip source={b.sourceType} />
                    </td>
                    <td className="py-1.5 px-3 max-w-[280px]">
                      <div className="truncate font-mono text-text-secondary" title={b.reason || ''}>{b.reason || '-'}</div>
                      {b.sourceProxyHostDomain && (
                        <div className="text-[10px] text-text-muted truncate">on {b.sourceProxyHostDomain}</div>
                      )}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono text-text-primary">{b.hitCount}</td>
                    <td className="py-1.5 px-3 text-text-secondary whitespace-nowrap">{new Date(b.firstSeenAt).toLocaleString()}</td>
                    <td className="py-1.5 px-3 text-text-secondary whitespace-nowrap">
                      {b.bannedUntil ? new Date(b.bannedUntil).toLocaleString() : <span className="text-status-down font-medium">Permanent</span>}
                    </td>
                    <td className="py-1.5 px-3">
                      {b.sentToObliguardAt
                        ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-up/10 text-status-up">synced</span>
                        : b.obliguardError
                        ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-down/10 text-status-down" title={b.obliguardError}>failed</span>
                        : <span className="text-[10px] text-text-muted">-</span>}
                    </td>
                    <td className="py-1.5 px-3 text-right">
                      {b.isActive && (
                        <button onClick={() => unban(b.id)} className="p-1 rounded text-text-muted hover:text-status-up" title="Unban">
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {creating && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50" onClick={() => setCreating(false)}>
          <div className="rounded-xl border border-border bg-bg-primary w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-text-primary">Manual ban</h2>
            </div>
            <div className="p-6 space-y-3">
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">IP address</label>
                <input value={newIp} onChange={e => setNewIp(e.target.value)} placeholder="1.2.3.4"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary font-mono" autoFocus />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">Reason (optional)</label>
                <input value={newReason} onChange={e => setNewReason(e.target.value)} placeholder="Manual ban — sketchy patterns"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary" />
              </div>
              <p className="text-[10px] text-text-muted">
                Ban is permanent by default. Also sent to Obliguard if configured.
              </p>
            </div>
            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button onClick={() => setCreating(false)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
              <button onClick={createManual} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Ban</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SourceChip({ source }: { source: BanSourceType }) {
  const { icon: Icon, label, cls } = {
    'honeypot-path': { icon: AlertTriangle, label: 'Honeypot', cls: 'bg-status-down/10 text-status-down' },
    'honeypot-acl':  { icon: Shield,        label: 'ACL',      cls: 'bg-status-pending/10 text-status-pending' },
    'manual':        { icon: Ban,           label: 'Manual',   cls: 'bg-accent/10 text-accent' },
    'obliguard-sync':{ icon: Globe,         label: 'Obliguard',cls: 'bg-text-muted/10 text-text-muted' },
  }[source];
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${cls}`}>
      <Icon size={9} /> {label}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-12 text-center">
      <Ban size={40} className="mx-auto mb-3 text-text-muted" />
      <div className="text-sm text-text-secondary font-medium mb-1">No bans yet</div>
      <div className="text-xs text-text-muted">
        Enable the honeypot on a proxy host and IPs that probe common exploit paths (or fail an access list) will appear here.
      </div>
    </div>
  );
}

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return '🏳️';
  const A = 0x1F1E6;
  return String.fromCodePoint(A + (code.charCodeAt(0) - 65), A + (code.charCodeAt(1) - 65));
}
