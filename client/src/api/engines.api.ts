import apiClient from './client';
import type { ApiResponse, DockerEngine, DockerEngineType, EngineSummary, HostAgentMode } from '@oblihub/shared';

export interface EngineWriteData {
  name: string;
  type: DockerEngineType;
  host?: string | null;
  port?: number | null;
  sshUser?: string | null;
  sshPrivateKey?: string; // omit on edit to keep existing
  sshKnownHost?: string | null;
  apiKey?: string; // omit on edit to keep existing
  apiKeyHeader?: string | null;
  tlsCa?: string | null;
  tlsCert?: string | null;
  tlsKey?: string; // omit on edit to keep existing
  enabled?: boolean;
  tailscaleHostname?: string | null;
  tailscaleAdvertisedRoutes?: string | null;
  hostAgentMode?: HostAgentMode;
}

/** What DELETE /engines/:id tore down alongside the engine row. */
export interface EngineDeleteResult {
  removedStacks: number;
  removedContainers: number;
  agentRemoved: boolean;
  warnings: string[];
}

export interface TestResult {
  ok: boolean;
  message?: string;
  serverVersion?: string;
}

export const enginesApi = {
  async list(): Promise<DockerEngine[]> {
    const res = await apiClient.get<ApiResponse<DockerEngine[]>>('/engines');
    return res.data.data!;
  },
  async getById(id: number): Promise<DockerEngine> {
    const res = await apiClient.get<ApiResponse<DockerEngine>>(`/engines/${id}`);
    return res.data.data!;
  },
  async create(data: EngineWriteData): Promise<DockerEngine> {
    const res = await apiClient.post<ApiResponse<DockerEngine>>('/engines', data);
    return res.data.data!;
  },
  async update(id: number, data: Partial<EngineWriteData>): Promise<DockerEngine> {
    const res = await apiClient.patch<ApiResponse<DockerEngine>>(`/engines/${id}`, data);
    return res.data.data!;
  },
  /** Identity of every engine without host or secrets. Unlike list(), readable by non-admins. */
  async summary(): Promise<EngineSummary[]> {
    const res = await apiClient.get<ApiResponse<EngineSummary[]>>('/engines/summary');
    return res.data.data ?? [];
  },
  /**
   * Null when the server sends no body: older servers answered a bare `{ success: true }`, and the
   * client container can be upgraded before the server.
   */
  async delete(id: number): Promise<EngineDeleteResult | null> {
    const res = await apiClient.delete<ApiResponse<EngineDeleteResult>>(`/engines/${id}`);
    return res.data?.data ?? null;
  },
  async setDefault(id: number): Promise<void> {
    await apiClient.post(`/engines/${id}/set-default`);
  },
  async testExisting(id: number): Promise<TestResult> {
    const res = await apiClient.post<ApiResponse<TestResult>>(`/engines/${id}/test`);
    return res.data.data!;
  },
  async testTransient(data: EngineWriteData): Promise<TestResult> {
    const res = await apiClient.post<ApiResponse<TestResult>>('/engines/test', data);
    return res.data.data!;
  },
  async generateSshKey(): Promise<{ privateKey: string; publicKey: string; comment: string }> {
    const res = await apiClient.post<ApiResponse<{ privateKey: string; publicKey: string; comment: string }>>('/engines/generate-ssh-key');
    return res.data.data!;
  },
};
