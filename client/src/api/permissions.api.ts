import apiClient from './client';
import type { ApiResponse } from '@oblihub/shared';

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

export const permissionsApi = {
  async getPermissions(): Promise<Permission[]> {
    const res = await apiClient.get<ApiResponse<Permission[]>>('/permissions');
    return res.data.data!;
  },
  async getMyPermissions(): Promise<string[]> {
    const res = await apiClient.get<ApiResponse<string[]>>('/my-permissions');
    return res.data.data!;
  },
  async getRoles(): Promise<Role[]> {
    const res = await apiClient.get<ApiResponse<Role[]>>('/roles');
    return res.data.data!;
  },
  async createRole(data: { name: string; label: string; description?: string; permissions?: string[] }): Promise<Role> {
    const res = await apiClient.post<ApiResponse<Role>>('/roles', data);
    return res.data.data!;
  },
  async updateRolePermissions(roleId: number, permissions: string[]): Promise<void> {
    await apiClient.put(`/roles/${roleId}/permissions`, { permissions });
  },
  async deleteRole(roleId: number): Promise<void> {
    await apiClient.delete(`/roles/${roleId}`);
  },
};
