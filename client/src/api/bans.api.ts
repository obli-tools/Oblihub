import apiClient from './client';
import type { ApiResponse, BannedIp, HoneypotPath } from '@oblihub/shared';

export const bansApi = {
  async list(opts?: { activeOnly?: boolean; sourceType?: string; hostId?: number }): Promise<BannedIp[]> {
    const p = new URLSearchParams();
    if (opts?.activeOnly === false) p.set('activeOnly', 'false');
    if (opts?.sourceType) p.set('sourceType', opts.sourceType);
    if (opts?.hostId) p.set('hostId', String(opts.hostId));
    const qs = p.toString();
    const res = await apiClient.get<ApiResponse<BannedIp[]>>(`/bans${qs ? '?' + qs : ''}`);
    return res.data.data!;
  },
  async create(data: { ip: string; reason?: string; banDurationSeconds?: number | null }): Promise<BannedIp> {
    const res = await apiClient.post<ApiResponse<BannedIp>>('/bans', data);
    return res.data.data!;
  },
  async unban(id: number): Promise<void> {
    await apiClient.delete(`/bans/${id}`);
  },
};

export const honeypotApi = {
  async listForHost(hostId: number): Promise<HoneypotPath[]> {
    const res = await apiClient.get<ApiResponse<HoneypotPath[]>>(`/honeypot/${hostId}/paths`);
    return res.data.data!;
  },
  async replaceAll(hostId: number, paths: Array<{ path: string; enabled: boolean }>): Promise<HoneypotPath[]> {
    const res = await apiClient.put<ApiResponse<HoneypotPath[]>>(`/honeypot/${hostId}/paths`, { paths });
    return res.data.data!;
  },
  async addPreset(hostId: number): Promise<HoneypotPath[]> {
    const res = await apiClient.post<ApiResponse<HoneypotPath[]>>(`/honeypot/${hostId}/preset`);
    return res.data.data!;
  },
  async getDefaults(): Promise<string[]> {
    const res = await apiClient.get<ApiResponse<string[]>>('/honeypot/defaults');
    return res.data.data!;
  },
};

export interface ObliguardStatus {
  configured: boolean;
  source: 'obligate' | 'manual' | null;
  url: string | null;
  reachable: boolean;
  hasDelegation: boolean;
}

export const obliguardApi = {
  async status(): Promise<ObliguardStatus> {
    const res = await apiClient.get<ApiResponse<ObliguardStatus>>('/obliguard/status');
    return res.data.data!;
  },
  async testPing(): Promise<{ ok: boolean; reason: string; target?: string }> {
    const res = await apiClient.post<ApiResponse<{ ok: boolean; reason: string; target?: string }>>('/obliguard/test');
    return res.data.data!;
  },
};
