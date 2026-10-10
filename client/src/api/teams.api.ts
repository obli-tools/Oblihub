import apiClient from './client';
import type { ApiResponse, Team } from '@oblihub/shared';

export const teamsApi = {
  async list(): Promise<Team[]> {
    const res = await apiClient.get<ApiResponse<Team[]>>('/teams');
    return res.data.data!;
  },
  async getById(id: number): Promise<Team> {
    const res = await apiClient.get<ApiResponse<Team>>(`/teams/${id}`);
    return res.data.data!;
  },
  async create(data: { name: string; description?: string; allResources?: boolean }): Promise<Team> {
    const res = await apiClient.post<ApiResponse<Team>>('/teams', data);
    return res.data.data!;
  },
  async update(id: number, data: { name?: string; description?: string; allResources?: boolean }): Promise<Team> {
    const res = await apiClient.put<ApiResponse<Team>>(`/teams/${id}`, data);
    return res.data.data!;
  },
  async delete(id: number): Promise<void> {
    await apiClient.delete(`/teams/${id}`);
  },
  async addMember(teamId: number, userId: number): Promise<void> {
    await apiClient.post(`/teams/${teamId}/members`, { userId });
  },
  async removeMember(teamId: number, userId: number): Promise<void> {
    await apiClient.delete(`/teams/${teamId}/members/${userId}`);
  },
  async setResources(teamId: number, resources: { type: 'stack' | 'container'; id: number; excluded?: boolean }[]): Promise<Team> {
    const res = await apiClient.put<ApiResponse<Team>>(`/teams/${teamId}/resources`, { resources });
    return res.data.data!;
  },
  async getMyResources(): Promise<{ all: boolean; stackIds: number[]; containerIds: number[]; excludedContainerIds?: number[] }> {
    const res = await apiClient.get<ApiResponse<{ all: boolean; stackIds: number[]; containerIds: number[]; excludedContainerIds?: number[] }>>('/teams/my-resources');
    return res.data.data!;
  },
  async getStackTeams(): Promise<{ stackTeams: Record<number, string[]>; globalTeams: string[] }> {
    const res = await apiClient.get<ApiResponse<{ stackTeams: Record<number, string[]>; globalTeams: string[] }>>('/teams/by-stacks');
    return res.data.data!;
  },
};
