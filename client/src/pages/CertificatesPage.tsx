import { Fragment, useEffect, useRef, useState } from 'react';
import { RefreshCw, Plus, Trash2, Shield, Upload, RotateCw, ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { proxyApi } from '@/api/proxy.api';
import type { Certificate } from '@oblihub/shared';
import toast from 'react-hot-toast';

const STATUS_STYLES: Record<string, string> = {
  valid: 'bg-status-up/10 text-status-up',
  pending: 'bg-status-pending/10 text-status-pending',
  expired: 'bg-status-down/10 text-status-down',
  error: 'bg-status-down/10 text-status-down',
};

export function CertificatesPage() {
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ domains: '', provider: 'letsencrypt', email: '' });

  const load = async () => {
    try { setCerts(await proxyApi.listCertificates()); }
    catch { toast.error('Failed to load certificates'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // Poll pending certs
  useEffect(() => {
    if (!certs.some(c => c.status === 'pending')) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [certs]);

  const handleCreate = async () => {
    const domainNames = form.domains.split(',').map(d => d.trim()).filter(Boolean);
    if (!domainNames.length) { toast.error('Enter at least one domain'); return; }
    if (form.provider === 'letsencrypt' && !form.email) { toast.error('Email required for Let\'s Encrypt'); return; }
    try {
      await proxyApi.createCertificate({ domainNames, provider: form.provider, acmeEmail: form.email });
      toast.success(form.provider === 'letsencrypt' ? 'Certificate request started...' : 'Certificate created');
      setShowCreate(false);
      setForm({ domains: '', provider: 'letsencrypt', email: '' });
      load();
    } catch { toast.error('Failed to create certificate'); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this certificate?')) return;
    try {
      await proxyApi.deleteCertificate(id);
      toast.success('Certificate deleted');
      load();
    } catch { toast.error('Failed to delete. Certificate may be in use.'); }
  };

  const handleRetry = async (cert: Certificate) => {
    if (cert.provider !== 'letsencrypt') { toast.error('Retry only available for Let\'s Encrypt'); return; }
    try {
      await proxyApi.retryCertificate(cert.id);
      // Open the log row automatically so the operator sees fresh entries arrive.
      setExpandedLogs(prev => { const n = new Set(prev); n.add(cert.id); return n; });
      toast.success('Retry started — watch the log below');
      load();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Retry failed'); }
  };

  // Which certs have their log row expanded. Auto-expand rule: any time we OBSERVE a cert in
  // pending or error state for the first time, we open its log row. That covers:
  //   - First load: existing pending/error certs are opened immediately
  //   - After clicking "Request cert": the new pending cert opens as soon as the next poll
  //     surfaces it (since we polled `load()` after create)
  //   - Retry click: handleRetry already adds it; if missed somehow, this catches it too
  // We never auto-collapse — once open, only the user can hide it (collapse chevron). That
  // way a transition pending → valid keeps the success log visible until they close it.
  const [expandedLogs, setExpandedLogs] = useState<Set<number>>(new Set());
  const seenIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const toOpen: number[] = [];
    for (const c of certs) {
      if (seenIdsRef.current.has(c.id)) continue;
      seenIdsRef.current.add(c.id);
      if (c.status === 'pending' || c.status === 'error') toOpen.push(c.id);
    }
    if (toOpen.length) {
      setExpandedLogs(prev => {
        const next = new Set(prev);
        for (const id of toOpen) next.add(id);
        return next;
      });
    }
  }, [certs]);

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Shield size={20} /> SSL Certificates</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowCreate(v => !v)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Add Certificate
          </button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="rounded-xl border border-border bg-bg-secondary p-4 mb-6 space-y-3">
          <h3 className="text-sm font-semibold text-text-secondary">New Certificate</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input value={form.domains} onChange={e => setForm(f => ({ ...f, domains: e.target.value }))} placeholder="domain.com, www.domain.com"
              className="sm:col-span-2 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <select value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}
              className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
              <option value="letsencrypt">Let's Encrypt</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          {form.provider === 'letsencrypt' && (
            <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="admin@example.com"
              type="email" className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
          )}
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
              {form.provider === 'letsencrypt' ? 'Request Certificate' : 'Create'}
            </button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-tertiary">
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Domains</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Provider</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Status</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-text-muted">Expires</th>
              <th className="w-16"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {certs.map(cert => {
              const open = expandedLogs.has(cert.id);
              const hasLog = (cert.requestLog?.length || 0) > 0;
              return (
                <Fragment key={cert.id}>
                  <tr className="hover:bg-bg-hover/50">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1">
                        {(hasLog || cert.status === 'pending') && (
                          <button
                            onClick={() => setExpandedLogs(prev => { const n = new Set(prev); n.has(cert.id) ? n.delete(cert.id) : n.add(cert.id); return n; })}
                            className="text-text-muted hover:text-text-primary"
                            title={open ? 'Hide request log' : 'Show request log'}
                          >
                            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </button>
                        )}
                        <div className="flex flex-wrap gap-1">
                          {cert.domainNames.map(d => (
                            <span key={d} className="font-mono text-xs text-text-primary">{d}</span>
                          ))}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-text-muted capitalize">{cert.provider}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[cert.status] || ''}`}>
                        {cert.status === 'pending' && <span className="inline-block h-2 w-2 mr-1 animate-spin rounded-full border border-current border-t-transparent" />}
                        {cert.status}
                      </span>
                      {cert.errorMessage && <div className="text-[10px] text-status-down mt-0.5 truncate max-w-xs" title={cert.errorMessage}>{cert.errorMessage}</div>}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-text-muted">
                      {cert.expiresAt ? new Date(cert.expiresAt).toLocaleDateString() : '-'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="inline-flex items-center gap-0.5">
                        {cert.provider === 'letsencrypt' && (
                          <button
                            onClick={() => handleRetry(cert)}
                            className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-accent"
                            title={
                              cert.status === 'error' ? 'Retry Let\'s Encrypt request'
                              : cert.status === 'pending' ? 'Re-queue the request — useful when a previous attempt seems stuck'
                              : 'Renew Let\'s Encrypt cert now'
                            }
                          >
                            <RotateCw size={14} />
                          </button>
                        )}
                        <button onClick={() => handleDelete(cert.id)} className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-status-down" title="Delete">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={5} className="px-4 py-3 bg-bg-tertiary/40">
                        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-2">
                          <FileText size={11} /> Request log
                          {cert.requestLog && <span className="text-text-muted normal-case font-normal">— {cert.requestLog.length} entries</span>}
                        </div>
                        {hasLog ? (
                          <pre className="text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all bg-[#0d1117] rounded p-2 max-h-72 overflow-auto">
                            {cert.requestLog.map((e, i) => (
                              <div
                                key={i}
                                className={
                                  e.level === 'error' ? 'text-status-down' :
                                  e.level === 'warn' ? 'text-status-pending' :
                                  'text-text-secondary'
                                }
                              >
                                <span className="text-text-muted">{new Date(e.at).toLocaleTimeString()}</span>{' '}
                                <span className={
                                  e.level === 'error' ? 'text-status-down/80' :
                                  e.level === 'warn' ? 'text-status-pending/80' :
                                  'text-text-muted'
                                }>[{e.level}]</span>{' '}
                                {e.message}
                              </div>
                            ))}
                          </pre>
                        ) : (
                          <div className="text-[11px] text-text-muted italic">
                            No log entries yet. {cert.status === 'pending' && 'Polling — entries will appear here as Let\'s Encrypt is contacted.'}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {certs.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">No certificates</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
