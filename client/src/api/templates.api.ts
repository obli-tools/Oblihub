import apiClient from './client';
import type { ApiResponse, AppTemplate } from '@oblihub/shared';

export const templatesApi = {
  async list(): Promise<AppTemplate[]> {
    const res = await apiClient.get<ApiResponse<AppTemplate[]>>('/templates');
    return res.data.data!;
  },
  async deploy(id: number, stackName: string, envValues: Record<string, string>): Promise<{ stackId: number; stackName: string }> {
    const res = await apiClient.post<ApiResponse<{ stackId: number; stackName: string }>>(`/templates/${id}/deploy`, { stackName, envValues });
    return res.data.data!;
  },
};
