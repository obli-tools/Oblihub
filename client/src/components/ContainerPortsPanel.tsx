import { useEffect, useRef, useState } from 'react';
import { findContainerPort, portSegmentContains, suggestProxyPort } from '@oblihub/shared';
import type { Container, PortChipModel, ResolvedUpstream, UpstreamVia } from '@oblihub/shared';
import { containersApi } from '../api/stacks.api';
import { useEngineSummaries } from '../hooks/useEngineSummaries';
import { apiErrorMessage } from '../utils/apiError';
import { PortChips } from './PortChips';

export type UpstreamPatch = { forwardHost?: string; forwardPort?: number; forwardScheme?: 'http' | 'https' };

const VIA_LABEL: Record<UpstreamVia, string> = {
  'local-docker-dns': 'Docker DNS',
  'local-host-network': 'host network',
  'tailscale-subnet-route': 'Tailscale subnet route',
  'tailscale-hostname-published-port': 'Tailscale + published port',
  'engine-public-host': 'engine host + published port',
};

const LOCAL_DNS_INFO = 'Reached through Docker DNS on the proxy network — the internal port is what matters';

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; data: ResolvedUpstream; applied: boolean }
  | { kind: 'error'; message: string };

/** Only the modes that change how nginx reaches the container deserve a chip; compose's
 *  `<project>_default` is the everyday case and would just be noise. */
function networkModeChip(mode: string | null | undefined): string | null {
  if (!mode || mode === 'bridge' || mode === 'default' || mode.endsWith('_default')) return null;
  if (mode.startsWith('container:')) return `container:${mode.slice('container:'.length, 'container:'.length + 12)}`;
  return mode;
}

/** The resolver needs proxy.manage plus team access; without them the editor still works by hand,
 *  so a refusal is not worth an error line. containersApi.resolveUpstream turns 4xx answers into a
 *  plain Error carrying the server text, hence the message check next to the status one. */
function isAccessDenied(err: unknown): boolean {
  if ((err as { response?: { status?: number } })?.response?.status === 403) return true;
  const msg = err instanceof Error ? err.message : '';
  return /^(permission denied|access denied|insufficient permissions)/i.test(msg);
}

function errorText(err: unknown): string {
  if ((err as { response?: unknown })?.response) return apiErrorMessage(err, 'Could not resolve the upstream');
  return err instanceof Error && err.message ? err.message : 'Could not resolve the upstream';
}

/** The form's port field can hold anything while it is being typed. */
function isFormPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function protocolFor(container: Container, port: number): 'tcp' | 'udp' {
  if (findContainerPort(container.ports ?? [], port, 'tcp')) return 'tcp';
  return findContainerPort(container.ports ?? [], port, 'udp') ? 'udp' : 'tcp';
}

/**
 * Ports and upstream status of the container a proxy host (or sub-route) targets. Local targets
 * keep their container name as host (Docker DNS on the proxy network), so a picked chip only sets
 * the port and the resolver is asked for display only — it says when the container is not on the
 * proxy network, which Oblihub never fixes by itself. Remote targets cannot be reached by name
 * from the hub's nginx, so the resolver's host/port/scheme replace the form values.
 */
