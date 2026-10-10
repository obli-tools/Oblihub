import apiClient from './client';
import type { ApiResponse, EngineHostAgentInfo, GpuPowerLimitResult, ResourcesDashboard } from '@oblihub/shared';

export const resourcesApi = {
  async getResourcesDashboard(): Promise<ResourcesDashboard> {
    const res = await apiClient.get<ApiResponse<ResourcesDashboard>>('/resources/dashboard');
    return res.data.data!;
  },
  /** Host-wide power limit of one GPU on one engine (admin only). `gpuKey` is the GPU uuid when
   *  known — indices can be renumbered after a driver reload — else its index. `watts: null` resets
   *  the GPU to its default limit and forgets the value Oblihub re-applies after a reboot. */
  async setGpuPowerLimit(engineId: number, gpuKey: string, watts: number | null): Promise<GpuPowerLimitResult> {
    const res = await apiClient.put<ApiResponse<GpuPowerLimitResult>>(
      `/resources/engines/${engineId}/gpus/${encodeURIComponent(gpuKey)}/power-limit`,
      { watts },
    );
    return res.data.data!;
  },
  /** Admin only: drops the engine's host-agent backoff and reconciles it now. */
  async retryAgent(engineId: number): Promise<EngineHostAgentInfo> {
    const res = await apiClient.post<ApiResponse<EngineHostAgentInfo>>(`/resources/engines/${engineId}/agent/retry`);
    return res.data.data!;
  },
};
