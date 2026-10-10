import { db } from '../db';
import { logger } from '../utils/logger';
import { geoipService } from './geoip.service';
import type { BannedIp, BanSourceType } from '@oblihub/shared';

/**
 * Centralized IP ban store used by the honeypot machinery + manual admin actions.
 *
 * Bans are GLOBAL by default — one row applies to every proxy_host via the nginx ban_map. A
 * scanner caught on one host is silently 404'd on the whole install, which is the desired
 * behavior: an attacker probing my Oblihub for /wp-login.php doesn't get a second chance at
 * my Gitea or Home Assistant either.
 *
 * Dedup: `ip` is UNIQUE. Repeat hits increment hit_count + push last_hit_at + extend
 * banned_until if the new ban has a longer window. Manual unbans just flip is_active to false
 * so the audit trail survives.
 *
 * Every successful create() fire-and-forgets an Obliguard sync — see obliguardHub.service.
 */

function rowToBan(row: Record<string, unknown>): BannedIp {
  return {
    id: row.id as number,
    ip: row.ip as string,
    bannedUntil: row.banned_until ? (row.banned_until as Date).toISOString() : null,
    reason: (row.reason as string) || null,
    sourceType: row.source_type as BanSourceType,
    sourceProxyHostId: (row.source_proxy_host_id as number) || null,
    firstSeenAt: (row.first_seen_at as Date).toISOString(),
    lastHitAt: (row.last_hit_at as Date).toISOString(),
    hitCount: row.hit_count as number,
    sentToObliguardAt: row.sent_to_obliguard_at ? (row.sent_to_obliguard_at as Date).toISOString() : null,
    obliguardError: (row.obliguard_error as string) || null,
    isActive: !!row.is_active,
    bannedByUserId: (row.banned_by_user_id as number) || null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1] || '0', 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd00:')) return true;
  return false;
}

interface CreateBanArgs {
  ip: string;
  reason?: string;
  sourceType: BanSourceType;
  sourceProxyHostId?: number | null;
  banDurationSeconds?: number | null;  // null / undefined = permanent
  bannedByUserId?: number | null;
}

