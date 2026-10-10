import { db } from '../db';
import type { Team } from '@oblihub/shared';

export const teamService = {
  async getAll(): Promise<Team[]> {
    const teams = await db('teams').orderBy('name');
    return Promise.all(teams.map(t => this.hydrate(t)));
  },

  async getById(id: number): Promise<Team | null> {
    const team = await db('teams').where({ id }).first();
    return team ? this.hydrate(team) : null;
  },

  async hydrate(row: Record<string, unknown>): Promise<Team> {
    const id = row.id as number;
    const members = await db('team_members')
      .join('users', 'team_members.user_id', 'users.id')
      .where({ team_id: id })
      .select('team_members.id', 'team_members.user_id', 'users.username', 'users.display_name');

    const resources = await db('team_resources')
      .where({ team_id: id })
      .select('*');

    // Resolve resource names
    const resolvedResources = await Promise.all(resources.map(async (r: Record<string, unknown>) => {
      let name = '';
      if (r.resource_type === 'stack') {
        const stack = await db('stacks').where({ id: r.resource_id }).first();
        name = stack?.name || `Stack #${r.resource_id}`;
      } else {
        const container = await db('containers').where({ id: r.resource_id }).first();
        name = container?.container_name || `Container #${r.resource_id}`;
      }
      return {
        id: r.id as number,
        resourceType: r.resource_type as 'stack' | 'container',
        resourceId: r.resource_id as number,
        resourceName: name,
        excluded: r.excluded as boolean,
      };
    }));

    return {
      id,
      name: row.name as string,
      description: (row.description as string) || null,
      allResources: row.all_resources as boolean,
      maxStacks: (row.max_stacks as number) ?? null,
      maxContainers: (row.max_containers as number) ?? null,
      maxCertificates: (row.max_certificates as number) ?? null,
      maxProxyHosts: (row.max_proxy_hosts as number) ?? null,
      members: members.map((m: Record<string, unknown>) => ({
        id: m.id as number,
        userId: m.user_id as number,
        username: m.username as string,
        displayName: (m.display_name as string) || null,
      })),
      resources: resolvedResources,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  },

  async create(data: { name: string; description?: string; allResources?: boolean; maxStacks?: number | null; maxContainers?: number | null; maxCertificates?: number | null; maxProxyHosts?: number | null }): Promise<Team> {
    const [row] = await db('teams').insert({
      name: data.name,
      description: data.description || null,
      all_resources: data.allResources || false,
      max_stacks: data.maxStacks ?? null,
      max_containers: data.maxContainers ?? null,
      max_certificates: data.maxCertificates ?? null,
      max_proxy_hosts: data.maxProxyHosts ?? null,
    }).returning('*');
    return this.hydrate(row);
  },

  async update(id: number, data: { name?: string; description?: string; allResources?: boolean; maxStacks?: number | null; maxContainers?: number | null; maxCertificates?: number | null; maxProxyHosts?: number | null }): Promise<Team | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.allResources !== undefined) update.all_resources = data.allResources;
    if (data.maxStacks !== undefined) update.max_stacks = data.maxStacks;
    if (data.maxContainers !== undefined) update.max_containers = data.maxContainers;
    if (data.maxCertificates !== undefined) update.max_certificates = data.maxCertificates;
    if (data.maxProxyHosts !== undefined) update.max_proxy_hosts = data.maxProxyHosts;
    await db('teams').where({ id }).update(update);
    return this.getById(id);
  },

  async delete(id: number): Promise<void> {
    await db('teams').where({ id }).delete();
  },

  async addMember(teamId: number, userId: number): Promise<void> {
    await db('team_members').insert({ team_id: teamId, user_id: userId }).onConflict(['team_id', 'user_id']).ignore();
  },

  async removeMember(teamId: number, userId: number): Promise<void> {
    await db('team_members').where({ team_id: teamId, user_id: userId }).delete();
  },

  async addResource(teamId: number, resourceType: 'stack' | 'container', resourceId: number): Promise<void> {
    await db('team_resources').insert({ team_id: teamId, resource_type: resourceType, resource_id: resourceId }).onConflict(['team_id', 'resource_type', 'resource_id']).ignore();
  },

  async removeResource(teamId: number, resourceType: 'stack' | 'container', resourceId: number): Promise<void> {
    await db('team_resources').where({ team_id: teamId, resource_type: resourceType, resource_id: resourceId }).delete();
  },

  async setExcluded(teamId: number, resourceType: 'stack' | 'container', resourceId: number, excluded: boolean): Promise<void> {
    await db('team_resources').where({ team_id: teamId, resource_type: resourceType, resource_id: resourceId }).update({ excluded });
  },

  async setResources(teamId: number, resources: { type: 'stack' | 'container'; id: number; excluded?: boolean }[]): Promise<void> {
    await db('team_resources').where({ team_id: teamId }).delete();
    if (resources.length > 0) {
      await db('team_resources').insert(resources.map(r => ({
        team_id: teamId,
        resource_type: r.type,
        resource_id: r.id,
        excluded: r.excluded || false,
      })));
    }
  },

  /** Get team names that have access to a stack */
  async getTeamsForStack(stackId: number): Promise<string[]> {
    const allTeams = await db('teams').select('id', 'name', 'all_resources');
    const result: string[] = [];
    for (const team of allTeams) {
      if (team.all_resources) { result.push(team.name); continue; }
      const resource = await db('team_resources').where({ team_id: team.id, resource_type: 'stack', resource_id: stackId, excluded: false }).first();
      if (resource) result.push(team.name);
    }
    return result;
  },

  /** Get teams for a user */
  async getTeamsForUser(userId: number): Promise<Team[]> {
    const teamIds = await db('team_members').where({ user_id: userId }).pluck('team_id');
    if (teamIds.length === 0) return [];
    const teams = await db('teams').whereIn('id', teamIds).orderBy('name');
    return Promise.all(teams.map(t => this.hydrate(t)));
  },

  /** Check if a user has access to a resource via their teams */
  async userHasAccess(userId: number, resourceType: 'stack' | 'container', resourceId: number): Promise<boolean> {
    const teams = await this.getTeamsForUser(userId);
    for (const team of teams) {
      // All resources = access to everything
      if (team.allResources) {
        // Check if explicitly excluded
        const excluded = team.resources.find(r => r.resourceType === resourceType && r.resourceId === resourceId && r.excluded);
        if (!excluded) return true;
      }
      // Check direct resource assignment
      const resource = team.resources.find(r => r.resourceType === resourceType && r.resourceId === resourceId && !r.excluded);
      if (resource) return true;
      // If resource is a container, check if parent stack is assigned
      if (resourceType === 'container') {
        const container = await db('containers').where({ id: resourceId }).first();
        if (container?.stack_id) {
          const stackResource = team.resources.find(r => r.resourceType === 'stack' && r.resourceId === container.stack_id && !r.excluded);
          if (stackResource) {
            // Check container not individually excluded
            const containerExcluded = team.resources.find(r => r.resourceType === 'container' && r.resourceId === resourceId && r.excluded);
            if (!containerExcluded) return true;
          }
        }
      }
    }
    return false;
  },
};
