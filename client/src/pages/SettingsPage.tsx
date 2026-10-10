import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { settingsApi } from '@/api/settings.api';
import { MaintenanceWindowEditor } from '@/components/MaintenanceWindowEditor';
import { MAINTENANCE_CONFIG_KEY, DEFAULT_MAINTENANCE_WINDOW, effectiveMaintenance, maintenanceAllowsNow, nextWindowOpening, describeWindow, isValidTimezone, type GlobalMaintenance } from '@oblihub/shared';
import { notificationsApi, type PluginMeta } from '@/api/notifications.api';
import { systemApi } from '@/api/stacks.api';
import { proxyApi } from '@/api/proxy.api';
import { obliguardApi, type ObliguardStatus } from '@/api/bans.api';
import { tailscaleApi } from '@/api/tailscale.api';
import { enginesApi } from '@/api/engines.api';
import type { CustomPage, TailscaleStatus, DockerEngine } from '@oblihub/shared';
import { useAuthStore } from '@/store/authStore';
import type { NotificationChannel } from '@oblihub/shared';
import toast from 'react-hot-toast';
import { Save, Plus, Trash2, Send, ChevronDown, ChevronRight, Power, PowerOff, X, Globe, RefreshCw, Shield, CheckCircle, Copy, Eye, EyeOff, Network, Server } from 'lucide-react';

// ── Obliguard integration status pill ──
//
// Reflects the state of the SAVED config (server-side check), not the current input values.
// After changing URL / key, the user has to Save first, then hit refresh here — otherwise the
// pill would report "reachable" for a URL that's still just in the input field.
//
// Order the checks by user intent when composing the label:
//   1. No target resolved   → "Not configured" (nothing to test)
//   2. Target resolved but unreachable → the URL is the problem
//   3. Target reachable, no delegation token → auth setup is the problem (Obligate down / not registered)
//   4. Both reachable + token → green, all good
function ObliguardStatusPill() {
  const [status, setStatus] = useState<ObliguardStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try { setStatus(await obliguardApi.status()); }
    catch { setStatus({ configured: false, source: null, url: null, reachable: false, hasDelegation: false }); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);

  const { dot, label, hint } = ((): { dot: string; label: string; hint: string } => {
    if (loading && !status) return { dot: 'bg-text-muted animate-pulse', label: 'Checking…', hint: '' };
    if (!status || !status.configured) return { dot: 'bg-text-muted', label: 'Not configured', hint: 'No URL saved and no Obliguard app found via Obligate.' };
    if (!status.reachable) return { dot: 'bg-status-down', label: 'Unreachable', hint: `${status.url} did not answer /health — check DNS, port, TLS.` };
    if (!status.hasDelegation) return { dot: 'bg-status-warning', label: 'Reachable, no delegation token', hint: 'Obligate rejected the app-scoped mint request or is unreachable. Bans will not sync.' };
    return { dot: 'bg-status-up', label: status.source === 'obligate' ? 'Auto (via Obligate)' : 'Manual', hint: `Syncing to ${status.url}` };
  })();

  const runTest = async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await obliguardApi.testPing();
      if (result.ok) toast.success(`Obliguard ping OK — ${result.target || 'target'}`);
      else toast.error(`Obliguard ping failed: ${result.reason}`);
    } catch (e) {
      toast.error(`Test call errored: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
      await refresh();
    }
  };

  return (
    <div className="flex items-center gap-2" title={hint}>
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      <span className="text-[11px] text-text-secondary">{label}</span>
      <button
        type="button"
        onClick={refresh}
        disabled={loading}
        className="text-text-muted hover:text-text-primary disabled:opacity-50"
        title="Re-check (reads the saved config)"
      >
        <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
      </button>
      <button
        type="button"
        onClick={runTest}
        disabled={loading || !status?.configured}
        className="text-[10px] px-1.5 py-0.5 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-40"
        title="Actually POST to Obliguard with a fresh delegation token — end-to-end auth chain check"
      >
        Test
      </button>
    </div>
  );
}

// ── Obligate SSO Section ──
function SsoSection({ config, setConfig, onSave, saving }: {
  config: Record<string, string | null>;
  setConfig: (c: Record<string, string | null>) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const enabled = config.obligate_enabled === 'true';
  // Read-only fact from the server: the environment overrides this setting
  const inboundSecretFromEnv = config.obligate_inbound_secret_env === 'true';
  const [ssoStatus, setSsoStatus] = useState<'checking' | 'connected' | 'unreachable' | 'disabled'>('checking');

  useEffect(() => {
    if (!enabled || !config.obligate_url) {
      setSsoStatus(enabled ? 'unreachable' : 'disabled');
      return;
    }
    // Simple connectivity check via our own backend (settings already loaded means backend is reachable)
    setSsoStatus(enabled ? 'connected' : 'disabled');
  }, [enabled, config.obligate_url]);

  const statusDot = {
    checking: 'bg-text-muted',
    connected: 'bg-status-up',
    unreachable: 'bg-status-down',
    disabled: 'bg-text-muted',
  };
  const statusLabel = {
    checking: 'Checking...',
    connected: 'Connected',
    unreachable: 'Unreachable',
    disabled: 'Disabled',
  };

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">Obligate SSO</h2>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span className={`h-2 w-2 rounded-full ${statusDot[ssoStatus]}`} />
          {statusLabel[ssoStatus]}
        </div>
      </div>
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-text-secondary mb-1">Obligate URL</label>
          <input type="text" value={config.obligate_url || ''} placeholder="https://sso.example.com"
            onChange={(e) => setConfig({ ...config, obligate_url: e.target.value || null })}
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label className="block text-sm text-text-secondary mb-1">API Key</label>
          <input type="password" value={config.obligate_api_key || ''} placeholder="Enter API key"
            onChange={(e) => setConfig({ ...config, obligate_api_key: e.target.value || null })}
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label className="block text-sm text-text-secondary mb-1">Inbound secret (optional)</label>
          <input type="password" value={inboundSecretFromEnv ? '' : (config.obligate_inbound_secret || '')}
            placeholder={inboundSecretFromEnv ? 'Set by OBLIGATE_INBOUND_SECRET' : 'Empty = Obligate calls Oblihub with the API key'}
            disabled={inboundSecretFromEnv}
            onChange={(e) => setConfig({ ...config, obligate_inbound_secret: e.target.value || null })}
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60" />
          <p className="text-xs text-text-muted mt-1">
            Secret Obligate must present when it calls Oblihub (user sync, app info, dashboard stats). At least 16
            characters. Set it only once Obligate sends a separate secret, otherwise its calls are refused.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setConfig({ ...config, obligate_enabled: enabled ? 'false' : 'true' })}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${enabled ? 'bg-accent' : 'bg-bg-tertiary border border-border'}`}>
            <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
          <span className="text-sm text-text-secondary">Enable SSO</span>
        </div>
        <button onClick={onSave} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
          <Save size={14} /> {saving ? 'Saving...' : 'Save SSO Settings'}
        </button>
      </div>
    </div>
  );
}

