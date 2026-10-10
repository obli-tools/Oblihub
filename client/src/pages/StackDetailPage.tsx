import { useEffect, useState, useRef } from 'react';
import { StackMaintenanceControl } from '@/components/StackMaintenanceControl';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Play, Settings2, RotateCcw, Square, Terminal, ScrollText, FileEdit, Info, Trash2, ExternalLink, Globe, Plus, Power, PowerOff, Shield, Moon, Sun, XCircle } from 'lucide-react';
import { stacksApi, containersApi, systemApi } from '@/api/stacks.api';
import { managedStacksApi } from '@/api/managed-stacks.api';
import { proxyApi } from '@/api/proxy.api';
import { useSocket } from '@/hooks/useSocket';
import { useEngineSummaries } from '@/hooks/useEngineSummaries';
import { Sparkline } from '@/components/Sparkline';
import { SOCKET_EVENTS, suggestProxyPort } from '@oblihub/shared';
import type { ContainerStats as ContainerStatsType } from '@oblihub/shared';
import { ContainerLogs } from '@/components/ContainerLogs';
import { ContainerConsole } from '@/components/ContainerConsole';
import { NotificationBindingsPanel } from '@/components/NotificationBindingsPanel';
import { StackResourcesTab } from '@/components/StackResourcesTab';
import { PortChips } from '@/components/PortChips';
import type { Stack, Container, UpdateHistoryEntry, ManagedStack, ProxyHost, ContainerInspectResult, ContainerPort, ResolvedUpstream, UpstreamVia } from '@oblihub/shared';
import toast from 'react-hot-toast';
import { apiErrorMessage } from '@/utils/apiError';

type PanelType = 'logs' | 'console' | 'inspect' | 'sleep';

const VIA_LABELS: Record<UpstreamVia, string> = {
  'local-docker-dns': 'Docker DNS',
  'local-host-network': 'Host network',
  'tailscale-subnet-route': 'Tailscale subnet route',
  'tailscale-hostname-published-port': 'Tailscale + published port',
  'engine-public-host': 'Engine host',
};

/** '80/tcp' → an internal ContainerPort, so image EXPOSE entries render with the same chips. */
function exposedToPorts(exposed: string[] | undefined): ContainerPort[] {
  const out: ContainerPort[] = [];
  for (const key of exposed ?? []) {
    const [portText, proto] = key.split('/');
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    out.push({ hostPort: null, containerPort: port, protocol: (proto || 'tcp').toLowerCase() });
  }
  return out;
}

function formatBindingIp(ip: string | undefined): string {
  const v = ip || '0.0.0.0';
  return v.includes(':') && !v.startsWith('[') ? `[${v}]` : v;
}

interface UpstreamPreviewState {
  loading: boolean;
  data: ResolvedUpstream | null;
  error: string | null;
  /** The resolver refused (400/409): quick setup would be refused the same way. */
  blocking: boolean;
}

const EMPTY_PREVIEW: UpstreamPreviewState = { loading: false, data: null, error: null, blocking: false };

