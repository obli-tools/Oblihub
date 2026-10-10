import type { ContainerPort, DockerEngine, ResolvedUpstream, UpstreamVia } from '@oblihub/shared';
import { findContainerPort, isLoopbackIp, portSegmentContains, suggestProxyPort } from '@oblihub/shared';
import { db } from '../db';
import { stackService } from './stack.service';
import { engineService } from './engine.service';
import { dockerService } from './docker.service';
import { tailscaleService } from './tailscale.service';
import { withTimeout } from '../utils/withTimeout';
import { logger } from '../utils/logger';

/** A container row whose engine was deleted must never be routed to the local daemon: the same
 *  docker id could name a different container there. */
export const ORPHAN_MSG = "This container's engine no longer exists — Oblihub will not guess which daemon to call";

const FALLBACK_HOST_GATEWAY = '172.17.0.1';
const INSPECT_TIMEOUT_MS = 5_000;

const REMOTE_REMEDIATION =
  'Could not determine an upstream for this container. Either publish a port on the host, advertise the bridge subnet via Tailscale, or set a Tailscale hostname on the engine.'
  + ' Publish the port on 0.0.0.0 or advertise the bridge subnet via Tailscale.';

export type ResolveUpstreamResult =
  | { ok: true; data: ResolvedUpstream }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Returns true if `ip` (IPv4 dotted quad) is inside `cidr` (e.g. "172.17.0.0/16"). Tiny
 * implementation — we only need IPv4 here and we control both sides of the input. Returns
 * false for malformed input rather than throwing, so the caller can fall through gracefully.
 */
export function cidrContains(cidr: string, ip: string): boolean {
  const m = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  const ipParts = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m || !ipParts) return false;
  const prefix = parseInt(m[5], 10);
  if (prefix < 0 || prefix > 32) return false;
  const toInt = (a: string, b: string, c: string, d: string): number =>
    (((parseInt(a, 10) << 24) >>> 0) + (parseInt(b, 10) << 16) + (parseInt(c, 10) << 8) + parseInt(d, 10)) >>> 0;
  const cidrInt = toInt(m[1], m[2], m[3], m[4]);
  const ipInt = toInt(ipParts[1], ipParts[2], ipParts[3], ipParts[4]);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (cidrInt & mask) === (ipInt & mask);
}

/** `?port=` of the upstream routes: absent or empty → null (let the resolver pick), a valid port →
 *  that number, anything else → undefined (the caller answers 400). */
export function parsePortQuery(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return undefined;
  const n = parseInt(raw, 10);
  return n >= 1 && n <= 65535 ? n : undefined;
}

interface LiveView {
  networkMode: string | null;
  /** null = the inspect failed, so membership is unknown (not "on no network"). */
  networks: string[] | null;
  bridgeIp: string | null;
}

async function inspectLive(dockerId: string, engineId: number): Promise<LiveView | null> {
  try {
    const info = await withTimeout(dockerService.inspectContainer(dockerId, engineId), INSPECT_TIMEOUT_MS, 'inspect');
    const rawNetworks = (info.NetworkSettings?.Networks || {}) as Record<string, { IPAddress?: string } | null>;
    const bridgeIp = Object.values(rawNetworks)
      .map((n) => n?.IPAddress)
      .find((ip): ip is string => !!ip) ?? null;
    return {
      networkMode: info.HostConfig?.NetworkMode ?? null,
      networks: Object.keys(rawNetworks),
      bridgeIp,
    };
  } catch (err) {
    logger.debug({ dockerId, engineId, err: err instanceof Error ? err.message : String(err) }, 'Upstream resolver: live inspect failed, using DB data');
    return null;
  }
}

/** The gateway of the proxy network is the host's address as seen from nginx, which is how a
 *  host-networked container is reached. */
async function proxyNetworkGateway(): Promise<string> {
  try {
    const name = await dockerService.getProxyNetworkName();
    const net = await withTimeout(dockerService.inspectNetwork(name), INSPECT_TIMEOUT_MS, 'network inspect');
    const gw = (net.IPAM?.Config?.[0] as { Gateway?: string } | undefined)?.Gateway;
    if (gw) return gw;
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'Upstream resolver: proxy network inspect failed');
  }
  return FALLBACK_HOST_GATEWAY;
}

/** Oblihub itself wires deployed local managed stacks onto the proxy network after a proxy host
 *  is saved (the existing attach-only refresh); nothing else is attached automatically. */
