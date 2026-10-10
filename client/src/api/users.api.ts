import apiClient from './client';
import type { ApiResponse, User } from '@oblihub/shared';

export const usersApi = {
  async list(): Promise<User[]> {
    const res = await apiClient.get<ApiResponse<User[]>>('/users');
    return res.data.data!;
  },
  async create(data: { username: string; password: string; displayName?: string; email?: string; role?: string }): Promise<User> {
    const res = await apiClient.post<ApiResponse<User>>('/users', data);
    return res.data.data!;
  },
  async update(id: number, data: { displayName?: string; email?: string; role?: string; password?: string }): Promise<User> {
    const res = await apiClient.patch<ApiResponse<User>>(`/users/${id}`, data);
    return res.data.data!;
  },
  async toggleActive(id: number): Promise<User> {
    const res = await apiClient.post<ApiResponse<User>>(`/users/${id}/toggle-active`);
    return res.data.data!;
  },
  async delete(id: number): Promise<void> {
    await apiClient.delete(`/users/${id}`);
  },
};
