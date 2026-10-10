import { db } from '../db';
import { getPlugin, getAllPlugins } from '../notifications/registry';
import type { NotificationPayload } from '../notifications/types';
import { logger } from '../utils/logger';
import { config } from '../config';
import type { NotificationChannel, NotificationBinding } from '@oblihub/shared';

interface ChannelRow {
  id: number; name: string; type: string; config: unknown; is_enabled: boolean;
  created_by: number | null; created_at: Date; updated_at: Date;
}

interface BindingRow {
  id: number; channel_id: number; scope: string; scope_id: number | null; override_mode: string;
}

function rowToChannel(row: ChannelRow): NotificationChannel {
  return {
    id: row.id, name: row.name, type: row.type as NotificationChannel['type'],
    config: (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as Record<string, unknown>,
    isEnabled: row.is_enabled,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

export const notificationService = {
  // -- Channel CRUD --
  async getChannels(): Promise<NotificationChannel[]> {
    const rows = await db<ChannelRow>('notification_channels').orderBy('name');
    return rows.map(rowToChannel);
  },

  async createChannel(data: { name: string; type: string; config: Record<string, unknown>; createdBy?: number }): Promise<NotificationChannel> {
    const [row] = await db<ChannelRow>('notification_channels').insert({
      name: data.name, type: data.type, config: JSON.stringify(data.config),
      is_enabled: true, created_by: data.createdBy ?? null,
    }).returning('*');
    return rowToChannel(row);
  },

  async updateChannel(id: number, data: { name?: string; config?: Record<string, unknown>; isEnabled?: boolean }): Promise<NotificationChannel | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.config !== undefined) update.config = JSON.stringify(data.config);
    if (data.isEnabled !== undefined) update.is_enabled = data.isEnabled;
    const [row] = await db<ChannelRow>('notification_channels').where({ id }).update(update).returning('*');
    return row ? rowToChannel(row) : null;
  },

  async deleteChannel(id: number): Promise<boolean> {
    return (await db('notification_channels').where({ id }).del()) > 0;
  },

  // -- Bindings --
  async getBindings(scope: string, scopeId: number | null): Promise<NotificationBinding[]> {
    const query = db<BindingRow>('notification_bindings').where({ scope });
    if (scopeId !== null) query.where({ scope_id: scopeId });
    else query.whereNull('scope_id');
    const rows = await query;
    return rows.map(r => ({ id: r.id, channelId: r.channel_id, scope: r.scope as NotificationBinding['scope'], scopeId: r.scope_id, overrideMode: r.override_mode as NotificationBinding['overrideMode'] }));
  },

  async addBinding(channelId: number, scope: string, scopeId: number | null, overrideMode: string = 'merge'): Promise<void> {
    await db('notification_bindings').insert({ channel_id: channelId, scope, scope_id: scopeId, override_mode: overrideMode })
      .onConflict(['channel_id', 'scope', 'scope_id']).merge({ override_mode: overrideMode });
  },

  async removeBinding(channelId: number, scope: string, scopeId: number | null): Promise<void> {
    const query = db('notification_bindings').where({ channel_id: channelId, scope });
    if (scopeId !== null) query.where({ scope_id: scopeId });
    else query.whereNull('scope_id');
    await query.del();
  },

  // -- Send --
  async sendForStack(stackId: number | null, stackName: string, payload: NotificationPayload): Promise<void> {
    payload.appName = config.appName;

    // Resolve channels: global bindings + stack bindings
    const globalBindings = await this.getBindings('global', null);
    const stackBindings = stackId ? await this.getBindings('stack', stackId) : [];

    // Determine effective channel IDs
    const channelIds = new Set<number>();
    for (const b of globalBindings) channelIds.add(b.channelId);

    // Stack bindings can merge, replace, or exclude
    if (stackBindings.length > 0) {
      const hasReplace = stackBindings.some(b => b.overrideMode === 'replace');
      if (hasReplace) {
        channelIds.clear();
        for (const b of stackBindings) {
          if (b.overrideMode !== 'exclude') channelIds.add(b.channelId);
        }
      } else {
        for (const b of stackBindings) {
          if (b.overrideMode === 'exclude') channelIds.delete(b.channelId);
          else channelIds.add(b.channelId);
        }
      }
    }

    // Send to each channel
    for (const channelId of channelIds) {
      const row = await db<ChannelRow>('notification_channels').where({ id: channelId, is_enabled: true }).first();
      if (!row) continue;
      const channel = rowToChannel(row);
      const plugin = getPlugin(channel.type);
      if (!plugin) continue;

      try {
        await plugin.send(channel.config, payload);
        await db('notification_log').insert({ channel_id: channelId, stack_id: stackId, event_type: payload.eventType, success: true }).catch(() => {});
      } catch (err) {
        logger.error({ channelId, type: channel.type, err }, 'Notification send failed');
        await db('notification_log').insert({ channel_id: channelId, stack_id: stackId, event_type: payload.eventType, success: false, error: String(err) }).catch(() => {});
      }
    }
  },

  async sendTest(channelId: number): Promise<void> {
    const row = await db<ChannelRow>('notification_channels').where({ id: channelId }).first();
    if (!row) throw new Error('Channel not found');
    const channel = rowToChannel(row);
    const plugin = getPlugin(channel.type);
    if (!plugin) throw new Error(`Unknown plugin type: ${channel.type}`);
    await plugin.send(channel.config, {
      stackName: 'Test Stack', containerName: 'test-container',
      image: 'nginx:latest', eventType: 'test',
      message: 'This is a test notification from Oblihub.',
      timestamp: new Date().toISOString(), appName: config.appName,
    });
  },

  getPluginMetas() {
    return getAllPlugins().map(p => ({ type: p.type, name: p.name, configFields: p.configFields }));
  },
};
