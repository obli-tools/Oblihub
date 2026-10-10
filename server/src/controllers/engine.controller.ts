import type { Request, Response, NextFunction } from 'express';
import { engineService } from '../services/engine.service';
import { engineFactsService } from '../services/engineFacts.service';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { validateEngineHost, validateSshUser } from '../utils/engineValidation';
import type { DockerEngineType, HostAgentMode } from '@oblihub/shared';

interface EngineWriteBody {
  name?: string;
  type?: DockerEngineType;
  host?: string;
  port?: number;
  sshUser?: string;
  sshPrivateKey?: string;
  sshKnownHost?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  tlsCa?: string;
  tlsCert?: string;
  tlsKey?: string;
  enabled?: boolean;
  tailscaleHostname?: string | null;
  tailscaleAdvertisedRoutes?: string | null;
  hostAgentMode?: HostAgentMode;
}

const HOST_AGENT_MODES: readonly string[] = ['auto', 'always', 'off'];

/**
 * `host` and `sshUser` are written verbatim into ~/.ssh/config and DOCKER_HOST, so a newline or a
 * shell metacharacter there is an injection, not a typo. Surrounding whitespace is trimmed
 * first (a pasted hostname often carries some) so the stored value is exactly the validated one.
 * `partial` = PATCH: name and type are not required.
 */
function validateWriteBody(body: EngineWriteBody, { partial }: { partial: boolean }): void {
  if (!partial && (!body.name || !body.type)) throw new AppError(400, 'name and type required');
  if (body.hostAgentMode !== undefined && !HOST_AGENT_MODES.includes(body.hostAgentMode as string)) {
    throw new AppError(400, 'hostAgentMode must be auto, always or off');
  }
  for (const field of ['host', 'sshUser'] as const) {
    const value: unknown = body[field];
    if (value == null) continue;
    if (typeof value !== 'string') throw new AppError(400, `${field} must be a string`);
    body[field] = value.trim();
  }
  const hostError = validateEngineHost(body.host);
  if (hostError) throw new AppError(400, hostError);
  const userError = validateSshUser(body.sshUser);
  if (userError) throw new AppError(400, userError);
}

export const engineController = {
  async list(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.json({ success: true, data: await engineService.getAll() }); }
    catch (err) { next(err); }
  },

  /** Auth only (declared before the admin gate): no host, no secret. */
  async listSummary(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.json({ success: true, data: await engineService.getSummaries() }); }
    catch (err) { next(err); }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const engine = await engineService.getById(id);
      if (!engine) throw new AppError(404, 'Engine not found');
      res.json({ success: true, data: engine });
    } catch (err) { next(err); }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as EngineWriteBody;
      validateWriteBody(body, { partial: false });
      const engine = await engineService.create({
        name: body.name!,
        type: body.type!,
        host: body.host,
        port: body.port,
        sshUser: body.sshUser,
        sshPrivateKey: body.sshPrivateKey,
        sshKnownHost: body.sshKnownHost,
        apiKey: body.apiKey,
        apiKeyHeader: body.apiKeyHeader,
        tlsCa: body.tlsCa,
        tlsCert: body.tlsCert,
        tlsKey: body.tlsKey,
        enabled: body.enabled,
        tailscaleHostname: body.tailscaleHostname,
        tailscaleAdvertisedRoutes: body.tailscaleAdvertisedRoutes,
        hostAgentMode: body.hostAgentMode,
      });
      res.json({ success: true, data: engine });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const body = req.body as EngineWriteBody;
      validateWriteBody(body, { partial: true });
      const engine = await engineService.update(id, body);
      if (!engine) throw new AppError(404, 'Engine not found');
      // The host, credentials, enabled flag or host-agent mode may have changed: cached docker info
      // describes the old target, and the agent's log-follow stream is bound to the old client.
      engineFactsService.invalidate(id);
      const { hostAgentService } = await import('../services/hostAgent.service');
      void hostAgentService.reconcileNow(id).catch((err: unknown) =>
        logger.warn({ engineId: id, err: err instanceof Error ? err.message : String(err) }, 'Host agent reconcile after engine update failed'));
      res.json({ success: true, data: engine });
    } catch (err) { next(err); }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      res.json({ success: true, data: await engineService.delete(id) });
    } catch (err) { next(err); }
  },

  async setDefault(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await engineService.setDefault(id);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async testExisting(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const result = await engineService.testConnection(id);
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  async testTransient(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as EngineWriteBody;
      validateWriteBody(body, { partial: false });
      const result = await engineService.testConfig({
        name: body.name!,
        type: body.type!,
        host: body.host,
        port: body.port,
        sshUser: body.sshUser,
        sshPrivateKey: body.sshPrivateKey,
        sshKnownHost: body.sshKnownHost,
        apiKey: body.apiKey,
        apiKeyHeader: body.apiKeyHeader,
        tlsCa: body.tlsCa,
        tlsCert: body.tlsCert,
        tlsKey: body.tlsKey,
        enabled: body.enabled,
        tailscaleHostname: body.tailscaleHostname,
        tailscaleAdvertisedRoutes: body.tailscaleAdvertisedRoutes,
      });
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  /**
   * Generate a fresh ed25519 keypair on the server. The client uses this in the SSH form
   * to populate the private key field and display the public key + install snippet for the user.
   * Returns the keys ONCE — they are never persisted on the server until the user clicks Save.
   */
  async generateSshKey(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // ssh2 is a dependency of dockerode (SSH transport); we add it explicitly to lock the API.
      const ssh2 = await import('ssh2');
      const comment = `oblihub-engine@${new Date().toISOString().slice(0, 10)}`;
      // utils.generateKeyPairSync returns { private, public } in OpenSSH format.
      const keys = (ssh2 as unknown as { utils: { generateKeyPairSync: (kt: string, opts?: { comment?: string }) => { private: string; public: string } } })
        .utils.generateKeyPairSync('ed25519', { comment });
      res.json({ success: true, data: { privateKey: keys.private, publicKey: keys.public, comment } });
    } catch (err) { next(err); }
  },
};
