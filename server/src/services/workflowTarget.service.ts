import { db } from '../db';
import type { WorkflowTarget, WorkflowTargetType } from '@oblihub/shared';

function rowToTarget(row: Record<string, unknown>): WorkflowTarget {
  return {
    id: row.id as number,
    name: row.name as string,
    description: (row.description as string) || null,
    teamId: (row.team_id as number) || null,
    ownerUserId: (row.owner_user_id as number) || null,
    targetType: (row.target_type as WorkflowTargetType) || 'sftp',
    host: row.host as string,
    port: (row.port as number) || 22,
    username: row.username as string,
    remotePath: row.remote_path as string,
    sshKeyId: (row.ssh_key_id as number) || null,
    hostKeyFingerprint: (row.host_key_fingerprint as string) || null,
    createdByUserId: (row.created_by_user_id as number) || null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export const workflowTargetService = {
  async list(filter?: { teamIds?: number[]; ownerUserId?: number; includeGlobal?: boolean }): Promise<WorkflowTarget[]> {
    const rows = await db('workflow_targets')
      .where(function () {
        if (filter?.teamIds?.length) this.orWhereIn('team_id', filter.teamIds);
        if (filter?.ownerUserId) this.orWhere({ owner_user_id: filter.ownerUserId });
        if (filter?.includeGlobal) {
          this.orWhere(function () { this.whereNull('team_id').whereNull('owner_user_id'); });
        }
      })
      .orderBy('name');
    return rows.map(rowToTarget);
  },

  async getById(id: number): Promise<WorkflowTarget | null> {
    const row = await db('workflow_targets').where({ id }).first();
    return row ? rowToTarget(row) : null;
  },

  async create(data: {
    name: string;
    description?: string | null;
    teamId?: number | null;
    ownerUserId?: number | null;
    targetType?: WorkflowTargetType;
    host: string;
    port?: number;
    username: string;
    remotePath: string;
    sshKeyId: number;
    hostKeyFingerprint?: string | null;
    createdByUserId?: number | null;
  }): Promise<WorkflowTarget> {
    if (data.teamId && data.ownerUserId) {
      throw new Error('Target cannot be both team-scoped and personal — pick one');
    }
    const [row] = await db('workflow_targets').insert({
      name: data.name,
      description: data.description || null,
      team_id: data.teamId || null,
      owner_user_id: data.ownerUserId || null,
      target_type: data.targetType || 'sftp',
      host: data.host,
      port: data.port ?? 22,
      username: data.username,
      remote_path: data.remotePath,
      ssh_key_id: data.sshKeyId,
      host_key_fingerprint: data.hostKeyFingerprint || null,
      created_by_user_id: data.createdByUserId || null,
    }).returning('*');
    return rowToTarget(row);
  },

  async update(id: number, data: Partial<{
    name: string;
    description: string | null;
    teamId: number | null;
    ownerUserId: number | null;
    host: string;
    port: number;
    username: string;
    remotePath: string;
    sshKeyId: number;
    hostKeyFingerprint: string | null;
  }>): Promise<WorkflowTarget | null> {
    if (data.teamId && data.ownerUserId) {
      throw new Error('Target cannot be both team-scoped and personal — pick one');
    }
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.teamId !== undefined) update.team_id = data.teamId;
    if (data.ownerUserId !== undefined) update.owner_user_id = data.ownerUserId;
    if (data.host !== undefined) update.host = data.host;
    if (data.port !== undefined) update.port = data.port;
    if (data.username !== undefined) update.username = data.username;
    if (data.remotePath !== undefined) update.remote_path = data.remotePath;
    if (data.sshKeyId !== undefined) update.ssh_key_id = data.sshKeyId;
    if (data.hostKeyFingerprint !== undefined) update.host_key_fingerprint = data.hostKeyFingerprint;
    const [row] = await db('workflow_targets').where({ id }).update(update).returning('*');
    return row ? rowToTarget(row) : null;
  },

  async delete(id: number): Promise<void> {
    // Same protective pattern as sshKey — surface a clean error if a workflow still points here.
    const referencing = await db('workflows')
      .whereRaw("action_config->>'targetId' = ?", [String(id)])
      .count<{ count: string }[]>('* as count')
      .first();
    if (referencing && Number(referencing.count) > 0) {
      throw new Error(`This target is used by ${referencing.count} workflow(s). Detach or delete them first.`);
    }
    await db('workflow_targets').where({ id }).delete();
  },
};
