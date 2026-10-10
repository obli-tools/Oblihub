import { db } from '../db';
import { appConfigService } from './appConfig.service';
import { logger } from '../utils/logger';
import type { BannedIp } from '@oblihub/shared';

/**
 * Server-to-server sync bridge to Obliguard. When Oblihub creates a ban (honeypot hit,
 * manual admin action), it is echoed to Obliguard's cross-suite ban store — Obliguard then
 * broadcasts through its own downstream (MikroTik routers, remote blocklists, other tenants).
 *
 * Auth: Obligate-signed DELEGATION TOKEN, app-scoped. Same pattern Oblidesk uses to read from
 * Obliance. Oblihub asks Obligate to mint a JWT (subjectType='app', audience='obliguard',
 * tenantSlug='master'), sends it as Bearer to Obliguard, Obliguard verifies via Obligate's
 * JWKS. No static shared secret. If Obligate is down, the sync fails and the ban stays local
 * with obliguard_error recorded — the retry worker takes over.
 *
 * Auto-discovery: the Obliguard URL comes from Obligate's connected_apps registry when both
 * apps are registered there, or from a manual override in app_config. Zero shared secret to
 * configure once Obligate is in place.
 *
 * Token caching: minted tokens live ~120s. We cache to just under 90s so we never send a
 * near-expiring token, and mint a fresh one per burst of bans instead of per-ban.
 */

interface ObliguardTarget { url: string; source: 'obligate' | 'manual'; }
interface TokenCacheEntry { token: string; expiresAtMs: number; }

const TOKEN_LIFETIME_MS = 90_000;  // token TTL is 120s, we refresh ~30s early
const TENANT_SLUG = 'master';       // cross-suite bans live at the platform tenant

let cachedToken: TokenCacheEntry | null = null;
let cachedTarget: { target: ObliguardTarget; fetchedAt: number } | null = null;
const TARGET_CACHE_MS = 60_000;

async function resolveTarget(): Promise<ObliguardTarget | null> {
  if (cachedTarget && Date.now() - cachedTarget.fetchedAt < TARGET_CACHE_MS) return cachedTarget.target;

  // Step 1 — auto-discovery via Obligate connected_apps
  try {
    const obligateUrl = await appConfigService.get('obligate_url');
    const obligateKey = await appConfigService.get('obligate_api_key');
    const obligateEnabled = (await appConfigService.get('obligate_enabled')) === 'true';
    if (obligateEnabled && obligateUrl && obligateKey) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(`${obligateUrl.replace(/\/$/, '')}/api/apps/connected`, {
          headers: { Authorization: `Bearer ${obligateKey}` },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json() as { data?: Array<{ appType?: string; name?: string; baseUrl?: string }> };
          const apps = data.data || [];
          const guard = apps.find(a =>
            (a.appType && a.appType.toLowerCase() === 'obliguard') ||
            (a.name && a.name.toLowerCase() === 'obliguard'));
          if (guard?.baseUrl) {
            const target: ObliguardTarget = { url: guard.baseUrl.replace(/\/$/, ''), source: 'obligate' };
            cachedTarget = { target, fetchedAt: Date.now() };
            return target;
          }
        }
      } catch { clearTimeout(timeout); }
    }
  } catch { /* fall through */ }

  // Step 2 — manual override (obliguard_url is optional; if only URL is set but no key,
  // that's fine — auth is via Obligate delegation token, not a shared secret).
  const manualUrl = await appConfigService.get('obliguard_url');
  if (manualUrl) {
    const target: ObliguardTarget = { url: manualUrl.replace(/\/$/, ''), source: 'manual' };
    cachedTarget = { target, fetchedAt: Date.now() };
    return target;
  }
  return null;
}

