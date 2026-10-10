import type { Request, Response, NextFunction } from 'express';
import { tailscaleService } from '../services/tailscale.service';
import { engineService } from '../services/engine.service';
import { proxyUpstreamService, parsePortQuery } from '../services/proxyUpstream.service';

interface InstallCommandBody {
  hostname?: string;
  authKey?: string;
  subnetRoutes?: string[];
  acceptRoutes?: boolean;
  // When set, the server probes the target engine for its Docker bridge subnets and includes them
  // in --advertise-routes automatically. Convenient for the "Bridge routing" UI mode.
  discoverFromEngineId?: number;
}

export const tailscaleController = {
  /** Status of the local tailscaled (enabled? peers? self IP/hostname). Returns enabled:false
   *  gracefully when the sidecar isn't running — never throws. */
  async status(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = await tailscaleService.getStatus();
      res.json({ success: true, data: status });
    } catch (err) { next(err); }
  },

  async installCommand(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as InstallCommandBody;
      const hostname = (body.hostname || '').trim();
      if (!hostname) {
        res.status(400).json({ success: false, error: 'hostname is required' });
        return;
      }

      let subnetRoutes = body.subnetRoutes || [];
      if (body.discoverFromEngineId) {
        // Bridge-routing mode: query the remote daemon to list its bridge subnets, then advertise
        // them. We do this server-side so the operator doesn't have to ssh into the host to figure
        // it out — they already configured the engine, we already have a working client.
        try {
          const { dockerService } = await import('../services/docker.service');
          const client = await dockerService.forEngine(body.discoverFromEngineId);
          const networks = await client.listNetworks();
          const cidrs: string[] = [];
          for (const net of networks) {
            // Only bridge-driver networks have an interesting subnet — skip host/null/overlay.
            if (net.Driver !== 'bridge') continue;
            const ipam = (net as { IPAM?: { Config?: Array<{ Subnet?: string }> } }).IPAM;
            for (const cfg of ipam?.Config || []) {
              if (cfg.Subnet && !cidrs.includes(cfg.Subnet)) cidrs.push(cfg.Subnet);
            }
          }
          subnetRoutes = [...new Set([...subnetRoutes, ...cidrs])];
        } catch (err) {
          // Don't fail the whole request — just return the command without auto-discovered routes
          // and surface the reason so the user knows why nothing was prepopulated.
          res.json({
            success: true,
            data: {
              command: tailscaleService.generateInstallCommand({
                hostname,
                authKey: body.authKey,
                subnetRoutes,
                acceptRoutes: body.acceptRoutes,
              }),
              subnetRoutes,
              discoveryError: err instanceof Error ? err.message : String(err),
            },
          });
          return;
        }
      }

      const command = tailscaleService.generateInstallCommand({
        hostname,
        authKey: body.authKey,
        subnetRoutes,
        acceptRoutes: body.acceptRoutes,
      });
      res.json({ success: true, data: { command, subnetRoutes } });
    } catch (err) { next(err); }
  },

  /** Same resolver (and response shape) as GET /api/containers/:id/upstream; kept for callers of
   *  the older admin-only route. */
  async resolveContainerUpstream(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const containerId = parseInt(req.params.containerId, 10);
      if (!Number.isFinite(containerId)) {
        res.status(400).json({ success: false, error: 'Invalid container id' });
        return;
      }
      const port = parsePortQuery(req.query.port);
      if (port === undefined) {
        res.status(400).json({ success: false, error: 'port must be an integer between 1 and 65535' });
        return;
      }
      const r = await proxyUpstreamService.resolve(containerId, { port });
      if (!r.ok) {
        res.status(r.status).json({ success: false, error: r.error });
        return;
      }
      res.json({ success: true, data: r.data });
    } catch (err) { next(err); }
  },

  /**
   * Returns the list of Tailnet peers in a shape ready to populate an autocomplete dropdown for
   * the Engine SSH form. Pre-filters offline peers? No — we keep all of them; the user might be
   * configuring an engine for a host that's currently offline.
   */
  async peerSuggestions(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = await tailscaleService.getStatus();
      const engines = await engineService.getAll();
      const usedHostnames = new Set(
        engines.map((e) => e.tailscaleHostname).filter((h): h is string => !!h)
      );
      const suggestions = status.peers.map((p) => ({
        hostname: p.hostname,
        dnsName: p.dnsName,
        ipv4: p.ipv4,
        online: p.online,
        os: p.os,
        alreadyAttached: !!p.dnsName && usedHostnames.has(p.dnsName),
      }));
      res.json({ success: true, data: suggestions });
    } catch (err) { next(err); }
  },
};
