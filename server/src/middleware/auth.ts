import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';

declare module 'express-session' {
  interface SessionData {
    userId: number;
    username: string;
    role: string;
    oauthState: string;
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    next(new AppError(401, 'Authentication required'));
    return;
  }
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      next(new AppError(401, 'Authentication required'));
      return;
    }
    if (!req.session.role || !roles.includes(req.session.role)) {
      next(new AppError(403, 'Insufficient permissions'));
      return;
    }
    next();
  };
}
