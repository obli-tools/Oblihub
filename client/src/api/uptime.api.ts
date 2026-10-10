import apiClient from './client';
import type { ApiResponse, UptimeMonitor, UptimeHeartbeat, StatusPage } from '@oblihub/shared';

export const uptimeApi = {
  async listMonitors(): Promise<UptimeMonitor[]> {
    const res = await apiClient.get<ApiResponse<UptimeMonitor[]>>('/uptime/monitors');
    return res.data.data!;
  },
  async createMonitor(data: { name: string; url: string; type?: string; intervalSeconds?: number; timeoutMs?: number; expectedStatus?: number; keyword?: string; proxyHostId?: number }): Promise<UptimeMonitor> {
    const res = await apiClient.post<ApiResponse<UptimeMonitor>>('/uptime/monitors', data);
    return res.data.data!;
  },
  async deleteMonitor(id: number): Promise<void> {
    await apiClient.delete(`/uptime/monitors/${id}`);
  },
  async updateMonitor(id: number, data: { notificationChannelId?: number | null; intervalSeconds?: number }): Promise<void> {
    await apiClient.patch(`/uptime/monitors/${id}`, data);
  },
  async getMonitorByProxy(proxyHostId: number): Promise<UptimeMonitor | null> {
    const res = await apiClient.get<ApiResponse<UptimeMonitor | null>>(`/uptime/monitors/by-proxy/${proxyHostId}`);
    return res.data.data!;
  },
  async syncProxyHosts(): Promise<{ created: number }> {
    const res = await apiClient.post<ApiResponse<{ created: number }>>('/uptime/monitors/sync-proxy-hosts');
    return res.data.data!;
  },
  async toggleMonitor(id: number): Promise<{ enabled: boolean }> {
    const res = await apiClient.post<ApiResponse<{ enabled: boolean }>>(`/uptime/monitors/${id}/toggle`);
    return res.data.data!;
  },
  async getHeartbeats(id: number, range: '1h' | '24h' | '7d' | '30d' = '24h'): Promise<UptimeHeartbeat[]> {
    const res = await apiClient.get<ApiResponse<UptimeHeartbeat[]>>(`/uptime/monitors/${id}/heartbeats?range=${range}`);
    return res.data.data!;
  },
  async listPages(): Promise<StatusPage[]> {
    const res = await apiClient.get<ApiResponse<StatusPage[]>>('/uptime/pages');
    return res.data.data!;
  },
  async createPage(data: { name: string; slug: string; monitorIds: number[] }): Promise<StatusPage> {
    const res = await apiClient.post<ApiResponse<StatusPage>>('/uptime/pages', data);
    return res.data.data!;
  },
  async deletePage(id: number): Promise<void> {
    await apiClient.delete(`/uptime/pages/${id}`);
  },
};
