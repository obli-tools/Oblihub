import { useEffect, useState } from 'react';
import { RefreshCw, Plus, Trash2, Edit2, Globe, Power, PowerOff } from 'lucide-react';
import { proxyApi } from '@/api/proxy.api';
import { stacksApi } from '@/api/stacks.api';
import { azureAuthApi } from '@/api/azureAuth.api';
import type { ProxyHost, Certificate, AccessList, CustomPage, Stack, Container, AzureAuthProvider } from '@oblihub/shared';
import toast from 'react-hot-toast';
import { ProxyHostEditor } from '@/components/ProxyHostEditor';

const DEFAULT_HOST: Partial<ProxyHost> = {
  domainNames: [],
  forwardScheme: 'http',
  forwardHost: '',
  forwardPort: 80,
  sslForced: false,
  http2Support: false,
  hstsEnabled: false,
  hstsSubdomains: false,
  blockExploits: true,
  cachingEnabled: false,
  websocketSupport: true,
  enabled: true,
  wakeExtraContainerIds: [],
};

export function ProxyHostsPage() {
  const [hosts, setHosts] = useState<ProxyHost[]>([]);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [accessLists, setAccessLists] = useState<AccessList[]>([]);
  const [azureProviders, setAzureProviders] = useState<AzureAuthProvider[]>([]);
  const [customPages, setCustomPages] = useState<CustomPage[]>([]);
  const [allContainers, setAllContainers] = useState<{ container: Container; stackName: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<ProxyHost> | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [domainInput, setDomainInput] = useState('');
  const [certMode, setCertMode] = useState<'none' | 'existing' | 'new'>('none');
  const [acmeEmail, setAcmeEmail] = useState(localStorage.getItem('oblihub_acme_email') || '');

  const load = async () => {
    try {
      const [h, c, a, p, stacks, az] = await Promise.all([
        proxyApi.listHosts(), proxyApi.listCertificates(), proxyApi.listAccessLists(), proxyApi.listCustomPages(),
        stacksApi.list().catch(() => [] as Stack[]),
        azureAuthApi.list().catch(() => [] as AzureAuthProvider[]),
      ]);
      setHosts(h);
      setCerts(c);
      setAccessLists(a);
      setCustomPages(p);
      setAzureProviders(az);
      const flat: { container: Container; stackName: string }[] = [];
      for (const s of stacks) for (const ctr of s.containers) flat.push({ container: ctr, stackName: s.name });
      setAllContainers(flat);
    } catch { toast.error('Failed to load proxy hosts'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // Auto-refresh while any cert is pending
  useEffect(() => {
    if (!hosts.some(h => h.certificate?.status === 'pending')) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [hosts]);

  const startCreate = () => {
    setEditing({ ...DEFAULT_HOST, domainNames: [] });
    setEditId(null);
    setDomainInput('');
  };

  const startEdit = (host: ProxyHost) => {
    setEditing({ ...host });
    setEditId(host.id);
    setDomainInput('');
    setCertMode(host.certificateId ? 'existing' : 'none');
  };

  const addDomain = () => {
    const d = domainInput.trim().toLowerCase();
    if (!d || editing?.domainNames?.includes(d)) return;
    setEditing(e => e ? { ...e, domainNames: [...(e.domainNames || []), d] } : null);
    setDomainInput('');
  };

  const removeDomain = (domain: string) => {
    setEditing(e => e ? { ...e, domainNames: (e.domainNames || []).filter(d => d !== domain) } : null);
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.domainNames?.length) { toast.error('At least one domain required'); return; }
    if (!editing.forwardHost) { toast.error('Forward host required'); return; }
    try {
      // If requesting new LE cert, create it first
      if (certMode === 'new') {
        if (!acmeEmail) { toast.error('Email required for Let\'s Encrypt'); return; }
        localStorage.setItem('oblihub_acme_email', acmeEmail);
        const cert = await proxyApi.createCertificate({ domainNames: editing.domainNames, provider: 'letsencrypt', acmeEmail });
        editing.certificateId = cert.id;
        editing.sslForced = true;
        editing.http2Support = true;
      }
      if (editId) {
        // Optimistic merge — the server returns the fresh row, splice it back into `hosts` so
        // reopening the editor immediately (before `load()` finishes) sees the new values. The
        // previous `load()` was fire-and-forget, causing a race where startEdit copied a stale
        // entry from the not-yet-refreshed list.
        const updated = await proxyApi.updateHost(editId, editing);
        setHosts(prev => prev.map(h => h.id === editId ? updated : h));
        toast.success('Proxy host updated');
      } else {
        const created = await proxyApi.createHost(editing);
        setHosts(prev => [...prev, created]);
        toast.success('Proxy host created');
      }
      setEditing(null);
      setEditId(null);
      setCertMode('none');
      // Full reload (certs, access lists, containers) — awaited so any subsequent user action
      // sees the fresh state, not a version between two ticks.
      await load();
    } catch { toast.error('Failed to save proxy host'); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this proxy host?')) return;
    try {
      await proxyApi.deleteHost(id);
      // Optimistic removal so the row disappears from the list even if load() races.
      setHosts(prev => prev.filter(h => h.id !== id));
      toast.success('Proxy host deleted');
      await load();
    } catch { toast.error('Failed to delete'); }
  };

  const handleToggle = async (id: number) => {
    try {
      const result = await proxyApi.toggleHost(id);
      // Reflect the toggle immediately in the list to keep hover/click UX consistent.
      setHosts(prev => prev.map(h => h.id === id ? { ...h, enabled: result.enabled } : h));
      toast.success(result.enabled ? 'Enabled' : 'Disabled');
      await load();
    } catch { toast.error('Failed to toggle'); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Globe size={20} /> Proxy Hosts</h1>
        <div className="flex gap-2">
          <button onClick={startCreate} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Add Proxy Host
          </button>
          <button
            onClick={async () => {
              if (!confirm('Reconcile the proxy network across all deployed managed stacks?\n\nUse this after an Oblihub update if front-ends went dark because the shared network was recreated. Idempotent — safe to click anytime.')) return;
              try {
                await proxyApi.restoreNetworks();
                toast.success('Proxy network membership restored');
                await load();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Restore failed');
              }
            }}
            title="Re-attach every managed-stack service that a proxy host targets. Recovery button for the case where the shared proxy network got recreated."
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover"
          >
            Restore networks
          </button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Editor modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50" onClick={() => setEditing(null)}>
          <div className="rounded-xl border border-border bg-bg-primary w-full max-w-3xl max-h-[85vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-text-primary">{editId ? 'Edit' : 'New'} Proxy Host</h2>
            </div>
            <ProxyHostEditor
              editing={editing}
              setEditing={setEditing}
              editId={editId}
              certs={certs}
              hosts={hosts}
              accessLists={accessLists}
              azureProviders={azureProviders}
              customPages={customPages}
              allContainers={allContainers}
              domainInput={domainInput}
              setDomainInput={setDomainInput}
              addDomain={addDomain}
              removeDomain={removeDomain}
              certMode={certMode}
              setCertMode={setCertMode}
              acmeEmail={acmeEmail}
              setAcmeEmail={setAcmeEmail}
            />
            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button onClick={() => { setEditing(null); setEditId(null); }} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
              <button onClick={handleSave} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Hosts list */}
      {hosts.length === 0 ? (
        <div className="text-center py-20">
          <Globe size={40} className="mx-auto mb-3 text-text-muted" />
          <p className="text-text-muted">No proxy hosts configured</p>
          <button onClick={startCreate} className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Add Proxy Host
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {hosts.map(host => (
            <div key={host.id} className={`rounded-xl border bg-bg-secondary overflow-hidden ${host.enabled ? 'border-border' : 'border-border opacity-50'}`}>
              <div className="px-4 py-3 flex items-center gap-4">
                <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${host.enabled ? (host.certificate?.status === 'valid' ? 'bg-status-up' : 'bg-status-pending') : 'bg-text-muted'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                    {host.domainNames.map(d => (
                      <span key={d} className="text-sm font-medium text-text-primary">{d}</span>
                    ))}
                  </div>
                  <div className="text-xs text-text-muted">
                    {host.forwardScheme}://{host.forwardHost}:{host.forwardPort}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {host.sslForced && <span className="text-[9px] px-1.5 py-0.5 rounded bg-status-up/10 text-status-up">SSL</span>}
                  {host.http2Support && <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">H2</span>}
                  {host.hstsEnabled && <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">HSTS</span>}
                  {host.websocketSupport && <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">WS</span>}
                  {host.blockExploits && <span className="text-[9px] px-1.5 py-0.5 rounded bg-status-pending/10 text-status-pending">Protected</span>}
                  {host.honeypotEnabled && <span className="text-[9px] px-1.5 py-0.5 rounded bg-status-down/10 text-status-down" title="Honeypot active — bait paths auto-ban scanners globally">🍯 Honeypot</span>}
                  {host.cachingEnabled && <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">Cached</span>}
                  {host.certificate && (
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${host.certificate.status === 'valid' ? 'bg-status-up/10 text-status-up' : 'bg-status-down/10 text-status-down'}`}>
                      {host.certificate.provider === 'letsencrypt' ? 'LE' : 'Custom'} {host.certificate.status}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => startEdit(host)} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover" title="Edit">
                    <Edit2 size={14} />
                  </button>
                  <button onClick={() => handleToggle(host.id)} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover" title={host.enabled ? 'Disable' : 'Enable'}>
                    {host.enabled ? <Power size={14} /> : <PowerOff size={14} />}
                  </button>
                  <button onClick={() => handleDelete(host.id)} className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-bg-hover" title="Delete">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
