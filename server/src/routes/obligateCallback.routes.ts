import { Router } from 'express';
import type { Request } from 'express';
import type { Knex } from 'knex';
import crypto from 'crypto';
import { db } from '../db';
import { obligateService, type ObligateAssertion, type ObligateRoster } from '../services/obligate.service';
import { appConfigService, OBLIGATE_SYNC_DISABLED_KEY_PREFIX } from '../services/appConfig.service';
// Namespace import on purpose: see endUserSockets (works with or without the
// disconnectUserSockets export of socket.ts)
import * as socketModule from '../socket';
import { logger } from '../utils/logger';

declare module 'express-session' {
  interface SessionData {
    /** redirect_uri of the pending /authorize request (built from a verified origin). */
    oauthRedirectUri: string;
  }
}

const router = Router();

// ── Live sockets ────────────────────────────────────────────────────────────

type SocketLike = { disconnect(close?: boolean): unknown; userId?: unknown; data?: { userId?: unknown } };
type IoLike = { of(namespace: string): { sockets: Map<string, SocketLike> } };

/**
 * The socket.io server as index.ts publishes it (`app.set('io', io)`),
 * captured from the first /auth or /api/auth request. Only used by
 * endUserSockets when socket.ts has no disconnectUserSockets export.
 */
let ioFallback: IoLike | null = null;
router.use((req, _res, next) => {
  if (!ioFallback) {
    const io = req.app.get('io') as Partial<IoLike> | undefined;
    if (io && typeof io.of === 'function') ioFallback = io as IoLike;
  }
  next();
});

/**
 * Disconnects the live sockets of a user (they cache userId / role from the
 * handshake). Uses socket.ts's disconnectUserSockets when it exists; the
 * committed socket.ts has none, so this then walks the socket.io server itself
 * (the handshake stores `socket.userId`). This keeps the SSO fix deployable on
 * its own, with either socket.ts.
 */
function endUserSockets(userId: number): void {
  const exported = (socketModule as unknown as Record<string, unknown>).disconnectUserSockets;
  if (typeof exported === 'function') {
    (exported as (id: number) => void)(userId);
    return;
  }
  if (!ioFallback) return;
  for (const socket of [...ioFallback.of('/').sockets.values()]) {
    const uid = socket.userId ?? socket.data?.userId;
    if (uid === userId) socket.disconnect(true);
  }
}

/**
 * Public origin used to build the OAuth redirect_uri. Host / X-Forwarded-*
 * are client-controlled (and client/nginx.conf relays X-Forwarded-Proto as
 * received), so the origin they name is only accepted when it is one this app
 * is really published under (obligateService.verifyPublicOrigin) — otherwise
 * a forged Host would make us exchange, with our own key, a code that Obligate
 * issued for an attacker's redirect_uri, and sign the attacker in as the
 * victim.
 */
async function resolvePublicOrigin(req: Request): Promise<string | null> {
  const protocol = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return null;
  const origin = await obligateService.verifyPublicOrigin(`${protocol}://${host}`);
  if (!origin) {
    logger.warn({ protocol, host },
      'Obligate SSO: request origin is not a public URL of this app (APP_URL, CLIENT_ORIGIN or its base URL in Obligate)');
  }
  return origin;
}

// ── Roles ───────────────────────────────────────────────────────────────────
// users.role holds a role name (roles table: admin / user / viewer / custom).
// Only 'admin' is special (bypasses every permission check); the others get
// what role_permissions grants them — an unknown name gets nothing.

/** A role name users.role can hold (varchar 16), or null. */
function storableRole(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^[A-Za-z0-9_-]{1,16}$/.test(s) ? s : null;
}

async function rolePermissions(role: string): Promise<Set<string>> {
  const keys = await db('roles')
    .join('role_permissions', 'role_permissions.role_id', 'roles.id')
    .where({ 'roles.name': role, 'role_permissions.granted': true })
    .pluck('role_permissions.permission_key') as string[];
  return new Set(keys);
}

/**
 * true when going from `from` to `to` grants nothing `from` did not have:
 * admin → anything else, or a role whose permissions are a subset of the
 * current one's. A move to 'admin', or to a role with any extra permission,
 * is a promotion (false).
 */
async function isRoleDowngrade(from: string, to: string): Promise<boolean> {
  if (from === to || to === 'admin') return false;
  if (from === 'admin') return true;
  const [fromPerms, toPerms] = await Promise.all([rolePermissions(from), rolePermissions(to)]);
  return [...toPerms].every((p) => fromPerms.has(p));
}

/**
 * Ends every session of a local user: the stored sessions (they cache userId
 * AND role — requireAuth / requireRole never re-read the users row) and the
 * live sockets opened with them. `quiet`: log only when a session was ended.
 */
async function destroyUserSessions(userId: number, reason: string, quiet = false): Promise<number> {
  let killed = 0;
  try {
    killed = await db('session').whereRaw(`sess->>'userId' = ?`, [String(userId)]).del();
  } catch (err) {
    // connect-pg-simple creates the table on first use: none yet = no session to end
    if ((err as { code?: string }).code !== '42P01') throw err;
  }
  try {
    endUserSockets(userId);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), userId }, 'Obligate SSO: socket disconnect failed');
  }
  if (!quiet || killed > 0) logger.info({ userId, sessions: killed, reason }, 'Obligate SSO: sessions of the user ended');
  return killed;
}

/** Adds to `q`: `updated_at` still what it was when read (compared to the millisecond, as JS reads it). */
function updatedAtIs(q: Knex.QueryBuilder, updatedAt: Date | string | null): void {
  if (updatedAt === null) q.whereNull('updated_at');
  else q.whereRaw(`date_trunc('milliseconds', updated_at) = ?`, [new Date(updatedAt)]);
}

