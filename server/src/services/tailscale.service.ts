import http from 'node:http';
import fs from 'node:fs';
import type { TailscalePeer, TailscaleStatus } from '@oblihub/shared';
import { logger } from '../utils/logger';

/**
 * Tailscale LocalAPI client.
 *
 * Talks to the local tailscaled daemon over its Unix domain socket. The socket is mounted into
 * this container by the `tailscale` compose service when the `tailscale` profile is active. When
 * the socket is absent (profile off), every method returns a benign "disabled" status — Oblihub
 * works fine without Tailscale, the UI just hides the related features.
 *
 * LocalAPI reference (HTTP-over-Unix-socket):
 *   GET /localapi/v0/status               → tailscale status JSON
 *
 * The auth model is: anyone who can connect to the socket is trusted. We rely on Docker volume
 * permissions to keep the socket out of reach of unprivileged processes.
 */

const SOCKET_PATH = process.env.TAILSCALE_SOCKET || '/var/run/tailscale/tailscaled.sock';

interface TailscaleRawPeerStatus {
  ID: string;
  HostName: string;
  DNSName: string;
  OS?: string;
  TailscaleIPs?: string[];
  Online: boolean;
  AllowedIPs?: string[];      // routes accepted by this peer (= advertised routes once approved)
  PrimaryRoutes?: string[];   // routes this peer is actively serving as a subnet router
}

interface TailscaleRawSelfStatus extends TailscaleRawPeerStatus {
  // self has the same shape but a few extra fields we don't use
}

interface TailscaleRawStatus {
  BackendState?: string;
  Self?: TailscaleRawSelfStatus;
  Peer?: Record<string, TailscaleRawPeerStatus>;
  MagicDNSSuffix?: string;
  CurrentTailnet?: { Name?: string; MagicDNSSuffix?: string };
}

function socketExists(): boolean {
  try {
    fs.accessSync(SOCKET_PATH, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function httpGetOverUnix(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET_PATH,
        path,
        method: 'GET',
        // tailscaled validates the Host header to prevent DNS rebinding even on a unix socket.
        // "local-tailscaled.sock" is the canonical value used by the official CLI.
        headers: { Host: 'local-tailscaled.sock' },
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('tailscaled LocalAPI timeout')); });
    req.end();
  });
}

function ipv4From(peer: TailscaleRawPeerStatus): string | null {
  const ip = (peer.TailscaleIPs || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  return ip ?? null;
}

function mapPeer(raw: TailscaleRawPeerStatus): TailscalePeer {
  // tailscaled's "AllowedIPs" includes the peer's own /32 — strip it to keep only real routes.
  const ownIp = ipv4From(raw);
  const ownIp6 = (raw.TailscaleIPs || []).find((a) => a.includes(':'));
  const advertised = (raw.AllowedIPs || []).filter((cidr) => {
    if (ownIp && cidr === `${ownIp}/32`) return false;
    if (ownIp6 && cidr === `${ownIp6}/128`) return false;
    return true;
  });
  return {
    id: raw.ID,
    hostname: raw.HostName,
    dnsName: raw.DNSName.replace(/\.$/, ''),
    ipv4: ownIp,
    online: !!raw.Online,
    os: raw.OS || null,
    advertisedRoutes: advertised,
    primaryRoutes: raw.PrimaryRoutes || [],
  };
}

let lastStatusCache: { at: number; value: TailscaleStatus } | null = null;
const STATUS_TTL_MS = 5000;

export const tailscaleService = {
  /**
   * Lightweight check used by routes/UI to decide whether to expose Tailscale features.
   * Cheap: just checks the socket exists.
   */
  isAvailable(): boolean {
    return socketExists();
  },

  async getStatus(force = false): Promise<TailscaleStatus> {
    if (!force && lastStatusCache && Date.now() - lastStatusCache.at < STATUS_TTL_MS) {
      return lastStatusCache.value;
    }
    if (!socketExists()) {
      const disabled: TailscaleStatus = {
        enabled: false,
        selfHostname: null,
        selfDnsName: null,
        selfIpv4: null,
        tailnet: null,
        peers: [],
        message: 'Tailscale sidecar is not running. Start the "tailscale" compose profile with TAILSCALE_AUTHKEY set.',
      };
      lastStatusCache = { at: Date.now(), value: disabled };
      return disabled;
    }
    try {
      const { status, body } = await httpGetOverUnix('/localapi/v0/status');
      if (status !== 200) {
        const value: TailscaleStatus = {
          enabled: false,
          selfHostname: null,
          selfDnsName: null,
          selfIpv4: null,
          tailnet: null,
          peers: [],
          message: `tailscaled returned HTTP ${status}: ${body.slice(0, 200)}`,
        };
        lastStatusCache = { at: Date.now(), value };
        return value;
      }
      const raw = JSON.parse(body) as TailscaleRawStatus;
      const peers = Object.values(raw.Peer || {}).map(mapPeer);
      const value: TailscaleStatus = {
        enabled: raw.BackendState === 'Running',
        selfHostname: raw.Self?.HostName ?? null,
        selfDnsName: raw.Self?.DNSName?.replace(/\.$/, '') ?? null,
        selfIpv4: raw.Self ? ipv4From(raw.Self) : null,
        tailnet: raw.CurrentTailnet?.Name ?? raw.MagicDNSSuffix ?? null,
        peers,
        message: raw.BackendState !== 'Running' ? `Backend state: ${raw.BackendState}` : undefined,
      };
      lastStatusCache = { at: Date.now(), value };
      return value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, 'Tailscale LocalAPI query failed');
      const value: TailscaleStatus = {
        enabled: false,
        selfHostname: null,
        selfDnsName: null,
        selfIpv4: null,
        tailnet: null,
        peers: [],
        message,
      };
      lastStatusCache = { at: Date.now(), value };
      return value;
    }
  },

  /**
   * Build a copy-pasteable install command for a remote host. We don't store the auth key on the
   * server — the operator pastes it from their Tailscale admin console.
   *
   *   subnetRoutes: optional CIDR list to advertise. When provided, the resulting node can be
   *   used as a subnet router so other Tailnet members reach those subnets directly. For Oblihub
   *   the typical case is advertising the remote host's Docker bridge subnets.
   */
  generateInstallCommand(opts: {
    hostname: string;
    authKey?: string;
    subnetRoutes?: string[];
    acceptRoutes?: boolean;
  }): string {
    const hostname = opts.hostname.trim() || 'host';
    const authPart = opts.authKey ? `--authkey=${opts.authKey} ` : '--authkey=<PASTE-YOUR-TSKEY-HERE> ';
    const routes = (opts.subnetRoutes || []).map((r) => r.trim()).filter(Boolean);
    const advertise = routes.length ? `--advertise-routes=${routes.join(',')} ` : '';
    const accept = opts.acceptRoutes ? '--accept-routes ' : '';
    const lines = [
      '# 1. Install Tailscale on the target host',
      'curl -fsSL https://tailscale.com/install.sh | sh',
      '',
      '# 2. Join your Tailnet',
      `sudo tailscale up ${authPart}${advertise}${accept}--hostname=${hostname}`,
    ];
    if (routes.length) {
      lines.push('');
      lines.push('# 3. Approve the advertised routes (one-click) at:');
      lines.push('#    https://login.tailscale.com/admin/machines');
    }
    return lines.join('\n');
  },
};
