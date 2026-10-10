import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { sshKeyService } from '../services/sshKey.service';
import { workflowTargetService } from '../services/workflowTarget.service';
import { workflowService, _runWorkflow as runWorkflow } from '../services/workflow.service';
import { AppError } from '../middleware/errorHandler';

/**
 * All three automation resources (ssh_keys, workflow_targets, workflows) share the same
 * ownership model: team-scoped OR personal OR global (both team_id and owner_user_id null).
 * This helper resolves the buckets a given user is allowed to see so the service layer can
 * filter accordingly. Admins see everything; regular users see their teams + their personal
 * items + global.
 */
async function resolveVisibility(req: Request): Promise<{ teamIds: number[]; ownerUserId: number; includeGlobal: boolean }> {
  // Oblihub uses express-session, not Passport — the authenticated identity lives on
  // req.session, not req.user. Earlier versions of this file read the wrong slot and
  // returned 401 on every read for every user. See auth.ts SessionData for the shape.
  const session = req.session as { userId?: number; role?: string };
  if (!session.userId) throw new AppError(401, 'Not authenticated');
  const isAdmin = session.role === 'admin';
  const teamRows = await db('team_members').where({ user_id: session.userId }).pluck('team_id');
  return {
    teamIds: teamRows as number[],
    ownerUserId: session.userId,
    // Global scope = admin-managed shared resources. Non-admins can SEE them too — needed so a
    // "user" role team member can reference a global SSH key in a workflow target they create.
    includeGlobal: true || isAdmin,
  };
}

// ── SSH keys ──

export const sshKeyController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const vis = await resolveVisibility(req);
      const keys = await sshKeyService.list(vis);
      res.json({ success: true, data: keys });
    } catch (err) { next(err); }
  },

  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const key = await sshKeyService.getById(id);
      if (!key) throw new AppError(404, 'SSH key not found');
      res.json({ success: true, data: key });
    } catch (err) { next(err); }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const session = req.session as { userId?: number };
      const user = { id: session.userId! };
      const { name, description, teamId, ownerUserId, keyType } = req.body;
      if (!name) throw new AppError(400, 'name required');
      const key = await sshKeyService.create({
        name, description, teamId, ownerUserId, keyType,
        createdByUserId: user.id,
      });
      res.json({ success: true, data: key });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const key = await sshKeyService.update(id, req.body);
      if (!key) throw new AppError(404, 'SSH key not found');
      res.json({ success: true, data: key });
    } catch (err) { next(err); }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await sshKeyService.delete(id);
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};

// ── Workflow targets ──

export const workflowTargetController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const vis = await resolveVisibility(req);
      const items = await workflowTargetService.list(vis);
      res.json({ success: true, data: items });
    } catch (err) { next(err); }
  },

  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const t = await workflowTargetService.getById(id);
      if (!t) throw new AppError(404, 'Target not found');
      res.json({ success: true, data: t });
    } catch (err) { next(err); }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const session = req.session as { userId?: number };
      const user = { id: session.userId! };
      const body = req.body;
      if (!body.name || !body.host || !body.username || !body.remotePath || !body.sshKeyId) {
        throw new AppError(400, 'name, host, username, remotePath and sshKeyId are required');
      }
      const t = await workflowTargetService.create({ ...body, createdByUserId: user.id });
      res.json({ success: true, data: t });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const t = await workflowTargetService.update(id, req.body);
      if (!t) throw new AppError(404, 'Target not found');
      res.json({ success: true, data: t });
    } catch (err) { next(err); }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await workflowTargetService.delete(id);
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};

// ── Workflows ──

export const workflowController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const vis = await resolveVisibility(req);
      const items = await workflowService.list(vis);
      res.json({ success: true, data: items });
    } catch (err) { next(err); }
  },

  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const w = await workflowService.getById(id);
      if (!w) throw new AppError(404, 'Workflow not found');
      res.json({ success: true, data: w });
    } catch (err) { next(err); }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const session = req.session as { userId?: number };
      const user = { id: session.userId! };
      const body = req.body;
      if (!body.name || !body.actionType || !body.triggerType) {
        throw new AppError(400, 'name, actionType and triggerType are required');
      }
      const w = await workflowService.create({ ...body, createdByUserId: user.id });
      res.json({ success: true, data: w });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const w = await workflowService.update(id, req.body);
      if (!w) throw new AppError(404, 'Workflow not found');
      res.json({ success: true, data: w });
    } catch (err) { next(err); }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await workflowService.delete(id);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /**
   * Run a workflow now (on-demand button). Runs fire-and-forget so a slow SFTP push doesn't
   * block the HTTP response; the runner records a workflow_runs row that the UI polls.
   */
  async runNow(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const w = await workflowService.getById(id);
      if (!w) throw new AppError(404, 'Workflow not found');
      // Fire-and-forget; the runner records everything.
      runWorkflow(w, 'on-demand').catch(() => { /* runner logs its own errors */ });
      res.json({ success: true, message: 'Workflow started' });
    } catch (err) { next(err); }
  },

  async listRuns(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const limit = Math.min(200, parseInt((req.query.limit as string) || '50', 10));
      const runs = await workflowService.listRuns(id, limit);
      res.json({ success: true, data: runs });
    } catch (err) { next(err); }
  },
};
