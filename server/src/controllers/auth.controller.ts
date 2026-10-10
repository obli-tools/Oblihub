import type { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';
import { AppError } from '../middleware/errorHandler';
import { disconnectSessionSockets } from '../socket';

export const authController = {
  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username, password } = req.body as { username?: string; password?: string };
      if (!username || !password) throw new AppError(400, 'Username and password required');
      const user = await authService.authenticate(username, password);
      if (!user) throw new AppError(401, 'Invalid credentials');
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      res.json({ success: true, data: { user } });
    } catch (err) { next(err); }
  },

  async logout(req: Request, res: Response): Promise<void> {
    // Read before destroy: the sockets opened with this session must close with it, not at the
    // next backstop sweep (they would keep their compose rooms until then).
    const sid = req.sessionID;
    req.session.destroy(() => {
      disconnectSessionSockets(sid);
      res.clearCookie('connect.sid');
      res.json({ success: true });
    });
  },

  async me(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await authService.getUserById(req.session.userId!);
      if (!user) throw new AppError(401, 'User not found');
      res.json({ success: true, data: { user } });
    } catch (err) { next(err); }
  },
};