export function StackDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const socket = useSocket();
  const [stack, setStack] = useState<Stack | null>(null);
  const [history, setHistory] = useState<UpdateHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [allowConsole, setAllowConsole] = useState(false);
  const [allowStack, setAllowStack] = useState(false);
  const [selfProject, setSelfProject] = useState<string | null>(null);
  const [managedStack, setManagedStack] = useState<ManagedStack | null>(null);
  // True once the managed-stack lookup below has settled successfully. Until then a null
  // managedStack only means "not known yet", and offering "Manage Stack" would POST a duplicate
  // that the server refuses with 409.
  const [managedLookupDone, setManagedLookupDone] = useState(false);
  const [allowNginx, setAllowNginx] = useState(false);
  const [openPanels, setOpenPanels] = useState<Record<number, PanelType | null>>({});
  const [inspectData, setInspectData] = useState<Record<number, ContainerInspectResult | null>>({});
  const [inspectErrors, setInspectErrors] = useState<Record<number, string | null>>({});
  const [proxyHosts, setProxyHosts] = useState<ProxyHost[]>([]);
  const [showQuickSetup, setShowQuickSetup] = useState(false);
  const [quickSetup, setQuickSetup] = useState({ containerId: 0, domainInput: '', domains: [] as string[], forwardPort: 80, requestCert: false, acmeEmail: localStorage.getItem('oblihub_acme_email') || '' });
  const [upstreamPreview, setUpstreamPreview] = useState<UpstreamPreviewState>(EMPTY_PREVIEW);
  const [containerStats, setContainerStats] = useState<Record<string, { cpu: number[]; mem: number[]; cpuNow: number; memNow: number }>>({});
  const { engines, byId: enginesById, loading: enginesLoading, error: enginesError } = useEngineSummaries();

  const load = async () => {
    if (!id) return;
    try {
      const [s, h] = await Promise.all([
        stacksApi.getById(Number(id)),
        stacksApi.getHistory(Number(id)),
      ]);
      setStack(s);
      setHistory(h);
    } catch { toast.error('Failed to load stack'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [id]);

  // Real-time updates: re-fetch via API on discovery (respects permissions)
  useEffect(() => {
    const onDiscovery = () => { load(); };
    socket.on(SOCKET_EVENTS.DISCOVERY_COMPLETE, onDiscovery);
    return () => { socket.off(SOCKET_EVENTS.DISCOVERY_COMPLETE, onDiscovery); };
  }, [socket, id]);

  // Pre-populate sparklines from server-side history on load, then poll for live updates.
  useEffect(() => {
    if (!stack?.containers?.length) return;
    const stackDockerIds = new Set(stack.containers.map(c => c.dockerId));

    const loadHistory = async () => {
      try {
        const { statsApi } = await import('@/api/stats.api');
        const history = await statsApi.getBulkRecent(15);
        const byDockerId = new Map<string, { cpu: number[]; mem: number[] }>();
        const sorted = [...history].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        for (const r of sorted) {
          if (!stackDockerIds.has(r.dockerId)) continue;
          const b = byDockerId.get(r.dockerId) || { cpu: [], mem: [] };
          b.cpu.push(r.cpuPercent);
          b.mem.push(r.memoryPercent);
          byDockerId.set(r.dockerId, b);
        }
        setContainerStats(prev => {
          const next = { ...prev };
          for (const [dockerId, b] of byDockerId) {
            const lastCpu = b.cpu[b.cpu.length - 1] || 0;
            const lastMem = b.mem[b.mem.length - 1] || 0;
            next[dockerId] = {
              cpu: b.cpu.slice(-30),
              mem: b.mem.slice(-30),
              cpuNow: lastCpu,
              memNow: lastMem,
            };
          }
          return next;
        });
      } catch { /* ignore */ }
    };

    const fetchLatest = async () => {
      try {
        const { statsApi } = await import('@/api/stats.api');
        const data = await statsApi.getLatest();
        setContainerStats(prev => {
          const next = { ...prev };
          for (const s of data) {
            if (!stackDockerIds.has(s.dockerId)) continue;
            const existing = next[s.dockerId] || { cpu: [], mem: [], cpuNow: 0, memNow: 0 };
            next[s.dockerId] = {
              cpu: [...existing.cpu, s.cpuPercent].slice(-30),
              mem: [...existing.mem, s.memoryPercent].slice(-30),
              cpuNow: s.cpuPercent,
              memNow: s.memoryPercent,
            };
          }
          return next;
        });
      } catch { /* ignore */ }
    };

    loadHistory();
    fetchLatest();
    const interval = setInterval(fetchLatest, 10000);
    return () => clearInterval(interval);
  }, [stack?.containers]);

  useEffect(() => {
    systemApi.getFeatures().then(f => {
      setAllowConsole(f.allowConsole);
      setAllowStack(f.allowStack);
      setAllowNginx(f.allowNginx);
      setSelfProject(f.selfProject);
    }).catch(() => {
      // Fallback: try the full system info
      systemApi.getInfo().then(info => {
        setAllowConsole(info.allowConsole);
        setAllowStack(info.allowStack);
      }).catch(() => {});
    });
  }, []);

  // Load proxy hosts linked to this stack + auto-refresh while certs pending
  useEffect(() => {
    if (!stack || !allowNginx) return;
    const refresh = () => proxyApi.getHostsByStack(stack.id).then(setProxyHosts).catch(() => {});
    refresh();
    const hasPending = proxyHosts.some(h => h.certificate && h.certificate.status === 'pending');
    if (hasPending) {
      const interval = setInterval(refresh, 5000);
      return () => clearInterval(interval);
    }
  }, [stack?.id, allowNginx, proxyHosts.some(h => h.certificate?.status === 'pending')]);

  // Try to find linked managed stack. Several engines can run a project with the same name, and
  // deleting through the link runs `compose down` on the MANAGED stack's engine, so link only a
  // managed stack on this stack's own daemon. A null managed engine means the local daemon, and
  // every local-type engine is that same daemon. An orphan stack (engine deleted) links nothing.
  // Without usable summaries (older server, fetch failure, no local engine listed) the daemon of an
  // engine id is unknown. Every id then counts as local, which is the old match on project name.
  // Otherwise a legacy NULL-engine managed stack would lose its link and "Manage Stack" would offer
  // to create a duplicate. The server still refuses a delete aimed at another engine's stack.
  const stackEngineId = stack?.engineId ?? null;
  const summariesUsable = !enginesError && engines.some(e => e.isLocal);
  useEffect(() => {
    // Every re-run starts a new lookup, so the previous answer no longer counts as settled.
    setManagedLookupDone(false);
    if (!stack?.composeProject || !allowStack || enginesLoading) return;
    const project = stack.composeProject;
    if (stackEngineId == null) { setManagedStack(null); setManagedLookupDone(true); return; }
    const isLocal = (engineId: number | null) => engineId == null || !summariesUsable || !!enginesById.get(engineId)?.isLocal;
    let alive = true;
    managedStacksApi.list().then(managed => {
      if (!alive) return;
      const sameProject = managed.filter(m => m.composeProject === project);
      // Exact engine first (as the server resolves it), so a same-daemon or fallback match never
      // wins over this stack's own managed stack.
      const match = sameProject.find(m => (m.engineId ?? null) === stackEngineId)
        ?? sameProject.find(m => isLocal(m.engineId ?? null) && isLocal(stackEngineId));
      setManagedStack(match || null);
      setManagedLookupDone(true);
      // A failed lookup leaves the flag false: whether this stack is already managed stays
      // unknown, so "Manage Stack" stays hidden rather than risk a duplicate create.
    }).catch(() => {});
    return () => { alive = false; };
  }, [stack?.composeProject, stackEngineId, allowStack, enginesById, enginesLoading, summariesUsable]);

  // Quick-setup preview: ask the same resolver the server will use on Create, so the operator
  // sees the real upstream (and why it may be unreachable) before saving anything.
  useEffect(() => {
    const cid = quickSetup.containerId;
    const port = quickSetup.forwardPort;
    if (!showQuickSetup || !cid) { setUpstreamPreview(EMPTY_PREVIEW); return; }
    let cancelled = false;
    setUpstreamPreview({ ...EMPTY_PREVIEW, loading: true });
    const timer = setTimeout(async () => {
      try {
        const data = await containersApi.resolveUpstream(cid, port);
        if (!cancelled) setUpstreamPreview({ loading: false, data, error: null, blocking: false });
      } catch (err) {
        if (cancelled) return;
        // resolveUpstream rethrows 4xx answers as a plain Error carrying the server's text; an
        // axios error means a 5xx or a network failure.
        const isAxios = !!(err as { isAxiosError?: boolean })?.isAxiosError;
        const status = (err as { status?: number })?.status
          ?? (err as { response?: { status?: number } })?.response?.status;
        setUpstreamPreview({
          loading: false,
          data: null,
          error: isAxios ? apiErrorMessage(err, 'Could not preview the upstream') : (err as Error).message,
          // Only a resolver refusal predicts that Create fails. A 404/403 can come from a server
          // older than this client (no preview route) whose quick setup still works.
          blocking: status === 400 || status === 409,
        });
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [showQuickSetup, quickSetup.containerId, quickSetup.forwardPort]);

  // A remote target is only reachable through a published port: its suggestion prefers one.
  const preferPublishedFor = (c: { engineId?: number | null }) =>
    ({ preferPublished: c.engineId != null && enginesById.get(c.engineId)?.isLocal === false });

  const openQuickSetup = () => {
    if (!stack) return;
    const prefillDomains: string[] = [];
    if (stack.url) {
      try { prefillDomains.push(new URL(stack.url).hostname); } catch { /* ignore */ }
    }
    // Start on the container most likely to be the web front end, with its likely HTTP port.
    const withSuggestion = stack.containers.find(c => suggestProxyPort(c.ports || [], preferPublishedFor(c)) != null);
    const initial = withSuggestion ?? stack.containers[0];
    const suggestion = initial ? suggestProxyPort(initial.ports || [], preferPublishedFor(initial)) : null;
    setShowQuickSetup(true);
    setQuickSetup(q => ({ ...q, containerId: initial?.id || 0, forwardPort: suggestion ?? 80, domains: prefillDomains, domainInput: '' }));
  };

  const togglePanel = (containerId: number, type: PanelType) => {
    if (type === 'inspect' && openPanels[containerId] !== 'inspect') {
      // Load inspect data if not loaded
      if (!inspectData[containerId]) {
        setInspectErrors(prev => ({ ...prev, [containerId]: null }));
        containersApi.inspect(containerId).then(data => {
          setInspectData(prev => ({ ...prev, [containerId]: data }));
        }).catch(err => {
          // Shown inside the panel: a 409 explains the container's engine was deleted, which a
          // generic toast would hide behind "Loading...".
          const msg = apiErrorMessage(err, 'Failed to inspect container');
          setInspectErrors(prev => ({ ...prev, [containerId]: msg }));
          toast.error(msg);
        });
      }
    }
    setOpenPanels(prev => ({
      ...prev,
      [containerId]: prev[containerId] === type ? null : type,
    }));
  };

  const handleRestart = async (c: Container) => {
    try {
      await containersApi.restart(c.id);
      toast.success(`Restarting ${c.containerName}`);
      setTimeout(load, 3000);
    } catch { toast.error(`Failed to restart ${c.containerName}`); }
  };

  const handleStop = async (c: Container) => {
    try {
      await containersApi.stop(c.id);
      toast.success(`Stopping ${c.containerName}`);
      setTimeout(load, 3000);
    } catch { toast.error(`Failed to stop ${c.containerName}`); }
  };

  const handleStart = async (c: Container) => {
    try {
      await containersApi.start(c.id);
      toast.success(`Starting ${c.containerName}`);
      setTimeout(load, 3000);
    } catch { toast.error(`Failed to start ${c.containerName}`); }
  };

  const handleRemoveContainer = async (c: Container) => {
    const withVolumes = confirm(`Remove container "${c.containerName}"?\n\nClick OK to remove.\nNote: volumes will be kept. To also remove volumes, use the stack delete option.`);
    if (!withVolumes && !confirm('Are you sure?')) return;
    try {
      await containersApi.remove(c.id);
      toast.success(`${c.containerName} removed`);
      load();
    } catch { toast.error(`Failed to remove ${c.containerName}`); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;
  if (!stack) return <div className="p-6 text-text-muted">Stack not found</div>;

  // "Manage Stack" creates the managed stack on this stack's own engine: a NULL engine would
  // deploy on the hub's socket instead. Orphans have no engine to target, and compose cannot
  // drive an https-apikey engine. Wait for the managed-stack lookup above to succeed (it runs
  // after the engines load) so the button does not show on an already-managed stack while that
  // lookup is pending, or for good when it failed.
  const stackEngine = stack.engineId != null ? enginesById.get(stack.engineId) : undefined;
  const canManage = allowStack && !managedStack && !!stack.composeProject && stack.engineId != null
    && !enginesLoading && managedLookupDone && stackEngine?.type !== 'https-apikey';

  return (
    <div className="p-6 max-w-5xl">
      <button onClick={() => navigate('/')} className="flex items-center gap-1 text-sm text-text-muted hover:text-text-primary mb-4">
        <ArrowLeft size={14} /> Back
      </button>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">{stack.name}</h1>
          {stack.composeProject && <p className="text-xs text-text-muted mt-1">Compose project: {stack.composeProject}</p>}
        </div>
        <div className="flex gap-2">
          {allowStack && managedStack && (
            <button onClick={() => navigate(`/stack-editor/${managedStack.id}`)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-accent/50 text-accent hover:bg-accent/10">
              <FileEdit size={14} /> Edit Compose
            </button>
          )}
          {canManage && (
            <button
              onClick={async () => {
                try {
                  const created = await managedStacksApi.create({
                    // The managed project is derived from the name: use the discovered project so a
                    // renamed stack still manages the containers it shows.
                    name: stack.composeProject!,
                    composeContent: `# Stack: ${stack.name}\n# Paste your docker-compose.yml content here\n\nservices:\n  # app:\n  #   image: your-image:latest\n  #   ports:\n  #     - "8080:80"\n`,
                    engineId: stack.engineId,
                  });
                  toast.success('Paste your docker-compose.yml content in the editor');
                  navigate(`/stack-editor/${created.id}`);
                } catch (err) { toast.error(apiErrorMessage(err, 'Failed to create managed stack')); }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover"
            >
              <FileEdit size={14} /> Manage Stack
            </button>
          )}
          <button onClick={() => stacksApi.check(stack.id).then(load)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} /> Check Now
          </button>
          <button onClick={() => stacksApi.triggerUpdate(stack.id).then(load)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Play size={14} /> Update All
          </button>
          {!(selfProject && stack.composeProject === selfProject) && (
            <button
              onClick={async () => {
                // "remove" is not offered for a managed stack: it would delete this discovery row
                // while the managed stack lives on, and that row holds the stack's resource limits,
                // team access and proxy links. Rediscovery brings back a bare row, so the next
                // deploy runs unlimited and the team gets 403. Deleting the managed stack instead runs
                // `compose down`, which "remove" promises not to do. The link above matches by
                // project name and may still be loading, so the server's 409 remains the authority.
                const choice = prompt(
                  `Delete stack "${stack.name}"?\n\n` +
                  `Type:\n` +
                  (managedStack
                    ? `  "remove" - Not available for a managed stack (its limits and team access live on this stack); delete it from Managed Stacks instead\n`
                    : `  "remove" - Remove from Oblihub only (containers keep running)\n`) +
                  `  "delete" - Stop & remove all containers\n` +
                  `  "purge"  - Stop & remove containers + volumes\n\n` +
                  `Type your choice:`
                );
                if (!choice) return;
                const c = choice.trim().toLowerCase();
                if (!['remove', 'delete', 'purge'].includes(c)) { toast.error('Invalid choice'); return; }
                if (c === 'remove' && managedStack) {
                  toast.error('This stack is managed by Oblihub: delete it from Managed Stacks, or choose "delete" or "purge"');
                  return;
                }
                try {
                  let keptVolumeData: string[] = [];
                  let managedDeleted = false;
                  // Only "delete" and "purge" get here with a managed stack (see above).
                  if (managedStack) {
                    // "purge" also wipes the managed stack's volumes (incl. .volumes folders).
                    // forEngine lets the server refuse if the link above ever points at another
                    // daemon, before anything is taken down.
                    ({ keptVolumeData } = await managedStacksApi.delete(managedStack.id, c === 'purge', stack.engineId));
                    managedDeleted = true;
                  }
                  try {
                    await stacksApi.delete(stack.id, {
                      containers: c === 'delete' || c === 'purge',
                      volumes: c === 'purge',
                    });
                  } catch (err) {
                    // The managed delete already drops this project's discovery rows on its daemon,
                    // so this row may be gone: that is the outcome asked for, not a failure.
                    const status = (err as { response?: { status?: number } })?.response?.status;
                    if (!(managedDeleted && status === 404)) throw err;
                  }
                  if (c === 'purge' && keptVolumeData.length > 0) {
                    toast.success(`Stack & containers purged — volume data kept on the server in: ${keptVolumeData.join(', ')}`);
                  } else {
                    toast.success(c === 'remove' ? 'Stack removed from Oblihub' : c === 'delete' ? 'Stack & containers deleted' : 'Stack, containers & volumes purged');
                  }
                  navigate('/');
                } catch (err) { toast.error(apiErrorMessage(err, 'Failed to delete stack')); }
              }}
              className="p-1.5 rounded-lg text-text-muted hover:text-status-down hover:bg-bg-hover"
              title="Delete stack"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Live update progress — only renders while at least one container is updating */}
      <UpdateProgressPanel stackId={stack.id} containerNames={Object.fromEntries(stack.containers.map(c => [c.id, c.containerName]))} />

      {/* Containers */}
      <div className="rounded-xl border border-border bg-bg-secondary mb-6">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text-secondary">Containers</h2>
        </div>
        <div className="divide-y divide-border">
          {stack.containers.map((c) => (
            <div key={c.id}>
              <div className="px-4 py-3 flex items-center gap-4">
                <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                  c.status === 'up_to_date' ? 'bg-status-up' :
                  c.status === 'update_available' ? 'bg-status-pending' :
                  (c.status as string) === 'stopped' ? 'bg-status-down/50' :
                  c.status === 'error' ? 'bg-status-down' :
                  c.status === 'updating' ? 'bg-accent animate-pulse' : 'bg-text-muted'
                }`} />
                {c.status === 'stopped' && <span className="text-[10px] text-status-down/70 font-medium">Stopped</span>}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-primary">{c.containerName}</div>
                  <div className="text-xs text-text-muted">{c.image}:{c.imageTag}</div>
                  <PortChips ports={c.ports || []} showInternal size="xs" max={10} className="mt-1"
                    emptyLabel={c.networkMode === 'host' ? 'host network' : null} />
                </div>
                <div className="text-right shrink-0">
                  {c.currentDigest && (
                    <div className="text-[10px] font-mono text-text-muted" title={c.currentDigest}>
                      {c.currentDigest.slice(7, 19)}
                    </div>
                  )}
                  {c.latestDigest && c.latestDigest !== c.currentDigest && (
                    <div className="text-[10px] font-mono text-status-pending" title={c.latestDigest}>
                      &rarr; {c.latestDigest.slice(7, 19)}
                    </div>
                  )}
                </div>
                {/* Stats sparklines */}
                {containerStats[c.dockerId] && (
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-center">
                      <Sparkline data={containerStats[c.dockerId].cpu} width={60} height={20} color="#4a9eff" />
                      <div className="text-[9px] text-text-muted">{containerStats[c.dockerId].cpuNow.toFixed(1)}% CPU</div>
                    </div>
                    <div className="text-center">
                      <Sparkline data={containerStats[c.dockerId].mem} width={60} height={20} color="#3fb950" />
                      <div className="text-[9px] text-text-muted">{containerStats[c.dockerId].memNow.toFixed(1)}% RAM</div>
                    </div>
                  </div>
                )}
                {c.excluded && <span className="text-[10px] text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded">Excluded</span>}

                {/* Action buttons */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => togglePanel(c.id, 'logs')}
                    className={`p-1.5 rounded-md transition-colors ${openPanels[c.id] === 'logs' ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`}
                    title="Logs"
                  >
                    <ScrollText size={14} />
                  </button>
                  <button
                    onClick={() => togglePanel(c.id, 'inspect')}
                    className={`p-1.5 rounded-md transition-colors ${openPanels[c.id] === 'inspect' ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`}
                    title="Inspect"
                  >
                    <Info size={14} />
                  </button>
                  <button
                    onClick={() => togglePanel(c.id, 'sleep')}
                    className={`p-1.5 rounded-md transition-colors ${
                      openPanels[c.id] === 'sleep' ? 'bg-accent/20 text-accent'
                      : c.sleepState === 'sleeping' ? 'text-status-pending hover:bg-bg-hover'
                      : c.sleepState === 'waking' ? 'text-accent animate-pulse'
                      : c.sleepEnabled ? 'text-accent/70 hover:bg-bg-hover'
                      : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
                    }`}
                    title={
                      c.sleepState === 'sleeping' ? 'Sleeping — click to configure'
                      : c.sleepState === 'waking' ? 'Waking…'
                      : c.sleepEnabled ? `Sleep mode (idle after ${c.sleepAfterSeconds}s)`
                      : 'Configure sleep mode'
                    }
                  >
                    <Moon size={14} />
                  </button>
                  {allowConsole && (
                    <button
                      onClick={() => togglePanel(c.id, 'console')}
                      className={`p-1.5 rounded-md transition-colors ${openPanels[c.id] === 'console' ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`}
                      title="Console"
                    >
                      <Terminal size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => handleRestart(c)}
                    className="p-1.5 rounded-md text-text-muted hover:text-status-pending hover:bg-bg-hover transition-colors"
                    title="Restart"
                  >
                    <RotateCcw size={14} />
                  </button>
                  <button
                    onClick={() => handleStop(c)}
                    className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-bg-hover transition-colors"
                    title="Stop"
                  >
                    <Square size={14} />
                  </button>
                  <button
                    onClick={() => handleStart(c)}
                    className="p-1.5 rounded-md text-text-muted hover:text-status-up hover:bg-bg-hover transition-colors"
                    title="Start"
                  >
                    <Play size={14} />
                  </button>
                  <button
                    onClick={() => handleRemoveContainer(c)}
                    className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-bg-hover transition-colors"
                    title="Remove container"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* Expandable panels */}
              {openPanels[c.id] === 'logs' && (
                <div className="px-4 pb-3">
                  <ContainerLogs dockerId={c.dockerId} onClose={() => togglePanel(c.id, 'logs')} />
                </div>
              )}
              {openPanels[c.id] === 'console' && (
                <div className="px-4 pb-3">
                  <ContainerConsole dockerId={c.dockerId} onClose={() => togglePanel(c.id, 'console')} />
                </div>
              )}
              {openPanels[c.id] === 'sleep' && (
                <div className="px-4 pb-3">
                  <SleepPanel
                    container={c}
                    onChange={(updated) => {
                      setStack(s => s ? { ...s, containers: s.containers.map(x => x.id === updated.id ? updated : x) } : null);
                    }}
                    onClose={() => togglePanel(c.id, 'sleep')}
                  />
                </div>
              )}
              {openPanels[c.id] === 'inspect' && (
                <div className="px-4 pb-3">
                  <div className="rounded-lg border border-border bg-bg-tertiary overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-1.5 bg-bg-secondary border-b border-border">
                      <span className="text-xs font-medium text-text-secondary">Inspect</span>
                      <button onClick={() => togglePanel(c.id, 'inspect')} className="p-1 rounded hover:bg-bg-hover text-text-muted text-xs">&times;</button>
                    </div>
                    {inspectData[c.id] ? (
                      <div className="p-3 space-y-4 text-xs max-h-80 overflow-auto">
                        {(() => {
                          const info = inspectData[c.id]!;
                          // publishedPorts is what Docker actually bound (ephemeral ports included);
                          // an older server only sends the configured bindings.
                          const source = info.publishedPorts ?? info.ports ?? {};
                          const published = Object.entries(source).flatMap(([port, bindings]) =>
                            (bindings || []).filter(b => b && b.HostPort).map(b => ({ key: `${b.HostIp}|${b.HostPort}|${port}`, host: `${formatBindingIp(b.HostIp)}:${b.HostPort}`, port })));
                          const exposed = exposedToPorts(info.exposedPorts);
                          return (
                            <>
                              {info.networkMode && (
                                <div className="flex gap-2">
                                  <span className="font-semibold text-text-secondary">Network mode</span>
                                  <span className="font-mono text-text-primary">{info.networkMode}</span>
                                </div>
                              )}
                              {published.length > 0 && (
                                <div>
                                  <div className="font-semibold text-text-secondary mb-1.5">Published</div>
                                  <div className="space-y-0.5">
                                    {published.map(p => (
                                      <div key={p.key} className="flex gap-2 font-mono text-text-primary">
                                        <span className="text-text-muted">{p.host}</span>
                                        <span className="text-text-muted">&rarr;</span>
                                        <span>{p.port}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {exposed.length > 0 && (
                                <div>
                                  <div className="font-semibold text-text-secondary mb-1.5">Exposed</div>
                                  <PortChips ports={exposed} showInternal size="xs" max={50} />
                                </div>
                              )}
                            </>
                          );
                        })()}
                        {/* Networks */}
                        {Object.keys(inspectData[c.id]!.networks).length > 0 && (
                          <div>
                            <div className="font-semibold text-text-secondary mb-1.5">Networks</div>
                            <div className="space-y-0.5">
                              {Object.entries(inspectData[c.id]!.networks).map(([name, net]) => (
                                <div key={name} className="flex gap-3 font-mono text-text-primary">
                                  <span className="text-accent">{name}</span>
                                  <span className="text-text-muted">IP: {net.IPAddress || '-'}</span>
                                  <span className="text-text-muted">GW: {net.Gateway || '-'}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Mounts */}
                        {inspectData[c.id]!.mounts.length > 0 && (
                          <div>
                            <div className="font-semibold text-text-secondary mb-1.5">Mounts</div>
                            <div className="space-y-0.5">
                              {inspectData[c.id]!.mounts.map((m, i) => (
                                <div key={i} className="font-mono text-text-primary">
                                  <span className="text-text-muted">{m.Source}</span>
                                  <span className="text-text-muted mx-1">&rarr;</span>
                                  <span>{m.Destination}</span>
                                  <span className="text-text-muted ml-2">({m.Type}{m.Mode ? `, ${m.Mode}` : ''})</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Env */}
                        <div>
                          <div className="font-semibold text-text-secondary mb-1.5">Environment</div>
                          <div className="space-y-0.5 max-h-40 overflow-auto">
                            {inspectData[c.id]!.env.map((e, i) => {
                              const idx = e.indexOf('=');
                              const key = idx >= 0 ? e.substring(0, idx) : e;
                              const val = idx >= 0 ? e.substring(idx + 1) : '';
                              return (
                                <div key={i} className="font-mono text-text-primary">
                                  <span className="text-accent">{key}</span>
                                  <span className="text-text-muted">=</span>
                                  <span>{val}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    ) : inspectErrors[c.id] ? (
                      <div className="p-4 text-center text-status-down text-xs">{inspectErrors[c.id]}</div>
                    ) : (
                      <div className="p-4 text-center text-text-muted text-xs">Loading...</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Proxy Hosts */}
      {allowNginx && (
        <div className="rounded-xl border border-border bg-bg-secondary mb-6">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-secondary flex items-center gap-1.5"><Globe size={14} /> Proxy Hosts</h2>
            <button onClick={openQuickSetup}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-accent text-white hover:bg-accent-hover">
              <Plus size={12} /> Add Proxy Host
            </button>
          </div>
          {proxyHosts.length > 0 ? (
            <div className="divide-y divide-border">
              {proxyHosts.map(ph => (
                <div key={ph.id} className="px-4 py-2.5 flex items-center gap-3">
                  <div className={`h-2 w-2 rounded-full shrink-0 ${ph.enabled ? (ph.certificate?.status === 'valid' ? 'bg-status-up' : 'bg-status-pending') : 'bg-text-muted'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary">{ph.domainNames.join(', ')}</div>
                    <div className="text-[10px] text-text-muted">{ph.forwardScheme}://{ph.forwardHost}:{ph.forwardPort}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    {ph.sslForced && <span className="text-[9px] px-1 py-0.5 rounded bg-status-up/10 text-status-up">SSL</span>}
                    {ph.websocketSupport && <span className="text-[9px] px-1 py-0.5 rounded bg-accent/10 text-accent">WS</span>}
                    {ph.certificate && <span className={`text-[9px] px-1 py-0.5 rounded ${ph.certificate.status === 'valid' ? 'bg-status-up/10 text-status-up' : 'bg-status-pending/10 text-status-pending'}`}><Shield size={8} className="inline mr-0.5" />{ph.certificate.status}</span>}
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={async () => { await proxyApi.toggleHost(ph.id); proxyApi.getHostsByStack(stack.id).then(setProxyHosts); }}
                      className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover" title={ph.enabled ? 'Disable' : 'Enable'}>
                      {ph.enabled ? <Power size={12} /> : <PowerOff size={12} />}
                    </button>
                    <button onClick={async () => { if (confirm('Delete this proxy host?')) { await proxyApi.deleteHost(ph.id); toast.success('Deleted'); proxyApi.getHostsByStack(stack.id).then(setProxyHosts); } }}
                      className="p-1 rounded text-text-muted hover:text-status-down hover:bg-bg-hover">
                      <Trash2 size={12} />
                    </button>
                    <a href={`https://${ph.domainNames[0]}`} target="_blank" rel="noopener noreferrer" className="p-1 rounded text-text-muted hover:text-accent hover:bg-bg-hover">
                      <ExternalLink size={12} />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-6 text-center text-xs text-text-muted">No proxy hosts linked to this stack</div>
          )}
        </div>
      )}

      {/* Quick Setup Modal */}
      {showQuickSetup && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/50" onClick={() => setShowQuickSetup(false)}>
          <div className="rounded-xl border border-border bg-bg-primary w-full max-w-lg shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-text-primary">Quick Proxy Setup</h2>
              <p className="text-xs text-text-muted mt-0.5">Link a domain to a container in this stack</p>
            </div>
            <div className="p-6 space-y-4">
              {/* Container picker */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Container</label>
                <select value={quickSetup.containerId} onChange={e => {
                  const cid = parseInt(e.target.value);
                  const selected = stack.containers.find(c => c.id === cid);
                  const suggestion = selected ? suggestProxyPort(selected.ports || [], preferPublishedFor(selected)) : null;
                  setQuickSetup(q => ({ ...q, containerId: cid, forwardPort: suggestion ?? q.forwardPort }));
                }}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                  {stack.containers.map(c => (
                    <option key={c.id} value={c.id}>{c.containerName} ({c.image}:{c.imageTag})</option>
                  ))}
                </select>
                <div className="mt-2">
                  <PortChips
                    ports={stack.containers.find(c => c.id === quickSetup.containerId)?.ports || []}
                    showInternal
                    // Every chip is a pick target here: the internal-only port (the usual proxy
                    // target) must not end up behind the unclickable "+N" of the default 8.
                    max={Infinity}
                    size="sm"
                    onPick={chip => setQuickSetup(q => ({ ...q, forwardPort: chip.containerStart }))}
                    highlightContainerPort={quickSetup.forwardPort}
                    emptyLabel="No declared ports — enter the port manually"
                  />
                </div>
              </div>

              {/* Port */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Forward Port</label>
                <input type="number" value={quickSetup.forwardPort} onChange={e => setQuickSetup(q => ({ ...q, forwardPort: parseInt(e.target.value) || 80 }))}
                  placeholder="80" className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>

              {/* Domain names */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Domain Names</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {quickSetup.domains.map(d => (
                    <span key={d} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/10 text-accent text-xs font-mono">
                      {d} <button onClick={() => setQuickSetup(q => ({ ...q, domains: q.domains.filter(x => x !== d) }))} className="hover:text-status-down">&times;</button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input value={quickSetup.domainInput} onChange={e => setQuickSetup(q => ({ ...q, domainInput: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); const d = quickSetup.domainInput.trim().toLowerCase(); if (d && !quickSetup.domains.includes(d)) setQuickSetup(q => ({ ...q, domains: [...q.domains, d], domainInput: '' })); } }}
                    placeholder="app.example.com" className="flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                  <button onClick={() => { const d = quickSetup.domainInput.trim().toLowerCase(); if (d && !quickSetup.domains.includes(d)) setQuickSetup(q => ({ ...q, domains: [...q.domains, d], domainInput: '' })); }}
                    className="px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Add</button>
                </div>
              </div>

              {/* Let's Encrypt */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                  <input type="checkbox" checked={quickSetup.requestCert} onChange={e => setQuickSetup(q => ({ ...q, requestCert: e.target.checked }))} className="rounded" />
                  <Shield size={12} /> Request Let's Encrypt SSL certificate
                </label>
                {quickSetup.requestCert && (
                  <input value={quickSetup.acmeEmail} onChange={e => setQuickSetup(q => ({ ...q, acmeEmail: e.target.value }))}
                    placeholder="admin@example.com" type="email"
                    className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                )}
              </div>

              {/* Preview */}
              {quickSetup.containerId > 0 && (
                <div className="rounded-lg bg-bg-tertiary p-3 text-xs space-y-1.5">
                  <div className="text-text-muted">Preview:</div>
                  {upstreamPreview.loading ? (
                    <div className="text-text-muted">resolving…</div>
                  ) : upstreamPreview.error ? (
                    <div className={upstreamPreview.blocking ? 'text-status-down' : 'text-status-warning'}>{upstreamPreview.error}</div>
                  ) : upstreamPreview.data ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-text-primary break-all">
                          {quickSetup.domains[0] ? <>{quickSetup.domains[0]} &rarr; </> : null}
                          {upstreamPreview.data.scheme}://{upstreamPreview.data.host}:{upstreamPreview.data.port}
                        </span>
                        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-accent/10 text-accent border border-accent/30"
                          title={upstreamPreview.data.engineName ? `Engine: ${upstreamPreview.data.engineName}` : undefined}>
                          {VIA_LABELS[upstreamPreview.data.via] ?? upstreamPreview.data.via}
                        </span>
                      </div>
                      {upstreamPreview.data.needsProxyNetwork ? (
                        // Oblihub never attaches a non-managed container by itself: say so
                        // plainly, but keep Create enabled because the operator may attach it by hand.
                        <div className="rounded border border-status-warning/30 bg-status-warning/10 px-2 py-1.5 text-status-warning">
                          {upstreamPreview.data.hint}
                        </div>
                      ) : upstreamPreview.data.hint ? (
                        <div className="text-text-muted">{upstreamPreview.data.hint}</div>
                      ) : null}
                      {upstreamPreview.data.warnings.length > 0 && (
                        <ul className="space-y-0.5 text-status-warning">
                          {upstreamPreview.data.warnings.map((w, i) => <li key={i}>{w}</li>)}
                        </ul>
                      )}
                    </>
                  ) : null}
                  <div className="text-text-muted">WebSocket: on, Block Exploits: on{quickSetup.requestCert ? ', SSL: on, HTTP/2: on' : ''}</div>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button onClick={() => setShowQuickSetup(false)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
              <button
                onClick={async () => {
                  if (!quickSetup.domains.length) { toast.error('Enter at least one domain'); return; }
                  if (quickSetup.requestCert) localStorage.setItem('oblihub_acme_email', quickSetup.acmeEmail);
                  try {
                    const { upstream } = await proxyApi.quickSetup({
                      stackId: stack.id,
                      containerId: quickSetup.containerId,
                      domainNames: quickSetup.domains,
                      forwardPort: quickSetup.forwardPort,
                      requestCertificate: quickSetup.requestCert,
                      acmeEmail: quickSetup.acmeEmail || undefined,
                    });
                    if (upstream) {
                      // The server resolves again on Create; report what it actually stored.
                      const target = `${upstream.scheme}://${upstream.host}:${upstream.port}`;
                      const warning = upstream.warnings[0];
                      toast.success(
                        <div className="text-sm">
                          <div>Proxy host created &rarr; <span className="font-mono">{target}</span></div>
                          {warning && <div className="text-xs mt-1 opacity-80">{warning}</div>}
                        </div>,
                        { duration: warning ? 8000 : 4000 },
                      );
                    } else {
                      toast.success('Proxy host created!');
                    }
                    setShowQuickSetup(false);
                    proxyApi.getHostsByStack(stack.id).then(setProxyHosts);
                    // Auto-fill Stack URL if empty
                    if (!stack.url && quickSetup.domains.length > 0) {
                      const scheme = quickSetup.requestCert ? 'https' : 'http';
                      const autoUrl = `${scheme}://${quickSetup.domains[0]}`;
                      stacksApi.update(stack.id, { url: autoUrl }).then(updated => {
                        setStack(updated);
                        toast.success(`Stack URL set to ${autoUrl}`);
                      }).catch(() => {});
                    }
                  } catch (err) { toast.error(apiErrorMessage(err, 'Failed to create proxy host')); }
                }}
                // The server would refuse the same resolution, so do not offer a Create that must fail.
                disabled={upstreamPreview.blocking}
                title={upstreamPreview.blocking ? upstreamPreview.error ?? undefined : undefined}
                className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-accent"
              >
                Create Proxy Host
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Config */}
      <div className="rounded-xl border border-border bg-bg-secondary mb-6 p-4">
        <h2 className="text-sm font-semibold text-text-secondary mb-4 flex items-center gap-1.5"><Settings2 size={14} /> Configuration</h2>
        <div className="space-y-4">
          {/* Stack URL */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-text-primary">Stack URL</div>
              <div className="text-xs text-text-muted">Quick access link shown on dashboard</div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="url"
                defaultValue={stack.url || ''}
                onBlur={async (e) => {
                  const val = e.target.value.trim() || null;
                  if (val !== (stack.url || null)) {
                    const updated = await stacksApi.update(stack.id, { url: val });
                    setStack(updated);
                    toast.success(val ? 'URL saved' : 'URL removed');
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                placeholder="https://..."
                className="w-64 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              />
              {stack.url && (
                <a href={stack.url} target="_blank" rel="noopener noreferrer" className="p-1.5 rounded-md text-accent hover:bg-accent/10" title="Open">
                  <ExternalLink size={14} />
                </a>
              )}
            </div>
          </div>

          {/* Check Interval */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-text-primary">Check Interval</div>
              <div className="text-xs text-text-muted">How often to check for updates</div>
            </div>
            <div className="flex items-center gap-2">
              <input type="number" min={10} max={86400} value={stack.checkInterval}
                onChange={async (e) => {
                  const val = parseInt(e.target.value, 10);
                  if (val >= 10) {
                    const updated = await stacksApi.update(stack.id, { checkInterval: val });
                    setStack(updated);
                  }
                }}
                onBlur={load}
                className="w-24 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary text-right focus:outline-none focus:ring-1 focus:ring-accent" />
              <span className="text-xs text-text-muted">seconds</span>
            </div>
          </div>

          {/* Auto-Update toggle */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-text-primary">Auto-Update</div>
              <div className="text-xs text-text-muted">Automatically pull and recreate containers when updates are detected</div>
            </div>
            <button
              onClick={async () => {
                const updated = await stacksApi.update(stack.id, { autoUpdate: !stack.autoUpdate });
                setStack(updated);
                toast.success(updated.autoUpdate ? 'Auto-update enabled' : 'Auto-update disabled');
              }}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${stack.autoUpdate ? 'bg-accent' : 'bg-bg-tertiary border border-border'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${stack.autoUpdate ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>

          {/* Monitoring toggle */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-text-primary">Monitoring</div>
              <div className="text-xs text-text-muted">Enable or pause update checks for this stack</div>
            </div>
            <button
              onClick={async () => {
                const updated = await stacksApi.update(stack.id, { enabled: !stack.enabled });
                setStack(updated);
                toast.success(updated.enabled ? 'Monitoring enabled' : 'Monitoring paused');
              }}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${stack.enabled ? 'bg-status-up' : 'bg-bg-tertiary border border-border'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${stack.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>

          <StackMaintenanceControl stack={stack} onSaved={setStack} />
          {/* Notification overrides */}
          <div className="border-t border-border pt-4 mt-4">
            <div className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">Notification Overrides</div>
            <div className="space-y-3">
              {/* Notify update available */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-text-primary">Notify: Update Available</div>
                  <div className="text-xs text-text-muted">{stack.notifyUpdateAvailable === null ? 'Using global setting' : 'Overridden for this stack'}</div>
                </div>
                <div className="flex items-center gap-2">
                  {stack.notifyUpdateAvailable === null ? (
                    <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyUpdateAvailable: true }); setStack(updated); }}
                      className="px-2.5 py-1 text-[10px] rounded-md border border-border text-text-muted hover:bg-bg-hover">Override</button>
                  ) : (
                    <>
                      <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyUpdateAvailable: !stack.notifyUpdateAvailable }); setStack(updated); }}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${stack.notifyUpdateAvailable ? 'bg-status-up' : 'bg-status-down'}`}>
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${stack.notifyUpdateAvailable ? 'translate-x-6' : 'translate-x-1'}`} />
                      </button>
                      <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyUpdateAvailable: null }); setStack(updated); toast.success('Reset to global'); }}
                        className="px-2.5 py-1 text-[10px] rounded-md border border-accent/30 text-accent hover:bg-accent/10">Reset</button>
                    </>
                  )}
                </div>
              </div>

              {/* Notify update applied */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-text-primary">Notify: Update Applied</div>
                  <div className="text-xs text-text-muted">{stack.notifyUpdateApplied === null ? 'Using global setting' : 'Overridden for this stack'}</div>
                </div>
                <div className="flex items-center gap-2">
                  {stack.notifyUpdateApplied === null ? (
                    <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyUpdateApplied: true }); setStack(updated); }}
                      className="px-2.5 py-1 text-[10px] rounded-md border border-border text-text-muted hover:bg-bg-hover">Override</button>
                  ) : (
                    <>
                      <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyUpdateApplied: !stack.notifyUpdateApplied }); setStack(updated); }}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${stack.notifyUpdateApplied ? 'bg-status-up' : 'bg-status-down'}`}>
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${stack.notifyUpdateApplied ? 'translate-x-6' : 'translate-x-1'}`} />
                      </button>
                      <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyUpdateApplied: null }); setStack(updated); toast.success('Reset to global'); }}
                        className="px-2.5 py-1 text-[10px] rounded-md border border-accent/30 text-accent hover:bg-accent/10">Reset</button>
                    </>
                  )}
                </div>
              </div>

              {/* Notify delay */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-text-primary">Notification Delay</div>
                  <div className="text-xs text-text-muted">{stack.notifyDelay === null ? 'Using global setting' : `${stack.notifyDelay}s (overridden)`}</div>
                </div>
                <div className="flex items-center gap-2">
                  {stack.notifyDelay === null ? (
                    <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyDelay: 300 }); setStack(updated); }}
                      className="px-2.5 py-1 text-[10px] rounded-md border border-border text-text-muted hover:bg-bg-hover">Override</button>
                  ) : (
                    <>
                      <input type="number" min={0} max={86400} value={stack.notifyDelay}
                        onBlur={async (e) => { const updated = await stacksApi.update(stack.id, { notifyDelay: parseInt(e.target.value) || 300 }); setStack(updated); }}
                        onChange={e => setStack(s => s ? { ...s, notifyDelay: parseInt(e.target.value) || 0 } : null)}
                        className="w-20 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary text-right focus:outline-none focus:ring-1 focus:ring-accent" />
                      <span className="text-xs text-text-muted">sec</span>
                      <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyDelay: null }); setStack(updated); toast.success('Reset to global'); }}
                        className="px-2.5 py-1 text-[10px] rounded-md border border-accent/30 text-accent hover:bg-accent/10">Reset</button>
                    </>
                  )}
                </div>
              {/* Notification channels */}
              <div className="mt-4 pt-3 border-t border-border/50">
                <div className="text-sm font-medium text-text-primary mb-2">Notification Channels</div>
                <div className="text-xs text-text-muted mb-2">Override which channels receive notifications for this stack</div>
                <NotificationBindingsPanel scope="stack" scopeId={stack.id} />
              </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Resources — priority tier, CPU/RAM caps, GPU visibility */}
      <div className="mb-6">
        <StackResourcesTab stackId={stack.id} />
      </div>

      {/* History */}
      {history.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-text-secondary">Update History</h2>
          </div>
          <div className="divide-y divide-border">
            {history.map((h) => (
              <div key={h.id} className="px-4 py-2.5 flex items-center gap-3 text-xs">
                <div className={`h-2 w-2 rounded-full shrink-0 ${
                  h.status === 'success' ? 'bg-status-up' : h.status === 'failed' ? 'bg-status-down' : 'bg-status-pending'
                }`} />
                <span className="text-text-primary font-medium">{h.containerName}</span>
                <span className="text-text-muted">{h.image}</span>
                <span className={`ml-auto ${h.status === 'success' ? 'text-status-up' : h.status === 'failed' ? 'text-status-down' : 'text-text-muted'}`}>
                  {h.status}
                </span>
                <span className="text-text-muted">{new Date(h.startedAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sleep panel ────────────────────────────────────────────────────────────
function SleepPanel({ container, onChange, onClose }: { container: Container; onChange: (c: Container) => void; onClose: () => void }) {
  const [enabled, setEnabled] = useState(container.sleepEnabled);
  const [idleMinutes, setIdleMinutes] = useState(Math.round(container.sleepAfterSeconds / 60));
  const [mode, setMode] = useState(container.sleepMode);
  const [healthPath, setHealthPath] = useState(container.wakeHealthPath || '');
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await containersApi.updateSleepConfig(container.id, {
        sleepEnabled: enabled,
        sleepAfterSeconds: Math.max(60, idleMinutes * 60),
        sleepMode: mode,
        wakeHealthPath: healthPath.trim() || null,
      });
      onChange(updated);
      toast.success('Sleep config saved');
    } catch { toast.error('Failed to save'); }
    finally { setSaving(false); }
  };

  const handleSleepNow = async () => {
    if (!confirm(`Put "${container.containerName}" to sleep now? It will ${mode === 'pause' ? 'pause' : 'stop'} until accessed via proxy.`)) return;
    setActing(true);
    try {
      await containersApi.sleepNow(container.id);
      toast.success('Sleeping');
      onChange({ ...container, sleepState: 'sleeping' });
    } catch { toast.error('Failed to sleep'); }
    finally { setActing(false); }
  };

  const handleWakeNow = async () => {
    setActing(true);
    try {
      await containersApi.wakeNow(container.id);
      toast.success('Waking…');
      onChange({ ...container, sleepState: 'waking', wakeStartedAt: new Date().toISOString() });
    } catch { toast.error('Failed to wake'); }
    finally { setActing(false); }
  };

  const stateBadge =
    container.sleepState === 'sleeping' ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-status-pending/10 text-status-pending">Sleeping</span>
    : container.sleepState === 'waking' ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-accent/10 text-accent">Waking…</span>
    : container.sleepState === 'wake_failed' ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-status-down/10 text-status-down">Wake failed</span>
    : <span className="px-1.5 py-0.5 rounded text-[10px] bg-status-up/10 text-status-up">Awake</span>;

  return (
    <div className="rounded-lg border border-border bg-bg-tertiary overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-bg-secondary border-b border-border">
        <span className="text-xs font-medium text-text-secondary flex items-center gap-1.5"><Moon size={12} /> Sleep mode</span>
        <div className="flex items-center gap-2">
          {stateBadge}
          <button onClick={onClose} className="p-1 rounded hover:bg-bg-hover text-text-muted text-xs">&times;</button>
        </div>
      </div>
      <div className="p-3 space-y-3 text-xs">
        <p className="text-text-muted">
          Idle containers can be put to sleep to free resources (incl. GPU VRAM). Wake-up is automatic when traffic hits the linked proxy host.
          <strong className="block mt-1 text-status-pending">Use <code>stop</code> for AI/GPU workloads</strong> — <code>pause</code> only freezes the cgroup and keeps VRAM allocated.
        </p>

        {/* Enabled toggle */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-text-primary">Enable auto-sleep</div>
            <div className="text-[11px] text-text-muted">Sleep the container after the idle threshold below</div>
          </div>
          <button onClick={() => setEnabled(!enabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${enabled ? 'bg-accent' : 'bg-bg-hover border border-border'}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        {/* Idle minutes */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-text-primary">Idle threshold</div>
            <div className="text-[11px] text-text-muted">Sleep after this many minutes without activity</div>
          </div>
          <div className="flex items-center gap-1.5">
            <input type="number" min={1} max={1440} value={idleMinutes}
              onChange={e => setIdleMinutes(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-20 rounded border border-border bg-bg-primary px-2 py-1 text-right focus:outline-none focus:ring-1 focus:ring-accent" />
            <span className="text-text-muted">min</span>
          </div>
        </div>

        {/* Mode */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-text-primary">Mode</div>
            <div className="text-[11px] text-text-muted">{mode === 'stop' ? 'docker stop — frees VRAM, slower wake (model reload)' : 'docker pause — instant wake, VRAM stays pinned'}</div>
          </div>
          <select value={mode} onChange={e => setMode(e.target.value as 'stop' | 'pause')}
            className="rounded border border-border bg-bg-primary px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent">
            <option value="stop">stop (frees VRAM)</option>
            <option value="pause">pause (fast wake)</option>
          </select>
        </div>

        {/* Health path */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-text-primary">Wake readiness check</div>
            <div className="text-[11px] text-text-muted">Optional HTTP path probed during wake (e.g. <code>/health</code>). Empty = TCP probe on first port.</div>
          </div>
          <input type="text" value={healthPath} onChange={e => setHealthPath(e.target.value)} placeholder="/health"
            className="w-36 rounded border border-border bg-bg-primary px-2 py-1 font-mono focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>

        {/* Last active */}
        {container.lastActiveAt && (
          <div className="text-[11px] text-text-muted">
            Last activity: {new Date(container.lastActiveAt).toLocaleString()}
          </div>
        )}

        <div className="flex items-center gap-2 pt-2 border-t border-border">
          <button onClick={save} disabled={saving}
            className="px-3 py-1 rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-50 flex items-center gap-1">
            {saving ? 'Saving…' : 'Save config'}
          </button>
          {container.sleepState === 'awake' && (
            <button onClick={handleSleepNow} disabled={acting}
              className="px-3 py-1 rounded-md border border-border text-text-muted hover:bg-bg-hover hover:text-status-pending flex items-center gap-1">
              <Moon size={11} /> Sleep now
            </button>
          )}
          {container.sleepState === 'sleeping' && (
            <button onClick={handleWakeNow} disabled={acting}
              className="px-3 py-1 rounded-md border border-border text-text-muted hover:bg-bg-hover hover:text-status-up flex items-center gap-1">
              <Sun size={11} /> Wake now
            </button>
          )}
          {container.sleepState === 'wake_failed' && (
            <button onClick={handleWakeNow} disabled={acting}
              className="px-3 py-1 rounded-md border border-status-down text-status-down hover:bg-status-down/10 flex items-center gap-1">
              <Sun size={11} /> Retry wake
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Live update progress panel — subscribes to UPDATE_LOG (per-line stream of pull/recreate
// output) and UPDATE_COMPLETE (clears the active container when done) for THIS stack only.
// Sits above the container list so it's visible without scrolling. Auto-collapses when the
// stack has no active update.
function UpdateProgressPanel({ stackId, containerNames }: { stackId: number; containerNames: Record<number, string> }) {
  const socket = useSocket();
  // Keyed by containerId so we can show output for parallel updates (multiple containers
  // in the same stack updating simultaneously). Each entry holds the last N lines.
  const [perContainer, setPerContainer] = useState<Record<number, string[]>>({});
  const [activeContainerIds, setActiveContainerIds] = useState<Set<number>>(new Set());
  const tailRefs = useRef<Record<number, HTMLPreElement | null>>({});

  useEffect(() => {
    const onLog = (data: { stackId: number; containerId: number; chunk: string }) => {
      if (data.stackId !== stackId) return;
      setActiveContainerIds((prev) => {
        if (prev.has(data.containerId)) return prev;
        const next = new Set(prev); next.add(data.containerId); return next;
      });
      setPerContainer((prev) => {
        const cur = prev[data.containerId] || [];
        const next = [...cur, data.chunk];
        // Cap retained history per container so a long pull doesn't bloat React state.
        if (next.length > 500) next.splice(0, next.length - 500);
        return { ...prev, [data.containerId]: next };
      });
    };
    const onComplete = (data: { stackId: number; containerId: number; success: boolean; error?: string }) => {
      if (data.stackId !== stackId) return;
      setActiveContainerIds((prev) => {
        if (!prev.has(data.containerId)) return prev;
        const next = new Set(prev); next.delete(data.containerId); return next;
      });
      // Append the resolution + the error detail (when present) so the failure reason is
      // visible right in the panel rather than buried in server logs.
      setPerContainer((prev) => {
        const cur = prev[data.containerId] || [];
        const lines = data.success
          ? [...cur, '✓ Update complete']
          : [...cur, '✗ Update failed', ...(data.error ? [`  → ${data.error}`] : [])];
        return { ...prev, [data.containerId]: lines };
      });
    };
    socket.on(SOCKET_EVENTS.UPDATE_LOG, onLog);
    socket.on(SOCKET_EVENTS.UPDATE_COMPLETE, onComplete);
    return () => {
      socket.off(SOCKET_EVENTS.UPDATE_LOG, onLog);
      socket.off(SOCKET_EVENTS.UPDATE_COMPLETE, onComplete);
    };
  }, [socket, stackId]);

  // Auto-scroll each tail to the bottom as new lines arrive.
  useEffect(() => {
    for (const [cid, el] of Object.entries(tailRefs.current)) {
      if (el) el.scrollTop = el.scrollHeight;
      void cid;
    }
  }, [perContainer]);

  // Only show containers that have any log output OR are currently active.
  const visibleIds = Object.keys(perContainer).map(Number).filter(id => (perContainer[id] || []).length > 0);
  if (visibleIds.length === 0) return null;

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 mb-6 overflow-hidden">
      <div className="px-4 py-2 border-b border-accent/20 flex items-center gap-2 bg-accent/10">
        <div className="h-2 w-2 rounded-full bg-accent animate-pulse" />
        <span className="text-xs font-semibold text-accent">
          {activeContainerIds.size > 0
            ? `Updating ${activeContainerIds.size} container${activeContainerIds.size > 1 ? 's' : ''}…`
            : 'Last update output'}
        </span>
      </div>
      <div className="divide-y divide-border">
        {visibleIds.map((cid) => {
          const lines = perContainer[cid] || [];
          const isActive = activeContainerIds.has(cid);
          return (
            <div key={cid}>
              <div className="px-4 py-1.5 flex items-center gap-2 text-[11px] font-mono bg-bg-secondary/60">
                {isActive && <div className="h-2 w-2 rounded-full border border-accent border-t-transparent animate-spin" />}
                <span className="text-text-primary font-semibold">{containerNames[cid] || `Container #${cid}`}</span>
                <span className="text-text-muted">— {lines.length} line{lines.length !== 1 ? 's' : ''}</span>
                {isActive && (
                  <button
                    onClick={async () => {
                      try {
                        const { containersApi } = await import('@/api/stacks.api');
                        const r = await containersApi.cancelUpdate(cid);
                        if (!r.cancelled) toast('No update was running.');
                        else toast.success('Cancel signal sent.');
                      } catch { toast.error('Cancel failed'); }
                    }}
                    className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded bg-red-600 hover:bg-red-700 text-white shadow-sm"
                    title="Stop this update — useful when a multi-GB pull is stuck or being rate-limited"
                  >
                    <XCircle size={11} /> Cancel update
                  </button>
                )}
              </div>
              <pre
                ref={(el) => { tailRefs.current[cid] = el; }}
                className="text-[11px] leading-relaxed font-mono text-text-secondary whitespace-pre-wrap break-all bg-[#0d1117] p-3 max-h-48 overflow-auto"
              >
                {lines.join('\n')}
              </pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}
