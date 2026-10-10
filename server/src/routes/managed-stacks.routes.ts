import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { managedStackController } from '../controllers/managed-stack.controller';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import { AppError } from '../middleware/errorHandler';
import { managedStackService, canAccessManagedStack, assertCallerMayTakeProject } from '../services/managed-stack.service';
import { engineFactsService } from '../services/engineFacts.service';
import { logger } from '../utils/logger';
import { toComposeProject } from '../utils/composeProject';
import { config } from '../config';

const router = Router();

router.use(requireAuth);
router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!config.allowStack) { res.status(403).json({ success: false, error: 'Stack management is disabled' }); return; }
  next();
});

// In-memory uploads capped at 100 MB. Source archives for build stacks are typically <10 MB;
// the cap protects against accidental dumps of node_modules / built artifacts. Bump if needed.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

type Session = { userId?: number; role?: string };
/** A managed stack as the per-id guard keys it: its id, and its compose project on its managed engine. */
type StackKey = { id: number; composeProject: string; engineId: number | null };

const INT4_MAX = 2_147_483_647;

/**
 * A rename or an engine move points the stack at another (project, daemon). Without this check a
 * non-admin could take over another team's project there, or Oblihub's own: the next deploy runs
 * the caller's compose under that project name and recreates those containers (Oblihub's own
 * project even goes through the self-update helper, which copies the compose over Oblihub's).
 * Same guard as create() (assertCallerMayTakeProject): Oblihub's own project is reserved on every
 * engine (its folder is on the hub whatever the target), another team's stack folder is refused on
 * any engine, and so is a folder no managed stack claims. The stack's own row and folder never count
 * against it; an empty target is fine, as in create().
 */
async function assertMoveTargetAllowed(session: Session, stack: StackKey, project: string, engineId: number | null): Promise<void> {
  const targetDaemon = await engineFactsService.managedDaemonKey(engineId);
  if (project === stack.composeProject && targetDaemon === await engineFactsService.managedDaemonKey(stack.engineId)) return;
  await assertCallerMayTakeProject(session, project, engineId, stack.id);
}

/** The stack the per-id guard loaded (non-admin requests only), else a fresh read. */
async function loadStack(req: Request, res: Response): Promise<StackKey> {
  const cached = res.locals.managedStack as StackKey | undefined;
  if (cached) return cached;
  const id = Number(req.params.id);
  const stack = await managedStackService.getById(id);
  if (!stack) throw new AppError(404, 'Managed stack not found');
  return { id, composeProject: stack.composeProject, engineId: stack.engineId };
}

/**
 * Per-stack authorization for every /:id route. router.param runs before the route's own
 * middleware, so an unauthorized zip upload is refused before multer buffers up to 100 MB of it.
 * The id must be all digits: the controllers parseInt() it, and "5abc" would otherwise be checked
 * as one value here and acted on as stack 5 there.
 */
router.param('id', async (req: Request, res: Response, next: NextFunction, value: string) => {
  try {
    const id = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(id) || id > INT4_MAX) throw new AppError(404, 'Managed stack not found');
    const session = req.session as Session;
    if (session.role === 'admin') { next(); return; }
    const stack = await managedStackService.getById(id);
    if (!stack) throw new AppError(404, 'Managed stack not found');
    const key: StackKey = { id, composeProject: stack.composeProject, engineId: stack.engineId };
    if (!(await canAccessManagedStack(session.userId!, key))) {
      logger.warn({ userId: session.userId, managedStackId: id, project: stack.composeProject }, 'Managed stack access denied (no team)');
      throw new AppError(403, 'Access denied: you are not a member of a team with access to this stack');
    }
    res.locals.managedStack = key;
    next();
  } catch (err) { next(err); }
});