// ── og_ accounts disabled by the Obligate sync ─────────────────────────────
// When Obligate confirms that a user may no longer sign in here, the sync
// disables their og_ account and marks it in app_config
// (`obligate_sync_disabled:<local id>` = { obligateUserId, at }, `at` being
// the updated_at the sync wrote). A later VERIFIED SSO sign-in re-enables a
// marked account — Obligate only asserts a user it allows here, as for the
// other Obli* apps — provided nothing touched the row since: an Oblihub admin
// re-enabling or disabling it (Users → toggle-active sets updated_at) voids
// the mark. An account an Oblihub admin disabled has no valid mark and stays
// disabled until an Oblihub admin re-enables it: never by a push, never by a
// sign-in.

type SsoAccount = { id: number; username: string; role: string; is_active: boolean; updated_at: Date | string | null };

const syncMarkKey = (userId: number): string => `${OBLIGATE_SYNC_DISABLED_KEY_PREFIX}${userId}`;

/** true when this DISABLED account was disabled by the sync for this identity, and untouched since. */
async function hasValidSyncMark(account: SsoAccount, obligateUserId: number): Promise<boolean> {
  if (account.is_active !== false || account.updated_at === null) return false;
  const value = await appConfigService.get(syncMarkKey(account.id));
  if (!value) return false;
  try {
    const mark = JSON.parse(value) as { obligateUserId?: unknown; at?: unknown };
    return mark.obligateUserId === obligateUserId && typeof mark.at === 'string'
      && Date.parse(mark.at) === new Date(account.updated_at).getTime();
  } catch {
    return false;
  }
}

async function clearSyncMark(userId: number): Promise<void> {
  await db('app_config').where({ key: syncMarkKey(userId) }).del();
}

/**
 * Obligate confirmed (roster read by us) that this og_ account's user may no
 * longer sign in here: an ACTIVE account is disabled with the sync mark and
 * loses an admin role; an account already disabled keeps its state (a local
 * block never gets the mark) and loses an admin role; sessions and sockets
 * end in both cases.
 * `readUpdatedAt` (the roster sweep): the row as read BEFORE the roster — if it
 * changed since (e.g. a sign-in just after the roster read), nothing is done.
 */
async function revokeSsoAccess(
  account: SsoAccount, obligateUserId: number, reason: string, readUpdatedAt?: Date | string | null,
): Promise<'disabled' | 'already_disabled' | 'changed'> {
  const guarded = readUpdatedAt !== undefined;
  if (account.is_active) {
    const at = new Date();
    const disabled = await db.transaction(async (trx) => {
      const q = trx('users').where({ id: account.id, is_active: true });
      if (guarded) updatedAtIs(q, readUpdatedAt);
      const n = await q.update({
        is_active: false,
        role: trx.raw(`CASE WHEN role = 'admin' THEN 'user' ELSE role END`),
        updated_at: at,
      });
      if (!n) return false;
      await trx('app_config')
        .insert({ key: syncMarkKey(account.id), value: JSON.stringify({ obligateUserId, at: at.toISOString() }) })
        .onConflict('key').merge(['value']);
      return true;
    });
    if (disabled) {
      await destroyUserSessions(account.id, reason);
      logger.info({ obligateUserId, localUserId: account.id, reason, roleBefore: account.role },
        'Obligate SSO: og_ account disabled (Obligate no longer lets this user sign in here)');
      return 'disabled';
    }
    // Changed meanwhile: the sweep leaves it to the next run; a push still ends the sessions
    if (guarded) return 'changed';
  } else if (guarded) {
    // Sweep: still the disabled row read before the roster (not re-enabled by a sign-in since)?
    const still = db('users').where({ id: account.id, is_active: false });
    updatedAtIs(still, readUpdatedAt);
    if (!(await still.first('id'))) return 'changed';
  }
  // Already disabled (or disabled meanwhile): no mark, no updated_at change
  await db('users').where({ id: account.id, role: 'admin', is_active: false }).update({ role: 'user' });
  await destroyUserSessions(account.id, reason, true);
  return 'already_disabled';
}

/** New session id for a sign-in (session fixation). */
function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

class SsoSignInError extends Error {
  constructor(message: string, readonly loginError: 'sso_failed' | 'account_disabled' = 'sso_failed') {
    super(message);
  }
}

/**
 * Provision or update the local og_ account of a VERIFIED assertion (our code
 * exchange with Obligate) and open a new session on it. Returns the local id.
 */
