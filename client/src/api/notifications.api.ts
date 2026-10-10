import apiClient from './client';
import type { ApiResponse, NotificationChannel, NotificationBinding } from '@oblihub/shared';

export interface PluginMeta {
  type: string;
  name: string;
  configFields: Array<{ key: string; label: string; type: string; required?: boolean; placeholder?: string }>;
}

export const notificationsApi = {
  async getChannels(): Promise<NotificationChannel[]> {
    const res = await apiClient.get<ApiResponse<NotificationChannel[]>>('/notifications/channels');
    return res.data.data!;
  },
  async createChannel(data: { name: string; type: string; config: Record<string, unknown> }): Promise<NotificationChannel> {
    const res = await apiClient.post<ApiResponse<NotificationChannel>>('/notifications/channels', data);
    return res.data.data!;
  },
  async updateChannel(id: number, data: { name?: string; config?: Record<string, unknown>; isEnabled?: boolean }): Promise<NotificationChannel> {
    const res = await apiClient.patch<ApiResponse<NotificationChannel>>(`/notifications/channels/${id}`, data);
    return res.data.data!;
  },
  async deleteChannel(id: number): Promise<void> {
    await apiClient.delete(`/notifications/channels/${id}`);
  },
  async testChannel(id: number): Promise<void> {
    await apiClient.post(`/notifications/channels/${id}/test`);
  },
  async getPlugins(): Promise<PluginMeta[]> {
    const res = await apiClient.get<ApiResponse<PluginMeta[]>>('/notifications/plugins');
    return res.data.data!;
  },
  async getBindings(scope: string, scopeId: number | null): Promise<NotificationBinding[]> {
    const params = scopeId !== null ? `?scope=${scope}&scopeId=${scopeId}` : `?scope=${scope}`;
    const res = await apiClient.get<ApiResponse<NotificationBinding[]>>(`/notifications/bindings${params}`);
    return res.data.data!;
  },
  async createBinding(channelId: number, scope: string, scopeId: number | null, overrideMode: string): Promise<void> {
    await apiClient.post('/notifications/bindings', { channelId, scope, scopeId, overrideMode });
  },
  async removeBinding(channelId: number, scope: string, scopeId: number | null): Promise<void> {
    await apiClient.delete('/notifications/bindings', { data: { channelId, scope, scopeId } });
  },
};