// ── Default Settings Section ──
function DefaultSettingsSection({ config, setConfig, onSave, saving }: {
  config: Record<string, string | null>;
  setConfig: (c: Record<string, string | null>) => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
      <h2 className="text-sm font-semibold text-text-primary mb-4">Default Settings</h2>
      <div className="mb-4">
        <label className="block text-sm text-text-secondary mb-1">Default Check Interval (seconds)</label>
        <input type="number" min={10} value={config.default_check_interval || '300'}
          onChange={(e) => setConfig({ ...config, default_check_interval: e.target.value || '300' })}
          className="w-48 rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
        <p className="text-xs text-text-muted mt-1">How often stacks are checked for updates (minimum 10s)</p>
      </div>

      {/* Global Auto-Update */}
      <div className="mb-4 flex items-center justify-between rounded-lg border border-border bg-bg-tertiary p-3">
        <div>
          <div className="text-sm font-medium text-text-primary">Global Auto-Update</div>
          <div className="text-xs text-text-muted">Automatically update ALL stacks when new images are detected</div>
          <div className="text-xs text-status-down mt-1 font-medium">Not recommended — prefer per-stack auto-update</div>
        </div>
        <button
          onClick={() => {
            const current = config.global_auto_update === 'true';
            setConfig({ ...config, global_auto_update: current ? 'false' : 'true' });
          }}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ml-4 ${config.global_auto_update === 'true' ? 'bg-status-down' : 'bg-bg-hover border border-border'}`}>
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${config.global_auto_update === 'true' ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      <GlobalMaintenanceBlock config={config} setConfig={setConfig} />

      <button onClick={onSave} disabled={saving}
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
        <Save size={14} /> {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
}

/** Global maintenance window (app_config `maintenance_window`, JSON). */
function readGlobalMaintenance(raw: string | null | undefined): GlobalMaintenance {
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (raw) {
    try {
      const v = JSON.parse(raw) as Partial<GlobalMaintenance>;
      return { enabled: !!v.enabled, window: { ...DEFAULT_MAINTENANCE_WINDOW, ...v.window }, timezone: v.timezone || browserTz };
    } catch { /* fall through */ }
  }
  return { enabled: false, window: { ...DEFAULT_MAINTENANCE_WINDOW }, timezone: browserTz };
}

function GlobalMaintenanceBlock({ config, setConfig }: {
  config: Record<string, string | null>;
  setConfig: (c: Record<string, string | null>) => void;
}) {
  const value = readGlobalMaintenance(config[MAINTENANCE_CONFIG_KEY]);
  const write = (next: GlobalMaintenance) => setConfig({ ...config, [MAINTENANCE_CONFIG_KEY]: JSON.stringify(next) });
  const zones = (() => { try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { return []; } })();
  const tzOk = isValidTimezone(value.timezone);
  const eff = effectiveMaintenance(value, null);
  const openNow = maintenanceAllowsNow(eff);
  const next = openNow ? null : nextWindowOpening(eff);
  return (
    <div className="mb-4 rounded-lg border border-border bg-bg-tertiary p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-text-primary">Maintenance window</div>
          <div className="text-xs text-text-muted">
            Automatic update work (scheduled checks, auto-update, git auto-pull) only runs inside this window.
            Manual Check / Update / Pull always work. Each stack can inherit it, override it, or allow any time.
          </div>
        </div>
        <button type="button" onClick={() => write({ ...value, enabled: !value.enabled })}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ml-4 ${value.enabled ? 'bg-accent' : 'bg-bg-hover border border-border'}`}>
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${value.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>
      <MaintenanceWindowEditor value={value.window} onChange={w => write({ ...value, window: w })} disabled={!value.enabled} />
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <span>Time zone</span>
        <input list="oblihub-timezones" value={value.timezone} onChange={e => write({ ...value, timezone: e.target.value })}
          className={`w-64 rounded-md border bg-bg-secondary px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent ${tzOk ? 'border-border' : 'border-status-down'}`} />
        <datalist id="oblihub-timezones">{zones.map(z => <option key={z} value={z} />)}</datalist>
        {!tzOk && <span className="text-xs text-status-down">unknown time zone</span>}
      </div>
      {value.enabled && tzOk && (
        <div className="text-xs text-text-muted">
          {describeWindow(value.window)} ({value.timezone}) — {openNow ? 'open now' : `closed now${next ? `, opens ${next.toLocaleString()}` : ''}`}
        </div>
      )}
    </div>
  );
}

