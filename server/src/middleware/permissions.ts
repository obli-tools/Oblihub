import type { Request, Response, NextFunction } from 'express';
import { permissionService } from '../services/permission.service';
import { teamService } from '../services/team.service';
import { logger } from '../utils/logger';

/**
 * Middleware that checks if the current user has a specific permission.
 * Admin role bypasses all permission checks.
 */
export function requirePermission(permissionKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = req.session as { userId?: number; role?: string };
    if (!session.userId) { res.status(401).json({ success: false, error: 'Not authenticated' }); return; }

    // Admin bypasses all permissions
    if (session.role === 'admin') return next();

    const hasPermission = await permissionService.hasPermission(session.role || 'user', permissionKey);
    if (!hasPermission) {
      logger.warn({ userId: session.userId, role: session.role, permission: permissionKey }, 'Permission denied');
      res.status(403).json({ success: false, error: 'Permission denied' });
      return;
    }
    next();
  };
}

/**
 * Middleware that checks if the current user has access to a stack resource via their teams.
 * Expects req.params.id to be the stack ID.
 * Admin role bypasses all team checks.
 */
export function requireStackAccess(paramName = 'id') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = req.session as { userId?: number; role?: string };
    if (!session.userId) { res.status(401).json({ success: false, error: 'Not authenticated' }); return; }
    if (session.role === 'admin') return next();

    const stackId = parseInt(req.params[paramName], 10);
    if (isNaN(stackId)) return next();

    const hasAccess = await teamService.userHasAccess(session.userId, 'stack', stackId);
    if (!hasAccess) {
      logger.warn({ userId: session.userId, stackId }, 'Stack access denied (no team)');
      res.status(403).json({ success: false, error: 'Access denied: you are not a member of a team with access to this stack' });
      return;
    }
    next();
  };
}

/**
 * Middleware that checks if the current user has access to a container resource via their teams.
 */
export function requireContainerAccess(paramName = 'id') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = req.session as { userId?: number; role?: string };
    if (!session.userId) { res.status(401).json({ success: false, error: 'Not authenticated' }); return; }
    if (session.role === 'admin') return next();

    const containerId = parseInt(req.params[paramName], 10);
    if (isNaN(containerId)) return next();

    const hasAccess = await teamService.userHasAccess(session.userId, 'container', containerId);
    if (!hasAccess) {
      logger.warn({ userId: session.userId, containerId }, 'Container access denied (no team)');
      res.status(403).json({ success: false, error: 'Access denied' });
      return;
    }
    next();
  };
}

/**
 * Filter stacks list to only those the user has access to via teams.
 * Used as a post-processing step on GET /stacks.
 */
export async function filterStacksByTeam(userId: number, role: string, stacks: unknown[]): Promise<unknown[]> {
  if (role === 'admin') return stacks;
  const teams = await teamService.getTeamsForUser(userId);
  if (teams.length === 0) return [];
  if (teams.some(t => t.allResources)) return stacks;

  const accessibleStackIds = new Set<number>();
  for (const team of teams) {
    for (const r of team.resources) {
      if (r.resourceType === 'stack' && !r.excluded) accessibleStackIds.add(r.resourceId);
    }
  }
  return (stacks as { id: number }[]).filter(s => accessibleStackIds.has(s.id));
}
