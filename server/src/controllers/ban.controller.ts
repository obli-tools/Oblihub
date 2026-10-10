import type { Request, Response, NextFunction } from 'express';
import { banService } from '../services/ban.service';
import { honeypotService } from '../services/honeypot.service';
import { obliguardHubService } from '../services/obliguardHub.service';
import { nginxService } from '../services/nginx.service';
import { AppError } from '../middleware/errorHandler';
import type { BanSourceType } from '@oblihub/shared';

export const banController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const activeOnly = req.query.activeOnly !== 'false';
      const sourceType = req.query.sourceType as BanSourceType | undefined;
      const hostId = req.query.hostId ? parseInt(req.query.hostId as string, 10) : undefined;
      const bans = await banService.list({ activeOnly, sourceType, hostId, enrich: true, limit: 500 });
      res.json({ success: true, data: bans });
    } catch (err) { next(err); }
  },

  async unban(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const ok = await banService.unban(id);
      if (!ok) throw new AppError(404, 'Ban not found');
      // Regen ban_map immediately — the freshly-unbanned IP shouldn't get a 404 on the next tick.
      await nginxService.writeBanMap().catch(() => {});
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async createManual(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const session = req.session as { userId?: number };
      const { ip, reason, banDurationSeconds } = req.body as { ip: string; reason?: string; banDurationSeconds?: number | null };
      if (!ip) throw new AppError(400, 'ip required');
      const ban = await banService.create({
        ip, reason, sourceType: 'manual',
        banDurationSeconds: banDurationSeconds ?? null,
        bannedByUserId: session.userId,
      });
      if (!ban) throw new AppError(400, 'Cannot ban a private / link-local IP');
      await nginxService.writeBanMap().catch(() => {});
      res.json({ success: true, data: ban });
    } catch (err) { next(err); }
  },
};

export const honeypotController = {
  async listForHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hostId = parseInt(req.params.hostId, 10);
      const paths = await honeypotService.list(hostId);
      res.json({ success: true, data: paths });
    } catch (err) { next(err); }
  },

  async replaceAll(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hostId = parseInt(req.params.hostId, 10);
      const { paths } = req.body as { paths: Array<{ path: string; enabled: boolean }> };
      if (!Array.isArray(paths)) throw new AppError(400, 'paths must be an array');
      await honeypotService.replaceAll(hostId, paths);
      // Regen the full nginx config — honeypot paths are baked into vhost location blocks.
      await nginxService.regenerateAndReload().catch(() => {});
      const fresh = await honeypotService.list(hostId);
      res.json({ success: true, data: fresh });
    } catch (err) { next(err); }
  },

  async addPreset(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hostId = parseInt(req.params.hostId, 10);
      const paths = await honeypotService.addDefaultPreset(hostId);
      await nginxService.regenerateAndReload().catch(() => {});
      res.json({ success: true, data: paths });
    } catch (err) { next(err); }
  },

  async getDefaults(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const defaults = await honeypotService.getDefaults();
      res.json({ success: true, data: defaults });
    } catch (err) { next(err); }
  },
};

export const obliguardController = {
  async status(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = await obliguardHubService.getStatus();
      res.json({ success: true, data: status });
    } catch (err) { next(err); }
  },

  async testPing(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await obliguardHubService.testPing();
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },
};
