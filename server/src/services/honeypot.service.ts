import { db } from '../db';
import { appConfigService } from './appConfig.service';
import type { HoneypotPath } from '@oblihub/shared';

function rowToPath(row: Record<string, unknown>): HoneypotPath {
  return {
    id: row.id as number,
    proxyHostId: row.proxy_host_id as number,
    path: row.path as string,
    enabled: !!row.enabled,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/**
 * Per-proxy_host honeypot path management. Each path is a URI PREFIX that nginx serves via a
 * dedicated `location` block which logs to the honeypot log format — the HoneypotWorker then
 * bans the source IP. The set of paths is per-host: `/admin` may be a bait on public-facing
 * hosts but a real management URL on internal-only ones.
 */
export const honeypotService = {
  async list(proxyHostId: number): Promise<HoneypotPath[]> {
    const rows = await db('honeypot_paths').where({ proxy_host_id: proxyHostId }).orderBy('path');
    return rows.map(rowToPath);
  },

  async listEnabled(proxyHostId: number): Promise<HoneypotPath[]> {
    const rows = await db('honeypot_paths').where({ proxy_host_id: proxyHostId, enabled: true }).orderBy('path');
    return rows.map(rowToPath);
  },

  /** Replace the full set of paths for a host — used by the UI's "Save" that provides the whole list. */
  async replaceAll(proxyHostId: number, paths: Array<{ path: string; enabled: boolean }>): Promise<void> {
    await db('honeypot_paths').where({ proxy_host_id: proxyHostId }).delete();
    if (paths.length === 0) return;
    // Dedup by path — a UI mistake shouldn't crash the insert.
    const dedup = new Map<string, boolean>();
    for (const p of paths) {
      const clean = p.path.trim();
      if (!clean) continue;
      if (!dedup.has(clean)) dedup.set(clean, p.enabled);
    }
    await db('honeypot_paths').insert(
      [...dedup.entries()].map(([path, enabled]) => ({ proxy_host_id: proxyHostId, path, enabled })),
    );
  },

  async addOne(proxyHostId: number, path: string): Promise<HoneypotPath | null> {
    const clean = path.trim();
    if (!clean) return null;
    try {
      const [row] = await db('honeypot_paths').insert({ proxy_host_id: proxyHostId, path: clean, enabled: true }).returning('*');
      return rowToPath(row);
    } catch {
      // Duplicate key (unique on proxy_host_id + path) — return the existing row instead of throwing.
      const existing = await db('honeypot_paths').where({ proxy_host_id: proxyHostId, path: clean }).first();
      return existing ? rowToPath(existing) : null;
    }
  },

  async remove(id: number): Promise<void> {
    await db('honeypot_paths').where({ id }).delete();
  },

  async toggle(id: number, enabled: boolean): Promise<HoneypotPath | null> {
    const [row] = await db('honeypot_paths').where({ id }).update({ enabled, updated_at: new Date() }).returning('*');
    return row ? rowToPath(row) : null;
  },

  /**
   * The "Add common exploit URLs" quick-add: reads the seeded default list from app_config and
   * appends any missing entries to the host. Doesn't clobber existing entries or disable them.
   */
  async addDefaultPreset(proxyHostId: number): Promise<HoneypotPath[]> {
    const raw = await appConfigService.get('default_honeypot_paths');
    if (!raw) return this.list(proxyHostId);
    let defaults: string[] = [];
    try { defaults = JSON.parse(raw) as string[]; } catch { defaults = []; }
    if (defaults.length === 0) return this.list(proxyHostId);
    const existing = await db('honeypot_paths').where({ proxy_host_id: proxyHostId }).pluck('path');
    const existingSet = new Set(existing as string[]);
    const toInsert = defaults.filter(p => !existingSet.has(p)).map(p => ({ proxy_host_id: proxyHostId, path: p, enabled: true }));
    if (toInsert.length > 0) await db('honeypot_paths').insert(toInsert);
    return this.list(proxyHostId);
  },

  /** Fetch the default preset list itself (for the "Reset to defaults" UI). */
  async getDefaults(): Promise<string[]> {
    const raw = await appConfigService.get('default_honeypot_paths');
    if (!raw) return [];
    try { return JSON.parse(raw) as string[]; } catch { return []; }
  },
};