export const banService = {
  async list(opts?: { activeOnly?: boolean; sourceType?: BanSourceType; hostId?: number; enrich?: boolean; limit?: number }): Promise<BannedIp[]> {
    let q = db('banned_ips').orderBy('last_hit_at', 'desc');
    if (opts?.activeOnly !== false) q = q.where({ is_active: true });
    if (opts?.sourceType) q = q.where({ source_type: opts.sourceType });
    if (opts?.hostId) q = q.where({ source_proxy_host_id: opts.hostId });
    if (opts?.limit) q = q.limit(opts.limit);
    const rows = await q;
    const bans = rows.map(rowToBan);
    if (opts?.enrich) {
      // GeoIP lookup + host domain resolution — same batching pattern as traffic controllers.
      const ips = [...new Set(bans.map(b => b.ip))];
      const geoMap = await geoipService.lookupMany(ips);
      const hostIds = [...new Set(bans.map(b => b.sourceProxyHostId).filter((x): x is number => x != null))];
      const hostRows = hostIds.length > 0 ? await db('proxy_hosts').whereIn('id', hostIds).select('id', 'domain_names') : [];
      const domainByHost = new Map<number, string>();
      for (const h of hostRows) {
        const raw = h.domain_names;
        const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? JSON.parse(raw) : []);
        domainByHost.set(h.id as number, arr[0] || `#${h.id}`);
      }
      for (const b of bans) {
        const g = geoMap.get(b.ip);
        b.geo = g ? { countryCode: g.countryCode, countryName: g.countryName, city: g.city, org: g.org } : null;
        b.sourceProxyHostDomain = b.sourceProxyHostId != null ? (domainByHost.get(b.sourceProxyHostId) || null) : null;
      }
    }
    return bans;
  },

  async getById(id: number): Promise<BannedIp | null> {
    const row = await db('banned_ips').where({ id }).first();
    return row ? rowToBan(row) : null;
  },

  async isBanned(ip: string): Promise<boolean> {
    const row = await db('banned_ips').where({ ip, is_active: true }).first();
    if (!row) return false;
    if (row.banned_until && new Date(row.banned_until as Date) < new Date()) return false;
    return true;
  },

  /**
   * Register (or refresh) a ban. Dedup on IP:
   *   - New IP → INSERT + fire Obliguard sync
   *   - Existing IP → increment hit_count, extend banned_until if new window is longer or is
   *     permanent, refresh last_hit_at. Does NOT re-fire Obliguard (avoid spam).
   * Private/link-local IPs are silently dropped — banning your own LAN would be the ultimate
   * self-DoS.
   */
  async create(args: CreateBanArgs): Promise<BannedIp | null> {
    if (isPrivateIp(args.ip)) {
      logger.debug({ ip: args.ip }, 'banService.create: ignoring private/link-local IP');
      return null;
    }
    const now = new Date();
    const bannedUntil = args.banDurationSeconds != null && args.banDurationSeconds > 0
      ? new Date(now.getTime() + args.banDurationSeconds * 1000)
      : null; // null = permanent
    const existing = await db('banned_ips').where({ ip: args.ip }).first();
    if (existing) {
      // Two paths depending on whether the row was manually unbanned:
      //
      //   ACTIVE   → recurring offender. Bump hit_count, extend banned_until if the new
      //              window is more restrictive (null = permanent beats any timestamp), and
      //              refresh reason/source to reflect the LATEST hit (otherwise the display
      //              fossilizes on whatever the FIRST hit was and misleads diagnosis).
      //
      //   INACTIVE → operator manually unbanned this IP earlier. Treat the next hit as a
      //              NEW ban — reset hit_count to 1, reset first_seen_at, update reason, and
              //      re-arm is_active. This matches operator intent: "delete = second chance,
      //              start over if they re-offend." Also re-fires the Obliguard sync so the
      //              downstream stores get the fresh event, not an increment on a row they
      //              thought was closed.
      const currentUntil = existing.banned_until ? new Date(existing.banned_until as Date) : null;
      let newUntil = currentUntil;
      if (bannedUntil == null) newUntil = null;
      else if (currentUntil != null && bannedUntil > currentUntil) newUntil = bannedUntil;

      const wasInactive = !existing.is_active;
      const [updated] = await db('banned_ips').where({ id: existing.id }).update({
        banned_until: wasInactive ? bannedUntil : newUntil,
        hit_count: wasInactive ? 1 : db.raw('hit_count + 1'),
        first_seen_at: wasInactive ? now : existing.first_seen_at,
        last_hit_at: now,
        is_active: true,
        updated_at: now,
        reason: args.reason ?? existing.reason,
        source_type: args.sourceType ?? existing.source_type,
        source_proxy_host_id: args.sourceProxyHostId ?? existing.source_proxy_host_id,
        sent_to_obliguard_at: wasInactive ? null : existing.sent_to_obliguard_at,
        obliguard_error: wasInactive ? null : existing.obliguard_error,
      }).returning('*');
      const ban = rowToBan(updated);
      if (wasInactive) {
        (async () => {
          try {
            const { obliguardHubService } = await import('./obliguardHub.service');
            await obliguardHubService.sendBan(ban);
          } catch (err) {
            logger.warn({ ban: ban.id, err: err instanceof Error ? err.message : String(err) }, 'Obliguard re-sync on unban+rehit failed (non-fatal)');
          }
        })();
      }
      return ban;
    }

    const [row] = await db('banned_ips').insert({
      ip: args.ip,
      banned_until: bannedUntil,
      reason: args.reason || null,
      source_type: args.sourceType,
      source_proxy_host_id: args.sourceProxyHostId || null,
      first_seen_at: now,
      last_hit_at: now,
      hit_count: 1,
      is_active: true,
      banned_by_user_id: args.bannedByUserId || null,
    }).returning('*');
    const ban = rowToBan(row);
    // Fire-and-forget Obliguard sync — never fail the ban path because of a downstream flake.
    // Import lazily to avoid a boot-time circular dep with app_config service.
    (async () => {
      try {
        const { obliguardHubService } = await import('./obliguardHub.service');
        await obliguardHubService.sendBan(ban);
      } catch (err) {
        logger.warn({ ban: ban.id, err: err instanceof Error ? err.message : String(err) }, 'Obliguard sync failed (non-fatal)');
      }
    })();
    return ban;
  },

  /**
   * Soft-delete: flip is_active off, keep the row for the audit log.
   * Also propagates the unban to Obliguard fire-and-forget — a local unban should NEVER be
   * blocked by an Obliguard failure. Obliguard filters by origin_app so we only unban rows
   * that Oblihub originally pushed; another app's bans stay untouched.
   */
  async unban(id: number): Promise<boolean> {
    const row = await db('banned_ips').where({ id }).first();
    if (!row) return false;
    const count = await db('banned_ips').where({ id }).update({ is_active: false, updated_at: new Date() });
    if (count > 0 && row.sent_to_obliguard_at) {
      // Only propagate if we actually pushed the ban upstream — no point calling Obliguard
      // to delete something it never received.
      (async () => {
        try {
          const { obliguardHubService } = await import('./obliguardHub.service');
          await obliguardHubService.deleteBan(row.ip as string);
        } catch (err) {
          logger.warn({ ip: row.ip, err: err instanceof Error ? err.message : String(err) }, 'Obliguard delete-through failed (non-fatal)');
        }
      })();
    }
    return count > 0;
  },

  /** Purge expired temporary bans + inactive rows older than 90d (audit retention). */
  async purge(): Promise<{ expired: number; oldInactive: number }> {
    const now = new Date();
    const expired = await db('banned_ips')
      .where({ is_active: true })
      .whereNotNull('banned_until')
      .where('banned_until', '<', now)
      .update({ is_active: false, updated_at: now });
    const oldInactive = await db('banned_ips')
      .where({ is_active: false })
      .where('updated_at', '<', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))
      .delete();
    return { expired, oldInactive };
  },

  /** Full list of currently-active bans — used by nginx ban_map generator. */
  async listActiveIps(): Promise<string[]> {
    const now = new Date();
    const rows = await db('banned_ips')
      .where({ is_active: true })
      .where(function () { this.whereNull('banned_until').orWhere('banned_until', '>', now); })
      .select('ip');
    return rows.map(r => r.ip as string);
  },
};
