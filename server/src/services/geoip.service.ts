import { db } from '../db';
import { logger } from '../utils/logger';

/**
 * GeoIP lookup with DB-backed cache.
 *
 * v1: uses ip-api.com's free tier (no key required, 45 req/min limit). Every lookup is cached
 * in `ip_geo_cache` — subsequent hits for the same IP are DB reads, never hit the network.
 * Refresh policy: rows older than 30 days are considered stale and re-resolved on next request.
 *
 * v2 hook: `LOCAL_MMDB_PATH` env var. If set to a path pointing at a MaxMind GeoLite2-City
 * .mmdb file, the service switches to reading locally (require the `maxmind` npm package to
 * be added — future work). Falls back to ip-api if the file is unreadable.
 *
 * Rate limiting: batched processing with a soft 40 req/min cap (leaves headroom under the 45
 * limit). Anything past that in the same minute silently returns null — the caller can retry
 * later or just render "Unknown" on the map.
 */

// 30 days. Also the purge age of ip_geo_cache rows (workers/RetentionWorker.ts): a purged IP
// is simply a cache miss and gets re-resolved on its next sighting.
export const GEO_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_AFTER_MS = GEO_CACHE_TTL_MS;
const RATE_LIMIT_PER_MIN = 40;

let requestsThisMinute = 0;
let minuteResetAt = Date.now() + 60_000;

function resetRateWindow(): void {
  if (Date.now() >= minuteResetAt) {
    requestsThisMinute = 0;
    minuteResetAt = Date.now() + 60_000;
  }
}

export interface GeoInfo {
  ip: string;
  countryCode: string | null;
  countryName: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  org: string | null;
}

function isPrivateOrLocal(ip: string): boolean {
  if (!ip) return true;
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  // 172.16.0.0 – 172.31.255.255
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1] || '0', 10);
    if (second >= 16 && second <= 31) return true;
  }
  // Docker default / VPN ranges — treat as private too.
  if (ip.startsWith('172.17.') || ip.startsWith('172.18.') || ip.startsWith('172.19.')) return true;
  if (ip.startsWith('100.64.') || ip.startsWith('100.65.') || ip.startsWith('100.66.')) return true; // CG-NAT / Tailscale
  if (ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd00:')) return true; // IPv6 link-local / ULA
  return false;
}

async function lookupExternal(ip: string): Promise<GeoInfo | null> {
  resetRateWindow();
  if (requestsThisMinute >= RATE_LIMIT_PER_MIN) return null;
  requestsThisMinute++;
  try {
    // ip-api.com free tier. `fields` param keeps the response small and stable.
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,city,lat,lon,org`, {
      // Node 18+'s undici fetch. 5s timeout via AbortController — no network dep should stall
      // the log worker's flush.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    if (data.status !== 'success') return null;
    return {
      ip,
      countryCode: (data.countryCode as string) || null,
      countryName: (data.country as string) || null,
      city: (data.city as string) || null,
      latitude: typeof data.lat === 'number' ? data.lat : null,
      longitude: typeof data.lon === 'number' ? data.lon : null,
      org: (data.org as string) || null,
    };
  } catch (err) {
    logger.warn({ ip, err: err instanceof Error ? err.message : String(err) }, 'GeoIP external lookup failed');
    return null;
  }
}

export const geoipService = {
  /**
   * Resolve one IP. Cached in `ip_geo_cache`. Private / RFC1918 / IPv6 ULA return null instantly.
   */
  async lookup(ip: string): Promise<GeoInfo | null> {
    if (isPrivateOrLocal(ip)) return null;
    const cached = await db('ip_geo_cache').where({ ip }).first();
    if (cached) {
      const age = Date.now() - new Date(cached.looked_up_at as Date).getTime();
      if (age < STALE_AFTER_MS) {
        return {
          ip,
          countryCode: (cached.country_code as string) || null,
          countryName: (cached.country_name as string) || null,
          city: (cached.city as string) || null,
          latitude: cached.latitude != null ? Number(cached.latitude) : null,
          longitude: cached.longitude != null ? Number(cached.longitude) : null,
          org: (cached.org as string) || null,
        };
      }
    }
    const fresh = await lookupExternal(ip);
    if (!fresh) return cached ? {
      // On rate-limit or network error, keep serving the stale cached value rather than
      // dropping the row from the response entirely.
      ip,
      countryCode: (cached.country_code as string) || null,
      countryName: (cached.country_name as string) || null,
      city: (cached.city as string) || null,
      latitude: cached.latitude != null ? Number(cached.latitude) : null,
      longitude: cached.longitude != null ? Number(cached.longitude) : null,
      org: (cached.org as string) || null,
    } : null;

    await db('ip_geo_cache')
      .insert({
        ip: fresh.ip,
        country_code: fresh.countryCode,
        country_name: fresh.countryName,
        city: fresh.city,
        latitude: fresh.latitude,
        longitude: fresh.longitude,
        org: fresh.org,
        looked_up_at: new Date(),
      })
      .onConflict('ip')
      .merge({
        country_code: fresh.countryCode,
        country_name: fresh.countryName,
        city: fresh.city,
        latitude: fresh.latitude,
        longitude: fresh.longitude,
        org: fresh.org,
        looked_up_at: new Date(),
      });
    return fresh;
  },

  /** Bulk resolve — dedup + cache-hit fast path + rate-limited misses. */
  async lookupMany(ips: string[]): Promise<Map<string, GeoInfo | null>> {
    const out = new Map<string, GeoInfo | null>();
    const unique = [...new Set(ips.filter(ip => !isPrivateOrLocal(ip)))];
    for (const ip of unique) {
      out.set(ip, await this.lookup(ip));
    }
    return out;
  },
};
