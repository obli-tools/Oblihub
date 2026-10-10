import crypto from 'crypto';
import { db } from '../db';
import { appConfigService } from './appConfig.service';
import { logger } from '../utils/logger';
import { safeEqualSecret } from '../utils/safeCompare';

/**
 * Public OAuth client id of this app for Obligate: lowercase hex SHA-256 of
 * the API key. Cross-repo contract with Obligate (publicClientId() in its
 * app.service.ts) — change it on both sides or not at all.
 */
export function obligatePublicClientId(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/**
 * What Obligate asserts after a successful sign-in (POST /api/oauth/token/exchange,
 * our key as Bearer, one-time 60 s code bound to the redirect_uri). Trusted as
 * Obligate's word on WHO signed in and with which role — except
 * `linkedLocalUserId`, see getLinkedLocalUserId.
 */
export interface ObligateAssertion {
  obligateUserId: number;
  username: string;
  email: string | null;
  displayName: string | null;
  role: string;
  tenants: Array<{ slug: string; role: string }>;
  teams: string[];
  /**
   * Obligate's copy of the local id WE reported (report-provision). Anyone
   * holding the API key can rewrite it: never used to pick the local account.
   */
  linkedLocalUserId: number | null;
  preferences?: Record<string, unknown>;
}

/** One user of Obligate's roster for this app (GET /api/apps/users). */
export interface ObligateRosterEntry {
  /** The role Obligate gives this user on this app. */
  role: string;
  teams: string[];
  /**
   * Obligate's pointer to our local account (what report-provision last set —
   * anyone holding the API key can rewrite it). Only compared with our own
   * link, to re-report ours when they differ; never used to pick an account.
   */
  linkedLocalUserId: number | null;
}
/** Obligate user id → roster entry. */
export type ObligateRoster = Map<number, ObligateRosterEntry>;

export interface ObligateConnectedApp {
  appType: string;
  name: string;
  baseUrl: string;
  icon: string | null;
  color: string | null;
  /** Marks the entry that is this app itself (resolved by Obligate from the Bearer key). */
  self?: true;
  /** Not an Obli* app (filed under "More…" in Obligate). */
  thirdParty?: boolean;
}

/** app_type this app is registered under in Obligate. */
const OWN_APP_TYPE = 'oblihub';

/** Normalised `scheme://host[:port]` of an http(s) URL (lower-case host, no default port), or null. */
export function toHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** localhost / loopback origin: for another machine's browser, that is itself. */
function isLoopbackOrigin(origin: string): boolean {
  const { hostname } = new URL(origin);
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || /^127\./.test(hostname);
}

/** Public origin set by the operator (APP_URL / CLIENT_ORIGIN, read at call time), or null when unset. */
function envOrigin(name: 'APP_URL' | 'CLIENT_ORIGIN'): string | null {
  const value = process.env[name]?.trim();
  return value ? toHttpOrigin(value) : null;
}

/**
 * true when the operator named this instance's public URL: APP_URL is set, or
 * CLIENT_ORIGIN is set to a non-loopback URL (the docker-compose default
 * http://localhost names nothing). The base URL registered in Obligate is then
 * never trusted (it may be another instance's, or a stale domain).
 */
function publicOriginPinned(): boolean {
  if (envOrigin('APP_URL')) return true;
  const clientOrigin = envOrigin('CLIENT_ORIGIN');
  return clientOrigin !== null && !isLoopbackOrigin(clientOrigin);
}

// Logged once per process: the redirect_uri relies on the base URL registered in Obligate
let registeredOriginWarned = false;

const ORIGIN_CACHE_TTL_MS = 5 * 60 * 1000;
const ORIGIN_CACHE_MIN_REFRESH_MS = 30 * 1000;
/** Obligate allows its sso-user-sync pushes 5 s: the roster read stays under it. */
const ROSTER_TIMEOUT_MS = 4_000;
const OUTBOUND_TIMEOUT_MS = 5_000;

/** Oblihub's brand accent (logo blue, client --c-accent), announced to Obligate. */
const APP_ACCENT_COLOR = '#1678cd';

// Roster reads (see getAppRoster): at most one in flight, plus one queued
// behind it that every caller arriving meanwhile shares.
let rosterInflight: { promise: Promise<ObligateRoster | null> } | null = null;
let rosterQueued: Promise<ObligateRoster | null> | null = null;

/** Never rejects: null on any failure (settings unreadable, Obligate down…). */
async function fetchRoster(): Promise<ObligateRoster | null> {
  try {
    const raw = await appConfigService.getObligateRaw();
    // SSO switched off: nothing to confirm (the inbound routes refuse anyway)
    if (!raw.enabled || !raw.url || !raw.apiKey) return null;
    const res = await fetch(`${raw.url}/api/apps/users`, {
      headers: { 'Authorization': `Bearer ${raw.apiKey}` },
      signal: AbortSignal.timeout(ROSTER_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(`Obligate roster fetch failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json() as { success?: boolean; data?: unknown };
    if (!data?.success || !Array.isArray(data.data)) return null;
    const roster: ObligateRoster = new Map();
    for (const item of data.data) {
      const u = item as { obligateUserId?: unknown; role?: unknown; teams?: unknown; linkedLocalUserId?: unknown } | null;
      const id = u?.obligateUserId;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue;
      if (typeof u!.role !== 'string' || !u!.role) continue; // no role = no access here
      const teams = Array.isArray(u!.teams) ? (u!.teams as unknown[]).filter((s): s is string => typeof s === 'string') : [];
      const linked = u!.linkedLocalUserId;
      const linkedLocalUserId = typeof linked === 'number' && Number.isSafeInteger(linked) && linked > 0 ? linked : null;
      roster.set(id, { role: u!.role, teams, linkedLocalUserId });
    }
    return roster;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Obligate roster fetch error');
    return null;
  }
}

function startRosterFetch(): Promise<ObligateRoster | null> {
  const entry = { promise: fetchRoster() };
  rosterInflight = entry;
  const clear = () => { if (rosterInflight === entry) rosterInflight = null; };
  entry.promise.then(clear, clear);
  return entry.promise;
}

export const obligateService = {
  async getSsoConfig(): Promise<{ obligateUrl: string | null; obligateReachable: boolean; obligateEnabled: boolean }> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.enabled) {
      return { obligateUrl: null, obligateReachable: false, obligateEnabled: false };
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${raw.url}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      return { obligateUrl: raw.url, obligateReachable: res.ok, obligateEnabled: true };
    } catch {
      return { obligateUrl: raw.url, obligateReachable: false, obligateEnabled: true };
    }
  },

  /**
   * client_id for the browser-facing /authorize URL (it goes through the
   * browser: Location header, history, Referer, access logs — it is PUBLIC).
   * Always the public id obligatePublicClientId(apiKey): the key itself never
   * leaves the server that way, and Obligate refuses it as a client_id.
   */
  authorizeClientId(raw: { apiKey: string | null }): string | null {
    if (!raw.apiKey) return null;
    return obligatePublicClientId(raw.apiKey);
  },

  /**
   * Authenticate a server-to-server call made by Obligate to this server
   * (`Authorization: Bearer <secret>`): sso-user-sync, app-info,
   * dashboard-stats.
   *
   * The expected secret is the distinct inbound secret when one is set
   * (Settings or OBLIGATE_INBOUND_SECRET), else the API key (today's wire
   * behaviour). Constant-time, and fails closed when nothing is configured.
   *
   * Earlier versions sent the raw API key as the client_id (in the
   * /auth/sso-redirect Location header), so a key configured back then must be
   * treated as known to others until it is regenerated in Obligate: these
   * routes must never grant more than a key holder may do — see /sso-user-sync.
   */
  async verifyInboundBearer(authHeader: string | string[] | undefined): Promise<boolean> {
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return false;
    const raw = await appConfigService.getObligateRaw();
    // "Enable SSO" off (Settings) = every Obligate route of this app is off,
    // e.g. an admin reacting to a leaked key
    if (!raw.enabled) return false;
    const expected = raw.inboundSecret ?? raw.apiKey;
    return safeEqualSecret(authHeader.slice(7), expected);
  },

  /**
   * The local account linked to an Obligate identity, from OUR records only:
   *   1. the sso_foreign_users row of that identity — written by this server
   *      alone (SSO provisioning), never from anything Obligate says — when it
   *      points to the og_ account provisioned for that identity
   *      (users.foreign_source 'obligate' and the same foreign_id);
   *   2. else the og_ account provisioned for it, e.g. when the link row went
   *      missing.
   * Oblihub never links an Obligate identity to a LOCAL account: the result is
   * always an og_ account of that very identity.
   *
   * Obligate's `linkedLocalUserId` / `remoteUserId` are only its copy of the
   * id we reported through report-provision, and anyone holding the API key
   * can rewrite them (report-provision): they are never trusted on their own.
   * Returns null when no existing local account is linked.
   */
  async getLinkedLocalUserId(obligateUserId: number): Promise<number | null> {
    if (!Number.isSafeInteger(obligateUserId) || obligateUserId <= 0) return null;

    const link = await db('sso_foreign_users as l')
      .join('users as u', 'u.id', 'l.local_user_id')
      .where({
        'l.foreign_source': 'obligate',
        'l.foreign_user_id': obligateUserId,
        'u.foreign_source': 'obligate',
        'u.foreign_id': obligateUserId,
      })
      .first('u.id') as { id: number } | undefined;
    if (link) return link.id;

    const provisioned = await db('users')
      .where({ foreign_source: 'obligate', foreign_id: obligateUserId })
      .orderBy('id', 'desc')
      .first('id') as { id: number } | undefined;
    return provisioned?.id ?? null;
  },

  /**
   * Obligate's CURRENT roster for this app (GET /api/apps/users, read with our
   * key from the configured Obligate URL): every Obligate user who may sign in
   * here right now (active, not disabled on this app, with a role), with the
   * role / teams Obligate gives them. Whoever calls our inbound routes cannot
   * forge it — the read goes out from here.
   *
   * Used to confirm what an inbound sso-user-sync push asks for: the push
   * proves nothing, since its secret may be known to others (a key earlier
   * versions sent as the client_id, until regenerated) and Obligate lists the
   * (obligateUserId, local id) pairs to any key holder.
   *
   * At most one read in flight. A caller arriving while one runs waits for the
   * NEXT read (shared by every caller arriving meanwhile): the running one may
   * have started before the change being confirmed was made in Obligate. So a
   * burst of pushes costs Obligate at most one read at a time.
   * Returns null when SSO is off, Obligate is not configured or does not
   * answer. Never rejects.
   */
  getAppRoster(): Promise<ObligateRoster | null> {
    if (!rosterInflight) return startRosterFetch();
    if (!rosterQueued) {
      // Whatever the running read's outcome (even a rejection), the queue is
      // released and the next read started: a failed read never sticks.
      const next = (): Promise<ObligateRoster | null> => {
        rosterQueued = null;
        return startRosterFetch();
      };
      rosterQueued = rosterInflight.promise.then(next, next);
    }
    return rosterQueued;
  },

  /**
   * Public origin this app is registered under in Obligate: the base URL of
   * the active connected app of type 'oblihub' (the URL Obligate and the other
   * Obli* apps send browsers to). Obligate does not tell an app which
   * registration is its own, so this is only usable when there is exactly ONE
   * such app. With several (e.g. prod + staging on one Obligate) none is
   * trusted and APP_URL must name this instance. Fallback only: never
   * consulted once APP_URL (or a non-loopback CLIENT_ORIGIN) is set.
   * Cached 5 min; `refresh` bypasses the cache unless it is under 30 s old.
   */
  _originCache: null as { origin: string | null; at: number } | null,
  async getRegisteredAppOrigin(refresh = false): Promise<string | null> {
    const now = Date.now();
    const cached = this._originCache;
    if (cached && now - cached.at < (refresh ? ORIGIN_CACHE_MIN_REFRESH_MS : ORIGIN_CACHE_TTL_MS)) {
      return cached.origin;
    }
    const apps = await this.getConnectedApps();
    // No app at all is a failed fetch (we are registered ourselves): not cached
    if (apps.length === 0) return null;
    const own = apps.filter((a) => a.appType === OWN_APP_TYPE);
    if (own.length > 1) {
      logger.error({ baseUrls: own.map((a) => a.baseUrl) },
        'Obligate SSO: several Oblihub apps are registered in Obligate, so their base URLs are not trusted — set APP_URL to this instance\'s public URL');
    }
    const origin = own.length === 1 && typeof own[0].baseUrl === 'string' ? toHttpOrigin(own[0].baseUrl) : null;
    this._originCache = { origin, at: now };
    return origin;
  },

  /**
   * Check the public origin a browser reached us through — derived from the
   * Host / X-Forwarded-* request headers, which any client can forge (nginx
   * relays X-Forwarded-Proto as received) — against the origins this app is
   * really published under:
   *   - APP_URL / CLIENT_ORIGIN when set;
   *   - its base URL in Obligate (getRegisteredAppOrigin) ONLY when the
   *     operator named no public URL (publicOriginPinned: no APP_URL, and
   *     CLIENT_ORIGIN unset or loopback). That registration may be another
   *     instance's (or a stale domain): with APP_URL set it is never trusted.
   * Matching is on host[:port], or on the hostname alone when the candidate
   * has no port (nginx's `$host`, forwarded by client/nginx.conf, drops it).
   * Only a trusted origin is ever returned — its scheme and port win over the
   * headers — so a forged Host can at most pick another of our own origins.
   * Null when the host is none of them.
   *
   * Why it matters: the OAuth redirect_uri is built from this origin, and
   * Obligate issues a code for any redirect_uri. Taken from the headers, a
   * forged Host made us exchange (with our key) a code Obligate had delivered
   * to an attacker's URL — and sign the attacker in as the victim.
   */
  async verifyPublicOrigin(candidate: string): Promise<string | null> {
    const origin = toHttpOrigin(candidate);
    if (!origin) return null;
    const { host, hostname, port } = new URL(origin);
    const match = (trusted: Array<string | null>): string | null => {
      const list = trusted.filter((o): o is string => o !== null);
      if (list.includes(origin)) return origin;
      return list.find((o) => new URL(o).host === host)
        ?? (port === '' ? list.find((o) => new URL(o).hostname === hostname) : undefined)
        ?? null;
    };
    const fromEnv = match([envOrigin('APP_URL'), envOrigin('CLIENT_ORIGIN')]);
    if (fromEnv || publicOriginPinned()) return fromEnv;
    const registered = match([await this.getRegisteredAppOrigin()])
      // The base URL may just have been changed in Obligate — retry uncached
      ?? match([await this.getRegisteredAppOrigin(true)]);
    if (registered && !registeredOriginWarned) {
      registeredOriginWarned = true;
      logger.warn({ origin: registered },
        'Obligate SSO: APP_URL is not set — the OAuth redirect_uri relies on the Oblihub base URL registered in Obligate. Set APP_URL to this instance\'s public URL');
    }
    return registered;
  },

  /**
   * Where to restart the SSO flow when the browser reached us through a host
   * this app is not published under (LAN IP, second DNS name…): APP_URL, else
   * CLIENT_ORIGIN, else — only when neither names this instance (see
   * verifyPublicOrigin) — its base URL in Obligate. Loopback origins are
   * skipped (they would point the browser at its own machine — e.g. the
   * docker-compose default CLIENT_ORIGIN=http://localhost). Null when none is
   * known.
   */
  async getCanonicalOrigin(): Promise<string | null> {
    const usable = (o: string | null): o is string => o !== null && !isLoopbackOrigin(o);
    const appUrl = envOrigin('APP_URL');
    if (usable(appUrl)) return appUrl;
    const clientOrigin = envOrigin('CLIENT_ORIGIN');
    if (usable(clientOrigin)) return clientOrigin;
    if (publicOriginPinned()) return null;
    const registered = await this.getRegisteredAppOrigin();
    return usable(registered) ? registered : null;
  },

  /**
   * Exchange an authorization code with Obligate for the user's assertion
   * (server to server, our API key as Bearer, one-time 60 s code bound to the
   * redirect_uri).
   */
  async exchangeCode(code: string, redirectUri: string): Promise<ObligateAssertion | null> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return null;
    try {
      const res = await fetch(`${raw.url}/api/oauth/token/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${raw.apiKey}` },
        body: JSON.stringify({ code, redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        logger.warn(`Obligate code exchange failed: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json() as { success: boolean; data?: ObligateAssertion };
      return data.success ? (data.data ?? null) : null;
    } catch (err) {
      logger.error(err, 'Obligate code exchange failed');
      return null;
    }
  },

  /**
   * Tell Obligate which local account an Obligate user is provisioned as
   * (it then includes it as linkedLocalUserId / remoteUserId). Overwrites a
   * missing, stale or rewritten pointer with OUR record. Fire and forget.
   */
  async reportProvision(obligateUserId: number, remoteUserId: number): Promise<void> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;
    try {
      await fetch(`${raw.url}/api/apps/report-provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${raw.apiKey}` },
        body: JSON.stringify({ obligateUserId, remoteUserId }),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to report provision to Obligate');
    }
  },

  /**
   * Active connected apps from Obligate (cross-app nav buttons, own base URL).
   * With `obligateUserId`, Obligate scopes the list to that user's
   * entitlements. Only entries with an http(s) base URL are returned (the
   * client navigates the browser to `<baseUrl>/auth/sso-redirect`).
   */
  async getConnectedApps(obligateUserId?: number | null): Promise<ObligateConnectedApp[]> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return [];
    const url = obligateUserId
      ? `${raw.url}/api/apps/connected?userId=${encodeURIComponent(obligateUserId)}`
      : `${raw.url}/api/apps/connected`;
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${raw.apiKey}` },
        // Also on the SSO redirect path (getRegisteredAppOrigin): never hang it
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const data = await res.json() as { success?: boolean; data?: unknown };
      if (!Array.isArray(data?.data)) return [];
      return (data.data as unknown[]).filter((a): a is ObligateConnectedApp => {
        const app = a as Partial<ObligateConnectedApp> | null;
        return !!app && typeof app.appType === 'string' && typeof app.baseUrl === 'string' && toHttpOrigin(app.baseUrl) !== null;
      }).map((a) => ({
        appType: a.appType,
        name: typeof a.name === 'string' ? a.name : a.appType,
        baseUrl: a.baseUrl.replace(/\/+$/, ''),
        icon: typeof a.icon === 'string' ? a.icon : null,
        color: typeof a.color === 'string' ? a.color : null,
        self: a.self === true ? true : undefined,
        thirdParty: a.thirdParty === true,
      }));
    } catch {
      return [];
    }
  },

  /**
   * Announce Oblihub's own accent color to Obligate (POST /api/apps/self-info),
   * so every app switcher of the suite shows it without anything set by hand
   * in Obligate. Best-effort: never throws, does nothing until Obligate is
   * configured. Called at startup and whenever the Obligate settings change.
   */
  async announceSelfInfo(): Promise<void> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;
    try {
      const res = await fetch(`${raw.url}/api/apps/self-info`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${raw.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ color: APP_ACCENT_COLOR }),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
      if (!res.ok) logger.warn(`Obligate self-info announce failed: HTTP ${res.status}`);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Obligate self-info announce error');
    }
  },
};
