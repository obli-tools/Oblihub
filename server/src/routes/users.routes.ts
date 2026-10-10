import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { disconnectUserSockets } from '../socket';

const router = Router();

router.use(requireAuth);

// Admin-only middleware
function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if ((req.session as { role?: string }).role !== 'admin') {
    return next(new AppError(403, 'Admin access required'));
  }
  next();
}

router.use(requireAdmin);

// List all users
router.get('/', async (_req, res, next) => {
  try {
    const users = await authService.listUsers();
    res.json({ success: true, data: users });
  } catch (err) { next(err); }
});

// Create local user
router.post('/', async (req, res, next) => {
  try {
    const { username, password, displayName, email, role } = req.body;
    if (!username || !password) throw new AppError(400, 'Username and password required');
    if (password.length < 6) throw new AppError(400, 'Password must be at least 6 characters');
    const user = await authService.createUser({ username, password, displayName, email, role });
    res.json({ success: true, data: user });
  } catch (err) { next(err); }
});

// Update user
router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await authService.getUserById(id);
    if (!existing) throw new AppError(404, 'User not found');
    // OG users: only allow role change and deactivation, not profile edits
    if (existing.foreignSource) {
      const { role } = req.body;
      if (role) {
        const updated = await authService.updateUser(id, { role });
        return res.json({ success: true, data: updated });
      }
      throw new AppError(400, 'SSO users can only have their role changed');
    }
    const { displayName, email, role, password } = req.body;
    const updated = await authService.updateUser(id, { displayName, email, role, password });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// Toggle active/inactive
router.post('/:id/toggle-active', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const currentUserId = (req.session as { userId?: number }).userId;
    if (id === currentUserId) throw new AppError(400, 'Cannot deactivate yourself');
    const user = await authService.toggleActive(id);
    if (!user) throw new AppError(404, 'User not found');
    // A deactivated user loses their live sockets now, not at the next backstop sweep. A socket
    // closed server side is not reopened by the client, which is right for this user only (never
    // for a team or role change: revalidateSocketAccess keeps the socket there).
    if (!user.isActive) disconnectUserSockets(id);
    res.json({ success: true, data: user });
  } catch (err) { next(err); }
});

// Delete user
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const currentUserId = (req.session as { userId?: number }).userId;
    if (id === currentUserId) throw new AppError(400, 'Cannot delete yourself');
    await authService.deleteUser(id);
    disconnectUserSockets(id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
