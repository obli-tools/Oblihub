import apiClient from './client';
import type { ApiResponse, AzureAuthProvider } from '@oblihub/shared';

export const azureAuthApi = {
  async list(): Promise<AzureAuthProvider[]> {
    const res = await apiClient.get<ApiResponse<AzureAuthProvider[]>>('/azure-auth');
    return res.data.data!;
  },
  async create(data: { name: string; tenantId: string; clientId: string; clientSecret: string; allowedEmails?: string[]; allowedGroups?: string[] }): Promise<AzureAuthProvider> {
    const res = await apiClient.post<ApiResponse<AzureAuthProvider>>('/azure-auth', data);
    return res.data.data!;
  },
  async update(id: number, data: { name?: string; tenantId?: string; clientId?: string; clientSecret?: string; allowedEmails?: string[] | null; allowedGroups?: string[] | null }): Promise<AzureAuthProvider> {
    const res = await apiClient.put<ApiResponse<AzureAuthProvider>>(`/azure-auth/${id}`, data);
    return res.data.data!;
  },
  async delete(id: number): Promise<void> {
    await apiClient.delete(`/azure-auth/${id}`);
  },
  async redeploy(id: number): Promise<AzureAuthProvider> {
    const res = await apiClient.post<ApiResponse<AzureAuthProvider>>(`/azure-auth/${id}/redeploy`);
    return res.data.data!;
  },
  async callbackUrls(id: number): Promise<string[]> {
    const res = await apiClient.get<ApiResponse<string[]>>(`/azure-auth/${id}/callback-urls`);
    return res.data.data!;
  },
};
