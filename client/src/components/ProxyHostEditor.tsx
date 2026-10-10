import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Shield, Zap, Lock, Globe, Moon, Plus, Trash2 } from 'lucide-react';
import { findContainerPort, suggestProxyPort } from '@oblihub/shared';
import type { ProxyHost, Certificate, AccessList, CustomPage, Container, AzureAuthProvider, ProxyHostRoute, Stack, EngineSummary } from '@oblihub/shared';
import { useEngineSummaries } from '../hooks/useEngineSummaries';
import { ContainerPicker } from './ContainerPicker';
import { ContainerPortsPanel, type UpstreamPatch } from './ContainerPortsPanel';
import { RouteEditor } from './RouteEditor';

export type ProxyHostEditorProps = {
  editing: Partial<ProxyHost>;
  setEditing: Dispatch<SetStateAction<Partial<ProxyHost> | null>>;
  editId: number | null;
  certs: Certificate[];
  hosts: ProxyHost[];
  accessLists: AccessList[];
  azureProviders: AzureAuthProvider[];
  customPages: CustomPage[];
  allContainers: { container: Container; stackName: string }[];
  domainInput: string;
  setDomainInput: (v: string) => void;
  addDomain: () => void;
  removeDomain: (d: string) => void;
  certMode: 'none' | 'existing' | 'new';
  setCertMode: (m: 'none' | 'existing' | 'new') => void;
  acmeEmail: string;
  setAcmeEmail: (v: string) => void;
};

type Tab = 'general' | 'ssl' | 'auth' | 'routes' | 'honeypot' | 'performance' | 'others' | 'expert';
const TABS: { key: Tab; label: string }[] = [
  { key: 'general',     label: 'General' },
  { key: 'ssl',         label: 'SSL' },
  { key: 'auth',        label: 'Auth' },
  { key: 'routes',      label: 'Routes' },
  { key: 'honeypot',    label: 'Honeypot' },
  { key: 'performance', label: 'Performance' },
  { key: 'others',      label: 'Others' },
  { key: 'expert',      label: 'Expert' },
];

type PickedTarget = { container: Container; stackName: string | null };

/**
 * Which container a saved forward host names. Names are unique per daemon only, and /stacks comes
 * back in no fixed engine order, so a bare name matching on several engines is a guess: the host's
 * own stack link settles it; otherwise the local engine's container wins, since a bare name only
 * ever reached that one through the hub's Docker DNS. `sure` tells the panel whether the guess may
 * rewrite the forward host on its own — an unsure one must wait for the operator to pick.
 *
 * A lone remote match is never sure without the stack link: a saved bare name that worked resolved
 * through the hub's Docker DNS, where it may be a local compose service alias (`web` for
 * `shop-web-1`) that matches no container name at all. Auto-resolving would silently repoint live
 * traffic at an unrelated container that merely shares the name on another engine.
 */
function guessTarget(
  allContainers: { container: Container; stackName: string }[],
  host: string | null | undefined,
  stackId: number | null | undefined,
  engines: Map<number, EngineSummary>,
): { entry: PickedTarget | null; count: number; sure: boolean } {
  if (!host) return { entry: null, count: 0, sure: false };
  const isLocalMatch = (e: { container: Container }) =>
    e.container.engineId != null && engines.get(e.container.engineId)?.isLocal === true;
  const matches = allContainers.filter(e => e.container.containerName === host);
  const byStack = stackId != null ? matches.find(e => e.container.stackId === stackId) : undefined;
  const best = byStack ?? matches.find(isLocalMatch) ?? matches[0];
  return {
    entry: best ? { container: best.container, stackName: best.stackName } : null,
    count: matches.length,
    sure: byStack != null || (matches.length === 1 && isLocalMatch(matches[0])),
  };
}

/** What the General tab needs to show the target container's ports and upstream status. */
type TargetBinding = {
  picked: PickedTarget | null;
  ambiguousCount: number;
  /** False while the target is only an ambiguous guess, so reopening a host never retargets it. */
  autoResolve: boolean;
  onHostChange: (host: string) => void;
  onPickContainer: (c: Container, s: Stack) => void;
  onApply: (patch: UpstreamPatch) => void;
};

