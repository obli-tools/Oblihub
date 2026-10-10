import { db } from '../db';
import { logger } from '../utils/logger';

export interface Permission {
  key: string;
  category: string;
  label: string;
  description: string | null;
}

export interface Role {
  id: number;
  name: string;
  label: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
}

export const permissionService = {
  async getAllPermissions(): Promise<Permission[]> {
    const rows = await db('permissions').orderBy('category').orderBy('key');
    return rows.map(r => ({ key: r.key, category: r.category, label: r.label, description: r.description }));
  },

  async getAllRoles(): Promise<Role[]> {
    const roles = await db('roles').orderBy('is_system', 'desc').orderBy('name');
    const rolePerms = await db('role_permissions').where({ granted: true });

    return roles.map(r => ({
      id: r.id,
      name: r.name,
      label: r.label,
      description: r.description,
      isSystem: r.is_system,
      permissions: rolePerms.filter(rp => rp.role_id === r.id).map(rp => rp.permission_key),
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  },

  async getRoleByName(name: string): Promise<Role | null> {
    const role = await db('roles').where({ name }).first();
    if (!role) return null;
    const perms = await db('role_permissions').where({ role_id: role.id, granted: true });
    return {
      id: role.id, name: role.name, label: role.label, description: role.description,
      isSystem: role.is_system, permissions: perms.map(p => p.permission_key),
      createdAt: role.created_at.toISOString(), updatedAt: role.updated_at.toISOString(),
    };
  },

  async createRole(data: { name: string; label: string; description?: string; permissions?: string[] }): Promise<Role> {
    const [row] = await db('roles').insert({
      name: data.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
      label: data.label,
      description: data.description || null,
      is_system: false,
    }).returning('*');

    if (data.permissions?.length) {
      await db('role_permissions').insert(data.permissions.map(key => ({ role_id: row.id, permission_key: key, granted: true })));
    }

    return this.getRoleByName(row.name) as Promise<Role>;
  },

  async updateRolePermissions(roleId: number, permissions: string[]): Promise<void> {
    const role = await db('roles').where({ id: roleId }).first();
    if (!role) throw new Error('Role not found');

    // Replace all permissions
    await db('role_permissions').where({ role_id: roleId }).delete();
    if (permissions.length > 0) {
      await db('role_permissions').insert(permissions.map(key => ({ role_id: roleId, permission_key: key, granted: true })));
    }
    await db('roles').where({ id: roleId }).update({ updated_at: new Date() });
  },

  async deleteRole(roleId: number): Promise<void> {
    const role = await db('roles').where({ id: roleId }).first();
    if (!role) throw new Error('Role not found');
    if (role.is_system) throw new Error('Cannot delete system role');
    await db('roles').where({ id: roleId }).delete();
  },

  async getUserPermissions(userRole: string): Promise<string[]> {
    const role = await this.getRoleByName(userRole);
    return role?.permissions || [];
  },

  async hasPermission(userRole: string, permissionKey: string): Promise<boolean> {
    const perms = await this.getUserPermissions(userRole);
    return perms.includes(permissionKey);
  },
};
