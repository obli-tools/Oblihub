import type { Request, Response, NextFunction } from 'express';
import { sleepService, ORPHAN_ENGINE_MESSAGE } from '../services/sleep.service';
import { stackService } from '../services/stack.service';
import { AppError } from '../middleware/errorHandler';
import type { SleepMode } from '@oblihub/shared';

export const sleepController = {
  async updateConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const { sleepEnabled, sleepAfterSeconds, sleepMode, wakeHealthPath } = req.body as {
        sleepEnabled?: boolean;
        sleepAfterSeconds?: number;
        sleepMode?: SleepMode;
        wakeHealthPath?: string | null;
      };
      const container = await sleepService.updateConfig(id, { sleepEnabled, sleepAfterSeconds, sleepMode, wakeHealthPath });
      if (!container) throw new AppError(404, 'Container not found');
      res.json({ success: true, data: container });
    } catch (err) { next(err); }
  },

  async sleepNow(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const c = await stackService.getContainerById(id);
      if (!c) throw new AppError(404, 'Container not found');
      // Orphan: the service refuses it too; 409 because it is a state conflict, not a failure.
      if (c.engineId == null) throw new AppError(409, ORPHAN_ENGINE_MESSAGE);
      const r = await sleepService.sleep(id);
      if (!r.ok) throw new AppError(500, r.message || 'Sleep failed');
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async wakeNow(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const c = await stackService.getContainerById(id);
      if (!c) throw new AppError(404, 'Container not found');
      // The background wake would refuse an orphan silently; say so instead of "Wake started".
      if (c.engineId == null) throw new AppError(409, ORPHAN_ENGINE_MESSAGE);
      // Run wake in background — caller can poll status. Returns immediately.
      sleepService.wake(id).catch(() => { /* state already set on failure */ });
      res.json({ success: true, message: 'Wake started' });
    } catch (err) { next(err); }
  },

  async wakeStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const status = await sleepService.getWakeStatus(id);
      res.json({ success: true, data: status });
    } catch (err) { next(err); }
  },
};