async function provisionObligateUser(assertion: ObligateAssertion, req: Request): Promise<number> {
  const obligateUserId = assertion.obligateUserId;
  if (!Number.isSafeInteger(obligateUserId) || obligateUserId <= 0
    || typeof assertion.username !== 'string' || assertion.username.length === 0
    // users.username is varchar(64), with the 'og_' prefix
    || assertion.username.length > 61 || /[\u0000-\u001f\u007f]/.test(assertion.username)) {
    throw new SsoSignInError('SSO sign-in refused: malformed assertion (obligateUserId / username)');
  }
  // Obligate owns the role of an SSO account (admin / user / viewer / custom):
  // the verified assertion sets it at every sign-in. No role = 'user' (as before).
  const assertedRole: unknown = assertion.role;
  const role = assertedRole === undefined || assertedRole === null || assertedRole === ''
    ? 'user' : storableRole(assertedRole);
  if (!role) throw new SsoSignInError('SSO sign-in refused: malformed role in the assertion');
  const email = typeof assertion.email === 'string' ? assertion.email : null;
  const displayName = typeof assertion.displayName === 'string' ? assertion.displayName : null;

  // Which local account? From OUR records only (see getLinkedLocalUserId).
  // assertion.linkedLocalUserId is Obligate's copy of the id we reported, and
  // anyone holding the API key can rewrite it (report-provision): compared,
  // never trusted — it can never open a session on another account (e.g. a
  // local admin).
  let localUserId = await obligateService.getLinkedLocalUserId(obligateUserId);
  const claimed = typeof assertion.linkedLocalUserId === 'number' ? assertion.linkedLocalUserId : null;
  if (claimed !== null && claimed !== localUserId) {
    logger.warn({ obligateUserId, claimedLocalUserId: claimed, linkedLocalUserId: localUserId },
      'Obligate SSO: linkedLocalUserId does not match our link records — ignored');
  }

  let roleChanged = false;
  if (localUserId !== null) {
    const existing = await db('users').where({ id: localUserId })
      .first('id', 'username', 'is_active', 'role', 'updated_at') as SsoAccount | undefined;
    if (!existing) throw new SsoSignInError(`SSO sign-in refused: local account #${localUserId} vanished`);
    // A disabled account stays locked out, like password login — unless the
    // Obligate sync disabled it (valid sync mark, see hasValidSyncMark): this
    // verified assertion is Obligate saying the user may sign in here again.
    // One an Oblihub admin disabled (Users) is only re-enabled by an Oblihub
    // admin — never by a sign-in, never by a push.
    const reenable = !existing.is_active && await hasValidSyncMark(existing, obligateUserId);
    if (!existing.is_active && !reenable) {
      throw new SsoSignInError(`SSO sign-in refused: local account #${localUserId} is disabled`, 'account_disabled');
    }
    roleChanged = existing.role !== role;
    const q = db('users').where({ id: localUserId });
    // Re-enable only the row the mark was checked on (not touched meanwhile)
    if (reenable) { q.where({ is_active: false }); updatedAtIs(q, existing.updated_at); }
    const updated = await q.update({
      role,
      email,
      display_name: displayName,
      updated_at: new Date(),
      ...(reenable ? { is_active: true } : {}),
    });
    if (!updated) {
      throw new SsoSignInError(`SSO sign-in refused: local account #${localUserId} changed during the sign-in`,
        reenable ? 'account_disabled' : 'sso_failed');
    }
    if (reenable) {
      logger.info({ obligateUserId, localUserId },
        'Obligate SSO: og_ account re-enabled by a verified sign-in (it had been disabled by the Obligate sync)');
    }
    // The mark only means something on a disabled account: gone once active
    await clearSyncMark(localUserId);
    // Make sure the link row exists and points to this account (idempotent;
    // repairs accounts that were resolved through users.foreign_id)
    await db('sso_foreign_users')
      .insert({ foreign_source: 'obligate', foreign_user_id: obligateUserId, local_user_id: localUserId })
      .onConflict(['foreign_source', 'foreign_user_id'])
      .merge({ local_user_id: localUserId });
  } else {
    // User + link row in one transaction, so a failure can't leave an
    // unlinked og_ account behind that would block every later login
    localUserId = await db.transaction(async (trx) => {
      const [newUser] = await trx('users').insert({
        username: `og_${assertion.username}`,
        display_name: displayName || assertion.username,
        email,
        role,
        is_active: true,
        foreign_source: 'obligate',
        foreign_id: obligateUserId,
      }).returning('id') as Array<{ id: number }>;
      // A leftover link row for this identity can only point to an account
      // that was not provisioned for it — repoint it to the new account
      await trx('sso_foreign_users')
        .insert({ foreign_source: 'obligate', foreign_user_id: obligateUserId, local_user_id: newUser.id })
        .onConflict(['foreign_source', 'foreign_user_id'])
        .merge({ local_user_id: newUser.id });
      return newUser.id;
    });
    logger.info({ obligateUserId, localUserId }, 'Obligate SSO: og_ account provisioned');
  }
  // Tell Obligate which local id is this user's (missing, stale or rewritten
  // pointer). Obligate needs it to push sso-user-sync changes here.
  if (claimed !== localUserId) obligateService.reportProvision(obligateUserId, localUserId).catch(() => {});

  // Sync avatar (profile photo) and theme preference from Obligate assertion
  if (assertion.preferences) {
    const prefs = assertion.preferences as { profilePhotoUrl?: string | null; preferredTheme?: string };
    const colUpdate: Record<string, unknown> = {};
    if (prefs.profilePhotoUrl !== undefined) colUpdate.avatar = prefs.profilePhotoUrl;
    if (prefs.preferredTheme && ['obli-operator', 'obli-daylight', 'obli-dim', 'modern', 'neon'].includes(prefs.preferredTheme)) {
      const existing = await db('users').where({ id: localUserId }).select('preferences').first() as { preferences: unknown } | undefined;
      const existingPrefs = (typeof existing?.preferences === 'string' ? JSON.parse(existing.preferences) : existing?.preferences) ?? {};
      colUpdate.preferences = JSON.stringify({ ...existingPrefs, preferredTheme: prefs.preferredTheme });
    }
    if (Object.keys(colUpdate).length > 0) {
      await db('users').where({ id: localUserId }).update(colUpdate);
    }
  }

  // Sync team memberships from Obligate assertion
  if (Array.isArray(assertion.teams) && assertion.teams.length > 0) {
    const { teamService } = await import('../services/team.service');
    const allTeams = await teamService.getAll();
    // Remove from teams not in assertion
    for (const team of allTeams) {
      const isMember = team.members.some(m => m.userId === localUserId);
      const shouldBeMember = assertion.teams.includes(team.name);
      if (isMember && !shouldBeMember) await teamService.removeMember(team.id, localUserId);
      if (!isMember && shouldBeMember) await teamService.addMember(team.id, localUserId);
    }
  }

  // Sessions cache the role: a role changed by this assertion ends the user's
  // other sessions (this sign-in gets a new one below).
  if (roleChanged) await destroyUserSessions(localUserId, 'role_changed_at_sign_in');

  // New session id (session fixation), then the identity. The role comes
  // straight from the verified assertion (written above), not re-read: a
  // concurrent sso-user-sync call cannot slip another role into this session.
  const user = await db('users').where({ id: localUserId }).first('username') as { username: string } | undefined;
  await regenerateSession(req);
  req.session.userId = localUserId;
  req.session.username = user?.username ?? `og_${assertion.username}`;
  req.session.role = role;
  return localUserId;
}

