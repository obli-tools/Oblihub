import apiClient from './client';
import type { ApiResponse } from '@oblihub/shared';

export const settingsApi = {
  async getAll(): Promise<Record<string, string | null>> {
    const res = await apiClient.get<ApiResponse<Record<string, string | null>>>('/settings');
    return res.data.data!;
  },
  async update(entries: Record<string, string | null>): Promise<void> {
    await apiClient.patch('/settings', entries);
  },
  async getSystemInfo(): Promise<{ dockerConnected: boolean; dockerVersion: any; stackCount: number; containerCount: number }> {
    const res = await apiClient.get<ApiResponse<any>>('/system');
    return res.data.data!;
  },
};