/** PUT /:id may rename the stack (name → compose project) or move it (engineId). */
async function requireUpdateTargetAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = req.session as Session;
    if (session.role === 'admin') { next(); return; }
    const body = (req.body ?? {}) as { name?: unknown; engineId?: unknown };
    if (body.name === undefined && body.engineId === undefined) { next(); return; }
    if (body.name !== undefined && typeof body.name !== 'string') throw new AppError(400, 'name must be a string');
    if (body.engineId != null && !Number.isInteger(body.engineId)) throw new AppError(400, 'engineId must be an integer or null');
    const stack = await loadStack(req, res);
    await assertMoveTargetAllowed(
      session,
      stack,
      typeof body.name === 'string' ? toComposeProject(body.name) : stack.composeProject,
      body.engineId !== undefined ? body.engineId as number | null : stack.engineId,
    );
    next();
  } catch (err) { next(err); }
}

/** POST /:id/migrate-engine moves the same project to `targetEngineId`. */
async function requireMigrateTargetAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = req.session as Session;
    if (session.role === 'admin') { next(); return; }
    const body = (req.body ?? {}) as { targetEngineId?: unknown };
    // A missing target is the controller's 400.
    if (!('targetEngineId' in body)) { next(); return; }
    if (body.targetEngineId != null && !Number.isInteger(body.targetEngineId)) throw new AppError(400, 'targetEngineId must be an integer or null');
    const stack = await loadStack(req, res);
    await assertMoveTargetAllowed(session, stack, stack.composeProject, (body.targetEngineId ?? null) as number | null);
    next();
  } catch (err) { next(err); }
}

// Permission keys as on the discovered-stack routes (stacks.routes.ts): stacks.view to read,
// stacks.manage to create / edit / delete (down, source replacement and engine moves included, as
// they rewrite or remove what runs), stacks.deploy for the compose verbs that (re)start the stack
// from its stored definition, stacks.stop to stop it.
router.get('/', managedStackController.list);
router.post('/', requirePermission('stacks.manage'), managedStackController.create);
// stacks.manage: the stack editor, its only caller, needs it to save anyway, and the answer maps
// host ports to other stacks' containers on the engine.
router.post('/check-port-conflicts', requirePermission('stacks.manage'), managedStackController.checkPortConflicts);
router.get('/:id', requirePermission('stacks.view'), managedStackController.getById);
router.put('/:id', requirePermission('stacks.manage'), requireUpdateTargetAccess, managedStackController.update);
router.delete('/:id', requirePermission('stacks.manage'), managedStackController.delete);
router.post('/:id/deploy', requirePermission('stacks.deploy'), managedStackController.deploy);
router.post('/:id/stop', requirePermission('stacks.stop'), managedStackController.stop);
router.post('/:id/down', requirePermission('stacks.manage'), managedStackController.down);
router.post('/:id/pull', requirePermission('stacks.deploy'), managedStackController.pull);
router.post('/:id/redeploy', requirePermission('stacks.deploy'), managedStackController.redeploy);
router.post('/:id/cancel', requirePermission('stacks.deploy'), managedStackController.cancel);

// Build-pipeline source management
router.post('/:id/source/zip', requirePermission('stacks.manage'), upload.single('file'), managedStackController.uploadZip);
router.post('/:id/source/git', requirePermission('stacks.manage'), managedStackController.setGit);
router.post('/:id/source/git-pull', requirePermission('stacks.deploy'), managedStackController.gitPull);
router.get('/:id/source/files', requirePermission('stacks.view'), managedStackController.listSourceFiles);
router.get('/:id/source/generated', requirePermission('stacks.view'), managedStackController.getGeneratedFiles);
router.get('/:id/effective-config', requirePermission('stacks.view'), managedStackController.getEffectiveConfig);

// Engine migration
router.get('/:id/migration-preview', requirePermission('stacks.view'), managedStackController.previewMigration);
router.post('/:id/migrate-engine', requirePermission('stacks.manage'), requireMigrateTargetAccess, managedStackController.migrateEngine);

// Deploy history + rollback (Git-sourced stacks)
router.get('/:id/deploy-history', requirePermission('stacks.view'), managedStackController.getDeployHistory);
router.post('/:id/rollback', requirePermission('stacks.deploy'), managedStackController.rollback);

export default router;