/**
 * GET /auth/callback?code=xxx&state=xxx
 * Called (through the browser) by Obligate after a successful sign-in.
 * Exchanges the code for the user's assertion, provisions, opens a session.
 */
router.get('/callback', async (req, res) => {
  try {
    // "Enable SSO" off (Settings): no SSO sign-in at all
    if (!(await appConfigService.getObligateRaw()).enabled) {
      logger.warn('Obligate callback: SSO is disabled in Settings — sign-in refused');
      res.redirect('/login?error=sso_failed');
      return;
    }
    const { code, state } = req.query as { code?: unknown; state?: unknown };
    if (typeof code !== 'string' || !code) { res.status(400).json({ success: false, error: 'Missing code' }); return; }

    // OAuth state: Login CSRF protection (RFC 6749 §10.12), single use
    const expectedState = req.session?.oauthState;
    if (!expectedState || typeof state !== 'string' || state !== expectedState) {
      logger.warn({ hasExpectedState: !!expectedState }, 'Obligate callback: state mismatch');
      res.redirect('/login?error=sso_failed');
      return;
    }
    delete req.session.oauthState;

    // The redirect_uri of the authorize request: the one /sso-redirect stored
    // with the state (built from a verified origin), else rebuilt from a
    // VERIFIED public origin — never from the raw Host / X-Forwarded-* headers
    // (see resolvePublicOrigin).
    const storedRedirectUri = req.session.oauthRedirectUri;
    delete req.session.oauthRedirectUri;
    let redirectUri: string;
    if (typeof storedRedirectUri === 'string' && storedRedirectUri) {
      redirectUri = storedRedirectUri;
    } else {
      const origin = await resolvePublicOrigin(req);
      if (!origin) { res.redirect('/login?error=sso_failed'); return; }
      redirectUri = `${origin}/auth/callback`;
    }

    const assertion = await obligateService.exchangeCode(code, redirectUri);
    if (!assertion) {
      logger.warn('Obligate callback: code exchange failed (invalid / expired code or redirect_uri mismatch)');
      res.redirect('/login?error=sso_failed');
      return;
    }

    const localUserId = await provisionObligateUser(assertion, req);
    logger.info({ obligateUserId: assertion.obligateUserId, localUserId }, 'Obligate SSO: signed in');

    req.session.save((err) => {
      if (err) { logger.error(err, 'Obligate callback: session save failed'); res.redirect('/login?error=sso_failed'); return; }
      res.setHeader('Content-Type', 'text/html');
      res.end('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/"></head><body>Signing in...</body></html>');
    });
  } catch (err) {
    if (err instanceof SsoSignInError) {
      logger.warn({ reason: err.message }, 'Obligate callback: sign-in refused');
      res.redirect(`/login?error=${err.loginError}`);
      return;
    }
    logger.error(err, 'Obligate callback error');
    res.redirect('/login?error=sso_failed');
  }
});

/**
 * GET /auth/sso-redirect
 * Public, unauthenticated entry point of the SSO flow: sends the browser to
 * Obligate's /authorize.
 *
 * WARNING — the client_id of this public route IS visible to anyone (Location
 * header, browser history, Referer, access logs): it is always the public id
 * sha256(API key) (obligateService.authorizeClientId) — Obligate refuses the
 * raw API key there. Earlier versions sent the key itself, so a key configured
 * back then must be treated as known to others until it is regenerated in
 * Obligate: every Bearer-authenticated route below grants a key holder nothing
 * beyond what Obligate itself confirms (see /sso-user-sync).
 */
router.get('/sso-redirect', async (req, res) => {
  try {
    const raw = await appConfigService.getObligateRaw();
    const clientId = obligateService.authorizeClientId(raw);
    // "Enable SSO" off (Settings), or not configured: no SSO
    if (!raw.enabled || !raw.url || !clientId) { res.redirect('/login'); return; }

    const selfUrl = await resolvePublicOrigin(req);
    if (!selfUrl) {
      // Reached through a host this app is not published under (LAN IP,
      // second DNS name…) or a forged one: restart the flow on the canonical
      // public origin, where the session, the state and a trusted redirect_uri
      // all live. Only once (`canon=1`): if even that request is not
      // recognised, the proxy hides the public host — give up.
      const retried = req.query.canon === '1';
      const canonical = retried ? null : await obligateService.getCanonicalOrigin();
      if (canonical) {
        const target = new URL('/auth/sso-redirect', canonical);
        target.searchParams.set('canon', '1');
        logger.info({ canonical }, 'sso-redirect: untrusted host — restarting SSO on the canonical origin');
        res.redirect(target.toString());
        return;
      }
      if (retried) {
        logger.error('sso-redirect: canonical origin not recognised either — make the reverse proxy forward the public host (X-Forwarded-Host) or set APP_URL');
      }
      res.redirect('/login?error=sso_failed');
      return;
    }
    // Safety: never redirect to ourselves (obligate_url pointing to this app)
    if (raw.url === selfUrl) {
      logger.error({ obligateUrl: raw.url, selfUrl }, 'sso-redirect: obligate_url points to this app — aborting to prevent a loop');
      res.redirect('/login?error=sso_failed');
      return;
    }
    const redirectUri = `${selfUrl}/auth/callback`;

    // State (CSRF), stored with the exact redirect_uri /auth/callback must present
    const oauthState = crypto.randomBytes(32).toString('hex');
    req.session.oauthState = oauthState;
    req.session.oauthRedirectUri = redirectUri;
    const obligateUrl = `${raw.url}/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(oauthState)}`;
    req.session.save((err) => {
      if (err) { logger.error(err, 'sso-redirect: session save failed'); res.redirect('/login?error=sso_failed'); return; }
      res.redirect(obligateUrl);
    });
  } catch (err) {
    logger.error(err, 'sso-redirect error');
    res.redirect('/login');
  }
});

