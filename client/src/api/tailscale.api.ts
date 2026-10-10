import apiClient from './client';
import type { ApiResponse, TailscaleStatus, ResolvedUpstream } from '@oblihub/shared';

// Both lines are needed: the import gives resolveUpstream's return type a local binding, the
// re-export keeps `import { type ResolvedUpstream } from '@/api/tailscale.api'` working.
export type { ResolvedUpstream };

export interface PeerSuggestion {
  hostname: string;
  dnsName: string;
  ipv4: string | null;
  online: boolean;
  os: string | null;
  alreadyAttached: boolean;
}

export interface InstallCommandResult {
  command: string;
  subnetRoutes: string[];
  discoveryError?: string;
}

export const tailscaleApi = {
  async status(): Promise<TailscaleStatus> {
    const res = await apiClient.get<ApiResponse<TailscaleStatus>>('/tailscale/status');
    return res.data.data!;
  },
  async peers(): Promise<PeerSuggestion[]> {
    const res = await apiClient.get<ApiResponse<PeerSuggestion[]>>('/tailscale/peers');
    return res.data.data!;
  },
  async installCommand(opts: {
    hostname: string;
    authKey?: string;
    subnetRoutes?: string[];
    acceptRoutes?: boolean;
    discoverFromEngineId?: number;
  }): Promise<InstallCommandResult> {
    const res = await apiClient.post<ApiResponse<InstallCommandResult>>('/tailscale/install-command', opts);
    return res.data.data!;
  },
  async resolveUpstream(containerId: number, port?: number): Promise<ResolvedUpstream> {
    const url = port
      ? `/tailscale/resolve-upstream/${containerId}?port=${port}`
      : `/tailscale/resolve-upstream/${containerId}`;
    const res = await apiClient.get<ApiResponse<ResolvedUpstream>>(url);
    return res.data.data!;
  },
};
