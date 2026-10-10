import { useEffect, useState } from 'react';
import { Plus, Server, RefreshCw, Trash2, Edit2, CheckCircle2, XCircle, Star, Copy, Terminal, KeyRound, Eye, EyeOff, Network, AlertTriangle } from 'lucide-react';
import { enginesApi, type EngineWriteData, type TestResult } from '@/api/engines.api';
import { tailscaleApi, type PeerSuggestion } from '@/api/tailscale.api';
import { invalidateEngineSummaries } from '@/hooks/useEngineSummaries';
import { apiErrorMessage } from '@/utils/apiError';
import type { DockerEngine, DockerEngineType, HostAgentMode } from '@oblihub/shared';
import toast from 'react-hot-toast';

const TYPE_LABELS: Record<DockerEngineType, string> = {
  'local': 'Local socket',
  'ssh': 'SSH',
  'https-apikey': 'HTTP + API key (socket-proxy)',
  'tls': 'TLS (mTLS)',
};

const HTTPS_APIKEY_WARNING = 'Plain HTTP: the API key travels unencrypted and the stock tecnativa socket-proxy does not check it — restrict the port (firewall/Tailscale) or prefer SSH/TLS. Compose features (managed stack deploy, resource-limit overrides, GPU visibility) are unavailable on this transport; CPU/RAM caps fall back to docker update. The host agent is Off by default here; Always allows it and the privileged helpers used for GPU power limits.';

// Mirrors the server's create default: plain-HTTP engines must opt in before Oblihub creates any
// container on them, since anyone who can reach the port can drive that daemon too.
const defaultAgentMode = (type: DockerEngineType): HostAgentMode => (type === 'https-apikey' ? 'off' : 'auto');

const EMPTY: EngineWriteData = {
  name: '',
  type: 'ssh',
  host: '',
  port: 22,
  sshUser: 'root',
  sshPrivateKey: '',
  apiKey: '',
  apiKeyHeader: 'X-API-Key',
  tlsCa: '',
  tlsCert: '',
  tlsKey: '',
  enabled: true,
  hostAgentMode: defaultAgentMode('ssh'),
};

