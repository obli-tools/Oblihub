import { db } from '../db';
import { hashPassword, comparePassword } from '../utils/crypto';
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

export const authService = {
  async authenticate(username: string, password: string): Promise<User | null> {
    const row = await db<UserRow>('users').where({ username, is_active: true }).first();
    if (!row || !row.password_hash) return null;
    const valid = await comparePassword(password, row.password_hash);
    return valid ? rowToUser(row) : null;
  },

  async getUserById(id: number): Promise<User | null> {
    const row = await db<UserRow>('users').where({ id }).first();
    return row ? rowToUser(row) : null;
  },

  async ensureDefaultAdmin(username: string, password: string): Promise<void> {
    const existing = await db('users').where({ role: 'admin' }).first();
    if (existing) return;
    const passwordHash = await hashPassword(password);
    await db('users').insert({
      username,
      password_hash: passwordHash,
      role: 'admin',
      display_name: 'Administrator',
      is_active: true,
    });
  },

  async listUsers(): Promise<User[]> {
    const rows = await db<UserRow>('users').orderBy('id');
    return rows.map(rowToUser);
  },

  async createUser(data: { username: string; password: string; displayName?: string; email?: string; role?: string }): Promise<User> {
    const passwordHash = await hashPassword(data.password);
    const [row] = await db<UserRow>('users').insert({
      username: data.username,
      password_hash: passwordHash,
      display_name: data.displayName || null,
      email: data.email || null,
      role: data.role || 'user',
      is_active: true,
    }).returning('*');
    return rowToUser(row);
  },

  async updateUser(id: number, data: { displayName?: string; email?: string; role?: string; password?: string }): Promise<User | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.displayName !== undefined) update.display_name = data.displayName;
    if (data.email !== undefined) update.email = data.email;
    if (data.role !== undefined) update.role = data.role;
    if (data.password) update.password_hash = await hashPassword(data.password);
    const [row] = await db<UserRow>('users').where({ id }).update(update).returning('*');
    return row ? rowToUser(row) : null;
  },

  async toggleActive(id: number): Promise<User | null> {
    const user = await db<UserRow>('users').where({ id }).first();
    if (!user) return null;
    const [row] = await db<UserRow>('users').where({ id }).update({ is_active: !user.is_active, updated_at: new Date() }).returning('*');
    return row ? rowToUser(row) : null;
  },

  async deleteUser(id: number): Promise<void> {
    await db('sso_foreign_users').where({ local_user_id: id }).delete();
    await db('users').where({ id }).delete();
  },
};