export function ProxyHostEditor(props: ProxyHostEditorProps) {
  const [tab, setTab] = useState<Tab>('general');
  const { editing, setEditing, allContainers } = props;

  // Kept here rather than in GeneralTab so the pick survives switching tabs: after a remote
  // container is resolved the forward host is a Tailscale/engine address that no longer names it.
  // null = follow the inference from the saved forward host; { entry: null } = cleared by typing.
  const [pick, setPick] = useState<{ entry: PickedTarget | null } | null>(null);
  const [lastAppliedHost, setLastAppliedHost] = useState<string | null>(null);

  const { byId: enginesById } = useEngineSummaries();
  const inferred = useMemo(
    () => guessTarget(allContainers, editing.forwardHost, editing.stackId, enginesById),
    [allContainers, editing.forwardHost, editing.stackId, enginesById],
  );

  const picked = pick ? pick.entry : inferred.entry;

  const binding: TargetBinding = {
    picked,
    ambiguousCount: pick ? 0 : inferred.count,
    autoResolve: pick != null || inferred.sure,
    onHostChange: (host) => {
      setEditing(h => h ? { ...h, forwardHost: host } : null);
      if (picked && host !== picked.container.containerName && host !== lastAppliedHost) setPick({ entry: null });
    },
    onPickContainer: (c, s) => {
      setPick({ entry: { container: c, stackName: s.name } });
      // Linking stackId makes the host appear on the stack page, feeds the priority watchdog's
      // nginx-traffic signal and scopes proxy override detection to that stack. An existing link
      // is the operator's choice and is kept.
      setEditing(h => h ? {
        ...h,
        forwardHost: c.containerName,
        forwardPort: (h.forwardPort == null || h.forwardPort === 80 || !findContainerPort(c.ports, h.forwardPort))
          // A remote target is only reachable through a published port: prefer one.
          ? (suggestProxyPort(c.ports, { preferPublished: c.engineId != null && enginesById.get(c.engineId)?.isLocal === false }) ?? h.forwardPort ?? 80)
          : h.forwardPort,
        stackId: h.stackId ?? s.id,
      } : null);
    },
    onApply: (patch) => {
      if (patch.forwardHost !== undefined) {
        setLastAppliedHost(patch.forwardHost);
        // An inferred pick follows the host name, which is about to stop naming the container.
        if (!pick) setPick({ entry: picked });
      }
      setEditing(h => h ? { ...h, ...patch } : null);
    },
  };

  return (
    <>
      <div className="border-b border-border px-6 flex gap-1 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors flex-shrink-0 ${
              tab === t.key ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="p-6 space-y-5">
        {tab === 'general'     && <GeneralTab {...props} binding={binding} />}
        {tab === 'ssl'         && <SslTab {...props} />}
        {tab === 'auth'        && <AuthTab {...props} />}
        {tab === 'routes'      && (
          <RouteEditor
            routes={editing.routes || []}
            onChange={(next) => setEditing(e => e ? { ...e, routes: typeof next === 'function' ? next(e.routes || []) : next } : null)}
            defaults={{
              forwardScheme: editing.forwardScheme || 'http',
              forwardHost: editing.forwardHost || '',
              forwardPort: editing.forwardPort || 80,
            }}
            azureProviders={props.azureProviders}
            accessLists={props.accessLists}
            allContainers={allContainers}
          />
        )}
        {tab === 'honeypot'    && <HoneypotTab {...props} />}
        {tab === 'performance' && <PerformanceTab {...props} />}
        {tab === 'others'      && <OthersTab {...props} />}
        {tab === 'expert'      && <ExpertTab {...props} />}
      </div>
    </>
  );
}

// ── General ──
function GeneralTab({ editing, setEditing, domainInput, setDomainInput, addDomain, removeDomain, binding }: ProxyHostEditorProps & { binding: TargetBinding }) {
  return (
    <>
      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">Domain Names</label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {(editing.domainNames || []).map(d => (
            <span key={d} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/10 text-accent text-xs font-mono">
              {d}
              <button onClick={() => removeDomain(d)} className="hover:text-status-down">&times;</button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={domainInput}
            onChange={e => setDomainInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addDomain())}
            placeholder="example.com"
            className="flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button onClick={addDomain} className="px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Add</button>
        </div>
      </div>

      <div className="grid grid-cols-[80px_1fr_100px] gap-3">
        <div>
          <label className="text-xs font-medium text-text-secondary block mb-1.5">Scheme</label>
          <select
            value={editing.forwardScheme || 'http'}
            onChange={e => setEditing(h => h ? { ...h, forwardScheme: e.target.value as 'http' | 'https' } : null)}
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="http">http</option>
            <option value="https">https</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-text-secondary block mb-1.5">Forward Host</label>
          <ContainerPicker
            value={editing.forwardHost || ''}
            onChange={binding.onHostChange}
            onPickContainer={binding.onPickContainer}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-text-secondary block mb-1.5">Port</label>
          <input
            type="number"
            value={editing.forwardPort || 80}
            onChange={e => setEditing(h => h ? { ...h, forwardPort: parseInt(e.target.value) || 80 } : null)}
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      <ContainerPortsPanel
        container={binding.picked?.container ?? null}
        stackName={binding.picked?.stackName ?? null}
        ambiguousCount={binding.ambiguousCount}
        autoResolve={binding.autoResolve}
        currentPort={editing.forwardPort || 80}
        currentHost={editing.forwardHost || ''}
        onApply={binding.onApply}
      />

      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">
          Docker network <span className="text-text-muted font-normal">(for auto network-attach on deploy)</span>
        </label>
        <input
          value={editing.dockerNetwork || ''}
          onChange={e => setEditing(h => h ? { ...h, dockerNetwork: e.target.value || null } : null)}
          placeholder="proxy (default) — or nginx-proxy-manager_default, traefik_default, …"
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <p className="text-[10px] text-text-muted mt-1">
          The compose override attaches the forward-host service to this network on every deploy so it survives rebuilds. Leave blank for Oblihub&#39;s built-in proxy.
        </p>
      </div>

      {/* Small feature toggles that don't fit anywhere else. */}
      <div className="grid grid-cols-2 gap-3">
        <ToggleCell active={editing.blockExploits ?? true} onToggle={() => setEditing(h => h ? { ...h, blockExploits: !h.blockExploits } : null)} icon={Shield} label="Block common exploits" />
        <ToggleCell active={editing.enabled ?? true} onToggle={() => setEditing(h => h ? { ...h, enabled: !h.enabled } : null)} icon={Globe} label="Enabled" />
      </div>
    </>
  );
}