async function isLocalDeployedManagedStack(stackId: number | null): Promise<boolean> {
  if (stackId == null) return false;
  const stack = await db('stacks').where({ id: stackId }).select('compose_project').first() as { compose_project: string | null } | undefined;
  if (!stack?.compose_project) return false;
  const row = await db('managed_stacks as m')
    .leftJoin('docker_engines as e', 'e.id', 'm.engine_id')
    .where('m.compose_project', stack.compose_project)
    .where('m.status', 'deployed')
    .where((q) => { q.whereNull('m.engine_id').orWhere('e.type', 'local'); })
    .select('m.id')
    .first();
  return !!row;
}

function schemeFor(containerPort: number): 'http' | 'https' {
  return containerPort === 443 || containerPort === 8443 ? 'https' : 'http';
}

type MakeResult = (via: UpstreamVia, host: string, port: number, hint: string, needsProxyNetwork?: boolean) => ResolveUpstreamResult;

async function resolveLocal(
  containerName: string,
  stackId: number | null,
  networkMode: string | null,
  live: LiveView | null,
  containerPort: number,
  warnings: string[],
  make: MakeResult,
): Promise<ResolveUpstreamResult> {
  if (networkMode === 'host') {
    const gateway = await proxyNetworkGateway();
    warnings.push('Uses host networking: reached through the Docker host gateway');
    return make('local-host-network', gateway, containerPort,
      `The container shares the host's network stack, so nginx reaches it on the Docker host gateway (${gateway}).`);
  }
  if (networkMode === 'none' || (networkMode && networkMode.startsWith('container:'))) {
    return {
      ok: false,
      status: 400,
      error: `This container has no network of its own (network_mode ${networkMode}) — target the container that owns the network namespace`,
    };
  }

  const host = containerName.replace(/^\//, '');
  const net = await dockerService.getProxyNetworkName();
  if (!live) {
    warnings.push(`Could not inspect the container — make sure it is on the ${net} network`);
    return make('local-docker-dns', host, containerPort,
      `Resolves via Docker's embedded DNS on the ${net} network — the internal port is what matters.`);
  }
  if (!live.networks?.includes(net)) {
    const managed = await isLocalDeployedManagedStack(stackId).catch(() => false);
    const hint = managed
      ? `Managed stack: Oblihub attaches its targeted services to ${net} after the proxy host is saved.`
      : `Not on the ${net} network: attach it (docker network connect ${net} ${host}) or deploy it as a managed stack — nginx cannot reach it until then.`;
    warnings.push(managed
      ? `Not on the ${net} network yet`
      : `Not on the ${net} network — Oblihub does not attach it automatically`);
    return make('local-docker-dns', host, containerPort, hint, true);
  }
  return make('local-docker-dns', host, containerPort,
    `Resolves via Docker's embedded DNS on the ${net} network — the internal port is what matters.`);
}

async function resolveRemote(
  engine: DockerEngine,
  ports: ContainerPort[],
  networkMode: string | null,
  live: LiveView | null,
  containerPort: number,
  protocol: string,
  warnings: string[],
  make: MakeResult,
): Promise<ResolveUpstreamResult> {
  // Host networking: no bridge IP and no published ports exist, but the service listens on the
  // engine's own address, so the engine's reachable name plus the container port is the upstream.
  if (networkMode === 'host') {
    const engineAddress = engine.tailscaleHostname ?? engine.host;
    if (!engineAddress) {
      return {
        ok: false,
        status: 400,
        error: 'Uses host networking, but the engine has neither a Tailscale hostname nor a host address — set one on the engine so the hub can reach it.',
      };
    }
    warnings.push('Uses host networking: reached on the engine address');
    return engine.tailscaleHostname
      ? make('tailscale-hostname-published-port', engineAddress, containerPort,
        `The container shares the engine's network stack, so the hub reaches it on the engine's Tailnet hostname + the port it listens on.`)
      : make('engine-public-host', engineAddress, containerPort,
        `The container shares the engine's network stack, so the hub reaches it on the engine's public host. Requires the port to be reachable from the Oblihub server.`);
  }

  const published = ports.filter((p) => p && p.hostPort != null && portSegmentContains(p, containerPort, protocol));
  const reachable = published.find((p) => !isLoopbackIp(p.hostIp));
  const loopbackOnly = published.length > 0 && !reachable;
  const LOOPBACK_WARNING = 'Published on 127.0.0.1 only — not reachable from the hub';

  // 1. Subnet route: the bridge IP is reachable over the tailnet, no published port needed.
  if (engine.tailscaleAdvertisedRoutes && engine.tailscaleHostname && live?.bridgeIp) {
    try {
      const status = await tailscaleService.getStatus();
      const matchingPeer = status.peers.find(
        (p) => p.dnsName === engine.tailscaleHostname || p.hostname === engine.tailscaleHostname,
      );
      const routes = matchingPeer?.primaryRoutes || [];
      const bridgeIp = live.bridgeIp;
      if (routes.some((cidr) => cidrContains(cidr, bridgeIp))) {
        return make('tailscale-subnet-route', bridgeIp, containerPort,
          `Bridge IP routed via Tailscale subnet route on ${engine.tailscaleHostname}. No published port required.`);
      }
    } catch (err) {
      // Tailscale sidecar down or not configured: the published-port paths may still work.
      logger.debug({ engineId: engine.id, err: err instanceof Error ? err.message : String(err) }, 'Upstream resolver: tailscale status unavailable');
    }
  }

  if (reachable && reachable.hostPort != null) {
    const hostPort = reachable.hostPort + (containerPort - reachable.containerPort);
    // 2. Published port through the engine's tailnet name.
    if (engine.tailscaleHostname) {
      return make('tailscale-hostname-published-port', engine.tailscaleHostname, hostPort,
        `Uses the engine's Tailnet hostname + the container's published port. Works without subnet routing.`);
    }
    // 3. Published port through the engine's own address.
    if (engine.host) {
      return make('engine-public-host', engine.host, hostPort,
        `Falls back to the engine's public host. Requires the port to be reachable from the Oblihub server.`);
    }
  }

  // 4./5. Loopback-only publishing is invisible from the hub. A failed resolution carries no
  // warnings array, so the loopback warning travels in the error text.
  return {
    ok: false,
    status: 400,
    error: loopbackOnly ? `${LOOPBACK_WARNING}. ${REMOTE_REMEDIATION}` : REMOTE_REMEDIATION,
  };
}

export const proxyUpstreamService = {
  /**
   * Pick the (host, port, scheme) nginx on the hub should use to reach a container, per engine:
   * local containers go through Docker's embedded DNS (or the host gateway for host networking);
   * remote containers need a Tailscale subnet route or a non-loopback published port (or, with host
   * networking, the engine's own address plus the port the service listens on). Read-only:
   * it reports when a local target is off the proxy network instead of attaching it.
   */
  async resolve(containerId: number, opts: { port?: number | null; protocol?: string } = {}): Promise<ResolveUpstreamResult> {
    const container = await stackService.getContainerById(containerId);
    if (!container) return { ok: false, status: 404, error: 'Container not found' };
    if (container.engineId == null) return { ok: false, status: 409, error: ORPHAN_MSG };
    const engine = await engineService.getById(container.engineId);
    if (!engine) return { ok: false, status: 409, error: ORPHAN_MSG };
    const local = engine.type === 'local';
    const protocol = (opts.protocol ?? 'tcp').toLowerCase();
    const ports: ContainerPort[] = container.ports || [];
    const warnings: string[] = [];

    // The network mode decides whether an undeclared port is suspicious, so it is read before the
    // port choice: Docker publishes no port list for a host-networked container, which then
    // listens on the engine's own address on whatever port the service binds.
    const live = await inspectLive(container.dockerId, container.engineId);
    const networkMode = live?.networkMode ?? container.networkMode ?? null;
    const hostNetworking = networkMode === 'host';

    let containerPort: number;
    let declared = true;
    if (opts.port != null) {
      containerPort = opts.port;
      declared = !!findContainerPort(ports, containerPort, protocol);
      if (!declared && !local && !hostNetworking) {
        return { ok: false, status: 400, error: `Port ${containerPort} is neither published nor exposed by this container` };
      }
    } else {
      // A remote target is only reachable through a published port (bar a subnet route): an
      // internal-only port that ranks higher would resolve to a dead end.
      const suggested = suggestProxyPort(ports, { preferPublished: !local });
      if (suggested == null) {
        return {
          ok: false,
          status: 400,
          error: hostNetworking
            ? 'Uses host networking, so Docker declares no ports for it — enter the port the service listens on'
            : 'Container exposes no ports — enter the port manually',
        };
      }
      containerPort = suggested;
    }

    // Discovery records no port list for host-networked containers, so the warning would fire on
    // every one of them without telling the operator anything.
    if (!declared && !hostNetworking) {
      warnings.push(`Port ${containerPort} is not declared by this container (EXPOSE/ports) — it may still listen on it`);
    }

    const make = (via: UpstreamVia, host: string, port: number, hint: string, needsProxyNetwork = false): ResolveUpstreamResult => ({
      ok: true,
      data: {
        host,
        port,
        scheme: schemeFor(containerPort),
        via,
        hint,
        warnings,
        containerPort,
        protocol,
        engineId: engine.id,
        engineName: engine.name,
        needsProxyNetwork,
      },
    });

    if (local) return resolveLocal(container.containerName, container.stackId, networkMode, live, containerPort, warnings, make);
    return resolveRemote(engine, ports, networkMode, live, containerPort, protocol, warnings, make);
  },
};
