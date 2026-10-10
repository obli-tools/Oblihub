import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler';
import { azureAuthService } from '../services/azureAuth.service';
import { nginxService } from '../services/nginx.service';

export const azureAuthController = {
  async list(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.json({ success: true, data: await azureAuthService.list() }); }
    catch (err) { next(err); }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, tenantId, clientId, clientSecret, allowedEmails, allowedGroups } = req.body as {
        name?: string; tenantId?: string; clientId?: string; clientSecret?: string;
        allowedEmails?: string[]; allowedGroups?: string[];
      };
      if (!name || !tenantId || !clientId || !clientSecret) {
        throw new AppError(400, 'name, tenantId, clientId, clientSecret all required');
      }
      const provider = await azureAuthService.create({ name, tenantId, clientId, clientSecret, allowedEmails, allowedGroups });
      // Fire-and-forget spawn — UI polls status via list().
      azureAuthService.deployAuthProxy(provider.id).catch(() => { /* logged in service */ });
      res.json({ success: true, data: provider });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const provider = await azureAuthService.update(id, req.body);
      if (!provider) throw new AppError(404, 'Provider not found');
      // Config may have changed — redeploy the sidecar with the new env.
      azureAuthService.deployAuthProxy(id).catch(() => {});
      res.json({ success: true, data: provider });
    } catch (err) { next(err); }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await azureAuthService.delete(id);
      // Any proxy_host that pointed at this provider now has azureAuthProviderId=null (ON DELETE SET NULL).
      // Regen nginx so the auth_request block is removed from those hosts.
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async redeploy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await azureAuthService.deployAuthProxy(id);
      res.json({ success: true, data: await azureAuthService.getById(id) });
    } catch (err) { next(err); }
  },

  async callbackUrls(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const urls = await azureAuthService.listCallbackUrls(id);
      res.json({ success: true, data: urls });
    } catch (err) { next(err); }
  },
};