// ── SSL ──
function SslTab({ editing, setEditing, certs, hosts, certMode, setCertMode, acmeEmail, setAcmeEmail, editId }: ProxyHostEditorProps) {
  const [search, setSearch] = useState('');
  // Rank the cert list by relevance to the current host so the operator lands on the right one:
  //   1. Currently selected cert first (never lose the pinned reference)
  //   2. Certs covering EVERY domain of the host (perfect SAN match) — the "obviously right" pick
  //   3. Certs covering AT LEAST ONE domain of the host (partial match — wildcard, multi-SAN)
  //   4. Alphabetical by primary domain
  // Search filters on any domain of the cert.
  const hostDomains = editing.domainNames || [];
  const rankedCerts = certs
    .map(c => {
      const domainsLower = c.domainNames.map(d => d.toLowerCase());
      const covers = (hd: string) => domainsLower.some(cd => cd === hd.toLowerCase() || (cd.startsWith('*.') && hd.toLowerCase().endsWith(cd.slice(1))));
      const perfectMatch = hostDomains.length > 0 && hostDomains.every(covers);
      const partialMatch = hostDomains.some(covers);
      return { c, perfectMatch, partialMatch };
    })
    .filter(({ c }) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return c.domainNames.some(d => d.toLowerCase().includes(q));
    })
    .sort((a, b) => {
      if (a.c.id === editing.certificateId) return -1;
      if (b.c.id === editing.certificateId) return 1;
      if (a.perfectMatch !== b.perfectMatch) return a.perfectMatch ? -1 : 1;
      if (a.partialMatch !== b.partialMatch) return a.partialMatch ? -1 : 1;
      return (a.c.domainNames[0] || '').localeCompare(b.c.domainNames[0] || '');
    });
  return (
    <>
      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">SSL Certificate</label>
        <div className="flex gap-2 mb-2">
          {(['none', 'new', 'existing'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => {
                setCertMode(mode);
                if (mode === 'none') setEditing(h => h ? { ...h, certificateId: null, sslForced: false, http2Support: false, hstsEnabled: false, hstsSubdomains: false } : null);
              }}
              className={`flex-1 px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                certMode === mode ? 'border-accent bg-accent/10 text-accent font-medium' : 'border-border text-text-muted hover:bg-bg-hover'
              }`}
            >
              {mode === 'none' ? 'No SSL' : mode === 'new' ? "Request Let's Encrypt" : 'Use Existing'}
            </button>
          ))}
        </div>
        {certMode === 'new' && (
          <div className="space-y-2 p-3 rounded-lg border border-accent/20 bg-accent/5">
            <div className="text-[10px] text-accent font-medium">A new Let's Encrypt certificate will be requested for the domains above</div>
            <input
              value={acmeEmail}
              onChange={e => setAcmeEmail(e.target.value)}
              placeholder="admin@example.com"
              type="email"
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        )}
        {certMode === 'existing' && (
          <div className="space-y-2">
            {certs.length === 0 ? (
              <div className="text-xs text-text-muted p-2">No certificates available</div>
            ) : (
              <>
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search by domain..."
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <div className="space-y-1 max-h-60 overflow-auto">
                  {rankedCerts.length === 0 && (
                    <div className="text-xs text-text-muted p-2 text-center">No cert matches &quot;{search}&quot;</div>
                  )}
                  {rankedCerts.map(({ c, perfectMatch, partialMatch }) => {
                    const isUsed = hosts.some(h => h.certificateId === c.id && h.id !== editId);
                    const isSelected = editing.certificateId === c.id;
                    return (
                      <button
                        key={c.id}
                        onClick={() => setEditing(h => h ? { ...h, certificateId: c.id, sslForced: true, http2Support: true } : null)}
                        className={`w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors ${
                          isSelected ? 'border-accent bg-accent/10' : isUsed ? 'border-status-down/30 bg-status-down/5 hover:bg-status-down/10' : 'border-border hover:bg-bg-hover'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className={`font-mono truncate ${isSelected ? 'text-accent' : 'text-text-primary'}`}>{c.domainNames.join(', ')}</span>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {perfectMatch && <span className="text-[9px] px-1 py-0.5 rounded bg-status-up/10 text-status-up" title="Covers every domain of this host">SAN ✓</span>}
                            {!perfectMatch && partialMatch && <span className="text-[9px] px-1 py-0.5 rounded bg-accent/10 text-accent" title="Covers at least one domain of this host">SAN partial</span>}
                            {isUsed && <span className="text-[9px] px-1 py-0.5 rounded bg-status-down/10 text-status-down">In use</span>}
                            <span className={`text-[9px] px-1 py-0.5 rounded ${c.status === 'valid' ? 'bg-status-up/10 text-status-up' : 'bg-status-pending/10 text-status-pending'}`}>{c.status}</span>
                          </div>
                        </div>
                        {c.expiresAt && <div className="text-[10px] text-text-muted mt-0.5">Expires: {new Date(c.expiresAt).toLocaleDateString()}</div>}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ToggleCell disabled={certMode === 'none'} active={!!editing.sslForced}     onToggle={() => setEditing(h => h ? { ...h, sslForced: !h.sslForced } : null)}         icon={Lock}   label="Force SSL" />
        <ToggleCell disabled={certMode === 'none'} active={!!editing.http2Support}  onToggle={() => setEditing(h => h ? { ...h, http2Support: !h.http2Support } : null)}   icon={Zap}    label="HTTP/2" />
        <ToggleCell disabled={certMode === 'none'} active={!!editing.hstsEnabled}   onToggle={() => setEditing(h => h ? { ...h, hstsEnabled: !h.hstsEnabled } : null)}     icon={Shield} label="HSTS" />
        <ToggleCell disabled={certMode === 'none' || !editing.hstsEnabled} active={!!editing.hstsSubdomains} onToggle={() => setEditing(h => h ? { ...h, hstsSubdomains: !h.hstsSubdomains } : null)} icon={Shield} label="HSTS Subdomains" />
      </div>
    </>
  );
}

// ── Auth ──
function AuthTab({ editing, setEditing, accessLists, azureProviders }: ProxyHostEditorProps) {
  return (
    <>
      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">
          Access Lists <span className="text-text-muted">(stackable — union of rules)</span>
        </label>
        {accessLists.length === 0 ? (
          <div className="text-[11px] text-text-muted italic rounded-lg border border-border bg-bg-tertiary px-3 py-2">
            No access lists configured. Create one in the Access Lists page.
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-bg-tertiary p-2 max-h-40 overflow-y-auto space-y-1">
            {accessLists.map(al => {
              const selected = (editing.accessListIds || (editing.accessListId ? [editing.accessListId] : [])).includes(al.id);
              return (
                <label key={al.id} className="flex items-center gap-2 text-xs text-text-primary cursor-pointer hover:bg-bg-secondary px-1 py-0.5 rounded">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(e) => setEditing(h => {
                      if (!h) return null;
                      const cur = h.accessListIds || (h.accessListId ? [h.accessListId] : []);
                      const next = e.target.checked ? [...cur, al.id] : cur.filter(x => x !== al.id);
                      return { ...h, accessListIds: next, accessListId: next[0] ?? null };
                    })}
                  />
                  <span className="font-medium">{al.name}</span>
                  <span className="text-text-muted">({al.clients.length} rule{al.clients.length !== 1 ? 's' : ''}, {al.auth.length} user{al.auth.length !== 1 ? 's' : ''})</span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">
          Azure AD forward-auth <span className="text-text-muted">(delegates auth to an oauth2-proxy sidecar)</span>
        </label>
        <select
          value={editing.azureAuthProviderId || ''}
          onChange={e => setEditing(h => h ? { ...h, azureAuthProviderId: e.target.value ? parseInt(e.target.value, 10) : null } : null)}
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">None — no forward-auth</option>
          {azureProviders.map(p => (
            <option key={p.id} value={p.id}>
              {p.name} {p.containerStatus === 'running' ? '' : `(${p.containerStatus || 'not deployed'})`}
            </option>
          ))}
        </select>
        {editing.azureAuthProviderId && editing.domainNames?.[0] && (
          <p className="text-[10px] text-status-pending mt-1.5">
            ⚠ Add this callback URL to the Azure app's Redirect URIs: <code className="bg-bg-tertiary px-1 rounded">https://{editing.domainNames[0]}/oauth2/callback</code>
          </p>
        )}
        {azureProviders.length === 0 && (
          <p className="text-[10px] text-text-muted mt-1.5">
            No providers yet — create one in the <a href="/azure-auth" className="text-accent hover:underline">Azure Auth page</a>.
          </p>
        )}
      </div>

      {editing.azureAuthProviderId && (
        <>
          <div>
            <label className="text-xs font-medium text-text-secondary block mb-1.5">
              Restrict to Azure group IDs <span className="text-text-muted">(per-host, comma-separated GUIDs — Object IDs)</span>
            </label>
            <input
              value={(editing.azureAuthAllowedGroups || []).join(', ')}
              onChange={e => {
                const parsed = e.target.value
                  .split(',')
                  .map(s => s.trim())
                  .filter(s => s.length > 0);
                setEditing(h => h ? { ...h, azureAuthAllowedGroups: parsed.length ? parsed : null } : null);
              }}
              placeholder="e.g. f1249c89-2f32-4e3f-bdcb-fa7a33d5d3f3, 8a2b1c4d-…"
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <p className="text-[10px] text-text-muted mt-1">
              GUID = <em>Object ID</em> from Azure Portal → Groups → &lt;group&gt; → Object ID. Provider must expose <code>groups</code> as an optional claim (Token configuration → Add optional claim → ID → groups) so the sidecar receives the user&#39;s group list.
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-text-secondary block mb-1.5">
              Restrict to emails / domains <span className="text-text-muted">(per-host, comma-separated)</span>
            </label>
            <input
              value={(editing.azureAuthAllowedEmails || []).join(', ')}
              onChange={e => {
                const parsed = e.target.value
                  .split(',')
                  .map(s => s.trim())
                  .filter(s => s.length > 0);
                setEditing(h => h ? { ...h, azureAuthAllowedEmails: parsed.length ? parsed : null } : null);
              }}
              placeholder="alice@contoso.com, contoso.com"
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <p className="text-[10px] text-text-muted mt-1">
              Entries with <code>@</code> are matched as full emails; entries without are matched as domains (any user <code>*@domain</code>).
            </p>
          </div>

          <div className="rounded-md border border-border bg-bg-tertiary/50 px-3 py-2 text-[10px] text-text-muted leading-relaxed">
            <span className="text-text-secondary font-semibold">How these filters combine</span> — both boxes above are <strong>restrictive surcharges</strong> on top of the provider. They <em>never widen</em> access; the strictest rule always wins.
            <ul className="list-disc pl-4 mt-1 space-y-0.5">
              <li>Empty = no per-host filter (only the provider filter applies).</li>
              <li>Both boxes filled = <strong>AND</strong>: user must be in one of the groups <em>and</em> match one of the emails/domains.</li>
              <li>Provider unrestricted + host restricted = only users matching the host rules reach this host (rest of the tenant is refused with 403).</li>
              <li>Enforced by nginx post-auth via <code>if ($auth_groups !~ …) / if ($auth_email !~ …) {'{'}return 403{'}'}</code>.</li>
            </ul>
          </div>
        </>
      )}
    </>
  );
}

// ── Performance ──
function PerformanceTab({ editing, setEditing }: ProxyHostEditorProps) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <ToggleCell active={!!editing.cachingEnabled}   onToggle={() => setEditing(h => h ? { ...h, cachingEnabled: !h.cachingEnabled } : null)}     icon={Zap}    label="Cache static assets" />
        <ToggleCell active={!!editing.gzipEnabled}      onToggle={() => setEditing(h => h ? { ...h, gzipEnabled: !h.gzipEnabled } : null)}           icon={Zap}    label="Gzip compression" />
        <ToggleCell active={!!editing.websocketSupport} onToggle={() => setEditing(h => h ? { ...h, websocketSupport: !h.websocketSupport } : null)} icon={Zap}    label="WebSocket support" />
        <ToggleCell active={!!editing.corsEnabled}      onToggle={() => setEditing(h => h ? { ...h, corsEnabled: !h.corsEnabled } : null)}           icon={Globe}  label="CORS headers" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] text-text-muted block mb-1">Max Body Size</label>
          <input value={editing.clientMaxBodySize || ''} onChange={e => setEditing(h => h ? { ...h, clientMaxBodySize: e.target.value || null } : null)} placeholder="100m"
            className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>
        <div>
          <label className="text-[10px] text-text-muted block mb-1">Proxy buffering</label>
          <select
            value={editing.proxyBuffering === false ? 'off' : editing.proxyBuffering === true ? 'on' : 'default'}
            onChange={e => setEditing(h => h ? { ...h, proxyBuffering: e.target.value === 'default' ? null : e.target.value === 'on' } : null)}
            className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="default">nginx default (on)</option>
            <option value="on">Force on</option>
            <option value="off">Off (streams / SSE)</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] text-text-muted block mb-1">Connect Timeout (sec)</label>
          <input type="number" value={editing.proxyConnectTimeout || ''} onChange={e => setEditing(h => h ? { ...h, proxyConnectTimeout: parseInt(e.target.value) || null } : null)} placeholder="60"
            className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>
        <div>
          <label className="text-[10px] text-text-muted block mb-1">Send Timeout (sec)</label>
          <input type="number" value={editing.proxySendTimeout || ''} onChange={e => setEditing(h => h ? { ...h, proxySendTimeout: parseInt(e.target.value) || null } : null)} placeholder="60"
            className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>
        <div>
          <label className="text-[10px] text-text-muted block mb-1">Read Timeout (sec)</label>
          <input type="number" value={editing.proxyReadTimeout || ''} onChange={e => setEditing(h => h ? { ...h, proxyReadTimeout: parseInt(e.target.value) || null } : null)} placeholder="60"
            className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] text-text-muted block mb-1">Rate Limit (req/sec)</label>
          <input type="number" value={editing.rateLimitRps || ''} onChange={e => setEditing(h => h ? { ...h, rateLimitRps: parseInt(e.target.value) || null } : null)} placeholder="Off"
            className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>
        <div>
          <label className="text-[10px] text-text-muted block mb-1">Rate Limit Burst</label>
          <input type="number" value={editing.rateLimitBurst || ''} onChange={e => setEditing(h => h ? { ...h, rateLimitBurst: parseInt(e.target.value) || null } : null)} placeholder="10"
            className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>
      </div>
    </>
  );
}

// ── Others: error page, sleep mode, custom response headers ──
function OthersTab({ editing, setEditing, customPages, allContainers }: ProxyHostEditorProps) {
  return (
    <>
      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">Error Page</label>
        <select
          value={editing.errorPageId || ''}
          onChange={e => setEditing(h => h ? { ...h, errorPageId: parseInt(e.target.value) || null } : null)}
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">Use global default</option>
          {customPages.filter(p => !p.isWakingPage).map(p => <option key={p.id} value={p.id}>{p.name} ({p.errorCodes.join(', ')})</option>)}
        </select>
      </div>

      <div className="rounded-lg border border-border bg-bg-tertiary/50 p-3">
        <div className="flex items-center gap-2 mb-2">
          <Moon size={14} className="text-accent" />
          <span className="text-sm font-medium text-text-primary">Sleep mode</span>
        </div>
        <p className="text-[11px] text-text-muted mb-3">
          When the linked container is asleep, requests to this host show a loading page that auto-wakes it. Configure the container&#39;s idle timeout from its Sleep panel in the Stack page.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] font-medium text-text-secondary block mb-1">Wake container</label>
            <select
              value={editing.wakeContainerId || ''}
              onChange={e => setEditing(h => h ? { ...h, wakeContainerId: parseInt(e.target.value) || null } : null)}
              className="w-full rounded-lg border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="">Disabled</option>
              {allContainers.map(({ container, stackName }) => (
                <option key={container.id} value={container.id}>
                  {stackName} / {container.containerName}{container.sleepEnabled ? ' ⏾' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11px] font-medium text-text-secondary block mb-1">Waking page</label>
            <select
              value={editing.wakingPageId || ''}
              onChange={e => setEditing(h => h ? { ...h, wakingPageId: parseInt(e.target.value) || null } : null)}
              className="w-full rounded-lg border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              disabled={!editing.wakeContainerId}
            >
              <option value="">Built-in default</option>
              {customPages.filter(p => p.isWakingPage).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>

        <div className="mt-3">
          <label className="text-[11px] font-medium text-text-secondary block mb-1">
            Also wake these containers <span className="text-text-muted">(optional, parallel)</span>
          </label>
          {editing.wakeContainerId ? (
            <div className="rounded-lg border border-border bg-bg-tertiary/40 p-2 max-h-40 overflow-y-auto space-y-1">
              {allContainers.filter(({ container }) => container.id !== editing.wakeContainerId).map(({ container, stackName }) => {
                const checked = (editing.wakeExtraContainerIds || []).includes(container.id);
                return (
                  <label key={container.id} className="flex items-center gap-2 text-[11px] text-text-primary cursor-pointer hover:bg-bg-tertiary px-1 py-0.5 rounded">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => setEditing(h => {
                        if (!h) return null;
                        const cur = h.wakeExtraContainerIds || [];
                        const next = e.target.checked ? [...cur, container.id] : cur.filter(id => id !== container.id);
                        return { ...h, wakeExtraContainerIds: next };
                      })}
                    />
                    <span>{stackName} / {container.containerName}{container.sleepEnabled ? ' ⏾' : ''}</span>
                  </label>
                );
              })}
              {allContainers.length <= 1 && (
                <div className="text-[11px] text-text-muted italic px-1 py-0.5">No other containers available.</div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-bg-tertiary/40 p-2 text-[11px] text-text-muted italic">Select a primary wake container first.</div>
          )}
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">Custom Response Headers</label>
        <div className="space-y-1.5 mb-2">
          {(editing.customResponseHeaders || []).map((h, i) => (
            <div key={i} className="flex gap-1.5 items-center">
              <select
                value={h.action}
                onChange={e => { const headers = [...(editing.customResponseHeaders || [])]; headers[i] = { ...h, action: e.target.value as 'add' | 'remove' }; setEditing(ed => ed ? { ...ed, customResponseHeaders: headers } : null); }}
                className="rounded border border-border bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-primary w-16"
              >
                <option value="add">Add</option><option value="remove">Remove</option>
              </select>
              <input
                value={h.name}
                onChange={e => { const headers = [...(editing.customResponseHeaders || [])]; headers[i] = { ...h, name: e.target.value }; setEditing(ed => ed ? { ...ed, customResponseHeaders: headers } : null); }}
                placeholder="Header-Name"
                className="flex-1 rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs font-mono text-text-primary"
              />
              {h.action === 'add' && (
                <input
                  value={h.value}
                  onChange={e => { const headers = [...(editing.customResponseHeaders || [])]; headers[i] = { ...h, value: e.target.value }; setEditing(ed => ed ? { ...ed, customResponseHeaders: headers } : null); }}
                  placeholder="value"
                  className="flex-1 rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs font-mono text-text-primary"
                />
              )}
              <button
                onClick={() => { const headers = (editing.customResponseHeaders || []).filter((_, j) => j !== i); setEditing(ed => ed ? { ...ed, customResponseHeaders: headers.length ? headers : null } : null); }}
                className="p-0.5 text-text-muted hover:text-status-down"
              >&times;</button>
            </div>
          ))}
        </div>
        <button
          onClick={() => setEditing(ed => ed ? { ...ed, customResponseHeaders: [...(ed.customResponseHeaders || []), { name: '', value: '', action: 'add' as const }] } : null)}
          className="text-xs text-accent hover:text-accent-hover"
        >+ Add header</button>
      </div>
    </>
  );
}

// ── Expert (advanced free-text) ──
function ExpertTab({ editing, setEditing }: ProxyHostEditorProps) {
  return (
    <div>
      <label className="text-xs font-medium text-text-secondary block mb-1.5">Custom Nginx Configuration</label>
      <textarea
        value={editing.advancedConfig || ''}
        onChange={e => setEditing(h => h ? { ...h, advancedConfig: e.target.value } : null)}
        rows={12}
        spellCheck={false}
        placeholder={'# Injected inside the server { } block, after location /.\n# Use Routes tab for common sub-location cases;\n# this is the escape hatch for the rest.'}
        className="w-full rounded-lg border border-border bg-[#0d1117] px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none"
      />
      <p className="text-[10px] text-text-muted mt-1">
        Free-form nginx directives. Emitted at the server-scope after the main location block. Use with care — a bad snippet fails <code>nginx -t</code> and stops reloads until fixed.
      </p>
    </div>
  );
}

// ── Honeypot tab — bait paths + ACL-violation ban switch ──
function HoneypotTab({ editing, setEditing }: ProxyHostEditorProps) {
  const [paths, setPaths] = useState<{ path: string; enabled: boolean }[]>([]);
  const [newPath, setNewPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [presetPreview, setPresetPreview] = useState<string[]>([]);
  const editId = (editing as { id?: number }).id;

  useEffect(() => {
    if (!editId) { setPaths([]); setLoading(false); return; }
    Promise.all([
      import('@/api/bans.api').then(m => m.honeypotApi.listForHost(editId).catch(() => [])),
      import('@/api/bans.api').then(m => m.honeypotApi.getDefaults().catch(() => [])),
    ]).then(([hostPaths, defaults]) => {
      setPaths(hostPaths.map(p => ({ path: p.path, enabled: p.enabled })));
      setPresetPreview(defaults);
      setLoading(false);
    });
  }, [editId]);

  const addPath = () => {
    const clean = newPath.trim();
    if (!clean) return;
    if (paths.some(p => p.path === clean)) return;
    setPaths([...paths, { path: clean, enabled: true }]);
    setNewPath('');
  };

  const removePath = (idx: number) => setPaths(paths.filter((_, i) => i !== idx));
  const togglePath = (idx: number) => setPaths(paths.map((p, i) => i === idx ? { ...p, enabled: !p.enabled } : p));

  const addPreset = () => {
    const existing = new Set(paths.map(p => p.path));
    const merged = [...paths, ...presetPreview.filter(p => !existing.has(p)).map(p => ({ path: p, enabled: true }))];
    setPaths(merged);
  };

  const savePaths = async () => {
    if (!editId) return;
    setSaving(true);
    try {
      const { honeypotApi } = await import('@/api/bans.api');
      await honeypotApi.replaceAll(editId, paths);
    } finally { setSaving(false); }
  };

  return (
    <>
      <div className="rounded-lg border border-status-down/30 bg-status-down/5 p-3">
        <div className="flex items-start gap-2">
          <Shield size={16} className="text-status-down mt-0.5 flex-shrink-0" />
          <div className="text-xs text-text-secondary">
            <p className="font-medium text-status-down mb-1">Honeypot = deceptive banning</p>
            <p>
              Enabled paths return 404 to <strong>everyone</strong>. Any IP that requests one gets banned across
              <strong> ALL your Oblihub proxy hosts</strong>. Post-ban, that IP sees 404 on every URL of every host — indistinguishable from a site that doesn't exist. Also synced to Obliguard if configured.
            </p>
          </div>
        </div>
      </div>

      <ToggleCell active={!!editing.honeypotEnabled} onToggle={() => setEditing(h => h ? { ...h, honeypotEnabled: !h.honeypotEnabled } : null)}
        icon={Shield} label="Enable honeypot on this host" />

      {(() => {
        const hasHostAcl = (editing.accessListIds?.length ?? 0) > 0 || !!editing.accessListId;
        const hasRouteAcl = (editing.routes || []).some(r => r.accessListMode === 'override' && r.accessListOverrideIds.length > 0);
        const canArm = hasHostAcl || hasRouteAcl;
        return (
          <>
            <ToggleCell active={!!editing.honeypotBanAclViolations} disabled={!canArm}
              onToggle={() => setEditing(h => h ? { ...h, honeypotBanAclViolations: !h.honeypotBanAclViolations } : null)}
              icon={Shield} label="Also ban IPs that fail an access list (host or route)" />
            <p className="-mt-3 text-[10px] text-text-muted">
              Any 403 from an <code>allow/deny</code> ACL — set at the host (Auth tab) OR on a sub-route (Routes tab, override mode) — becomes an auto-ban, globally. Perfect for a gated <code>/admin</code>: whitelisted IPs pass, everyone else gets trapped. Requires at least one ACL to be armed.
            </p>
          </>
        );
      })()}

      <div>
        <div className="text-sm font-medium text-text-primary mb-1 flex items-center gap-2">
          Honeypot endpoints
        </div>
        <p className="text-[11px] text-text-muted mb-2">
          One-click preset covers the top ~30 scanner targets (WordPress, PHP admin, CI leakage, cloud metadata, framework endpoints). You can also add custom paths — prefix matching, so <code>/admin</code> also catches <code>/admin/login</code>.
        </p>

        <div className="flex flex-wrap gap-2 mb-3">
          <button
            onClick={addPreset}
            disabled={!editing.honeypotEnabled}
            className="flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-40"
          >
            <Plus size={12} /> Add common exploit URLs ({presetPreview.length})
          </button>
          {editId && (
            <button
              onClick={savePaths}
              disabled={saving || !editing.honeypotEnabled}
              className="text-xs px-2.5 py-1 rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-40"
            >
              {saving ? 'Saving...' : 'Save paths'}
            </button>
          )}
          {!editId && <span className="text-[10px] text-text-muted self-center">Save this host first to manage paths</span>}
        </div>

        <div className="flex gap-2 mb-2">
          <input
            value={newPath}
            onChange={e => setNewPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addPath())}
            placeholder="/some-honeypot-path"
            disabled={!editing.honeypotEnabled}
            className="flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-40"
          />
          <button onClick={addPath} disabled={!editing.honeypotEnabled}
            className="px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover disabled:opacity-40">
            Add
          </button>
        </div>

        {loading ? (
          <div className="text-xs text-text-muted italic">Loading...</div>
        ) : paths.length === 0 ? (
          <div className="text-xs text-text-muted italic rounded-lg border border-border bg-bg-tertiary px-3 py-4 text-center">
            No honeypot paths yet — click "Add common exploit URLs" or add your own above.
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-bg-tertiary max-h-72 overflow-auto">
            {paths.map((p, i) => {
              // A sub-route on the same path (Routes tab) overrides the bait — nginx would
              // otherwise fail with "duplicate location". Show the operator this is happening
              // so they don't wonder why their bait isn't firing on that path.
              // Trailing slash normalization matches the server (`/admin` and `/admin/` are
              // considered the same override target, so a `/admin/` route also skips the
              // `/admin` bait — avoids the "I typed a slash and got banned" trap).
              const stripSlash = (s: string) => s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
              const overriddenByRoute = (editing.routes || []).some(r => stripSlash(r.pathIn) === stripSlash(p.path));
              return (
                <div key={p.path} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-border/40 last:border-b-0">
                  <input type="checkbox" checked={p.enabled} onChange={() => togglePath(i)} disabled={overriddenByRoute} className="cursor-pointer disabled:opacity-40" />
                  <span className={`font-mono flex-1 ${overriddenByRoute ? 'text-text-muted line-through' : p.enabled ? 'text-text-primary' : 'text-text-muted line-through'}`}>{p.path}</span>
                  {overriddenByRoute && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent" title="A sub-route claims this path — the bait is skipped. Use the route's ACL + Ban on ACL violation to still trap non-whitelisted access.">
                      overridden by route
                    </span>
                  )}
                  <button onClick={() => removePath(i)} className="text-text-muted hover:text-status-down p-1">
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {(editing.routes || []).some(r => paths.some(p => {
          const norm = (s: string) => s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
          return norm(p.path) === norm(r.pathIn);
        })) && (
          <p className="text-[10px] text-accent mt-2 leading-relaxed">
            Path shared with a sub-route (e.g. <code>/admin</code> on Vaultwarden): the bait is skipped so nginx can start.
            To still trap non-whitelisted access on that path, put an <strong>access list</strong> on the sub-route (Routes tab → Access lists → Override) and keep <strong>&quot;Also ban IPs that fail an access list&quot;</strong> above ON. Whitelisted IPs pass through, everyone else 403s → banned globally, same as a bait hit.
          </p>
        )}
      </div>

      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">Ban duration</label>
        <select
          value={editing.honeypotBanDurationSeconds ?? 'permanent'}
          onChange={e => {
            const v = e.target.value;
            setEditing(h => h ? { ...h, honeypotBanDurationSeconds: v === 'permanent' ? null : parseInt(v, 10) } : null);
          }}
          disabled={!editing.honeypotEnabled}
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-40"
        >
          <option value="permanent">Permanent (default)</option>
          <option value={String(60 * 60)}>1 hour</option>
          <option value={String(24 * 60 * 60)}>24 hours</option>
          <option value={String(7 * 24 * 60 * 60)}>7 days</option>
          <option value={String(30 * 24 * 60 * 60)}>30 days</option>
        </select>
        <p className="text-[10px] text-text-muted mt-1">
          How long a caught scanner stays banned. Falls back to the app-wide default when blank — which is <strong>permanent</strong> unless you change it in Settings.
        </p>
      </div>
    </>
  );
}

// ── Reusable toggle cell ──
function ToggleCell({ active, onToggle, icon: Icon, label, disabled }: { active: boolean; onToggle: () => void; icon: typeof Shield; label: string; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={() => { if (!disabled) onToggle(); }}
      className={`flex items-center gap-2 p-2 rounded-lg border transition-colors ${
        disabled ? 'border-border opacity-30 cursor-not-allowed' : active ? 'border-accent/50 bg-accent/10' : 'border-border hover:bg-bg-hover'
      }`}
    >
      <div className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors shrink-0 ${active && !disabled ? 'bg-accent' : 'bg-bg-tertiary'}`}>
        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${active && !disabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </div>
      <Icon size={12} className={active && !disabled ? 'text-accent' : 'text-text-muted'} />
      <span className={`text-xs ${active && !disabled ? 'text-text-primary' : 'text-text-secondary'}`}>{label}</span>
    </button>
  );
}