// GET /api/auth/sso-config — public: is SSO on and Obligate reachable (LoginPage)
router.get('/sso-config', async (_req, res) => {
  try {
    const config = await obligateService.getSsoConfig();
    res.json({ success: true, data: config });
  } catch { res.json({ success: true, data: { obligateUrl: null, obligateReachable: false, obligateEnabled: false } }); }
});

/**
 * GET /api/auth/app-info
 * Called by Obligate (Bearer auth) for its permission-group mapping UI.
 * Returns only what that UI uses: role names, team names, the tenant. No
 * internal ids, no permission matrix — the Bearer secret may be the (public)
 * API key.
 */
router.get('/app-info', async (req, res) => {
  try {
    if (!(await obligateService.verifyInboundBearer(req.headers.authorization))) {
      logger.warn('app-info: invalid Bearer token');
      res.status(401).json({ success: false, error: 'Invalid API key' });
      return;
    }
    const roles = await db('roles').orderBy('is_system', 'desc').orderBy('name').pluck('name') as string[];
    const teams = await db('teams').orderBy('name').pluck('name') as string[];
    res.json({
      success: true,
      data: {
        roles,
        teams: teams.map((name) => ({ name, tenantSlug: 'default', tenantName: 'Default' })),
        tenants: [{ slug: 'default', name: 'Default' }],
      },
    });
  } catch (err) {
    logger.error(err, 'app-info error');
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

/**
 * GET /api/auth/dashboard-stats
 * Called by Obligate (Bearer auth) for the Oblihub card of its dashboard:
 * four fleet-wide counters, nothing else (the Bearer secret may be public).
 */
router.get('/dashboard-stats', async (req, res) => {
  try {
    if (!(await obligateService.verifyInboundBearer(req.headers.authorization))) { res.status(401).json({ success: false }); return; }

    const { stackService } = await import('../services/stack.service');
    const stacks = await stackService.getAll();

    const totalStacks = stacks.length;
    let upToDate = 0;
    let updateAvailable = 0;
    let totalContainers = 0;

    for (const s of stacks) {
      totalContainers += s.containers.length;
      const hasUpdate = s.containers.some(c => c.status === 'update_available');
      const hasError = s.containers.some(c => c.status === 'error');
      if (hasUpdate || hasError) updateAvailable++;
      else upToDate++;
    }

    res.json({ success: true, data: { stats: [
      { label: 'Stacks', value: totalStacks, color: '#58a6ff' },
      { label: 'Up to Date', value: upToDate, color: '#2ea043' },
      { label: 'Updates Available', value: updateAvailable, color: '#d29922' },
      { label: 'Containers', value: totalContainers, color: '#8b949e' },
    ] } });
  } catch { res.json({ success: true, data: null }); }
});

/**
 * GET /api/auth/sso-logout-url
 * Obligate's logout URL, back to our /login on a verified public origin.
 */
router.get('/sso-logout-url', async (req, res) => {
  try {
    const cfg = await appConfigService.getObligateRaw();
    if (!cfg.url) { res.json({ success: true, data: null }); return; }
    const origin = (await resolvePublicOrigin(req)) ?? (await obligateService.getCanonicalOrigin());
    const logoutUrl = origin
      ? `${cfg.url}/logout?redirect_uri=${encodeURIComponent(`${origin}/login`)}`
      : `${cfg.url}/logout`;
    res.json({ success: true, data: logoutUrl });
  } catch { res.json({ success: true, data: null }); }
});

/**
 * GET /api/auth/connected-apps
 * Connected apps from Obligate, for the cross-app nav buttons (signed-in users).
 */
router.get('/connected-apps', async (req, res) => {
  try {
    if (!req.session?.userId) { res.status(401).json({ success: false }); return; }
    // Scope the app switcher to the caller's Obligate entitlements. Without
    // the userId, Obligate returns EVERY connected app, so the header would
    // show apps the user has no access to. Local (non-SSO) users have no
    // Obligate id → unfiltered fallback.
    const row = await db('users')
      .where({ id: req.session.userId })
      .select('foreign_source', 'foreign_id')
      .first() as { foreign_source: string | null; foreign_id: number | null } | undefined;
    const obligateUserId = row?.foreign_source === 'obligate' && row.foreign_id ? row.foreign_id : null;
    const apps = await obligateService.getConnectedApps(obligateUserId);
    res.json({ success: true, data: apps });
  } catch { res.json({ success: true, data: [] }); }
});

// ── sso-user-sync ───────────────────────────────────────────────────────────

/** A positive safe integer from a JSON body field (number or digit string), else null. */
function positiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const SYNC_ACTIONS = ['deactivate', 'reactivate', 'delete', 'update-role'] as const;
type SyncAction = typeof SYNC_ACTIONS[number];

/**
 * The og_ account OUR records link to this Obligate identity
 * (getLinkedLocalUserId: users.foreign_source = 'obligate', foreign_id =
 * obligateId), or null — never a local account, never another SSO user's.
 */
async function linkedSsoAccount(obligateId: number): Promise<SsoAccount | null> {
  const linkedId = await obligateService.getLinkedLocalUserId(obligateId);
  if (!linkedId) return null;
  const row = await db('users').where({ id: linkedId })
    .first('id', 'username', 'role', 'is_active', 'updated_at', 'foreign_source', 'foreign_id') as
    (SsoAccount & { foreign_source: string | null; foreign_id: number | null }) | undefined;
  if (!row || row.foreign_source !== 'obligate' || Number(row.foreign_id) !== obligateId) return null;
  return row;
}

/**
 * Lower an og_ account's role to the roster's when that grants nothing more
 * (isRoleDowngrade), and end its sessions. updated_at is left alone (a sync
 * mark stays valid). `readUpdatedAt`: see revokeSsoAccess. true when applied.
 */
async function demoteSsoAccount(
  account: SsoAccount, target: string, reason: string, readUpdatedAt?: Date | string | null,
): Promise<boolean> {
  if (target === account.role || !(await isRoleDowngrade(account.role, target))) return false;
  const q = db('users').where({ id: account.id, role: account.role });
  if (readUpdatedAt !== undefined) updatedAtIs(q, readUpdatedAt);
  if (!(await q.update({ role: target }))) return false;
  await destroyUserSessions(account.id, reason);
  logger.info({ localUserId: account.id, before: account.role, after: target, reason }, 'Obligate SSO: role lowered (per the Obligate roster)');
  return true;
}

/**
 * Apply a sync action to the og_ account linked to `obligateId`, ONLY as far
 * as Obligate's roster (read by us, from the configured Obligate, see
 * getAppRoster) confirms it:
 *   - deactivate: only when the user is no longer on the roster (may no longer
 *     sign in here) — access revoked (revokeSsoAccess: account disabled with
 *     the sync mark, admin role dropped, sessions + sockets ended);
 *   - delete: likewise, then the account is deleted — except an account an
 *     Oblihub admin disabled, which is kept disabled (deleting it would let a
 *     later sign-in of this identity provision a fresh, active account).
 *     Obligate pushes 'delete' BEFORE removing the user on its side → 'retry'
 *     while listed;
 *   - reactivate: NEVER applied. The next verified SSO sign-in re-enables an
 *     account the sync disabled; one an Oblihub admin disabled is re-enabled
 *     in Users only;
 *   - update-role: the role is the roster's, never the body's. A demotion
 *     (admin → anything else, or a role granting nothing more) is applied at
 *     once, sessions ended; a PROMOTION never is — the verified assertion of
 *     the next SSO sign-in carries the role. Off the roster: access revoked.
 * A pushed body alone thus changes nothing Obligate itself does not say, even
 * from someone holding the API key (possibly leaked by earlier versions, which
 * sent it as the client_id — see /sso-redirect — and Obligate lists the
 * (obligateUserId, local id) pairs to any key holder).
 * Returns 'retry' when the change may still be confirmed later.
 */
async function applyConfirmedSync(obligateId: number, action: SyncAction, roster: ObligateRoster): Promise<'done' | 'retry'> {
  const user = await linkedSsoAccount(obligateId);
  if (!user) return 'done'; // gone (or re-linked) meanwhile
  const current = roster.get(obligateId);
  const ctx = { obligateUserId: obligateId, localUserId: user.id, action };

  switch (action) {
    case 'deactivate': {
      if (current) { logger.warn(ctx, 'SSO sync: deactivation not confirmed (user still on the Obligate roster) — ignored'); return 'done'; }
      if (await revokeSsoAccess(user, obligateId, 'sso_deactivated') === 'already_disabled') {
        logger.info(ctx, 'SSO sync: deactivation confirmed — account already disabled, sessions ended');
      }
      return 'done';
    }
    case 'reactivate': {
      if (!user.is_active) {
        logger.warn({ ...ctx, onRoster: !!current },
          'SSO sync: reactivation is never applied from a push — the next SSO sign-in re-enables an account the sync disabled; one an Oblihub admin disabled is re-enabled in Users');
      }
      return 'done';
    }
    case 'delete': {
      if (current) return 'retry';
      if (!user.is_active && !(await hasValidSyncMark(user, obligateId))) {
        await revokeSsoAccess(user, obligateId, 'sso_deleted');
        logger.info(ctx, 'SSO sync: account kept (disabled by an Oblihub admin) — not deleted');
        return 'done';
      }
      await db.transaction(async (trx) => {
        await trx('sso_foreign_users').where({ local_user_id: user.id }).del();
        await trx('users').where({ id: user.id }).del();
        await trx('app_config').where({ key: syncMarkKey(user.id) }).del();
      });
      await destroyUserSessions(user.id, 'sso_deleted');
      logger.info(ctx, 'SSO sync: account deleted (not on the Obligate roster)');
      return 'done';
    }
    case 'update-role': {
      if (!current) {
        await revokeSsoAccess(user, obligateId, 'sso_access_removed');
        return 'done';
      }
      const target = storableRole(current.role);
      if (!target) {
        logger.warn({ ...ctx, rosterRole: current.role.slice(0, 64) }, 'SSO sync: roster role cannot be stored — ignored');
        return 'done';
      }
      if (target === user.role) return 'done';
      if (!(await demoteSsoAccount(user, target, 'sso_role_demoted'))) {
        logger.warn({ ...ctx, current: user.role, rosterRole: target },
          'SSO sync: promotion not applied — the role comes from the next SSO sign-in');
      }
      return 'done';
    }
  }
  return 'done';
}

/**
 * Obligate's pointer to our account (roster `linkedLocalUserId`) missing or
 * different from our link: report ours again (report-provision), or Obligate
 * pushes nothing — or pushes another id. Only for users on the roster
 * (Obligate refuses the report for anyone else).
 */
function repairObligatePointer(obligateId: number, localId: number, roster: ObligateRoster): boolean {
  const entry = roster.get(obligateId);
  if (!entry || entry.linkedLocalUserId === localId) return false;
  logger.warn({ obligateUserId: obligateId, obligatePointer: entry.linkedLocalUserId, linkedLocalUserId: localId },
    'Obligate SSO: Obligate\'s pointer to our account is missing or rewritten — reporting ours again');
  obligateService.reportProvision(obligateId, localId).catch(() => {});
  return true;
}

/**
 * Re-check delays (ms) of a sync change the roster does not confirm yet
 * (delete pushed before Obligate removes the user) or could not be read.
 * Exported for the verification harness only.
 */
export const SYNC_RECHECK_DELAYS_MS: number[] = [15_000, 60_000, 180_000];
const pendingSyncRechecks = new Set<string>();

function scheduleSyncRecheck(obligateId: number, action: SyncAction): void {
  const key = `${obligateId}:${action}`;
  if (pendingSyncRechecks.has(key)) return;
  pendingSyncRechecks.add(key);
  const attempt = (i: number): void => {
    if (i >= SYNC_RECHECK_DELAYS_MS.length) {
      pendingSyncRechecks.delete(key);
      logger.warn({ obligateUserId: obligateId, action },
        'SSO sync: change not confirmed by the Obligate roster in time — not applied');
      return;
    }
    setTimeout(async () => {
      let outcome: 'done' | 'retry' = 'retry';
      try {
        const roster = await obligateService.getAppRoster();
        if (roster) outcome = await applyConfirmedSync(obligateId, action, roster);
      } catch (err) {
        logger.error(err, 'SSO sync: re-check failed');
      }
      if (outcome === 'done') pendingSyncRechecks.delete(key);
      else attempt(i + 1);
    }, SYNC_RECHECK_DELAYS_MS[i]).unref();
  };
  attempt(0);
}

// Bursts of sync pushes are unusual for a real Obligate (an admin changes one
// user at a time): above this many in a minute, log once per minute.
const SYNC_BURST_WINDOW_MS = 60_000;
const SYNC_BURST_THRESHOLD = 30;
let syncWindow = { start: 0, count: 0, reported: false };
function noteSyncCall(ip: string | undefined): void {
  const now = Date.now();
  if (now - syncWindow.start > SYNC_BURST_WINDOW_MS) syncWindow = { start: now, count: 0, reported: false };
  syncWindow.count++;
  if (syncWindow.count > SYNC_BURST_THRESHOLD && !syncWindow.reported) {
    syncWindow.reported = true;
    logger.warn({ count: syncWindow.count, ip }, 'SSO sync: burst of sso-user-sync calls — check who holds the Obligate API key');
  }
}

/**
 * POST /api/auth/sso-user-sync
 * Called by Obligate (Bearer auth) when an SSO user is deactivated,
 * reactivated, deleted, or role-changed.
 * Body: { obligateUserId, obligateUsername, remoteUserId, action, role? }
 *
 * The Bearer secret may be public (see /sso-redirect), so:
 *   - it only ever acts on the og_ account OUR records link to
 *     `obligateUserId` (getLinkedLocalUserId) — never on a local account,
 *     never on another SSO user's account. `remoteUserId` (Obligate's copy of
 *     our id, rewritable by any key holder) never picks the account, and a
 *     different one never stops the push either: the roster decides. No
 *     linked og_ account → nothing done, answered success (Obligate stops
 *     retrying);
 *   - and only as far as Obligate's roster, read by us, confirms the change
 *     (applyConfirmedSync). Roster unreadable (or an error) → re-checked later.
 * The roster sweep (reconcileWithRoster) catches what no push reports.
 */
router.post('/sso-user-sync', async (req, res) => {
  let obligateId: number | null = null;
  let action: SyncAction | undefined;
  try {
    if (!(await obligateService.verifyInboundBearer(req.headers.authorization))) { res.status(401).json({ success: false }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    obligateId = positiveInt(body.obligateUserId);
    action = SYNC_ACTIONS.find((a) => a === body.action);
    // Obligate always sends remoteUserId; a malformed one is refused, but
    // its value is only logged (see above)
    const remoteGiven = body.remoteUserId !== undefined && body.remoteUserId !== null;
    const remoteId = remoteGiven ? positiveInt(body.remoteUserId) : null;
    if (!obligateId || !action || (remoteGiven && !remoteId)) {
      obligateId = null;
      res.status(400).json({ success: false, error: 'Missing fields' });
      return;
    }
    noteSyncCall(req.ip);

    const user = await linkedSsoAccount(obligateId);
    if (!user) {
      logger.warn({ obligateUserId: obligateId, remoteUserId: remoteId, action },
        'SSO sync: no og_ account linked to this Obligate user — ignored');
      obligateId = null;
      res.json({ success: true });
      return;
    }
    if (remoteId !== null && remoteId !== user.id) {
      logger.warn({ obligateUserId: obligateId, remoteUserId: remoteId, linkedLocalUserId: user.id, action },
        'SSO sync: remoteUserId is not our link for this Obligate user — acting on our link, as far as the roster confirms');
    }

    // The push itself proves nothing: confirm it with Obligate's roster.
    const roster = await obligateService.getAppRoster();
    if (!roster) {
      scheduleSyncRecheck(obligateId, action);
      logger.warn({ obligateUserId: obligateId, localUserId: user.id, action },
        'SSO sync: Obligate roster unreadable — change re-checked later');
      res.json({ success: true });
      return;
    }
    if (await applyConfirmedSync(obligateId, action, roster) === 'retry') {
      scheduleSyncRecheck(obligateId, action);
    }
    repairObligatePointer(obligateId, user.id, roster);
    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'sso-user-sync error');
    // A change Obligate may have made must not be lost to a transient error
    if (obligateId && action) scheduleSyncRecheck(obligateId, action);
    res.status(500).json({ success: false, error: 'Sync failed' });
  }
});

// ── Roster sweep ────────────────────────────────────────────────────────────

/**
 * Pushes alone cannot revoke access: Obligate pushes only for users it holds
 * our local id for (none for og_ accounts provisioned before this server
 * reported its ids), and anyone holding the API key can clear or rewrite that
 * pointer (report-provision) so that no push comes. So the og_ accounts are
 * reconciled with Obligate's roster, read by us, `firstDelayMs` after start
 * then every `intervalMs`:
 *   - off the roster (Obligate no longer lets the user sign in here): access
 *     revoked (revokeSsoAccess: account disabled with the sync mark, admin
 *     role dropped, sessions + sockets ended);
 *   - on it with a lower role: demotion applied, sessions ended (a promotion
 *     never — the next sign-in carries it);
 *   - Obligate's pointer to our account missing or different: ours reported.
 * Restrictive only: never re-enables, never promotes. Skipped while SSO is off
 * or the roster cannot be read — or is empty: Obligate always lists its
 * active platform admins, so an empty roster is a broken answer, not an order
 * to lock everyone out.
 * Exported (with runRosterSweep / stopRosterSweep) for the verification
 * harness.
 */
export const ROSTER_SWEEP = { firstDelayMs: 2 * 60_000, intervalMs: 5 * 60_000 };

export interface RosterSweepResult { accounts: number; revoked: number; demoted: number; pointersReported: number }

let sweepRunning = false;

export async function runRosterSweep(): Promise<RosterSweepResult | null> {
  if (sweepRunning) return null;
  sweepRunning = true;
  try {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.enabled || !raw.url || !raw.apiKey) return null;
    // Read BEFORE the roster: a row changed after this read (a sign-in right
    // after the roster read…) is left to the next run
    const accounts = await db('users')
      .where({ foreign_source: 'obligate' }).whereNotNull('foreign_id')
      .select('id', 'username', 'role', 'is_active', 'updated_at', 'foreign_id') as Array<SsoAccount & { foreign_id: number }>;
    const result: RosterSweepResult = { accounts: accounts.length, revoked: 0, demoted: 0, pointersReported: 0 };
    if (accounts.length === 0) return result;
    const roster = await obligateService.getAppRoster();
    if (!roster) {
      logger.warn('Obligate SSO: roster sweep skipped — Obligate roster unreadable');
      return null;
    }
    if (roster.size === 0) {
      logger.error('Obligate SSO: roster sweep skipped — Obligate returned an empty roster (it always lists its platform admins)');
      return null;
    }
    const linkedIds = new Map<number, number | null>();
    for (const account of accounts) {
      const obligateId = Number(account.foreign_id);
      const entry = roster.get(obligateId);
      if (!entry) {
        if (await revokeSsoAccess(account, obligateId, 'sso_sweep_off_roster', account.updated_at) === 'disabled') result.revoked++;
        continue;
      }
      const target = storableRole(entry.role);
      if (target && await demoteSsoAccount(account, target, 'sso_sweep_role_lowered', account.updated_at)) result.demoted++;
      if (entry.linkedLocalUserId !== account.id) {
        if (!linkedIds.has(obligateId)) linkedIds.set(obligateId, await obligateService.getLinkedLocalUserId(obligateId));
        if (linkedIds.get(obligateId) === account.id && repairObligatePointer(obligateId, account.id, roster)) result.pointersReported++;
      }
    }
    // Sync marks of accounts gone or active again (re-enabled in Users): read
    // now, after this run's own revocations
    const marks = await db('app_config').where('key', 'like', `${OBLIGATE_SYNC_DISABLED_KEY_PREFIX}%`).pluck('key') as string[];
    if (marks.length > 0) {
      const markedIds = marks.map((k) => Number(k.slice(OBLIGATE_SYNC_DISABLED_KEY_PREFIX.length))).filter((n) => Number.isSafeInteger(n));
      const disabled = new Set(await db('users').whereIn('id', markedIds).where({ is_active: false }).pluck('id') as number[]);
      const stale = marks.filter((k) => !disabled.has(Number(k.slice(OBLIGATE_SYNC_DISABLED_KEY_PREFIX.length))));
      if (stale.length > 0) await db('app_config').whereIn('key', stale).del();
    }

    if (result.revoked || result.demoted || result.pointersReported) {
      logger.info(result, 'Obligate SSO: roster sweep applied changes');
    }
    return result;
  } catch (err) {
    logger.error(err, 'Obligate SSO: roster sweep failed');
    return null;
  } finally {
    sweepRunning = false;
  }
}

let sweepTimers: NodeJS.Timeout[] = [];

/** Stops the periodic sweep (verification harness). */
export function stopRosterSweep(): void {
  for (const t of sweepTimers) clearTimeout(t);
  sweepTimers = [];
}

function startRosterSweep(): void {
  const first = setTimeout(() => {
    void runRosterSweep();
    const every = setInterval(() => { void runRosterSweep(); }, ROSTER_SWEEP.intervalMs);
    every.unref();
    sweepTimers.push(every);
  }, ROSTER_SWEEP.firstDelayMs);
  first.unref();
  sweepTimers.push(first);
}
startRosterSweep();

export default router;
