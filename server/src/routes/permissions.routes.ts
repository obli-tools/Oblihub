import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { permissionService } from '../services/permission.service';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { revalidateSocketAccess } from '../socket';

const router = Router();

router.use(requireAuth);

// Get all permissions (any authenticated user)
router.get('/permissions', async (_req, res, next) => {
  try {
    const perms = await permissionService.getAllPermissions();
    res.json({ success: true, data: perms });
  } catch (err) { next(err); }
});

// Get current user's permissions
router.get('/my-permissions', async (req, res, next) => {
  try {
    const role = (req.session as { role?: string }).role || 'user';
    const perms = await permissionService.getUserPermissions(role);
    res.json({ success: true, data: perms });
  } catch (err) { next(err); }
});

// Admin-only: roles CRUD
function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if ((req.session as { role?: string }).role !== 'admin') return next(new AppError(403, 'Admin access required'));
  next();
}

router.get('/roles', requireAdmin, async (_req, res, next) => {
  try {
    const roles = await permissionService.getAllRoles();
    res.json({ success: true, data: roles });
  } catch (err) { next(err); }
});

router.post('/roles', requireAdmin, async (req, res, next) => {
  try {
    const { name, label, description, permissions } = req.body;
    if (!name || !label) throw new AppError(400, 'Name and label required');
    const role = await permissionService.createRole({ name, label, description, permissions });
    res.json({ success: true, data: role });
  } catch (err) { next(err); }
});

router.put('/roles/:id/permissions', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { permissions } = req.body as { permissions: string[] };
    await permissionService.updateRolePermissions(id, permissions);
    // stacks.view gates the compose rooms of a non-admin: re-check the live sockets now rather than
    // at the next backstop sweep.
    await revalidateSocketAccess();
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/roles/:id', requireAdmin, async (req, res, next) => {
  try {
    await permissionService.deleteRole(parseInt(req.params.id, 10));
    await revalidateSocketAccess();
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
