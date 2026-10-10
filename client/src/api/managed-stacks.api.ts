import apiClient from './client';
import type { ApiResponse, ManagedStack, PortSpecInput, PortConflictResult, GeneratedComposeFile } from '@oblihub/shared';

/** What a cross-engine carry dropped from the GPU settings (server: LimitsCarryAdjustments). */
export interface LimitsCarryAdjustments {
  gpuIdsDropped: string[];
  vramCapsDropped: string[];
  gpuRevoked: boolean;
  /** The target's GPU list could not be read, so every GPU id / VRAM cap was dropped. */
  targetCatalogUnknown: boolean;
}

export interface MigrateEngineResult {
  stack: ManagedStack;
  migrated: { name: string; ok: boolean; bytesIn?: number; error?: string }[];
  skippedBinds: string[];
  engineOnly?: boolean;
  limitsCarried?: boolean;
  /** Absent from older servers. */
  limitsAdjusted?: LimitsCarryAdjustments | null;
}

/** PUT /managed-stacks/:id body. `gpuPolicy: 'revoke'` accepts, for a move to another daemon, that
 *  GPU ids / VRAM caps naming cards of the source host are dropped (as migrateEngine's). */
export interface ManagedStackUpdateBody {
  name?: string;
  composeContent?: string;
  envContent?: string | null;
  engineId?: number | null;
  registryCredentials?: Array<{ registry: string; username: string; password?: string }>;
  gitUsername?: string | null;
  gitToken?: string | null;
  composePath?: string | null;
  buildEnabled?: boolean;
  pollGitIntervalS?: number;
  gpuPolicy?: 'revoke';
}

// Fields added in later server versions — the client container can be updated before the server.
function withDefaults(s: ManagedStack): ManagedStack {
  return { ...s, volumesInStacksDir: !!s.volumesInStacksDir, volumePlacements: s.volumePlacements ?? [] };
}