export function ContainerPortsPanel({
  container,
  stackName = null,
  ambiguousCount = 0,
  currentPort,
  currentHost,
  onApply,
  autoResolve = false,
  compact = false,
}: {
  container: Container | null;
  stackName?: string | null;
  ambiguousCount?: number;
  currentPort: number;
  /** Current forward host. With it, auto-resolve fires only while the host is still the remote
   *  container's bare name, so reopening an editor never rewrites a host resolved earlier. */
  currentHost?: string;
  onApply: (patch: UpstreamPatch) => void;
  autoResolve?: boolean;
  compact?: boolean;
}) {
  const { byId, loading: enginesLoading } = useEngineSummaries();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const seq = useRef(0);
  // Resolutions finish after the user may have edited the form; always apply through the latest callback.
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;
  const autoKey = useRef<string | null>(null);

  const containerId = container?.id ?? null;
  const orphan = container != null && container.engineId == null;
  const engine = container?.engineId != null ? byId.get(container.engineId) ?? null : null;
  // An engine missing from the summaries (older server, fetch failure) is handled like today's
  // local-only behaviour: the host is never rewritten, the resolver's answer is only displayed.
  const isRemote = engine != null && !engine.isLocal;
  const ready = container != null && !orphan && !enginesLoading;
  const ports = container?.ports ?? [];
  // A remote target is only reachable through a published port (bar a subnet route): an
  // internal-only port that ranks higher would suggest a dead end.
  const suggested = container ? suggestProxyPort(ports, { preferPublished: isRemote }) : null;
  // Docker declares no ports for a host-networked container: the port is whatever the operator enters.
  const hostNetworked = container?.networkMode === 'host';

  useEffect(() => {
    seq.current++;
    setStatus({ kind: 'idle' });
  }, [containerId]);

  // onApply writes into the page-level editor state, which outlives this panel: a remote answer
  // landing after the modal closed would otherwise be patched into the next host opened.
  // autoKey is cleared too so StrictMode's simulated remount re-fires the auto-resolve it just dropped.
  useEffect(() => () => { seq.current++; autoKey.current = null; }, []);

  const resolveRemote = async (port: number | undefined, protocol: 'tcp' | 'udp') => {
    if (!container) return;
    const my = ++seq.current;
    setStatus({ kind: 'loading' });
    try {
      const data = await containersApi.resolveUpstream(container.id, port, protocol);
      if (my !== seq.current) return;
      onApplyRef.current({ forwardHost: data.host, forwardPort: data.port, forwardScheme: data.scheme });
      setStatus({ kind: 'ok', data, applied: true });
    } catch (err) {
      if (my !== seq.current) return;
      setStatus(isAccessDenied(err) ? { kind: 'idle' } : { kind: 'error', message: errorText(err) });
    }
  };

  // Local targets: show whether nginx can actually reach the container on the port in the form.
  // Debounced because the port field fires on every keystroke.
  useEffect(() => {
    if (!ready || isRemote || !container) return;
    const my = ++seq.current;
    const port = currentPort;
    const timer = setTimeout(() => {
      setStatus({ kind: 'loading' });
      containersApi.resolveUpstream(container.id, port, protocolFor(container, port))
        .then((data) => { if (my === seq.current) setStatus({ kind: 'ok', data, applied: false }); })
        .catch((err) => {
          if (my !== seq.current) return;
          setStatus(isAccessDenied(err) ? { kind: 'idle' } : { kind: 'error', message: errorText(err) });
        });
    }, 300);
    return () => clearTimeout(timer);
    // `container` itself changes identity on every parent reload; its id is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, ready, isRemote, currentPort]);

  // Remote targets: a remote container name never resolves from the hub's nginx, so leaving it in
  // the form would guarantee a 502 — replace it with the resolver's answer as soon as it is picked.
  useEffect(() => {
    if (!autoResolve || !ready || !isRemote || !container) { autoKey.current = null; return; }
    const stillBareName = currentHost === undefined || currentHost === container.containerName;
    if (!stillBareName) { autoKey.current = null; return; }
    const key = `${container.id}|${currentHost ?? ''}`;
    if (autoKey.current === key) return;
    autoKey.current = key;
    // The editor already moved the port to a declared one when the container was picked; keep it.
    // Host networking declares none, so the form's port is the only one there is: asked without it,
    // the server refuses and the bare container name (a certain 502) would stay in the form.
    const port = hostNetworked
      ? (isFormPort(currentPort) ? currentPort : undefined)
      : findContainerPort(ports, currentPort, 'tcp') ? currentPort : (suggested ?? undefined);
    void resolveRemote(port, 'tcp');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoResolve, ready, isRemote, containerId, currentHost]);

  if (!container) return null;

  const pick = (chip: PortChipModel) => {
    const protocol = chip.protocol === 'udp' ? 'udp' : 'tcp';
    if (isRemote) { void resolveRemote(chip.containerStart, protocol); return; }
    // Local: the host stays the container name; the effect above re-resolves for display.
    onApplyRef.current({ forwardPort: chip.containerStart });
  };

  const pickSuggested = () => {
    if (suggested == null) return;
    if (isRemote) void resolveRemote(suggested, 'tcp');
    else onApplyRef.current({ forwardPort: suggested });
  };

  const engineLabel = orphan ? 'Unknown engine' : engine?.name ?? (enginesLoading ? '…' : `Engine #${container.engineId}`);
  const netChip = networkModeChip(container.networkMode);
  const undeclaredLocalPort = !orphan && !isRemote && container.networkMode !== 'host'
    && ports.length > 0 && !ports.some((p) => portSegmentContains(p, currentPort));
  const highlight = isRemote
    ? (status.kind === 'ok' ? status.data.containerPort : null)
    : currentPort;
  // Hidden once the form already holds what that port resolves to.
  const resolveHostPortOffered = isRemote && !orphan && hostNetworked && status.kind !== 'loading'
    && isFormPort(currentPort)
    && !(status.kind === 'ok' && status.data.host === currentHost && status.data.port === currentPort);

  const text = compact ? 'text-[10px]' : 'text-[11px]';
  const badge = 'text-[9px] px-1 py-0.5 rounded';

  const header = (
    <div className={`flex flex-wrap items-center gap-1.5 ${text} text-text-muted`}>
      <span>Target:</span>
      <span className="font-mono text-text-primary" title={stackName ? `${stackName} / ${container.containerName}` : undefined}>
        {container.containerName}
      </span>
      <span>·</span>
      <span className={orphan ? 'text-status-down' : ''}>{engineLabel}</span>
      {isRemote && <span className={`${badge} bg-accent/10 text-accent`}>remote</span>}
      {netChip && <span className={`${badge} bg-bg-tertiary text-text-secondary font-mono`} title="Network mode">{netChip}</span>}
    </div>
  );

  const chips = (
    <div className="flex flex-wrap items-center gap-2">
      {/* A picker must list every segment: PortChips' default cap folds the tail into a
          non-clickable "+N", and buildPortChips puts internal-only ports (the usual proxy
          target) last, so they would be the first to become unpickable and unhighlightable. */}
      <PortChips
        ports={ports}
        showInternal
        max={Infinity}
        size={compact ? 'xs' : 'sm'}
        onPick={orphan ? undefined : pick}
        highlightContainerPort={highlight}
        emptyLabel={hostNetworked
          ? `Host networking: no declared ports. Enter the port the service listens on${isRemote ? ', then Resolve' : ''}`
          : 'No declared ports (EXPOSE/ports) — enter the port manually'}
      />
      {suggested != null && !orphan && (
        <button
          type="button"
          onClick={pickSuggested}
          title="Use the suggested port"
          className={`${text} text-text-muted hover:text-accent`}
        >
          Suggested: <span className="font-mono">{suggested}</span>
        </button>
      )}
      {resolveHostPortOffered && (
        // A remote host-networked target has no chip to pick: the port typed in the form is resolved
        // on demand. The server echoes that port, so applying only swaps the host for the engine's
        // address. Offered rather than run on each port edit, so a host typed by hand is never overwritten.
        <button
          type="button"
          onClick={() => void resolveRemote(currentPort, protocolFor(container, currentPort))}
          className={`${text} text-accent hover:underline`}
        >
          Resolve on port {currentPort}
        </button>
      )}
    </div>
  );

  const messages: JSX.Element[] = [];
  if (orphan) {
    messages.push(
      <div key="orphan" className={`${text} text-status-down`}>
        This container&#39;s engine was deleted — its upstream cannot be resolved
      </div>,
    );
  }
  if (ambiguousCount > 1) {
    messages.push(
      <div key="ambiguous" className={`${text} text-text-muted`}>
        {ambiguousCount} containers share this name on different engines — pick from the list to choose one
      </div>,
    );
  }
  // A remote name that was typed rather than picked is not resolved on its own (it may be a local
  // compose alias), so say what the form will actually do and how to reach the remote container.
  if (isRemote && !autoResolve && ambiguousCount <= 1 && currentHost === container.containerName && status.kind !== 'loading') {
    messages.push(
      <div key="remote-name" className={`${text} text-text-muted`}>
        This name resolves locally through the proxy network — pick a port to route to the container on {engineLabel} instead
      </div>,
    );
  }
  if (undeclaredLocalPort) {
    messages.push(
      <div key="undeclared" className={`${text} text-status-warning`}>
        Port {currentPort} is not declared by this container — it may still listen on it
      </div>,
    );
  }
  if (status.kind === 'loading') {
    messages.push(<div key="loading" className={`${text} text-text-muted`}>Resolving upstream…</div>);
  } else if (status.kind === 'error') {
    messages.push(<div key="error" className={`${text} text-status-down`}>{status.message}</div>);
  } else if (status.kind === 'ok') {
    const d = status.data;
    const localDns = d.via === 'local-docker-dns';
    if (localDns && d.needsProxyNetwork) {
      messages.push(<div key="hint" className={`${text} text-status-warning`}>{d.hint}</div>);
    } else if (localDns) {
      messages.push(<div key="hint" className={`${text} text-text-muted`}>{LOCAL_DNS_INFO}</div>);
    } else {
      // Host networking, or a remote engine the summaries did not know about: the container name
      // is not what nginx should use, so offer the resolver's endpoint instead of applying it silently.
      const canUse = !status.applied && (currentHost === undefined || currentHost !== d.host || currentPort !== d.port);
      messages.push(
        <div key="via" className={`flex flex-wrap items-center gap-1.5 ${text}`}>
          <span className={`${badge} bg-status-up/10 text-status-up`} title={d.via}>via {VIA_LABEL[d.via] ?? d.via}</span>
          <span className="font-mono text-text-primary">{d.scheme}://{d.host}:{d.port}</span>
          {status.applied && <span className="text-text-muted">applied</span>}
          {canUse && (
            <button
              type="button"
              onClick={() => { onApplyRef.current({ forwardHost: d.host, forwardPort: d.port, forwardScheme: d.scheme }); setStatus({ ...status, applied: true }); }}
              className="text-accent hover:underline"
            >
              Use it
            </button>
          )}
          <span className="text-text-muted">{d.hint}</span>
        </div>,
      );
    }
    // The panel already states these two in its own words.
    const warnings = d.warnings.filter((w) =>
      !(undeclaredLocalPort && w.startsWith(`Port ${d.containerPort} is not declared`))
      && !(d.needsProxyNetwork && w.startsWith('Not on the ')));
    for (const w of warnings) {
      messages.push(<div key={`w:${w}`} className={`${text} text-status-warning`}>{w}</div>);
    }
  }

  if (compact) {
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {header}
          {chips}
        </div>
        {messages}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-bg-tertiary/40 p-3 space-y-2">
      {header}
      {chips}
      {messages.length > 0 && <div className="space-y-1">{messages}</div>}
    </div>
  );
}
