import apiClient from './client';
import type { ApiResponse, User, UserPreferences } from '@oblihub/shared';

export const profileApi = {
  async getProfile(): Promise<User> {
    const res = await apiClient.get<ApiResponse<User>>('/profile');
    return res.data.data!;
  },
  async updateProfile(data: { displayName?: string; email?: string; preferences?: Partial<UserPreferences> }): Promise<User> {
    const res = await apiClient.put<ApiResponse<User>>('/profile', data);
    return res.data.data!;
  },
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await apiClient.put('/profile/password', { currentPassword, newPassword });
  },
};
