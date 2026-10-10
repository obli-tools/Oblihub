import apiClient from './client';
import type { ApiResponse, User } from '@oblihub/shared';

export const authApi = {
  async login(username: string, password: string): Promise<{ user: User }> {
    const res = await apiClient.post<ApiResponse<{ user: User }>>('/auth/login', { username, password });
    return res.data.data!;
  },
  async logout(): Promise<void> {
    await apiClient.post('/auth/logout');
  },
  async me(): Promise<{ user: User }> {
    const res = await apiClient.get<ApiResponse<{ user: User }>>('/auth/me');
    return res.data.data!;
  },
};