async function mintDelegationToken(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAtMs > Date.now() + 5_000) return cachedToken.token;
  const obligateUrl = await appConfigService.get('obligate_url');
  const obligateKey = await appConfigService.get('obligate_api_key');
  if (!obligateUrl || !obligateKey) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${obligateUrl.replace(/\/$/, '')}/api/delegation/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${obligateKey}`,
      },
      body: JSON.stringify({
        audience: 'obliguard',
        // App-scoped: sub = 'app:oblihub'. No user in the loop; ban push is a system action.
        subjectType: 'app',
        tenantSlug: TENANT_SLUG,
        scope: 'read',
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 200) }, 'Delegation mint refused by Obligate');
      return null;
    }
    const data = await res.json() as { success?: boolean; data?: { token: string; expiresAt: string } };
    if (!data.success || !data.data?.token) return null;
    cachedToken = { token: data.data.token, expiresAtMs: Date.now() + TOKEN_LIFETIME_MS };
    return cachedToken.token;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Delegation mint failed');
    return null;
  }
}

export const obliguardHubService = {
  /** Reachability + config check surfaced in Settings UI. */
  async getStatus(): Promise<{ configured: boolean; source: 'obligate' | 'manual' | null; url: string | null; reachable: boolean; hasDelegation: boolean }> {
    const target = await resolveTarget();
    if (!target) return { configured: false, source: null, url: null, reachable: false, hasDelegation: false };
    let reachable = false;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${target.url}/health`, { signal: controller.signal });
      clearTimeout(t);
      reachable = res.ok;
    } catch { /* unreachable */ }
    const token = await mintDelegationToken();
    return { configured: true, source: target.source, url: target.url, reachable, hasDelegation: !!token };
  },

  /**
   * Send a single ban to Obliguard. Idempotent from Obliguard's side (unique ip constraint).
   * Records the result on the banned_ips row so the operator sees success/failure per ban in
   * the /bans UI.
   */
  async sendBan(ban: BannedIp): Promise<void> {
    const target = await resolveTarget();
    if (!target) return;
    const token = await mintDelegationToken();
    if (!token) {
      await db('banned_ips').where({ id: ban.id }).update({
        obliguard_error: 'Delegation token mint failed (Obligate down or app not registered)',
      }).catch(() => {});
      return;
    }

    try {
      const domain = ban.sourceProxyHostId
        ? await db('proxy_hosts').where({ id: ban.sourceProxyHostId }).first().then((r: { domain_names?: unknown } | undefined) => {
            if (!r) return null;
            const raw = r.domain_names;
            const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? JSON.parse(raw) : []);
            return (arr as string[])[0] || null;
          }).catch(() => null)
        : null;

      const body = {
        ip: ban.ip,
        source: 'oblihub',
        reason: ban.reason || 'Honeypot hit',
        proxy_host_domain: domain,
        source_type: ban.sourceType,
        first_seen_at: ban.firstSeenAt,
        hit_count: ban.hitCount,
        banned_until: ban.bannedUntil,
      };

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${target.url}/api/external-bans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        await db('banned_ips').where({ id: ban.id }).update({
          sent_to_obliguard_at: new Date(),
          obliguard_error: null,
        });
      } else if (res.status === 401 || res.status === 403) {
        // Auth failure: invalidate the cached token so the NEXT retry mints a fresh one.
        cachedToken = null;
        const text = await res.text().catch(() => '');
        await db('banned_ips').where({ id: ban.id }).update({
          obliguard_error: `HTTP ${res.status}: ${text.slice(0, 400)}`,
        });
      } else {
        const text = await res.text().catch(() => '');
        await db('banned_ips').where({ id: ban.id }).update({
          obliguard_error: `HTTP ${res.status}: ${text.slice(0, 400)}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db('banned_ips').where({ id: ban.id }).update({ obliguard_error: msg.slice(0, 400) }).catch(() => {});
      logger.warn({ banId: ban.id, err: msg }, 'Obliguard sync failed');
    }
  },

  /**
   * Propagate a local unban to Obliguard. Called from banService.unban(). Fire-and-forget:
   * a failed delete never fails the local unban (audit trail already says the operator
   * intended it). Obliguard's DELETE endpoint filters by origin_app so we can only delete
   * bans that Oblihub originally pushed — an admin from one app can't wipe another app's
   * bans, even sharing the same Obliguard master tenant.
   */
  async deleteBan(ip: string): Promise<void> {
    const target = await resolveTarget();
    if (!target) return;
    const token = await mintDelegationToken();
    if (!token) return;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${target.url}/api/external-bans/${encodeURIComponent(ip)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(t);
      if (res.status === 401 || res.status === 403) cachedToken = null;
    } catch (err) {
      logger.warn({ ip, err: err instanceof Error ? err.message : String(err) }, 'Obliguard delete-through failed');
    }
  },

  /**
   * End-to-end connectivity test — mints a delegation token and calls Obliguard's ping
   * endpoint. Returns { ok, reason } so the Settings pill's Test button can tell the operator
   * exactly which step failed (mint / network / auth). More useful than getStatus() alone,
   * which only mints — this actually posts to the guarded endpoint.
   */
  async testPing(): Promise<{ ok: boolean; reason: string; target?: string }> {
    const target = await resolveTarget();
    if (!target) return { ok: false, reason: 'No Obliguard target configured or discovered' };
    const token = await mintDelegationToken();
    if (!token) return { ok: false, reason: 'Delegation token mint failed — check Obligate config', target: target.url };
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${target.url}/api/external-bans/ping`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(t);
      if (res.ok) return { ok: true, reason: 'Ping OK — Obliguard accepted the delegation token', target: target.url };
      const body = await res.text().catch(() => '');
      return { ok: false, reason: `HTTP ${res.status}: ${body.slice(0, 200)}`, target: target.url };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err), target: target.url };
    }
  },

  /**
   * Retry sync for any active bans that never made it upstream — called on a cron by the
   * honeypot worker so a temporary Obliguard outage self-heals without manual replay.
   */
  async retryUnsyncedBans(maxBatch = 100): Promise<{ attempted: number }> {
    const target = await resolveTarget();
    if (!target) return { attempted: 0 };
    const rows = await db('banned_ips')
      .whereNull('sent_to_obliguard_at')
      .where({ is_active: true })
      .orderBy('last_hit_at', 'desc')
      .limit(maxBatch);
    for (const r of rows) {
      await this.sendBan({
        id: r.id as number,
        ip: r.ip as string,
        bannedUntil: r.banned_until ? (r.banned_until as Date).toISOString() : null,
        reason: (r.reason as string) || null,
        sourceType: r.source_type,
        sourceProxyHostId: (r.source_proxy_host_id as number) || null,
        firstSeenAt: (r.first_seen_at as Date).toISOString(),
        lastHitAt: (r.last_hit_at as Date).toISOString(),
        hitCount: r.hit_count as number,
        sentToObliguardAt: null,
        obliguardError: null,
        isActive: true,
        bannedByUserId: (r.banned_by_user_id as number) || null,
        createdAt: (r.created_at as Date).toISOString(),
        updatedAt: (r.updated_at as Date).toISOString(),
      });
    }
    return { attempted: rows.length };
  },
};
