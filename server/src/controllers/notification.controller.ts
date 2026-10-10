import type { Request, Response, NextFunction } from 'express';
import { notificationService } from '../services/notification.service';
import { AppError } from '../middleware/errorHandler';

export const notificationController = {
  async listChannels(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const channels = await notificationService.getChannels();
      res.json({ success: true, data: channels });
    } catch (err) { next(err); }
  },

  async createChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, type, config } = req.body as { name: string; type: string; config: Record<string, unknown> };
      if (!name || !type) throw new AppError(400, 'Name and type required');
      const channel = await notificationService.createChannel({ name, type, config: config || {}, createdBy: req.session.userId });
      res.status(201).json({ success: true, data: channel });
    } catch (err) { next(err); }
  },

  async updateChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const data = req.body as { name?: string; config?: Record<string, unknown>; isEnabled?: boolean };
      const channel = await notificationService.updateChannel(id, data);
      if (!channel) throw new AppError(404, 'Channel not found');
      res.json({ success: true, data: channel });
    } catch (err) { next(err); }
  },

  async deleteChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const deleted = await notificationService.deleteChannel(id);
      if (!deleted) throw new AppError(404, 'Channel not found');
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async testChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await notificationService.sendTest(id);
      res.json({ success: true, message: 'Test sent' });
    } catch (err) { next(err); }
  },

  async listPlugins(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ success: true, data: notificationService.getPluginMetas() });
    } catch (err) { next(err); }
  },

  async getBindings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const scope = req.query.scope as string || 'global';
      const scopeId = req.query.scopeId ? parseInt(req.query.scopeId as string, 10) : null;
      const bindings = await notificationService.getBindings(scope, scopeId);
      res.json({ success: true, data: bindings });
    } catch (err) { next(err); }
  },

  async addBinding(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { channelId, scope, scopeId, overrideMode } = req.body as { channelId: number; scope: string; scopeId?: number; overrideMode?: string };
      await notificationService.addBinding(channelId, scope, scopeId ?? null, overrideMode);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async removeBinding(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { channelId, scope, scopeId } = req.body as { channelId: number; scope: string; scopeId?: number };
      await notificationService.removeBinding(channelId, scope, scopeId ?? null);
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};