export function EnginesPage() {
  const [engines, setEngines] = useState<DockerEngine[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EngineWriteData | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showQuickSetup, setShowQuickSetup] = useState(false);

  const load = async () => {
    try { setEngines(await enginesApi.list()); }
    catch { toast.error('Failed to load engines'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const startCreate = () => { setEditing({ ...EMPTY }); setEditId(null); setTestResult(null); };
  const startEdit = (e: DockerEngine) => {
    setEditing({
      name: e.name,
      type: e.type,
      host: e.host ?? '',
      port: e.port ?? undefined,
      sshUser: e.sshUser ?? '',
      sshPrivateKey: '', // leave blank to keep existing
      sshKnownHost: e.sshKnownHost ?? '',
      apiKey: '',
      apiKeyHeader: e.apiKeyHeader ?? 'X-API-Key',
      tlsCa: e.tlsCa ?? '',
      tlsCert: e.tlsCert ?? '',
      tlsKey: '',
      enabled: e.enabled,
      hostAgentMode: e.hostAgentMode ?? 'auto',
    });
    setEditId(e.id);
    setTestResult(null);
  };

  const cleanForApi = (data: EngineWriteData): EngineWriteData => {
    // Strip empty secrets on edit (preserve existing on the server).
    const out = { ...data };
    if (editId) {
      if (!out.sshPrivateKey) delete out.sshPrivateKey;
      if (!out.apiKey) delete out.apiKey;
      if (!out.tlsKey) delete out.tlsKey;
    }
    return out;
  };

  const handleTest = async () => {
    if (!editing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = editId
        ? await enginesApi.testExisting(editId)
        : await enginesApi.testTransient(cleanForApi(editing));
      setTestResult(result);
    } catch (err) {
      // The server rejects a bad host / sshUser / hostAgentMode with a 400 whose body says why; show
      // that like Save does, and keep the axios/network message only when there is no server reason.
      setTestResult({ ok: false, message: apiErrorMessage(err, err instanceof Error ? err.message : 'Test failed') });
    } finally { setTesting(false); }
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.name.trim()) { toast.error('Name required'); return; }
    setSaving(true);
    try {
      if (editId) await enginesApi.update(editId, cleanForApi(editing));
      else await enginesApi.create(cleanForApi(editing));
      toast.success('Saved');
      setEditing(null); setEditId(null);
      invalidateEngineSummaries();
      load();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Save failed'));
    } finally { setSaving(false); }
  };

  const handleDelete = async (e: DockerEngine) => {
    if (e.isDefault) { toast.error('Cannot delete the default engine'); return; }
    if (!confirm(`Delete engine "${e.name}"? Oblihub removes its host agent from this engine and forgets the stacks and containers it discovered there (they come back if you re-add the engine). Engines used by managed stacks cannot be deleted — migrate or delete those stacks first.`)) return;
    try {
      const result = await enginesApi.delete(e.id);
      toast.success('Deleted');
      // The agent teardown is best effort (the engine may already be unreachable); the server says
      // which leftover containers the admin has to remove by hand, so keep it on screen long enough.
      // Every warning: a watchdog stack that could not be resumed comes first, the teardown's after.
      for (const warning of result?.warnings ?? []) toast(warning, { duration: 10_000 });
      invalidateEngineSummaries();
      load();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Delete failed'));
    }
  };

  const handleSetDefault = async (e: DockerEngine) => {
    try { await enginesApi.setDefault(e.id); toast.success(`${e.name} is now the default engine`); invalidateEngineSummaries(); load(); }
    catch { toast.error('Failed to set default'); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Server size={20} /> Docker Engines</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowQuickSetup(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <Terminal size={14} /> Quick setup (socket-proxy)
          </button>
          <button onClick={startCreate} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Add Engine
          </button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <p className="text-xs text-text-muted mb-4">
        Connect remote Docker daemons (Unraid, other VPS, edge boxes…) so Oblihub can manage them
        from this single instance. Pair this with Tailscale or any VPN for secure connectivity.
      </p>

      <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-tertiary text-text-muted text-[11px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Name</th>
              <th className="text-left px-4 py-2 font-medium">Type</th>
              <th className="text-left px-4 py-2 font-medium">Endpoint</th>
              <th className="text-left px-4 py-2 font-medium">Last ping</th>
              <th className="text-right px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {engines.map(e => (
              <tr key={e.id} className="hover:bg-bg-hover" title={e.type === 'https-apikey' ? HTTPS_APIKEY_WARNING : undefined}>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-text-primary font-medium">{e.name}</span>
                    {e.isDefault && <Star size={11} className="text-accent fill-accent" aria-label="Default" />}
                    {!e.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">disabled</span>}
                    {e.hostAgentMode && e.hostAgentMode !== 'auto' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">agent: {e.hostAgentMode}</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-text-muted">
                  <span className="inline-flex items-center gap-1">
                    {TYPE_LABELS[e.type]}
                    {e.type === 'https-apikey' && <AlertTriangle size={11} className="text-status-warning" aria-label="Plain HTTP transport" />}
                  </span>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-text-muted">
                  {e.type === 'local' ? '/var/run/docker.sock' : `${e.host}${e.port ? ':' + e.port : ''}`}
                </td>
                <td className="px-4 py-2.5 text-xs">
                  {e.lastPingStatus === 'ok' ? (
                    <span className="inline-flex items-center gap-1 text-status-up"><CheckCircle2 size={11} /> ok</span>
                  ) : e.lastPingStatus === 'error' ? (
                    <span className="inline-flex items-center gap-1 text-status-down" title={e.lastPingMessage || ''}><XCircle size={11} /> error</span>
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                  {e.lastPingAt && <span className="text-text-muted ml-2 text-[10px]">{new Date(e.lastPingAt).toLocaleString()}</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => enginesApi.testExisting(e.id).then(r => { toast[r.ok ? 'success' : 'error'](r.ok ? `Connected: Docker ${r.serverVersion}` : (r.message || 'Failed')); load(); })}
                    className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover" title="Test connection">
                    <RefreshCw size={13} />
                  </button>
                  {!e.isDefault && (
                    <button onClick={() => handleSetDefault(e)} className="p-1 rounded text-text-muted hover:text-accent hover:bg-bg-hover" title="Set as default">
                      <Star size={13} />
                    </button>
                  )}
                  <button onClick={() => startEdit(e)} className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover" title="Edit">
                    <Edit2 size={13} />
                  </button>
                  {!e.isDefault && (
                    <button onClick={() => handleDelete(e)} className="p-1 rounded text-text-muted hover:text-status-down hover:bg-bg-hover" title="Delete">
                      <Trash2 size={13} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {engines.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-text-muted text-sm">No engines configured</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Edit / create modal */}
      {editing && (
        <EngineEditor
          editing={editing}
          editId={editId}
          testResult={testResult}
          testing={testing}
          saving={saving}
          onChange={setEditing}
          onTest={handleTest}
          onSave={handleSave}
          onCancel={() => { setEditing(null); setEditId(null); setTestResult(null); }}
        />
      )}

      {/* Quick setup wizard */}
      {showQuickSetup && <QuickSetupModal onClose={() => setShowQuickSetup(false)} onCreated={() => { setShowQuickSetup(false); load(); }} />}
    </div>
  );
}

// ─── Editor modal ──────────────────────────────────────────────────────────
function EngineEditor({
  editing, editId, testResult, testing, saving,
  onChange, onTest, onSave, onCancel,
}: {
  editing: EngineWriteData;
  editId: number | null;
  testResult: TestResult | null;
  testing: boolean;
  saving: boolean;
  onChange: (d: EngineWriteData) => void;
  onTest: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const update = (patch: Partial<EngineWriteData>) => onChange({ ...editing, ...patch });
  // Until the admin picks a mode, the mode follows the type's default, so switching a new engine to
  // https-apikey cannot silently keep 'auto' from the initial SSH type.
  const [agentModeTouched, setAgentModeTouched] = useState(false);
  const changeType = (type: DockerEngineType) => {
    update(!editId && !agentModeTouched ? { type, hostAgentMode: defaultAgentMode(type) } : { type });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 bg-black/50" onClick={onCancel}>
      <div className="rounded-xl border border-border bg-bg-primary w-full max-w-2xl max-h-[85vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">{editId ? 'Edit' : 'New'} Docker Engine</h2>
          <button onClick={onCancel} className="text-text-muted hover:text-text-primary text-xl leading-none">&times;</button>
        </div>
        <div className="p-6 space-y-4">

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-text-secondary block mb-1.5">Name</label>
              <input value={editing.name} onChange={e => update({ name: e.target.value })} placeholder="e.g. Unraid - homelab"
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            </div>
            <div>
              <label className="text-xs font-medium text-text-secondary block mb-1.5">Type</label>
              <select value={editing.type} onChange={e => changeType(e.target.value as DockerEngineType)} disabled={!!editId}
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60">
                <option value="local">Local socket (this host)</option>
                <option value="ssh">SSH</option>
                <option value="https-apikey">HTTP + API key (socket-proxy)</option>
                <option value="tls">TLS (mTLS, raw Docker TCP)</option>
              </select>
            </div>
          </div>

          {editing.type !== 'local' && (
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Host</label>
                <TailnetHostInput
                  value={editing.host || ''}
                  onChange={(host, tailscaleHostname) => {
                    update({
                      host,
                      // When user picks a Tailnet peer, also record the Tailnet hostname on the engine
                      // — used downstream for proxy upstream resolution and engine identity.
                      tailscaleHostname: tailscaleHostname ?? editing.tailscaleHostname ?? null,
                    });
                  }}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Port</label>
                <input type="number" value={editing.port || ''} onChange={e => update({ port: parseInt(e.target.value) || undefined })}
                  placeholder={editing.type === 'ssh' ? '22' : editing.type === 'tls' ? '2376' : '2375'}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
            </div>
          )}

          {editing.type === 'ssh' && (
            <>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">SSH User</label>
                <input value={editing.sshUser || ''} onChange={e => update({ sshUser: e.target.value })} placeholder="root or oblihub-remote"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <SshKeySection editing={editing} editId={editId} update={update} />
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Known host (optional)</label>
                <input value={editing.sshKnownHost || ''} onChange={e => update({ sshKnownHost: e.target.value })} placeholder="ssh-ed25519 AAAA... (paste from server)"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
            </>
          )}

          {editing.type === 'https-apikey' && (
            <>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">
                  API key {editId && <span className="text-text-muted">— leave blank to keep existing</span>}
                </label>
                <input value={editing.apiKey || ''} onChange={e => update({ apiKey: e.target.value })} placeholder="random secret value"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Header name</label>
                <input value={editing.apiKeyHeader || ''} onChange={e => update({ apiKeyHeader: e.target.value })} placeholder="X-API-Key"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div className="rounded-lg border border-border bg-bg-tertiary/30 p-2.5 text-[11px] text-text-muted">
                Use this with <code className="bg-bg-tertiary px-1 rounded">tecnativa/docker-socket-proxy</code> on the remote host.
                Click <strong>Quick setup</strong> from the page header to generate the install snippet.
              </div>
              <div className="flex gap-2 rounded-lg border border-status-warning/30 bg-status-warning/5 p-2.5 text-[11px] text-status-warning">
                <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                <span>{HTTPS_APIKEY_WARNING}</span>
              </div>
            </>
          )}

          {editing.type === 'tls' && (
            <>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">CA certificate (PEM)</label>
                <textarea value={editing.tlsCa || ''} onChange={e => update({ tlsCa: e.target.value })} rows={4} spellCheck={false}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  className="w-full rounded-lg border border-border bg-[#0d1117] px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Client certificate (PEM)</label>
                <textarea value={editing.tlsCert || ''} onChange={e => update({ tlsCert: e.target.value })} rows={4} spellCheck={false}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  className="w-full rounded-lg border border-border bg-[#0d1117] px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">
                  Client private key {editId && <span className="text-text-muted">— leave blank to keep existing</span>}
                </label>
                <textarea value={editing.tlsKey || ''} onChange={e => update({ tlsKey: e.target.value })} rows={4} spellCheck={false}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  className="w-full rounded-lg border border-border bg-[#0d1117] px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
              </div>
            </>
          )}

          {testResult && (
            <div className={`rounded-lg border p-3 text-xs ${testResult.ok ? 'border-status-up/30 bg-status-up/5 text-status-up' : 'border-status-down/30 bg-status-down/5 text-status-down'}`}>
              {testResult.ok ? <CheckCircle2 size={13} className="inline mr-1" /> : <XCircle size={13} className="inline mr-1" />}
              {testResult.ok ? `Connected — Docker ${testResult.serverVersion}` : testResult.message}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              <input type="checkbox" checked={editing.enabled !== false} onChange={e => update({ enabled: e.target.checked })} className="rounded" />
              Enabled (Oblihub workers will poll this engine)
            </label>
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              Host metrics agent
              <select
                value={editing.hostAgentMode ?? defaultAgentMode(editing.type)}
                onChange={e => { setAgentModeTouched(true); update({ hostAgentMode: e.target.value as HostAgentMode }); }}
                className="rounded-lg border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                <option value="auto">Auto — only on GPU hosts (recommended)</option>
                <option value="always">Always — full host CPU/RAM/disk on this engine</option>
                <option value="off">Off — never create containers</option>
              </select>
            </label>
          </div>
          <p className="text-[11px] text-text-muted -mt-2">
            Oblihub can run a tiny labelled container (oblihub-host-agent: no network, no capabilities) on this engine to read host CPU/RAM and nvidia-smi. It is hidden from stacks and removed when set to Off. Off also forbids the short-lived helpers used for GPU power limits and the MPS probe.
          </p>
        </div>
        <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          <button onClick={onTest} disabled={testing} className="px-4 py-1.5 text-sm rounded-lg border border-accent text-accent hover:bg-accent/10 disabled:opacity-50">
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button onClick={onSave} disabled={saving} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SSH key section — paste-or-generate ────────────────────────────────────
function SshKeySection({ editing, editId, update }: {
  editing: EngineWriteData;
  editId: number | null;
  update: (patch: Partial<EngineWriteData>) => void;
}) {
  const [generated, setGenerated] = useState<{ publicKey: string; comment: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [showPrivate, setShowPrivate] = useState(false);

  const handleGenerate = async () => {
    if (editing.sshPrivateKey && !confirm('Replace the current private key with a freshly generated one? The old key will be lost.')) return;
    setGenerating(true);
    try {
      const keys = await enginesApi.generateSshKey();
      update({ sshPrivateKey: keys.privateKey });
      setGenerated({ publicKey: keys.publicKey, comment: keys.comment });
      setShowPrivate(false);
      toast.success('Key pair generated');
    } catch { toast.error('Key generation failed'); }
    finally { setGenerating(false); }
  };

  const copy = (text: string, label: string) => { navigator.clipboard.writeText(text); toast.success(`${label} copied`); };
  const installSnippet = generated ? `mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "${generated.publicKey}" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys` : '';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-text-secondary">
          Private key (OpenSSH ed25519) {editId && <span className="text-text-muted">— leave blank to keep existing</span>}
        </label>
        <button type="button" onClick={handleGenerate} disabled={generating}
          className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-accent/40 text-accent hover:bg-accent/10 disabled:opacity-50">
          <KeyRound size={11} /> {generating ? 'Generating…' : 'Generate new key pair'}
        </button>
      </div>

      <div className="relative">
        <textarea value={editing.sshPrivateKey || ''} onChange={e => update({ sshPrivateKey: e.target.value })}
          rows={6} spellCheck={false}
          placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----\n\nOr click "Generate new key pair" above'}
          style={{ filter: showPrivate || !editing.sshPrivateKey ? 'none' : 'blur(4px)' }}
          className="w-full rounded-lg border border-border bg-[#0d1117] px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none transition-all" />
        {editing.sshPrivateKey && (
          <button type="button" onClick={() => setShowPrivate(!showPrivate)}
            className="absolute top-2 right-2 p-1 rounded bg-bg-tertiary/80 hover:bg-bg-hover text-text-muted backdrop-blur"
            title={showPrivate ? 'Hide' : 'Show'}>
            {showPrivate ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        )}
      </div>

      {generated && (
        <div className="mt-2 rounded-lg border border-accent/30 bg-accent/5 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-accent flex items-center gap-1"><KeyRound size={11} /> Authorize this public key on the remote host</span>
            <button type="button" onClick={() => copy(generated.publicKey, 'Public key')} className="p-1 rounded hover:bg-bg-hover text-text-muted" title="Copy public key">
              <Copy size={11} />
            </button>
          </div>
          <pre className="bg-[#0d1117] rounded p-2 text-[10px] font-mono text-text-primary overflow-x-auto whitespace-pre-wrap break-all">{generated.publicKey}</pre>

          <div className="flex items-center justify-between mt-2">
            <span className="text-[11px] text-text-secondary">Run this on the target host (Unraid web UI terminal, SSH, etc.):</span>
            <button type="button" onClick={() => copy(installSnippet, 'Install snippet')} className="p-1 rounded hover:bg-bg-hover text-text-muted" title="Copy snippet">
              <Copy size={11} />
            </button>
          </div>
          <pre className="bg-[#0d1117] rounded p-2 text-[10px] font-mono text-text-primary overflow-x-auto whitespace-pre">{installSnippet}</pre>

          <p className="text-[10px] text-text-muted">
            The private key is stored encrypted in Oblihub's database and never shown again after you save.
            Make sure to back it up if you need to revoke access later — or just generate a new one.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Quick setup wizard (socket-proxy) ─────────────────────────────────────
function QuickSetupModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState<'config' | 'install' | 'finish'>('config');
  const [name, setName] = useState('Unraid');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(2375);
  const [apiKey, setApiKey] = useState(() => crypto.getRandomValues(new Uint8Array(24)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''));
  const [saving, setSaving] = useState(false);

  const snippet = `docker run -d --restart=unless-stopped --name oblihub-engine-proxy \\
  -p ${port}:2375 \\
  -v /var/run/docker.sock:/var/run/docker.sock:ro \\
  -e CONTAINERS=1 -e POST=1 -e IMAGES=1 -e EXEC=1 \\
  -e INFO=1 -e VERSION=1 -e PING=1 \\
  -e NETWORKS=0 -e VOLUMES=0 -e SECRETS=0 -e CONFIGS=0 \\
  -e API_KEY=${apiKey} \\
  tecnativa/docker-socket-proxy`;

  const copySnippet = () => { navigator.clipboard.writeText(snippet); toast.success('Copied'); };

  const handleCreate = async () => {
    if (!name.trim() || !host.trim()) { toast.error('Name and host required'); return; }
    setSaving(true);
    try {
      const created = await enginesApi.create({ name, type: 'https-apikey', host, port, apiKey, apiKeyHeader: 'X-API-Key', enabled: true });
      invalidateEngineSummaries();
      // Test it
      const result = await enginesApi.testExisting(created.id);
      toast[result.ok ? 'success' : 'error'](result.ok ? `Engine ready — Docker ${result.serverVersion}` : `Saved but connection failed: ${result.message}`);
      onCreated();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed';
      toast.error(msg);
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 bg-black/50" onClick={onClose}>
      <div className="rounded-xl border border-border bg-bg-primary w-full max-w-2xl max-h-[85vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2"><Terminal size={14} /> Quick setup — socket-proxy</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">&times;</button>
        </div>
        <div className="p-6 space-y-4">
          {step === 'config' && (
            <>
              <p className="text-xs text-text-muted">
                The fastest way to add a remote engine. Oblihub will generate an install snippet for
                <code className="bg-bg-tertiary px-1 rounded mx-0.5">tecnativa/docker-socket-proxy</code>
                — a tiny container that exposes a filtered, API-key-protected Docker socket over HTTP.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-text-secondary block mb-1.5">Engine name</label>
                  <input value={name} onChange={e => setName(e.target.value)} placeholder="Unraid"
                    className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
                <div>
                  <label className="text-xs font-medium text-text-secondary block mb-1.5">Port (on remote)</label>
                  <input type="number" value={port} onChange={e => setPort(parseInt(e.target.value) || 2375)}
                    className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Host (reachable from Oblihub)</label>
                <input value={host} onChange={e => setHost(e.target.value)} placeholder="100.64.10.5 or unraid.tailnet.ts.net"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                <p className="text-[11px] text-text-muted mt-1">Tip: use the Tailscale/WireGuard private IP, not the public one — the socket-proxy MUST be unreachable from the internet.</p>
              </div>
              <div className="flex justify-end">
                <button onClick={() => setStep('install')} disabled={!name.trim() || !host.trim()}
                  className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50">Next: install snippet →</button>
              </div>
            </>
          )}

          {step === 'install' && (
            <>
              <p className="text-xs text-text-muted">
                Run this on the remote host (Unraid: open the terminal from the web UI). The API key is generated and shown only once.
                The host metrics agent needs CONTAINERS, POST and IMAGES (already enabled by this snippet) and stays Off until you set it to Always in the engine settings.
              </p>
              <div className="relative">
                <pre className="bg-[#0d1117] rounded-lg p-3 text-[11px] font-mono text-text-primary overflow-x-auto whitespace-pre">{snippet}</pre>
                <button onClick={copySnippet} className="absolute top-2 right-2 p-1.5 rounded bg-bg-tertiary hover:bg-bg-hover text-text-muted" title="Copy">
                  <Copy size={12} />
                </button>
              </div>
              <div className="rounded-lg border border-status-pending/30 bg-status-pending/5 p-2.5 text-[11px] text-status-pending">
                <strong>API key:</strong> <code className="bg-bg-tertiary px-1 rounded font-mono">{apiKey}</code> — save it now, you cannot recover it.
              </div>
              <div className="flex justify-between">
                <button onClick={() => setStep('config')} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">← Back</button>
                <button onClick={handleCreate} disabled={saving}
                  className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50">
                  {saving ? 'Saving + testing…' : 'I ran it — Save engine'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Host input enriched with Tailnet peer autocomplete. Fetches peers once on mount; if the local
// tailscaled isn't running the API returns an empty list and the input behaves as a plain text
// field. The second arg of onChange carries the Tailnet hostname so the parent can persist it
// onto the engine — used later for proxy upstream resolution.
function TailnetHostInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (host: string, tailscaleHostname: string | null) => void;
}) {
  const [peers, setPeers] = useState<PeerSuggestion[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    tailscaleApi.peers().then((p) => {
      if (!cancelled) setPeers(p);
    }).catch(() => {
      // Tailscale sidecar not running — silently degrade to plain input.
    });
    return () => { cancelled = true; };
  }, []);

  const filtered = peers
    .filter((p) => {
      if (!value) return true;
      const q = value.toLowerCase();
      return p.hostname.toLowerCase().includes(q) || p.dnsName.toLowerCase().includes(q) || (p.ipv4 || '').includes(q);
    })
    .slice(0, 8);

  return (
    <div className="relative">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value, null)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="100.64.10.5 or unraid.tailnet.ts.net"
        className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-10 left-0 right-0 top-full mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-bg-secondary shadow-lg">
          <div className="px-3 py-1.5 text-[10px] text-text-muted uppercase tracking-wider border-b border-border flex items-center gap-1">
            <Network size={10} /> Tailnet peers
          </div>
          {filtered.map((p) => (
            <button
              key={p.dnsName || p.hostname}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(p.dnsName || p.ipv4 || p.hostname, p.dnsName || null);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 hover:bg-bg-tertiary border-b border-border last:border-b-0"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono text-text-primary">{p.hostname}</span>
                <span className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${p.online ? 'bg-status-up' : 'bg-text-muted'}`} />
                  <span className="font-mono text-text-muted">{p.ipv4 || '—'}</span>
                </span>
              </div>
              <div className="text-[10px] text-text-muted font-mono mt-0.5 truncate flex items-center justify-between">
                <span>{p.dnsName}</span>
                {p.alreadyAttached && <span className="text-status-warning">already attached</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
