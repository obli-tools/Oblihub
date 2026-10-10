import { useEffect, useState } from 'react';
import { KeyRound, Plus, RefreshCw, Trash2, Copy, RotateCw } from 'lucide-react';
import { azureAuthApi } from '@/api/azureAuth.api';
import type { AzureAuthProvider } from '@oblihub/shared';
import toast from 'react-hot-toast';

interface FormState {
  id?: number;
  name: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  allowedEmails: string;   // comma-separated in the form
  allowedGroups: string;
}

const EMPTY_FORM: FormState = { name: '', tenantId: '', clientId: '', clientSecret: '', allowedEmails: '', allowedGroups: '' };

/**
 * Azure AD (Entra ID) auth providers management. Each provider = 1 Azure app registration +
 * 1 auto-managed oauth2-proxy sidecar container that answers Nginx's auth_request. Proxy hosts
 * pick a provider via a dropdown in their editor to gate access via Azure sign-in.
 */
export function AzureAuthPage() {
  const [providers, setProviders] = useState<AzureAuthProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [callbackUrls, setCallbackUrls] = useState<Record<number, string[]>>({});

  const load = async () => {
    setLoading(true);
    try { setProviders(await azureAuthApi.list()); }
    catch { toast.error('Failed to load providers'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const startCreate = () => setEditing({ ...EMPTY_FORM });
  const startEdit = (p: AzureAuthProvider) => setEditing({
    id: p.id,
    name: p.name,
    tenantId: p.tenantId,
    clientId: p.clientId,
    clientSecret: '',   // never rehydrate — write-only
    allowedEmails: (p.allowedEmails || []).join(','),
    allowedGroups: (p.allowedGroups || []).join(','),
  });

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.name || !editing.tenantId || !editing.clientId) {
      toast.error('Name, tenant ID and client ID are required');
      return;
    }
    if (!editing.id && !editing.clientSecret) {
      toast.error('Client secret is required on create');
      return;
    }
    const payload = {
      name: editing.name.trim(),
      tenantId: editing.tenantId.trim(),
      clientId: editing.clientId.trim(),
      clientSecret: editing.clientSecret || undefined,
      allowedEmails: editing.allowedEmails.split(',').map(s => s.trim()).filter(Boolean),
      allowedGroups: editing.allowedGroups.split(',').map(s => s.trim()).filter(Boolean),
    };
    try {
      if (editing.id) {
        await azureAuthApi.update(editing.id, payload);
        toast.success('Provider updated + sidecar redeploying…');
      } else {
        if (!payload.clientSecret) return; // TS narrow
        await azureAuthApi.create({ ...payload, clientSecret: payload.clientSecret });
        toast.success('Provider created + sidecar deploying…');
      }
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this Azure auth provider? The oauth2-proxy sidecar will be torn down; any proxy_host that used it loses forward-auth on next regen.')) return;
    try { await azureAuthApi.delete(id); toast.success('Provider deleted'); await load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Delete failed'); }
  };

  const handleRedeploy = async (id: number) => {
    try { await azureAuthApi.redeploy(id); toast.success('Sidecar redeployed'); await load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Redeploy failed'); }
  };

  const loadCallbacks = async (id: number) => {
    try {
      const urls = await azureAuthApi.callbackUrls(id);
      setCallbackUrls(prev => ({ ...prev, [id]: urls }));
    } catch { toast.error('Failed to load callback URLs'); }
  };

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text);
    toast.success('Copied');
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2">
          <KeyRound size={20} /> Azure AD Auth Providers
        </h1>
        <div className="flex gap-2">
          <button onClick={startCreate} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Add Provider
          </button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/50" onClick={() => setEditing(null)}>
          <div className="w-full max-w-lg rounded-xl border border-border bg-bg-primary p-6 shadow-xl max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-text-primary mb-4">
              {editing.id ? 'Edit' : 'New'} Azure AD Provider
            </h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">Name</label>
                <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })}
                  placeholder="e.g. company-sso" className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">Tenant ID <span className="text-text-muted">(Azure AD directory)</span></label>
                <input value={editing.tenantId} onChange={e => setEditing({ ...editing, tenantId: e.target.value })}
                  placeholder="00000000-0000-0000-0000-000000000000" className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">Client ID <span className="text-text-muted">(App Registration)</span></label>
                <input value={editing.clientId} onChange={e => setEditing({ ...editing, clientId: e.target.value })}
                  placeholder="00000000-0000-0000-0000-000000000000" className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">
                  Client Secret {editing.id && <span className="text-text-muted">(leave blank to keep existing)</span>}
                </label>
                <input type="password" value={editing.clientSecret} onChange={e => setEditing({ ...editing, clientSecret: e.target.value })}
                  autoComplete="new-password"
                  placeholder={editing.id ? '••••••• (unchanged)' : 'paste Azure client secret'}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">
                  Allowed emails / domains <span className="text-text-muted">(comma-separated — leave BLANK to allow any user of the tenant)</span>
                </label>
                <input value={editing.allowedEmails} onChange={e => setEditing({ ...editing, allowedEmails: e.target.value })}
                  placeholder="e.g. yourcompany.com  (leave empty for any tenant user)" className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                <p className="text-[10px] text-text-muted mt-1">
                  ⚠ Filled with a real placeholder value like <code className="bg-bg-primary px-1 rounded">corp.com</code>? It's a live filter — only that domain will pass. Clear the field to allow everyone in your Azure tenant.
                </p>
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">
                  Allowed Azure group IDs <span className="text-text-muted">(optional, comma-separated GUIDs — restrict to specific security groups)</span>
                </label>
                <input value={editing.allowedGroups} onChange={e => setEditing({ ...editing, allowedGroups: e.target.value })}
                  placeholder="leave empty to skip group check, or paste GUIDs" className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div className="rounded-lg border border-status-pending/40 bg-status-pending/10 px-3 py-2 text-[11px] text-status-pending">
                <strong>Azure setup:</strong> in the app registration → <em>Authentication</em>, add each proxy_host domain's <code className="bg-bg-primary px-1 rounded">/oauth2/callback</code> URL to <em>Redirect URIs</em>. The list is shown per-provider below once a proxy_host uses it.
              </div>
              <div className="flex gap-2 pt-2">
                <button onClick={() => setEditing(null)} className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
                <button onClick={handleSave} className="flex-1 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-64"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>
      ) : providers.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          <KeyRound size={32} className="mx-auto mb-3 opacity-40" />
          <p>No Azure AD providers configured yet.</p>
          <button onClick={startCreate} className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Add first provider
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map(p => (
            <div key={p.id} className="rounded-xl border border-border bg-bg-secondary p-4">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-sm font-semibold text-text-primary">{p.name}</h3>
                    <span className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${
                      p.containerStatus === 'running' ? 'bg-status-up/10 text-status-up'
                        : p.containerStatus === 'error' ? 'bg-status-critical/10 text-status-critical'
                        : 'bg-text-muted/10 text-text-muted'
                    }`}>{p.containerStatus || 'unknown'}</span>
                  </div>
                  <div className="text-xs text-text-muted font-mono">tenant: {p.tenantId}</div>
                  <div className="text-xs text-text-muted font-mono">client: {p.clientId}</div>
                  <div className="text-xs text-text-muted">sidecar: <code className="bg-bg-tertiary px-1 rounded">{p.containerName || `oblihub-azauth-${p.id}`}</code></div>
                  {p.lastError && (
                    <div className="mt-2 text-[11px] text-status-critical">Last error: {p.lastError}</div>
                  )}
                  <button onClick={() => loadCallbacks(p.id)} className="mt-2 text-[11px] text-accent hover:underline">
                    Show callback URLs to add in Azure →
                  </button>
                  {callbackUrls[p.id] && (
                    <div className="mt-2 space-y-1 rounded bg-bg-primary border border-border p-2">
                      {callbackUrls[p.id].length === 0 ? (
                        <p className="text-[11px] text-text-muted italic">No proxy_host uses this provider yet.</p>
                      ) : (
                        callbackUrls[p.id].map(u => (
                          <div key={u} className="flex items-center gap-2 text-[11px] font-mono text-text-secondary">
                            <button onClick={() => copyToClipboard(u)} className="text-text-muted hover:text-accent" title="Copy"><Copy size={11} /></button>
                            {u}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <button onClick={() => handleRedeploy(p.id)} className="p-1.5 rounded-md text-text-muted hover:text-accent hover:bg-bg-hover" title="Redeploy sidecar with current config">
                    <RotateCw size={14} />
                  </button>
                  <button onClick={() => startEdit(p)} className="px-2 py-1 text-[11px] rounded-md border border-border text-text-secondary hover:bg-bg-hover">Edit</button>
                  <button onClick={() => handleDelete(p.id)} className="p-1.5 rounded-md text-text-muted hover:text-status-critical hover:bg-bg-hover" title="Delete">
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
