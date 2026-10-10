import apiClient from './client';
import type { ApiResponse, ContainerStats } from '@oblihub/shared';

export const statsApi = {
  async getLatest(): Promise<ContainerStats[]> {
    const res = await apiClient.get<ApiResponse<ContainerStats[]>>('/stats');
    return res.data.data!;
  },
  async getHistory(dockerId: string, range: '1h' | '6h' | '24h' | '7d' = '1h'): Promise<ContainerStats[]> {
    const res = await apiClient.get<ApiResponse<ContainerStats[]>>(`/stats/${dockerId}?range=${range}`);
    return res.data.data!;
  },
  async getBulkRecent(minutes = 15): Promise<ContainerStats[]> {
    const res = await apiClient.get<ApiResponse<ContainerStats[]>>(`/stats/bulk/recent?minutes=${minutes}`);
    return res.data.data!;
  },
};
