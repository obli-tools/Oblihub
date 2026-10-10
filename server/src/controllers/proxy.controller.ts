import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { proxyHostService, redirectionService, streamService, deadHostService, certificateService, accessListService, customPageService } from '../services/proxy.service';
import { stackService } from '../services/stack.service';
import { dockerService } from '../services/docker.service';
import { nginxService } from '../services/nginx.service';
import { letsEncryptService } from '../services/certificate.service';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { teamService } from '../services/team.service';
import { proxyUpstreamService, ORPHAN_MSG } from '../services/proxyUpstream.service';
import type { ResolvedUpstream } from '@oblihub/shared';

export const proxyController = {
  // ── Proxy Hosts ──

  async listProxyHosts(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hosts = await proxyHostService.getAll();
      res.json({ success: true, data: hosts });
    } catch (err) { next(err); }
  },

  async getProxyHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const host = await proxyHostService.getById(parseInt(req.params.id, 10));
      if (!host) throw new AppError(404, 'Proxy host not found');
      res.json({ success: true, data: host });
    } catch (err) { next(err); }
  },

  async createProxyHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const host = await proxyHostService.create(req.body);
      await nginxService.regenerateAndReload();
      // Re-evaluate which managed stack services need the shared `proxy` network — a new
      // forward_host may now match a compose service that wasn't proxied before.
      void proxyController._refreshProxyNetworks();
      // If this host uses an Azure AD provider, the sidecar's WHITELIST_DOMAINS env just
      // became stale — redeploy it so the new domain is accepted post-auth.
      if (host.azureAuthProviderId) void proxyController._refreshAzureAuthProvider(host.azureAuthProviderId);
      // Auto-create uptime monitor if requested
      if (host.autoMonitor && host.domainNames[0]) {
        const { rescheduleMonitor } = await import('../workers/UptimeWorker');
        const scheme = host.sslForced ? 'https' : 'http';
        const [row] = await db('uptime_monitors').insert({
          name: host.domainNames[0],
          url: `${scheme}://${host.domainNames[0]}`,
          type: 'http',
          interval_seconds: 60,
          timeout_ms: 5000,
          expected_status: 200,
          proxy_host_id: host.id,
          enabled: true,
        }).returning('*');
        rescheduleMonitor(row.id, 60, true);
      }
      res.json({ success: true, data: host });
    } catch (err) { next(err); }
  },

  async updateProxyHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      // Snapshot the pre-update provider so we can detect a change and refresh both sides.
      const before = await proxyHostService.getById(id);
      const host = await proxyHostService.update(id, req.body);
      if (!host) throw new AppError(404, 'Proxy host not found');
      await nginxService.regenerateAndReload();
      // forward_host may have changed → re-evaluate proxy network membership.
      void proxyController._refreshProxyNetworks();
      // Refresh Azure sidecar whitelist for both the old and new provider (may be the same).
      const providers = new Set<number>();
      if (before?.azureAuthProviderId) providers.add(before.azureAuthProviderId);
      if (host.azureAuthProviderId) providers.add(host.azureAuthProviderId);
      for (const pid of providers) void proxyController._refreshAzureAuthProvider(pid);
      res.json({ success: true, data: host });
    } catch (err) { next(err); }
  },

  async deleteProxyHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const before = await proxyHostService.getById(id);
      await proxyHostService.delete(id);
      await nginxService.regenerateAndReload();
      // Deleted host means the target service may no longer need to be on `proxy`.
      void proxyController._refreshProxyNetworks();
      if (before?.azureAuthProviderId) void proxyController._refreshAzureAuthProvider(before.azureAuthProviderId);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /** Fire-and-forget refresh of proxy network membership across all deployed managed stacks. */
  async _refreshProxyNetworks(): Promise<void> {
    try {
      const { composeService } = await import('../services/compose.service');
      await composeService.refreshProxyNetworksForAllStacks();
    } catch (err) {
      logger.warn({ err }, 'refreshProxyNetworksForAllStacks failed');
    }
  },

  /**
   * Fire-and-forget redeploy of a specific Azure AD sidecar. The sidecar's
   * OAUTH2_PROXY_WHITELIST_DOMAINS env is computed at deploy time from the set of proxy_hosts
   * referencing this provider — without a redeploy, adding/removing a host leaves the sidecar
   * with a stale whitelist and post-auth redirects fail with "domain / port not in whitelist".
   */
  async _refreshAzureAuthProvider(providerId: number): Promise<void> {
    try {
      const { azureAuthService } = await import('../services/azureAuth.service');
      await azureAuthService.deployAuthProxy(providerId);
    } catch (err) {
      logger.warn({ err, providerId }, 'refresh of Azure auth sidecar failed');
    }
  },

  /**
   * Manual "Restore proxy connections" — awaits the same reconciliation the internal handlers
   * call fire-and-forget. Meant for the recovery flow after the proxy network gets recreated
   * (e.g. `docker compose up -d` on Oblihub recreates the network when config drifted), which
   * detaches all foreign-stack containers. Reattaches everything based on the current
   * proxy_hosts config. Idempotent — safe to click anytime.
   */
  async restoreProxyNetworks(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { composeService } = await import('../services/compose.service');
      await composeService.refreshProxyNetworksForAllStacks();
      res.json({ success: true, message: 'Proxy network membership reconciled across all deployed stacks' });
    } catch (err) { next(err); }
  },

  async toggleProxyHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const host = await proxyHostService.getById(id);
      if (!host) throw new AppError(404, 'Proxy host not found');
      await proxyHostService.update(id, { enabled: !host.enabled });
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: { enabled: !host.enabled } });
    } catch (err) { next(err); }
  },

  // ── Certificates ──

  async listCertificates(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const certs = await certificateService.getAll();
      res.json({ success: true, data: certs });
    } catch (err) { next(err); }
  },

  async createCertificate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { domainNames, provider, acmeEmail } = req.body;
      if (!domainNames?.length) throw new AppError(400, 'Domain names required');

      const cert = await certificateService.create({ domainNames, provider: provider || 'letsencrypt', acmeEmail });

      // Start certificate provisioning in background
      if (provider === 'letsencrypt' || !provider) {
        if (!acmeEmail) throw new AppError(400, 'Email required for Let\'s Encrypt');
        letsEncryptService.requestCertificate(cert.id, domainNames, acmeEmail).catch(err => {
          logger.error({ certId: cert.id, err }, 'Background cert provisioning failed');
        });
      }

      res.json({ success: true, data: cert });
    } catch (err) { next(err); }
  },

  async uploadCertificate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const { certificate, key, chain } = req.body;
      if (!certificate || !key) throw new AppError(400, 'Certificate and key required');
      await letsEncryptService.uploadCustomCert(id, certificate, key, chain);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async deleteCertificate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await certificateService.delete(parseInt(req.params.id, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /**
   * Re-trigger a Let's Encrypt request on an existing certificate. The previous request_log
   * is cleared by the LE flow itself so the UI focuses on the fresh attempt.
   *
   * Use case: first attempt failed (DNS not propagated yet, port 80 firewall'd, …) — the
   * operator fixes the underlying issue and clicks Retry instead of having to delete and
   * re-create the cert (which would also drop the proxy_host link).
   */
  async retryCertificate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const cert = await certificateService.getById(id);
      if (!cert) throw new AppError(404, 'Certificate not found');
      if (cert.provider !== 'letsencrypt') throw new AppError(400, 'Retry is only supported for Let\'s Encrypt certificates');
      if (!cert.acmeEmail) throw new AppError(400, 'Certificate has no ACME email configured');
      if (!cert.domainNames?.length) throw new AppError(400, 'Certificate has no domains configured');

      // Fire-and-forget — UI polls /certificates and watches request_log fill up live.
      letsEncryptService.requestCertificate(id, cert.domainNames, cert.acmeEmail).catch(err => {
        logger.error({ certId: id, err }, 'Retry of LE provisioning failed');
      });
      res.json({ success: true, message: 'Retry started' });
    } catch (err) { next(err); }
  },

  // ── Redirections ──

  async listRedirections(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.json({ success: true, data: await redirectionService.getAll() }); } catch (err) { next(err); }
  },

  async createRedirection(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const host = await redirectionService.create(req.body);
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: host });
    } catch (err) { next(err); }
  },

  async updateRedirection(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const host = await redirectionService.update(parseInt(req.params.id, 10), req.body);
      if (!host) throw new AppError(404, 'Redirection not found');
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: host });
    } catch (err) { next(err); }
  },

  async deleteRedirection(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await redirectionService.delete(parseInt(req.params.id, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Streams ──

  async listStreams(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.json({ success: true, data: await streamService.getAll() }); } catch (err) { next(err); }
  },

  async createStream(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stream = await streamService.create(req.body);
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: stream });
    } catch (err) { next(err); }
  },

  async updateStream(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stream = await streamService.update(parseInt(req.params.id, 10), req.body);
      if (!stream) throw new AppError(404, 'Stream not found');
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: stream });
    } catch (err) { next(err); }
  },

  async deleteStream(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await streamService.delete(parseInt(req.params.id, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Dead Hosts ──

  async listDeadHosts(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.json({ success: true, data: await deadHostService.getAll() }); } catch (err) { next(err); }
  },

  async createDeadHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const host = await deadHostService.create(req.body);
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: host });
    } catch (err) { next(err); }
  },

  async deleteDeadHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await deadHostService.delete(parseInt(req.params.id, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Access Lists ──

  async listAccessLists(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.json({ success: true, data: await accessListService.getAll() }); } catch (err) { next(err); }
  },

  async createAccessList(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const list = await accessListService.create(req.body);
      res.json({ success: true, data: list });
    } catch (err) { next(err); }
  },

  async deleteAccessList(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await accessListService.delete(parseInt(req.params.id, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /** Rename the access list and/or toggle its satisfyAny / passAuth flags. */
  async updateAccessList(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as { name?: string; satisfyAny?: boolean; passAuth?: boolean };
      const updated = await accessListService.update(parseInt(req.params.id, 10), body);
      if (!updated) throw new AppError(404, 'Access list not found');
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  async addAccessListClient(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { address, directive } = req.body;
      if (!address) throw new AppError(400, 'Address required');
      await accessListService.addClient(parseInt(req.params.id, 10), address, directive || 'allow');
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async removeAccessListClient(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await accessListService.removeClient(parseInt(req.params.clientId, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /** Edit an existing IP rule in place — change the address and/or allow/deny directive. */
  async updateAccessListClient(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { address, directive } = req.body as { address?: string; directive?: 'allow' | 'deny' };
      await accessListService.updateClient(parseInt(req.params.clientId, 10), { address, directive });
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async addAccessListAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username, password } = req.body;
      if (!username || !password) throw new AppError(400, 'Username and password required');
      // Hash password for htpasswd (apr1 compatible)
      const bcrypt = await import('bcrypt');
      const hash = await bcrypt.hash(password, 10);
      await accessListService.addAuth(parseInt(req.params.id, 10), username, hash);
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async removeAccessListAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await accessListService.removeAuth(parseInt(req.params.authId, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /**
   * Edit a basic-auth entry — rename the user and/or rotate the password. `password` is
   * optional: omitting it keeps the existing hash so the operator can rename a user without
   * forcing them to send a new password.
   */
  async updateAccessListAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username, password } = req.body as { username?: string; password?: string };
      let passwordHash: string | undefined;
      if (password) {
        const bcrypt = await import('bcrypt');
        passwordHash = await bcrypt.hash(password, 10);
      }
      await accessListService.updateAuth(parseInt(req.params.authId, 10), { username, passwordHash });
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Nginx control ──

  async reloadNginx(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await nginxService.regenerateAndReload();
      res.json({ success: true, message: 'Nginx reloaded' });
    } catch (err) { next(err); }
  },

  async testNginx(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await nginxService.testConfig();
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  // ── Custom Pages ──

  async listCustomPages(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.json({ success: true, data: await customPageService.getAll() }); } catch (err) { next(err); }
  },

  async createCustomPage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, description, errorCodes, htmlContent, theme, isWakingPage } = req.body;
      if (!name || !htmlContent) throw new AppError(400, 'Name and HTML content required');
      const page = await customPageService.create({ name, description, errorCodes: errorCodes || [500], htmlContent, theme, isWakingPage });
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: page });
    } catch (err) { next(err); }
  },

  async updateCustomPage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const page = await customPageService.update(id, req.body);
      if (!page) throw new AppError(404, 'Custom page not found');
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: page });
    } catch (err) { next(err); }
  },

  async deleteCustomPage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await customPageService.delete(parseInt(req.params.id, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Stack integration ──

  async getProxyHostsByStack(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stackId = parseInt(req.params.stackId, 10);
      const hosts = await proxyHostService.getByStackId(stackId);
      res.json({ success: true, data: hosts });
    } catch (err) { next(err); }
  },

  async quickSetupProxyHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { stackId, containerId, domainNames, forwardPort, requestCertificate, acmeEmail, forwardHost, forwardScheme } = req.body as {
        stackId: number; containerId: number; domainNames: string[]; forwardPort: number;
        requestCertificate?: boolean; acmeEmail?: string;
        forwardHost?: string; forwardScheme?: 'http' | 'https';
      };

      if (!domainNames?.length) throw new AppError(400, 'At least one domain required');
      if (!forwardPort) throw new AppError(400, 'Forward port required');
      const requestedPort = Number(forwardPort);
      if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
        throw new AppError(400, 'Forward port must be an integer between 1 and 65535');
      }

      const cid = Number(containerId);
      if (!Number.isInteger(cid)) throw new AppError(400, 'containerId required');

      // The container id travels in the body, so requireContainerAccess() cannot guard this route;
      // without this check any proxy manager could expose a container of another team.
      const session = req.session as { userId?: number; role?: string };
      if (session.role !== 'admin') {
        const allowed = session.userId != null
          && await teamService.userHasAccess(session.userId, 'container', cid);
        if (!allowed) throw new AppError(403, 'Access denied');
      }

      const container = await stackService.getContainerById(cid);
      if (!container) throw new AppError(404, 'Container not found');
      if (container.engineId == null) throw new AppError(409, ORPHAN_MSG);

      let targetHost: string;
      let targetPort: number;
      let targetScheme: 'http' | 'https';
      let upstream: ResolvedUpstream | null = null;
      if (forwardHost !== undefined && forwardHost !== null) {
        const h = typeof forwardHost === 'string' ? forwardHost.trim() : '';
        if (!h || h.length > 255 || /\s/.test(h)) {
          throw new AppError(400, 'forwardHost must be a non-empty host name of at most 255 characters without whitespace');
        }
        if (forwardScheme !== undefined && forwardScheme !== 'http' && forwardScheme !== 'https') {
          throw new AppError(400, 'forwardScheme must be http or https');
        }
        targetHost = h;
        targetPort = requestedPort;
        targetScheme = forwardScheme ?? 'http';
      } else {
        // Storing the bare container name used to break every remote-engine target: the hub's
        // nginx cannot resolve a name that lives on another daemon.
        const r = await proxyUpstreamService.resolve(container.id, { port: requestedPort });
        if (!r.ok) throw new AppError(r.status, r.error);
        targetHost = r.data.host;
        targetPort = r.data.port;
        targetScheme = r.data.scheme;
        upstream = r.data;
      }

      // Create certificate if requested
      let certificateId: number | null = null;
      if (requestCertificate) {
        if (!acmeEmail) throw new AppError(400, 'Email required for Let\'s Encrypt');
        const cert = await certificateService.create({ domainNames, provider: 'letsencrypt', acmeEmail });
        certificateId = cert.id;
        // Start LE provisioning in background
        letsEncryptService.requestCertificate(cert.id, domainNames, acmeEmail).catch(err => {
          logger.error({ certId: cert.id, err }, 'Background cert provisioning failed');
        });
      }

      // Create proxy host with sensible defaults
      const host = await proxyHostService.create({
        domainNames,
        forwardScheme: targetScheme,
        forwardHost: targetHost,
        forwardPort: targetPort,
        certificateId,
        sslForced: !!requestCertificate,
        http2Support: !!requestCertificate,
        hstsEnabled: false,
        hstsSubdomains: false,
        blockExploits: true,
        cachingEnabled: false,
        websocketSupport: true,
        enabled: true,
        stackId,
        autoMonitor: true,
      });

      await nginxService.regenerateAndReload();

      // Auto-create uptime monitor
      const { rescheduleMonitor } = await import('../workers/UptimeWorker');
      const scheme = requestCertificate ? 'https' : 'http';
      const [monitorRow] = await db('uptime_monitors').insert({
        name: domainNames[0],
        url: `${scheme}://${domainNames[0]}`,
        type: 'http',
        interval_seconds: 60,
        timeout_ms: 5000,
        expected_status: 200,
        proxy_host_id: host.id,
        enabled: true,
      }).returning('*');
      rescheduleMonitor(monitorRow.id, 60, true);

      // Same attach-only refresh as create/update: only deployed MANAGED stacks get wired to the
      // proxy network; any other container stays where it is.
      void proxyController._refreshProxyNetworks();

      logger.info({ hostId: host.id, domains: domainNames, forward: `${targetScheme}://${targetHost}:${targetPort}`, via: upstream?.via ?? 'manual', monitorId: monitorRow.id }, 'Quick setup proxy host + monitor created');
      res.json({ success: true, data: host, upstream });
    } catch (err) { next(err); }
  },

  async getProxyStatus(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Check if proxy container is running
      let nginxRunning = false;
      try {
        const containers = await dockerService.listContainers();
        nginxRunning = containers.some(c => c.labels['oblihub.proxy'] === 'true');
      } catch { /* ignore */ }

      const allHosts = await proxyHostService.getAll();
      const allCerts = await certificateService.getAll();

      res.json({
        success: true,
        data: {
          nginxRunning,
          proxyHostCount: allHosts.length,
          enabledHostCount: allHosts.filter(h => h.enabled).length,
          certificateCount: allCerts.length,
          validCertCount: allCerts.filter(c => c.status === 'valid').length,
          expiringSoon: allCerts.filter(c => c.status === 'valid' && c.expiresAt && new Date(c.expiresAt).getTime() < Date.now() + 14 * 24 * 60 * 60 * 1000).length,
        },
      });
    } catch (err) { next(err); }
  },
};