export const managedStacksApi = {
  async list(): Promise<ManagedStack[]> {
    const res = await apiClient.get<ApiResponse<ManagedStack[]>>('/managed-stacks');
    return res.data.data!.map(withDefaults);
  },
  async getById(id: number): Promise<ManagedStack> {
    const res = await apiClient.get<ApiResponse<ManagedStack>>(`/managed-stacks/${id}`);
    return withDefaults(res.data.data!);
  },
  async create(data: { name: string; composeContent: string; envContent?: string | null; teamId?: number | null; engineId?: number | null; registryCredentials?: Array<{ registry: string; username: string; password?: string }>; gitUsername?: string | null; gitToken?: string | null; composePath?: string | null; buildEnabled?: boolean; pollGitIntervalS?: number }): Promise<ManagedStack> {
    const res = await apiClient.post<ApiResponse<ManagedStack>>('/managed-stacks', data);
    return withDefaults(res.data.data!);
  },
  async update(id: number, data: ManagedStackUpdateBody): Promise<ManagedStack> {
    return (await managedStacksApi.updateWithReport(id, data)).stack;
  },
  /**
   * update() plus what the save's limits carry reported. A rename or a move to another daemon
   * carries the stack's resource limits; `limitsAdjusted` lists the GPU ids / MPS VRAM caps of the
   * source host it dropped (null when nothing was, and always null from older servers). Without
   * `gpuPolicy: 'revoke'` the server refuses such a move with a 409 instead (see isGpuCarryRefusal).
   */
  async updateWithReport(id: number, data: ManagedStackUpdateBody): Promise<{ stack: ManagedStack; limitsAdjusted: LimitsCarryAdjustments | null }> {
    const res = await apiClient.put<ApiResponse<ManagedStack> & { limitsAdjusted?: LimitsCarryAdjustments | null }>(`/managed-stacks/${id}`, data);
    return { stack: withDefaults(res.data.data!), limitsAdjusted: res.data.limitsAdjusted ?? null };
  },
  /**
   * `forEngineId`: the engine of the discovered stack the delete comes from — the server refuses the
   * whole delete (409, nothing changed) when this managed stack runs on a different daemon, since
   * the page only matched it by project name. `keptVolumeData`: `.volumes` folders left on disk.
   * `force`: delete even though `compose down` failed (see isDownFailedRefusal); the answer then says
   * `containersLeftRunning`. `keptStackFiles`: the stack folder was left on disk because another
   * managed stack uses the same compose project (and so the same folder). `removedVolumes`: false
   * when a wipe was asked for but `down -v` failed and the server deleted the stack anyway (not
   * deployed, no .volumes data).
   */
  async delete(id: number, removeVolumes = false, forEngineId?: number | null, force = false): Promise<{ removedVolumes: boolean; keptVolumeData: string[]; containersLeftRunning: boolean; keptStackFiles: boolean }> {
    const engineParam = forEngineId !== undefined ? `&forEngine=${forEngineId ?? 'null'}` : '';
    const forceParam = force ? '&force=true' : '';
    const res = await apiClient.delete<ApiResponse<{ removedVolumes: boolean; keptVolumeData?: string[]; removedStackRows?: number; containersLeftRunning?: boolean; keptStackFiles?: boolean }>>(`/managed-stacks/${id}?volumes=${removeVolumes}${engineParam}${forceParam}`);
    const data = res.data?.data;
    return {
      // Older servers do not send it: read it as the wipe that was asked for.
      removedVolumes: data?.removedVolumes ?? removeVolumes,
      keptVolumeData: data?.keptVolumeData ?? [],
      containersLeftRunning: !!data?.containersLeftRunning,
      // Older servers do not send it: they never keep the folder.
      keptStackFiles: !!data?.keptStackFiles,
    };
  },
  /**
   * The server refuses a delete whose `compose down` failed (disabled or unreachable engine), since
   * the containers may still run; only then is `force` worth offering. Matches the server's
   * DOWN_FAILED_PREFIX in managed-stack.controller.ts.
   */
  isDownFailedRefusal(err: unknown): boolean {
    const r = (err as { response?: { status?: number; data?: { error?: string } } })?.response;
    return r?.status === 409 && typeof r.data?.error === 'string' && r.data.error.startsWith('docker compose down failed');
  },
  async deploy(id: number): Promise<void> {
    await apiClient.post(`/managed-stacks/${id}/deploy`);
  },
  async stop(id: number): Promise<void> {
    await apiClient.post(`/managed-stacks/${id}/stop`);
  },
  /** `keptVolumeData`: `.volumes` folders a wipe had to keep (still used by another container / volume). */
  async down(id: number, removeVolumes = false): Promise<{ removedVolumeData: string[]; keptVolumeData: string[] }> {
    const res = await apiClient.post<ApiResponse<{ removedVolumeData: string[]; keptVolumeData: string[] }>>(`/managed-stacks/${id}/down?volumes=${removeVolumes}`);
    return res.data.data ?? { removedVolumeData: [], keptVolumeData: [] };
  },
  async pull(id: number): Promise<{ exitCode: number; output: string }> {
    const res = await apiClient.post<ApiResponse<{ exitCode: number; output: string }>>(`/managed-stacks/${id}/pull`);
    return res.data.data!;
  },
  /** `forceRecreate`: `up --force-recreate`, every container is recreated even if unchanged. */
  async redeploy(id: number, opts: { forceRecreate?: boolean } = {}): Promise<void> {
    await apiClient.post(`/managed-stacks/${id}/redeploy`, opts.forceRecreate ? { forceRecreate: true } : undefined);
  },
  /**
   * `portSpecs` (ranges + protocols) wins over the legacy `ports` list (single ports, any protocol).
   * `engineId: null` means the LOCAL engine on the server (it used to mean the default engine), so
   * callers should always send the concrete id of the engine they are about to deploy to.
   */
  async checkPortConflicts(args: { engineId: number | null; ports?: number[]; portSpecs?: PortSpecInput[]; excludeComposeProject?: string }): Promise<{
    conflicts: PortConflictResult[];
  }> {
    const res = await apiClient.post<ApiResponse<{ conflicts: PortConflictResult[] }>>('/managed-stacks/check-port-conflicts', args);
    return res.data.data!;
  },

  // ── Build-pipeline source operations ──
  async uploadZip(id: number, file: File): Promise<ManagedStack> {
    const form = new FormData();
    form.append('file', file);
    const res = await apiClient.post<ApiResponse<ManagedStack>>(`/managed-stacks/${id}/source/zip`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return withDefaults(res.data.data!);
  },
  async setGitSource(id: number, args: { gitUrl: string; gitBranch?: string; gitUsername?: string | null; gitToken?: string | null; composePath?: string | null }): Promise<ManagedStack> {
    const res = await apiClient.post<ApiResponse<ManagedStack>>(`/managed-stacks/${id}/source/git`, args);
    return withDefaults(res.data.data!);
  },
  async getDeployHistory(id: number, limit = 50): Promise<Array<import('@oblihub/shared').ManagedStackDeployHistoryEntry>> {
    const res = await apiClient.get<ApiResponse<Array<import('@oblihub/shared').ManagedStackDeployHistoryEntry>>>(`/managed-stacks/${id}/deploy-history?limit=${limit}`);
    return res.data.data!;
  },
  async rollback(id: number, gitRef: string): Promise<ManagedStack> {
    const res = await apiClient.post<ApiResponse<{ stack: ManagedStack }>>(`/managed-stacks/${id}/rollback`, { gitRef });
    return withDefaults(res.data.data!.stack);
  },
  async gitPull(id: number): Promise<{ stack: ManagedStack; redeployStarted: boolean }> {
    // Server chains pull → background redeploy when the stack has been deployed at least once.
    // Callers surface a different toast message depending on `redeployStarted` so the operator
    // knows if they still need to click Deploy or if the rebuild is already in flight.
    const res = await apiClient.post<ApiResponse<ManagedStack> & { redeployStarted?: boolean }>(`/managed-stacks/${id}/source/git-pull`);
    return { stack: withDefaults(res.data.data!), redeployStarted: !!res.data.redeployStarted };
  },
  async listSourceFiles(id: number): Promise<{ path: string; size: number; isDir: boolean }[]> {
    const res = await apiClient.get<ApiResponse<{ path: string; size: number; isDir: boolean }[]>>(`/managed-stacks/${id}/source/files`);
    return res.data.data!;
  },
  async getGeneratedFiles(id: number): Promise<GeneratedComposeFile[]> {
    const res = await apiClient.get<ApiResponse<GeneratedComposeFile[]>>(`/managed-stacks/${id}/source/generated`);
    return res.data.data!;
  },
  async getEffectiveConfig(id: number): Promise<{ config: string | null; error: string | null; exitCode: number }> {
    const res = await apiClient.get<ApiResponse<{ config: string | null; error: string | null; exitCode: number }>>(`/managed-stacks/${id}/effective-config`);
    return res.data.data!;
  },

  // Engine migration
  async previewMigration(id: number): Promise<{ named: string[]; binds: string[] }> {
    const res = await apiClient.get<ApiResponse<{ named: string[]; binds: string[] }>>(`/managed-stacks/${id}/migration-preview`);
    return res.data.data!;
  },
  /**
   * `engineOnly`: both engines are the same local daemon — only the reference changed, nothing was redeployed.
   * `limitsAdjusted`: GPU ids / MPS VRAM caps of the source host that the target does not have were
   * dropped from the carried resource limits (`gpuRevoked`: the restriction lost every id and now
   * grants no GPU). `gpuPolicy: 'revoke'` accepts that up front; without it the server refuses such a
   * move with a 409 before stopping anything (see isGpuCarryRefusal).
   */
  async migrateEngine(id: number, body: { targetEngineId: number | null; strategy: 'just-save' | 'stop-and-deploy' | 'migrate-data'; gpuPolicy?: 'revoke' }): Promise<MigrateEngineResult> {
    const res = await apiClient.post<ApiResponse<MigrateEngineResult>>(`/managed-stacks/${id}/migrate-engine`, body);
    const data = res.data.data!;
    return { ...data, stack: withDefaults(data.stack) };
  },
  /** The 409 for GPU settings that do not fit the target engine, sent by migrateEngine and by a PUT
   *  (update / updateWithReport) that moves the stack to another daemon. Matches the server's
   *  GPU_CARRY_REFUSAL_PREFIX in managed-stack.service.ts. */
  isGpuCarryRefusal(err: unknown): boolean {
    const r = (err as { response?: { status?: number; data?: { error?: string } } })?.response;
    return r?.status === 409 && typeof r.data?.error === 'string' && r.data.error.startsWith('GPU restriction refers to GPUs of the source engine');
  },
  async cancel(id: number): Promise<{ killed: boolean }> {
    const res = await apiClient.post<ApiResponse<{ killed: boolean }>>(`/managed-stacks/${id}/cancel`);
    return res.data.data!;
  },
};