// ── Dynamic Config Fields ──
function ConfigFields({ fields, config, setConfig }: {
  fields: PluginMeta['configFields'];
  config: Record<string, unknown>;
  setConfig: (c: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <div key={field.key}>
          <label className="block text-sm text-text-secondary mb-1">
            {field.label}{field.required && <span className="text-status-down ml-1">*</span>}
          </label>
          {field.type === 'boolean' ? (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={!!config[field.key]}
                onChange={(e) => setConfig({ ...config, [field.key]: e.target.checked })}
                className="h-4 w-4 rounded border-border bg-bg-tertiary accent-accent" />
              <span className="text-sm text-text-secondary">{field.label}</span>
            </label>
          ) : (
            <input
              type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
              value={String(config[field.key] ?? '')}
              placeholder={field.placeholder || ''}
              onChange={(e) => setConfig({ ...config, [field.key]: field.type === 'number' ? Number(e.target.value) : e.target.value })}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Notification Channels Section ──
function NotificationChannelsSection() {
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [plugins, setPlugins] = useState<PluginMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showNew, setShowNew] = useState(false);

  // New channel form
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('');
  const [newConfig, setNewConfig] = useState<Record<string, unknown>>({});
  const [creating, setCreating] = useState(false);

  // Edit state
  const [editName, setEditName] = useState('');
  const [editConfig, setEditConfig] = useState<Record<string, unknown>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);

  const load = async () => {
    try {
      const [ch, pl] = await Promise.all([notificationsApi.getChannels(), notificationsApi.getPlugins()]);
      setChannels(ch);
      setPlugins(pl);
    } catch { toast.error('Failed to load notifications'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const selectedPlugin = plugins.find(p => p.type === newType);

  const handleCreate = async () => {
    if (!newName.trim() || !newType) { toast.error('Name and type required'); return; }
    setCreating(true);
    try {
      await notificationsApi.createChannel({ name: newName.trim(), type: newType, config: newConfig });
      setShowNew(false);
      setNewName('');
      setNewType('');
      setNewConfig({});
      toast.success('Channel created');
      await load();
    } catch { toast.error('Failed to create channel'); }
    finally { setCreating(false); }
  };

  const handleToggle = async (ch: NotificationChannel) => {
    try {
      await notificationsApi.updateChannel(ch.id, { isEnabled: !ch.isEnabled });
      await load();
    } catch { toast.error('Failed to toggle channel'); }
  };

  const handleSave = async (id: number) => {
    setSavingId(id);
    try {
      await notificationsApi.updateChannel(id, { name: editName, config: editConfig });
      toast.success('Channel updated');
      await load();
    } catch { toast.error('Failed to update channel'); }
    finally { setSavingId(null); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this notification channel?')) return;
    try {
      await notificationsApi.deleteChannel(id);
      setExpandedId(null);
      toast.success('Channel deleted');
      await load();
    } catch { toast.error('Failed to delete channel'); }
  };

  const handleTest = async (id: number) => {
    setTestingId(id);
    try {
      await notificationsApi.testChannel(id);
      toast.success('Test notification sent');
    } catch { toast.error('Test failed'); }
    finally { setTestingId(null); }
  };

  const expand = (ch: NotificationChannel) => {
    if (expandedId === ch.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(ch.id);
    setEditName(ch.name);
    setEditConfig({ ...ch.config });
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
        <h2 className="text-sm font-semibold text-text-primary mb-4">Notification Channels</h2>
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">Notification Channels</h2>
        <button onClick={() => setShowNew(!showNew)}
          className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg bg-accent/10 text-accent hover:bg-accent/20 transition-colors">
          {showNew ? <X size={12} /> : <Plus size={12} />} {showNew ? 'Cancel' : 'New Channel'}
        </button>
      </div>

      {/* New channel form */}
      {showNew && (
        <div className="mb-4 p-4 rounded-lg border border-border bg-bg-tertiary space-y-3">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Channel Name</label>
            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="My Channel"
              className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">Plugin Type</label>
            <select value={newType} onChange={(e) => { setNewType(e.target.value); setNewConfig({}); }}
              className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent">
              <option value="">Select a plugin...</option>
              {plugins.map(p => <option key={p.type} value={p.type}>{p.name}</option>)}
            </select>
          </div>
          {selectedPlugin && (
            <ConfigFields fields={selectedPlugin.configFields} config={newConfig} setConfig={setNewConfig} />
          )}
          <button onClick={handleCreate} disabled={creating}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
            <Save size={14} /> {creating ? 'Creating...' : 'Create Channel'}
          </button>
        </div>
      )}

      {/* Channel list */}
      {channels.length === 0 ? (
        <p className="text-sm text-text-muted py-4 text-center">No notification channels configured</p>
      ) : (
        <div className="space-y-2">
          {channels.map((ch) => {
            const isExpanded = expandedId === ch.id;
            const plugin = plugins.find(p => p.type === ch.type);
            return (
              <div key={ch.id} className="rounded-lg border border-border bg-bg-tertiary overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-bg-hover transition-colors"
                  onClick={() => expand(ch)}>
                  {isExpanded ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
                  <span className="text-sm text-text-primary flex-1 font-medium">{ch.name}</span>
                  <span className="text-xs text-text-muted capitalize">{ch.type}</span>
                  <button onClick={(e) => { e.stopPropagation(); handleToggle(ch); }}
                    className={`p-1 rounded ${ch.isEnabled ? 'text-status-up hover:bg-status-up/10' : 'text-text-muted hover:bg-bg-hover'}`}
                    title={ch.isEnabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}>
                    {ch.isEnabled ? <Power size={14} /> : <PowerOff size={14} />}
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); handleTest(ch.id); }} disabled={testingId === ch.id}
                    className="p-1 rounded text-text-muted hover:text-accent hover:bg-accent/10 disabled:opacity-50" title="Send test">
                    <Send size={14} />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); handleDelete(ch.id); }}
                    className="p-1 rounded text-text-muted hover:text-status-down hover:bg-status-down/10" title="Delete">
                    <Trash2 size={14} />
                  </button>
                </div>

                {isExpanded && plugin && (
                  <div className="px-4 pb-4 border-t border-border pt-3 space-y-3">
                    <div>
                      <label className="block text-sm text-text-secondary mb-1">Channel Name</label>
                      <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                        className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
                    </div>
                    <ConfigFields fields={plugin.configFields} config={editConfig} setConfig={setEditConfig} />
                    <button onClick={() => handleSave(ch.id)} disabled={savingId === ch.id}
                      className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
                      <Save size={14} /> {savingId === ch.id ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── System Info / About Section ──
interface SystemInfo {
  dockerConnected: boolean;
  dockerVersion: { Version?: string; ApiVersion?: string; version?: string } | null;
  stackCount: number;
  containerCount: number;
  versions: {
    server: string | null;
    serverImage: string | null;
    clientImage: string | null;
    proxyImage: string | null;
    node: string;
  };
  instance: {
    uptimeSeconds: number;
    platform: string;
    arch: string;
  };
  memory: {
    processRssMb: number;
    processHeapMb: number;
  };
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

function AboutRow({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-text-muted">{label}</span>
      <span className={`text-xs text-text-primary truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function SystemInfoSection() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    settingsApi.getSystemInfo()
      .then((d) => setInfo(d as unknown as SystemInfo))
      .catch(() => toast.error('Failed to load system info'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
        <h2 className="text-sm font-semibold text-text-primary mb-4">About</h2>
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      </div>
    );
  }

  if (!info) {
    return null;
  }

  const dockerVer = info.dockerVersion?.Version || info.dockerVersion?.version || 'N/A';
  const apiVer = info.dockerVersion?.ApiVersion;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
      <h2 className="text-sm font-semibold text-text-primary mb-4">About</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-6">
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
            <Server size={12} /> Versions
          </p>
          <AboutRow label="Server" value={info.versions.server ? `v${info.versions.server}` : '—'} mono />
          <AboutRow label="Client" value={`v${__APP_VERSION__}`} mono />
          {info.versions.proxyImage && (
            <AboutRow label="Proxy" value={info.versions.proxyImage} mono />
          )}
          <AboutRow label="Node.js" value={info.versions.node} mono />
          <AboutRow label="Docker" value={apiVer ? `${dockerVer} (API ${apiVer})` : dockerVer} mono />
        </div>
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
            <Network size={12} /> Instance
          </p>
          <AboutRow label="Uptime" value={formatUptime(info.instance.uptimeSeconds)} mono />
          <AboutRow label="Platform" value={`${info.instance.platform}/${info.instance.arch}`} mono />
          <AboutRow
            label="Docker"
            value={
              <span className={`inline-flex items-center gap-1.5 ${info.dockerConnected ? 'text-status-up' : 'text-status-down'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${info.dockerConnected ? 'bg-status-up' : 'bg-status-down'}`} />
                {info.dockerConnected ? 'Connected' : 'Disconnected'}
              </span>
            }
          />
          <AboutRow label="Stacks" value={String(info.stackCount)} mono />
          <AboutRow label="Containers" value={String(info.containerCount)} mono />
        </div>
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
            <Shield size={12} /> Memory
          </p>
          <AboutRow label="RSS" value={`${info.memory.processRssMb} MB`} mono />
          <AboutRow label="Heap" value={`${info.memory.processHeapMb} MB`} mono />
          {info.versions.serverImage && (
            <AboutRow label="Server image" value={info.versions.serverImage} mono />
          )}
          {info.versions.clientImage && (
            <AboutRow label="Client image" value={info.versions.clientImage} mono />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Settings Page ──
export function SettingsPage() {
  const { user } = useAuthStore();
  const [config, setConfig] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Redirect non-admins
  if (user && user.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  useEffect(() => {
    settingsApi.getAll()
      .then(setConfig)
      .catch(() => toast.error('Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await settingsApi.update(config);
      toast.success('Settings saved');
    } catch (err) {
      // e.g. an inbound secret shorter than 16 characters (400)
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 max-w-3xl">
        <h1 className="text-xl font-semibold text-text-primary mb-6">Settings</h1>
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-text-primary mb-6">Settings</h1>
      <SsoSection config={config} setConfig={setConfig} onSave={handleSave} saving={saving} />
      <DefaultSettingsSection config={config} setConfig={setConfig} onSave={handleSave} saving={saving} />
      <NotificationChannelsSection />
      <NotificationGlobalSection config={config} setConfig={setConfig} onSave={handleSave} saving={saving} />
      <ProxyStatusSection />
      <TailscaleSection />
      <SystemInfoSection />
    </div>
  );
}

// ── Tailscale Section ──
// Shows status of the local tailscaled sidecar + lets the admin generate copy-pasteable
// install commands for remote hosts (engines). When the sidecar isn't running the section
// degrades gracefully with instructions on how to enable it.
function TailscaleSection() {
  const [status, setStatus] = useState<TailscaleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [engines, setEngines] = useState<DockerEngine[]>([]);

  const reload = async () => {
    setRefreshing(true);
    try {
      const [s, eng] = await Promise.all([
        tailscaleApi.status(),
        enginesApi.list().catch(() => [] as DockerEngine[]),
      ]);
      setStatus(s);
      setEngines(eng);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
        <h2 className="text-sm font-semibold text-text-primary mb-4">Tailscale</h2>
        <div className="flex items-center justify-center py-6">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Network size={16} className="text-text-muted" />
          <h2 className="text-sm font-semibold text-text-primary">Tailscale</h2>
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              status?.enabled ? 'bg-status-up/15 text-status-up' : 'bg-text-muted/15 text-text-muted'
            }`}
          >
            {status?.enabled ? 'Connected' : 'Disabled'}
          </span>
        </div>
        <button
          onClick={() => void reload()}
          disabled={refreshing}
          className="text-xs text-text-muted hover:text-text-primary flex items-center gap-1"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {!status?.enabled ? (
        <div className="text-xs text-text-muted space-y-2">
          <p>{status?.message || 'Tailscale sidecar is not running.'}</p>
          <p>
            To enable: add <code className="bg-bg-primary px-1 rounded">TAILSCALE_AUTHKEY=tskey-…</code>
            {' '}and <code className="bg-bg-primary px-1 rounded">TAILSCALE_HOSTNAME=oblihub</code> to
            your <code className="bg-bg-primary px-1 rounded">.env</code>, then start with{' '}
            <code className="bg-bg-primary px-1 rounded">docker compose --profile tailscale up -d</code>.
          </p>
          <p>
            Get an auth key from{' '}
            <a
              href="https://login.tailscale.com/admin/settings/keys"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              login.tailscale.com/admin/settings/keys
            </a>
            .
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4 mb-4 text-xs">
            <div>
              <span className="text-text-muted">Hostname</span>
              <div className="text-text-primary font-mono mt-1">{status.selfHostname || '—'}</div>
            </div>
            <div>
              <span className="text-text-muted">Tailnet IP</span>
              <div className="text-text-primary font-mono mt-1">{status.selfIpv4 || '—'}</div>
            </div>
            <div>
              <span className="text-text-muted">MagicDNS</span>
              <div className="text-text-primary font-mono mt-1 truncate">{status.selfDnsName || '—'}</div>
            </div>
          </div>

          <div className="border-t border-border pt-4 mb-4">
            <div className="text-xs text-text-muted mb-2">Peers ({status.peers.length})</div>
            {status.peers.length === 0 ? (
              <div className="text-xs text-text-muted italic">
                No peers yet — install Tailscale on at least one other host to populate this list.
              </div>
            ) : (
              <div className="space-y-1">
                {status.peers.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between text-xs py-1.5 px-2 rounded hover:bg-bg-primary"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`h-2 w-2 rounded-full flex-shrink-0 ${
                          p.online ? 'bg-status-up' : 'bg-text-muted'
                        }`}
                      />
                      <span className="text-text-primary font-mono truncate">{p.hostname}</span>
                      <span className="text-text-muted font-mono truncate">{p.ipv4 || ''}</span>
                    </div>
                    {p.primaryRoutes.length > 0 && (
                      <span className="text-status-up text-[10px] font-mono ml-2 truncate" title={p.primaryRoutes.join(', ')}>
                        routes: {p.primaryRoutes.join(', ')}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <InstallCommandGenerator engines={engines} />
        </>
      )}
    </div>
  );
}

function InstallCommandGenerator({ engines }: { engines: DockerEngine[] }) {
  const [hostname, setHostname] = useState('');
  const [authKey, setAuthKey] = useState('');
  const [showAuthKey, setShowAuthKey] = useState(false);
  const [routes, setRoutes] = useState('');
  const [bridgeMode, setBridgeMode] = useState(false);
  const [discoverFromEngineId, setDiscoverFromEngineId] = useState<number | ''>('');
  const [command, setCommand] = useState('');
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    if (!hostname.trim()) {
      toast.error('Hostname is required');
      return;
    }
    setGenerating(true);
    setDiscoveryError(null);
    try {
      const subnetRoutes = routes
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
      const result = await tailscaleApi.installCommand({
        hostname: hostname.trim(),
        authKey: authKey.trim() || undefined,
        subnetRoutes,
        acceptRoutes: true,
        discoverFromEngineId: bridgeMode && discoverFromEngineId ? Number(discoverFromEngineId) : undefined,
      });
      setCommand(result.command);
      if (result.discoveryError) setDiscoveryError(result.discoveryError);
      if (result.subnetRoutes.length && bridgeMode) {
        setRoutes(result.subnetRoutes.join(', '));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate command');
    } finally {
      setGenerating(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Copy failed');
    }
  };

  return (
    <div className="border-t border-border pt-4">
      <h3 className="text-xs font-semibold text-text-primary mb-2">Install on a remote host</h3>
      <p className="text-xs text-text-muted mb-3">
        Generate a one-liner to install Tailscale and join this Tailnet on any Linux host (Unraid, VPS, etc.). The auth key never
        leaves your browser unless you paste it here — the server only relays it into the snippet.
      </p>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-text-muted block mb-1">Target hostname</label>
          <input
            type="text"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="unraid"
            className="w-full bg-bg-primary border border-border rounded px-3 py-1.5 text-xs text-text-primary"
          />
        </div>

        <div>
          <label className="text-xs text-text-muted block mb-1">
            Auth key{' '}
            <span className="text-text-muted">
              (optional —{' '}
              <a
                href="https://login.tailscale.com/admin/settings/keys"
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                generate
              </a>
              )
            </span>
          </label>
          <div className="relative">
            <input
              type={showAuthKey ? 'text' : 'password'}
              value={authKey}
              onChange={(e) => setAuthKey(e.target.value)}
              placeholder="tskey-auth-…"
              className="w-full bg-bg-primary border border-border rounded px-3 py-1.5 text-xs text-text-primary font-mono pr-8"
            />
            <button
              type="button"
              onClick={() => setShowAuthKey((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
            >
              {showAuthKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={bridgeMode}
            onChange={(e) => setBridgeMode(e.target.checked)}
            className="mt-0.5"
            id="bridge-mode"
          />
          <div className="flex-1">
            <label htmlFor="bridge-mode" className="text-xs text-text-primary cursor-pointer">
              Bridge routing — advertise the host's Docker bridge subnets
            </label>
            <p className="text-xs text-text-muted mt-0.5">
              Lets Oblihub's proxy reach container bridge IPs directly, without published ports. Requires approval in the Tailscale
              admin console after install.
            </p>
            {bridgeMode && (
              <div className="mt-2 space-y-2">
                <div>
                  <label className="text-xs text-text-muted block mb-1">Auto-discover from engine (optional)</label>
                  <select
                    value={discoverFromEngineId}
                    onChange={(e) => setDiscoverFromEngineId(e.target.value ? Number(e.target.value) : '')}
                    className="w-full bg-bg-primary border border-border rounded px-2 py-1 text-xs text-text-primary"
                  >
                    <option value="">— manual entry below —</option>
                    {engines.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name} ({e.type})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-text-muted block mb-1">Subnets (CIDR, comma-separated)</label>
                  <input
                    type="text"
                    value={routes}
                    onChange={(e) => setRoutes(e.target.value)}
                    placeholder="172.17.0.0/16, 172.18.0.0/16"
                    className="w-full bg-bg-primary border border-border rounded px-3 py-1.5 text-xs text-text-primary font-mono"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <button
          onClick={() => void generate()}
          disabled={generating}
          className="w-full px-3 py-2 bg-accent text-white text-xs font-semibold rounded hover:bg-accent/90 disabled:opacity-50"
        >
          {generating ? 'Generating…' : 'Generate command'}
        </button>
      </div>

      {discoveryError && (
        <div className="mt-3 text-xs text-status-down bg-status-down/10 border border-status-down/30 rounded p-2">
          Could not auto-discover subnets: {discoveryError}
        </div>
      )}

      {command && (
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-text-muted">Run this on the target host (as root):</span>
            <button
              onClick={() => void copy()}
              className="text-xs text-accent hover:underline flex items-center gap-1"
            >
              <Copy size={11} /> Copy
            </button>
          </div>
          <pre className="bg-bg-primary border border-border rounded p-3 text-xs text-text-primary font-mono whitespace-pre-wrap overflow-x-auto">
            {command}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Notification Global Section ──
function NotificationGlobalSection({ config, setConfig, onSave, saving }: {
  config: Record<string, string | null>;
  setConfig: (c: Record<string, string | null>) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const notifyAvailable = config.notify_update_available !== 'false';
  const notifyApplied = config.notify_update_applied !== 'false';
  const notifyDelay = config.notify_delay || '300';
  const [channels, setChannels] = useState<{ id: number; name: string; type: string }[]>([]);
  const [errorPages, setErrorPages] = useState<CustomPage[]>([]);
  const defaultChannelIds: number[] = (() => { try { return JSON.parse(config.default_notification_channel_ids || '[]'); } catch { return []; } })();
  const defaultErrorPageId = config.default_error_page_id ? parseInt(config.default_error_page_id) : null;

  useEffect(() => {
    notificationsApi.getChannels().then(chs => setChannels(chs.map(c => ({ id: c.id, name: c.name, type: c.type })))).catch(() => {});
    proxyApi.listCustomPages().then(setErrorPages).catch(() => {});
  }, []);

  const toggleChannel = (id: number) => {
    const next = defaultChannelIds.includes(id) ? defaultChannelIds.filter(x => x !== id) : [...defaultChannelIds, id];
    setConfig({ ...config, default_notification_channel_ids: JSON.stringify(next) });
  };

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4 mb-6">
      <h2 className="text-sm font-semibold text-text-secondary mb-4">Notification & Proxy Defaults</h2>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-text-primary">Notify: Update Available</div>
            <div className="text-xs text-text-muted">Send notification when a container image update is detected</div>
          </div>
          <button onClick={() => setConfig({ ...config, notify_update_available: notifyAvailable ? 'false' : 'true' })}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${notifyAvailable ? 'bg-status-up' : 'bg-bg-tertiary border border-border'}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${notifyAvailable ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-text-primary">Notify: Update Applied</div>
            <div className="text-xs text-text-muted">Send notification when a container is successfully updated</div>
          </div>
          <button onClick={() => setConfig({ ...config, notify_update_applied: notifyApplied ? 'false' : 'true' })}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${notifyApplied ? 'bg-status-up' : 'bg-bg-tertiary border border-border'}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${notifyApplied ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-text-primary">Notification Delay</div>
            <div className="text-xs text-text-muted">Minimum seconds between repeat notifications for the same event</div>
          </div>
          <div className="flex items-center gap-2">
            <input type="number" min={0} max={86400} value={notifyDelay}
              onChange={e => setConfig({ ...config, notify_delay: e.target.value || '300' })}
              className="w-24 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary text-right focus:outline-none focus:ring-1 focus:ring-accent" />
            <span className="text-xs text-text-muted">sec</span>
          </div>
        </div>

        {/* Default notification channels */}
        <div>
          <div className="text-sm font-medium text-text-primary mb-1">Default Notification Channels</div>
          <div className="text-xs text-text-muted mb-2">Channels used for all notifications unless overridden per stack</div>
          <div className="flex flex-wrap gap-2">
            {channels.map(ch => {
              const active = defaultChannelIds.includes(ch.id);
              return (
                <button key={ch.id} onClick={() => toggleChannel(ch.id)}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${active ? 'border-accent bg-accent/10 text-accent font-medium' : 'border-border text-text-muted hover:bg-bg-hover'}`}>
                  {ch.name} <span className="text-[9px] text-text-muted">({ch.type})</span>
                </button>
              );
            })}
            {channels.length === 0 && <span className="text-xs text-text-muted">No channels configured</span>}
          </div>
        </div>

        {/* Default error page */}
        <div>
          <div className="text-sm font-medium text-text-primary mb-1">Default Error Page</div>
          <div className="text-xs text-text-muted mb-2">Error page used for all proxy hosts unless overridden</div>
          <select value={defaultErrorPageId || ''} onChange={e => setConfig({ ...config, default_error_page_id: e.target.value || null })}
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
            <option value="">None (nginx default)</option>
            {errorPages.map(p => <option key={p.id} value={p.id}>{p.name} ({p.errorCodes.join(', ')})</option>)}
          </select>
        </div>

        {/* Proxy network name */}
        <div>
          <div className="text-sm font-medium text-text-primary mb-1">Proxy Network Name</div>
          <div className="text-xs text-text-muted mb-2">
            Docker network the built-in nginx proxy runs on. Auto-created sidecars (e.g. Azure AD auth) attach here so nginx can reach them via docker DNS. Default: <code>proxy</code>. If Compose prefixed it (e.g. <code>oblihub_proxy</code>), set it here so sidecars land on the correct network. Run <code>docker network ls</code> on the host to check the exact name — changing this only affects future sidecar deploys.
          </div>
          <input
            type="text"
            value={config.proxy_network_name || ''}
            onChange={e => setConfig({ ...config, proxy_network_name: e.target.value || null })}
            placeholder="proxy"
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        {/* Obliguard integration */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-sm font-medium text-text-primary">Obliguard integration</div>
            <ObliguardStatusPill />
          </div>
          <div className="text-xs text-text-muted mb-2">
            Sends every ban Oblihub creates to Obliguard's central ban store. Leave both fields blank to auto-discover via Obligate (if both apps are registered there). Fill them in manually otherwise. Fire-and-forget — a failed sync doesn't fail the ban path.
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              value={config.obliguard_url || ''}
              onChange={e => setConfig({ ...config, obliguard_url: e.target.value || null })}
              placeholder="https://obliguard.yourdomain.com"
              className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <input
              type="password"
              value={config.obliguard_api_key || ''}
              onChange={e => setConfig({ ...config, obliguard_api_key: e.target.value || null })}
              placeholder="API key (bearer)"
              className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </div>

        {/* Default honeypot ban duration */}
        <div>
          <div className="text-sm font-medium text-text-primary mb-1">Default honeypot ban duration</div>
          <div className="text-xs text-text-muted mb-2">
            How long a caught scanner stays banned when the proxy_host doesn't set its own. Empty = permanent. Applies to bans coming from any host that hasn't overridden it.
          </div>
          <select
            value={config.default_honeypot_ban_duration_seconds || ''}
            onChange={e => setConfig({ ...config, default_honeypot_ban_duration_seconds: e.target.value || null })}
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">Permanent (default)</option>
            <option value={String(60 * 60)}>1 hour</option>
            <option value={String(24 * 60 * 60)}>24 hours</option>
            <option value={String(7 * 24 * 60 * 60)}>7 days</option>
            <option value={String(30 * 24 * 60 * 60)}>30 days</option>
          </select>
        </div>

        <button onClick={onSave} disabled={saving}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50">
          <Save size={14} /> {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ── Proxy Status Section ──
function ProxyStatusSection() {
  const [status, setStatus] = useState<{ nginxRunning: boolean; proxyHostCount: number; enabledHostCount: number; certificateCount: number; validCertCount: number; expiringSoon: number } | null>(null);
  const [allowNginx, setAllowNginx] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    systemApi.getFeatures().then(f => {
      setAllowNginx(f.allowNginx);
      if (f.allowNginx) {
        proxyApi.getStatus().then(setStatus).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  if (!allowNginx) return null;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4 mb-6">
      <h2 className="text-sm font-semibold text-text-secondary mb-4 flex items-center gap-1.5"><Globe size={14} /> Nginx Proxy Status</h2>
      {status ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className={`h-3 w-3 rounded-full ${status.nginxRunning ? 'bg-status-up' : 'bg-status-down'}`} />
            <span className="text-sm text-text-primary font-medium">{status.nginxRunning ? 'Running' : 'Stopped'}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg bg-bg-tertiary p-3 text-center">
              <div className="text-lg font-semibold text-text-primary">{status.enabledHostCount}</div>
              <div className="text-[10px] text-text-muted">Active Hosts</div>
            </div>
            <div className="rounded-lg bg-bg-tertiary p-3 text-center">
              <div className="text-lg font-semibold text-text-primary">{status.proxyHostCount}</div>
              <div className="text-[10px] text-text-muted">Total Hosts</div>
            </div>
            <div className="rounded-lg bg-bg-tertiary p-3 text-center">
              <div className="text-lg font-semibold text-status-up">{status.validCertCount}</div>
              <div className="text-[10px] text-text-muted">Valid Certs</div>
            </div>
            <div className="rounded-lg bg-bg-tertiary p-3 text-center">
              <div className={`text-lg font-semibold ${status.expiringSoon > 0 ? 'text-status-pending' : 'text-text-primary'}`}>{status.expiringSoon}</div>
              <div className="text-[10px] text-text-muted">Expiring Soon</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                setReloading(true);
                try { await proxyApi.reloadNginx(); toast.success('Nginx reloaded'); proxyApi.getStatus().then(setStatus); }
                catch { toast.error('Reload failed'); }
                finally { setReloading(false); }
              }}
              disabled={reloading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border text-text-secondary hover:bg-bg-hover disabled:opacity-50">
              <RefreshCw size={12} className={reloading ? 'animate-spin' : ''} /> Reload Nginx
            </button>
            <button
              onClick={async () => {
                setTesting(true);
                try {
                  const result = await proxyApi.testNginx();
                  if (result.valid) toast.success('Config is valid');
                  else toast.error(`Config invalid: ${result.error}`);
                } catch { toast.error('Test failed'); }
                finally { setTesting(false); }
              }}
              disabled={testing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border text-text-secondary hover:bg-bg-hover disabled:opacity-50">
              <CheckCircle size={12} /> Test Config
            </button>
          </div>
        </div>
      ) : (
        <div className="text-xs text-text-muted">Loading proxy status...</div>
      )}
    </div>
  );
}
