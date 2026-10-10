import apiClient from './client';
import { apiErrorMessage } from '../utils/apiError';
import type { ApiResponse, Stack, UpdateHistoryEntry, Container, SleepMode, SleepState, ResourceLimits, ContainerInspectResult, ResolvedUpstream, StackResourcesInfo, ResourceApplyResult, EffectiveMaintenance } from '@oblihub/shared';

export interface MaintenanceStatus { effective: EffectiveMaintenance; allowedNow: boolean; nextOpening: string | null }

export const stacksApi = {
  async list(): Promise<Stack[]> {
    const res = await apiClient.get<ApiResponse<Stack[]>>('/stacks');
    return res.data.data!;
  },
  async getById(id: number): Promise<Stack> {
    const res = await apiClient.get<ApiResponse<Stack>>(`/stacks/${id}`);
    return res.data.data!;
  },
  async update(id: number, data: Partial<Pick<Stack, 'name' | 'checkInterval' | 'autoUpdate' | 'enabled' | 'url' | 'notifyUpdateAvailable' | 'notifyUpdateApplied' | 'notifyDelay' | 'maintenanceWindow'>>): Promise<Stack> {
    const res = await apiClient.patch<ApiResponse<Stack>>(`/stacks/${id}`, data);
    return res.data.data!;
  },
  async getMaintenance(id: number): Promise<MaintenanceStatus> {
    const res = await apiClient.get<ApiResponse<MaintenanceStatus>>(`/stacks/${id}/maintenance`);
    return res.data.data!;
  },
  async delete(id: number, opts?: { containers?: boolean; volumes?: boolean }): Promise<void> {
    const params = new URLSearchParams();
    if (opts?.containers) params.set('containers', 'true');
    if (opts?.volumes) params.set('volumes', 'true');
    await apiClient.delete(`/stacks/${id}?${params}`);
  },
  async check(id: number): Promise<void> {
    await apiClient.post(`/stacks/${id}/check`);
  },
  async triggerUpdate(id: number): Promise<void> {
    await apiClient.post(`/stacks/${id}/update`);
  },
  async restart(id: number): Promise<void> {
    await apiClient.post(`/stacks/${id}/restart`);
  },
  async getHistory(id: number, limit = 50, offset = 0): Promise<UpdateHistoryEntry[]> {
    const res = await apiClient.get<ApiResponse<UpdateHistoryEntry[]>>(`/stacks/${id}/history?limit=${limit}&offset=${offset}`);
    return res.data.data!;
  },
  async getStackResources(id: number): Promise<StackResourcesInfo> {
    const res = await apiClient.get<ApiResponse<StackResourcesInfo>>(`/stacks/${id}/resources`);
    return res.data.data!;
  },
  /** The server answers 200 even when applying failed: `apply.ok` says what really happened.
   *  `apply` is null only from a server that predates apply reporting. */
  async setStackResources(
    id: number,
    limits: ResourceLimits,
  ): Promise<{ stack: Stack; apply: ResourceApplyResult | null }> {
    const res = await apiClient.put<ApiResponse<Stack> & { apply?: ResourceApplyResult }>(`/stacks/${id}/resources`, limits);
    return { stack: res.data.data!, apply: res.data.apply ?? null };
  },
  async clearStackResources(id: number): Promise<ResourceApplyResult | null> {
    const res = await apiClient.delete<{ success: boolean; apply?: ResourceApplyResult }>(`/stacks/${id}/resources`);
    return res.data?.apply ?? null;
  },
};

export const containersApi = {
  async restart(id: number): Promise<void> {
    await apiClient.post(`/containers/${id}/restart`);
  },
  async stop(id: number): Promise<void> {
    await apiClient.post(`/containers/${id}/stop`);
  },
  async start(id: number): Promise<void> {
    await apiClient.post(`/containers/${id}/start`);
  },
  async remove(id: number, removeVolumes = false): Promise<void> {
    await apiClient.delete(`/containers/${id}?volumes=${removeVolumes}`);
  },
  async inspect(id: number): Promise<ContainerInspectResult> {
    const res = await apiClient.get<ApiResponse<ContainerInspectResult>>(`/containers/${id}/inspect`);
    return res.data.data!;
  },
  /**
   * Where a proxy host should forward to for this container (engine-aware: docker DNS, host
   * network, tailscale route or the engine's public host). Needs `proxy.manage` plus team access
   * to the container: the server answers 403 otherwise, so only call it from proxy editors.
   * 4xx answers are rethrown as a plain Error carrying the server's text, because the editors show
   * it verbatim (unresolvable port, orphaned container, missing access). The rethrown Error also
   * carries the HTTP `status`, so a caller can tell a hard refusal (400/409) from a transient one.
   */
  async resolveUpstream(id: number, port?: number, protocol?: 'tcp' | 'udp'): Promise<ResolvedUpstream> {
    const params = new URLSearchParams();
    if (port != null) params.set('port', String(port));
    if (protocol) params.set('protocol', protocol);
    const qs = params.toString();
    try {
      const res = await apiClient.get<ApiResponse<ResolvedUpstream>>(`/containers/${id}/upstream${qs ? `?${qs}` : ''}`);
      return res.data.data!;
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status != null && status >= 400 && status < 500) {
        throw Object.assign(new Error(apiErrorMessage(err, `Could not resolve the upstream (HTTP ${status})`)), { status });
      }
      throw err;
    }
  },
  async updateSleepConfig(id: number, data: { sleepEnabled?: boolean; sleepAfterSeconds?: number; sleepMode?: SleepMode; wakeHealthPath?: string | null }): Promise<Container> {
    const res = await apiClient.patch<ApiResponse<Container>>(`/containers/${id}/sleep-config`, data);
    return res.data.data!;
  },
  async sleepNow(id: number): Promise<void> {
    await apiClient.post(`/containers/${id}/sleep`);
  },
  async wakeNow(id: number): Promise<void> {
    await apiClient.post(`/containers/${id}/wake`);
  },
  async wakeStatus(id: number): Promise<{ state: SleepState; elapsedMs: number; message?: string }> {
    const res = await apiClient.get<ApiResponse<{ state: SleepState; elapsedMs: number; message?: string }>>(`/containers/${id}/wake-status`);
    return res.data.data!;
  },
  async cancelUpdate(id: number): Promise<{ cancelled: boolean }> {
    const res = await apiClient.post<ApiResponse<{ cancelled: boolean }>>(`/containers/${id}/cancel-update`);
    return res.data.data!;
  },
};

export const systemApi = {
  async getInfo(): Promise<{ dockerConnected: boolean; dockerVersion: { version: string; apiVersion: string } | null; stackCount: number; containerCount: number; allowConsole: boolean; allowStack: boolean; allowNginx: boolean }> {
    const res = await apiClient.get<ApiResponse<{ dockerConnected: boolean; dockerVersion: { version: string; apiVersion: string } | null; stackCount: number; containerCount: number; allowConsole: boolean; allowStack: boolean; allowNginx: boolean }>>('/system');
    return res.data.data!;
  },
  async getFeatures(): Promise<{ allowConsole: boolean; allowStack: boolean; allowNginx: boolean; selfProject: string | null }> {
    const res = await apiClient.get<ApiResponse<{ allowConsole: boolean; allowStack: boolean; allowNginx: boolean; selfProject: string | null }>>('/system/features');
    return res.data.data!;
  },
};
