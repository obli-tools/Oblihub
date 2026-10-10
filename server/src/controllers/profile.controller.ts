import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { hashPassword, comparePassword } from '../utils/crypto';
import { AppError } from '../middleware/errorHandler';
import type { User, UserPreferences } from '@oblihub/shared';

interface UserRow {
  id: number;
  username: string;
  password_hash: string | null;
  display_name: string | null;
  role: string;
  is_active: boolean;
  email: string | null;
  preferred_language: string;
  foreign_source: string | null;
  foreign_id: number | null;
  avatar: string | null;
  preferences: unknown;
  created_at: Date;
  updated_at: Date;
}

function parsePrefs(raw: unknown): UserPreferences {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as UserPreferences; } catch { return {}; }
  }
  return raw as UserPreferences;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as User['role'],
    isActive: row.is_active,
    email: row.email,
    preferredLanguage: row.preferred_language ?? 'en',
    foreignSource: row.foreign_source,
    foreignId: row.foreign_id,
    avatar: row.avatar ?? null,
    preferences: parsePrefs(row.preferences),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const profileController = {
  async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const row = await db<UserRow>('users').where({ id: req.session.userId }).first();
      if (!row) throw new AppError(404, 'User not found');
      res.json({ success: true, data: rowToUser(row) });
    } catch (err) { next(err); }
  },

  async updateProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { displayName, email, preferences } = req.body as { displayName?: string; email?: string; preferences?: Partial<UserPreferences> };
      const update: Record<string, unknown> = { updated_at: new Date() };
      if (displayName !== undefined) update.display_name = displayName || null;
      if (email !== undefined) update.email = email || null;

      // Deep-merge preferences instead of replacing — caller sends only the keys they want to update.
      if (preferences && typeof preferences === 'object') {
        const existing = await db<UserRow>('users').where({ id: req.session.userId }).select('preferences').first();
        const merged: UserPreferences = { ...parsePrefs(existing?.preferences), ...preferences };
        update.preferences = JSON.stringify(merged);
      }

      const [row] = await db<UserRow>('users')
        .where({ id: req.session.userId })
        .update(update)
        .returning('*');
      if (!row) throw new AppError(404, 'User not found');
      res.json({ success: true, data: rowToUser(row) });
    } catch (err) { next(err); }
  },

  async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
      if (!currentPassword || !newPassword) throw new AppError(400, 'Current and new password required');
      if (newPassword.length < 6) throw new AppError(400, 'New password must be at least 6 characters');

      const row = await db<UserRow>('users').where({ id: req.session.userId }).first();
      if (!row) throw new AppError(404, 'User not found');
      if (row.foreign_source) throw new AppError(403, 'Password change not allowed for SSO users');
      if (!row.password_hash) throw new AppError(403, 'No password set');

      const valid = await comparePassword(currentPassword, row.password_hash);
      if (!valid) throw new AppError(401, 'Current password is incorrect');

      const newHash = await hashPassword(newPassword);
      await db('users').where({ id: req.session.userId }).update({ password_hash: newHash, updated_at: new Date() });
      res.json({ success: true, message: 'Password changed' });
    } catch (err) { next(err); }
  },
};
