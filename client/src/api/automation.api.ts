import apiClient from './client';
import type { ApiResponse, SshKey, WorkflowTarget, Workflow, WorkflowRun } from '@oblihub/shared';

export const sshKeysApi = {
  async list(): Promise<SshKey[]> {
    const res = await apiClient.get<ApiResponse<SshKey[]>>('/automation/ssh-keys');
    return res.data.data!;
  },
  async create(data: Partial<SshKey>): Promise<SshKey> {
    const res = await apiClient.post<ApiResponse<SshKey>>('/automation/ssh-keys', data);
    return res.data.data!;
  },
  async update(id: number, data: Partial<SshKey>): Promise<SshKey> {
    const res = await apiClient.patch<ApiResponse<SshKey>>(`/automation/ssh-keys/${id}`, data);
    return res.data.data!;
  },
  async delete(id: number): Promise<void> {
    await apiClient.delete(`/automation/ssh-keys/${id}`);
  },
};

export const workflowTargetsApi = {
  async list(): Promise<WorkflowTarget[]> {
    const res = await apiClient.get<ApiResponse<WorkflowTarget[]>>('/automation/targets');
    return res.data.data!;
  },
  async create(data: Partial<WorkflowTarget>): Promise<WorkflowTarget> {
    const res = await apiClient.post<ApiResponse<WorkflowTarget>>('/automation/targets', data);
    return res.data.data!;
  },
  async update(id: number, data: Partial<WorkflowTarget>): Promise<WorkflowTarget> {
    const res = await apiClient.patch<ApiResponse<WorkflowTarget>>(`/automation/targets/${id}`, data);
    return res.data.data!;
  },
  async delete(id: number): Promise<void> {
    await apiClient.delete(`/automation/targets/${id}`);
  },
};

export const workflowsApi = {
  async list(): Promise<Workflow[]> {
    const res = await apiClient.get<ApiResponse<Workflow[]>>('/automation/workflows');
    return res.data.data!;
  },
  async create(data: Partial<Workflow>): Promise<Workflow> {
    const res = await apiClient.post<ApiResponse<Workflow>>('/automation/workflows', data);
    return res.data.data!;
  },
  async update(id: number, data: Partial<Workflow>): Promise<Workflow> {
    const res = await apiClient.patch<ApiResponse<Workflow>>(`/automation/workflows/${id}`, data);
    return res.data.data!;
  },
  async delete(id: number): Promise<void> {
    await apiClient.delete(`/automation/workflows/${id}`);
  },
  async runNow(id: number): Promise<void> {
    await apiClient.post(`/automation/workflows/${id}/run`);
  },
  async listRuns(id: number, limit = 50): Promise<WorkflowRun[]> {
    const res = await apiClient.get<ApiResponse<WorkflowRun[]>>(`/automation/workflows/${id}/runs?limit=${limit}`);
    return res.data.data!;
  },
};
