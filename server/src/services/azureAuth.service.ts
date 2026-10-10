import * as crypto from 'crypto';
import { db } from '../db';
import { encryptSecret, decryptSecret } from '../utils/crypto';
import { dockerService } from './docker.service';
import { logger } from '../utils/logger';
import type { AzureAuthProvider } from '@oblihub/shared';

/**
 * One AzureAuthProvider row = one Azure app registration + one dedicated `oauth2-proxy`
 * sidecar container. The sidecar answers Nginx's `auth_request` for every proxy_host that
 * references this provider (2xx = session valid, 401 = redirect to Azure sign-in).
 *
 * Sidecar naming: `oblihub-azauth-<providerId>`. Kept on the shared `proxy` network so nginx
 * can reach it via docker DNS.
 *
 * Callback URL model: oauth2-proxy runs with `--reverse-proxy=true` and derives its redirect
 * dynamically from the incoming `X-Forwarded-Host` header. That way ONE Azure app registration
 * (this row) can serve any number of proxy_hosts — each with its own domain — as long as the
 * operator adds every domain's `/oauth2/callback` URL to the Azure app's Redirect URIs list.
 * The UI surfaces the list of callback URLs to add so the operator can copy them into Azure.
 */

const OAUTH2_PROXY_IMAGE = 'quay.io/oauth2-proxy/oauth2-proxy:latest';
// Shared Redis backend used by every oauth2-proxy sidecar to store session state. Azure ID
// tokens with group claims routinely exceed the 4kb single-cookie limit; without a server-side
// store, oauth2-proxy splits the session across `_oauth2_proxy_0`, `_1`, `_2`... which triggers
// silent auth failures (fragmented cookies get dropped by proxies / browsers, the sidecar can't
// reassemble on subsequent requests and returns 401 immediately after a successful callback).
// One tiny Redis container amortized across all providers eliminates the whole class of bug.
const REDIS_IMAGE = 'redis:7-alpine';
const REDIS_CONTAINER_NAME = 'oblihub-azauth-redis';

function rowToProvider(row: Record<string, unknown>): AzureAuthProvider {
  return {
    id: row.id as number,
    name: row.name as string,
    tenantId: row.tenant_id as string,
    clientId: row.client_id as string,
    hasClientSecret: !!row.client_secret_enc,
    allowedEmails: parseJson(row.allowed_emails) as string[] | null,
    allowedGroups: parseJson(row.allowed_groups) as string[] | null,
    containerName: (row.container_name as string) || null,
    containerStatus: (row.container_status as AzureAuthProvider['containerStatus']) || null,
    lastError: (row.last_error as string) || null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function parseJson(raw: unknown): unknown {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) { try { return JSON.parse(raw); } catch { return null; } }
  return raw;
}

// The sidecar network is resolved dynamically from dockerService.getProxyNetworkName() —
// hardcoding "proxy" broke installs where docker-compose prefixed the project's network name
// (e.g. `oblihub_proxy`): the sidecar ended up on a freshly-created `proxy` bridge that nginx
// wasn't attached to, so auth_request failed silently. The app-config key drives both what
// the sidecar attaches to and what ensureProxyNetwork() looks up / creates.

export const azureAuthService = {
  async list(): Promise<AzureAuthProvider[]> {
    const rows = await db('azure_auth_providers').orderBy('name');
    return rows.map(rowToProvider);
  },

  async getById(id: number): Promise<AzureAuthProvider | null> {
    const row = await db('azure_auth_providers').where({ id }).first();
    return row ? rowToProvider(row) : null;
  },

  async create(data: {
    name: string;
    tenantId: string;
    clientId: string;
    clientSecret: string;
    allowedEmails?: string[];
    allowedGroups?: string[];
  }): Promise<AzureAuthProvider> {
    // Generate a random 32-char cookie signing secret. oauth2-proxy validates STRING LENGTH
    // (not base64-decoded byte length) and rejects anything that isn't exactly 16/24/32 chars.
    // 16 random bytes → 32 hex chars, always valid. Rotating this invalidates every existing
    // session for the provider (deliberate — per-provider secret, no shared sessions).
    const cookieSecret = crypto.randomBytes(16).toString('hex');
    const [row] = await db('azure_auth_providers').insert({
      name: data.name,
      tenant_id: data.tenantId,
      client_id: data.clientId,
      client_secret_enc: encryptSecret(data.clientSecret),
      cookie_secret: cookieSecret,
      allowed_emails: data.allowedEmails?.length ? JSON.stringify(data.allowedEmails) : null,
      allowed_groups: data.allowedGroups?.length ? JSON.stringify(data.allowedGroups) : null,
      container_status: 'stopped',
    }).returning('*');
    return rowToProvider(row);
  },

  async update(id: number, data: {
    name?: string;
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;    // undefined = keep, '' = clear (rare), non-empty = replace
    allowedEmails?: string[] | null;
    allowedGroups?: string[] | null;
  }): Promise<AzureAuthProvider | null> {
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) updates.name = data.name;
    if (data.tenantId !== undefined) updates.tenant_id = data.tenantId;
    if (data.clientId !== undefined) updates.client_id = data.clientId;
    if (data.clientSecret !== undefined && data.clientSecret !== '') {
      updates.client_secret_enc = encryptSecret(data.clientSecret);
    }
    if (data.allowedEmails !== undefined) updates.allowed_emails = data.allowedEmails?.length ? JSON.stringify(data.allowedEmails) : null;
    if (data.allowedGroups !== undefined) updates.allowed_groups = data.allowedGroups?.length ? JSON.stringify(data.allowedGroups) : null;
    const [row] = await db('azure_auth_providers').where({ id }).update(updates).returning('*');
    return row ? rowToProvider(row) : null;
  },

  async delete(id: number): Promise<boolean> {
    // Tear down the sidecar first so we don't leave a dangling container.
    try { await this.tearDownAuthProxy(id); } catch { /* best-effort */ }
    const count = await db('azure_auth_providers').where({ id }).delete();
    return count > 0;
  },

  /**
   * Ensure the oauth2-proxy sidecar for this provider exists and is running with the current
   * config. Idempotent: recreate if config drifted, no-op if already up to date. Called on:
   *   - provider create/update
   *   - any proxy_host that references it being deployed
   *   - explicit "restart auth" button in the UI
   */
  async deployAuthProxy(providerId: number): Promise<void> {
    const row = await db('azure_auth_providers').where({ id: providerId }).first();
    if (!row) throw new Error(`Azure auth provider ${providerId} not found`);

    const containerName = `oblihub-azauth-${providerId}`;
    const clientSecret = decryptSecret(row.client_secret_enc as string);
    // Auto-heal providers created before the length fix — old default was a 44-char base64
    // string that oauth2-proxy refuses (needs exactly 16/24/32 char ASCII). Regenerate + persist
    // silently so the operator doesn't have to click anything. Invalidates existing sessions
    // (there are none if this branch fires — the sidecar was crashlooping).
    let cookieSecret = row.cookie_secret as string;
    if (![16, 24, 32].includes(cookieSecret?.length)) {
      cookieSecret = crypto.randomBytes(16).toString('hex');
      await db('azure_auth_providers').where({ id: providerId }).update({ cookie_secret: cookieSecret, updated_at: new Date() });
      logger.info({ providerId }, 'Migrated cookie_secret to valid 32-char format');
    }
    const allowedEmails = parseJson(row.allowed_emails) as string[] | null;
    const allowedGroups = parseJson(row.allowed_groups) as string[] | null;

    const env: string[] = [
      'OAUTH2_PROXY_PROVIDER=entra-id',
      `OAUTH2_PROXY_OIDC_ISSUER_URL=https://login.microsoftonline.com/${row.tenant_id}/v2.0`,
      `OAUTH2_PROXY_CLIENT_ID=${row.client_id}`,
      `OAUTH2_PROXY_CLIENT_SECRET=${clientSecret}`,
      `OAUTH2_PROXY_COOKIE_SECRET=${cookieSecret}`,
      // Auth-only mode: nginx forwards the request via auth_request; we return 2xx / 401 with
      // no upstream proxying done by oauth2-proxy itself. The sign-in / callback flow still
      // happens through the /oauth2/ location that nginx proxies to this container.
      'OAUTH2_PROXY_UPSTREAMS=static://200',
      'OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:4180',
      // Trust X-Forwarded-* from nginx so cookie domain + redirect_url adapt per host.
      'OAUTH2_PROXY_REVERSE_PROXY=true',
      // Skip the "click to sign in" welcome page — go straight to Azure on 401.
      'OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true',
      // Emit auth headers upstream so backends can read the identity.
      'OAUTH2_PROXY_PASS_ACCESS_TOKEN=true',
      'OAUTH2_PROXY_PASS_USER_HEADERS=true',
      'OAUTH2_PROXY_SET_XAUTHREQUEST=true',
      // Scope covers openid+email+profile out of the box for Entra ID.
      'OAUTH2_PROXY_SCOPE=openid email profile',
      // Session store: Redis, backed by the shared `oblihub-azauth-redis` container that
      // ensureAuthRedis() deploys on demand. Cookie stores hit the 4kb browser limit as soon as
      // the Azure ID token carries group claims — oauth2-proxy then split-encodes the session
      // across `_oauth2_proxy_0/_1/_2/...`, which reliably breaks in the field: nginx buffers
      // truncate, browsers drop fragments, the sidecar can't reassemble and returns 401 on the
      // request right after a successful callback. Server-side storage means one small ticket
      // cookie holds a Redis key, and the session payload lives in Redis regardless of size.
      'OAUTH2_PROXY_SESSION_STORE_TYPE=redis',
      `OAUTH2_PROXY_REDIS_CONNECTION_URL=redis://${REDIS_CONTAINER_NAME}:6379`,
    ];
    // Email whitelist. `*` (default when nothing specified) = any authenticated user in the
    // tenant. When the operator lists specific emails/domains, restrict.
    if (allowedEmails && allowedEmails.length > 0) {
      env.push(`OAUTH2_PROXY_EMAIL_DOMAINS=${allowedEmails.join(',')}`);
    } else {
      env.push('OAUTH2_PROXY_EMAIL_DOMAINS=*');
    }
    // Azure group restriction — oauth2-proxy checks the `groups` claim.
    if (allowedGroups && allowedGroups.length > 0) {
      env.push(`OAUTH2_PROXY_ALLOWED_GROUPS=${allowedGroups.join(',')}`);
    }
    // WHITELIST_DOMAINS: post-auth, oauth2-proxy refuses to redirect the user back to any
    // domain not listed here (anti-open-redirect). Without this, sign-in succeeds but the
    // final "back to the app" redirect gets rejected with "domain / port not in whitelist"
    // and the user sees a 401. We enumerate every domain from every proxy_host currently
    // referencing this provider — the sidecar is redeployed whenever a proxy_host is
    // created/updated/deleted so the whitelist stays in sync.
    const hosts = await db('proxy_hosts').where({ azure_auth_provider_id: providerId }).select('domain_names');
    const allDomains = new Set<string>();
    for (const h of hosts) {
      const raw = h.domain_names;
      let arr: string[] = [];
      if (Array.isArray(raw)) arr = raw as string[];
      else if (typeof raw === 'string' && raw) { try { arr = JSON.parse(raw); } catch { arr = []; } }
      for (const d of arr) if (d) allDomains.add(d);
    }
    if (allDomains.size > 0) {
      env.push(`OAUTH2_PROXY_WHITELIST_DOMAINS=${[...allDomains].join(',')}`);
    }

    try {
      const docker = await dockerService.forEngine(null);
      // Ensure the target network exists — we auto-attach to Oblihub's shared `proxy` network.
      await dockerService.ensureProxyNetwork(null);
      // Ensure the shared Redis session-store is up (idempotent, shared across all providers).
      // Must happen BEFORE the sidecar starts — oauth2-proxy exits with error at boot if it
      // can't reach the configured REDIS_CONNECTION_URL.
      await this.ensureAuthRedis();

      // Pull the image if it's not local yet. dockerode's `createContainer` does NOT auto-pull
      // (unlike the `docker run` CLI), so a fresh Oblihub install without the oauth2-proxy image
      // cached would fail on the first Azure provider deploy with "No such image". Idempotent —
      // no-op if the image is already present.
      try {
        const stream = await docker.pull(OAUTH2_PROXY_IMAGE);
        await new Promise<void>((resolve, reject) => {
          docker.modem.followProgress(stream, (err: Error | null) => err ? reject(err) : resolve());
        });
      } catch (err) {
        // Non-fatal only if the image is already local; verify.
        try { await docker.getImage(OAUTH2_PROXY_IMAGE).inspect(); }
        catch { throw new Error(`Failed to pull ${OAUTH2_PROXY_IMAGE}: ${err instanceof Error ? err.message : String(err)}`); }
      }

      // Stop + remove any existing sidecar so we redeploy with fresh config. Cheap idempotent.
      try {
        const existing = docker.getContainer(containerName);
        await existing.stop({ t: 5 }).catch(() => {});
        await existing.remove({ force: true }).catch(() => {});
      } catch { /* not there — fine */ }

      // Attach to `proxy` via NetworkingConfig — HostConfig.NetworkMode alone doesn't reliably
      // attach when the network is external + already exists (dockerode silently falls back to
      // the default bridge network, and docker DNS resolution from other containers on `proxy`
      // fails with "no such host" — auth_request then dies silently).
      const sidecarNetwork = await dockerService.getProxyNetworkName();
      const container = await docker.createContainer({
        name: containerName,
        Image: OAUTH2_PROXY_IMAGE,
        Env: env,
        Labels: {
          'oblihub.azauth.provider_id': String(providerId),
          'oblihub.managed': 'true',
        },
        HostConfig: {
          RestartPolicy: { Name: 'unless-stopped' },
        },
        NetworkingConfig: {
          EndpointsConfig: {
            [sidecarNetwork]: {},
          },
        },
      });
      await container.start();

      await db('azure_auth_providers').where({ id: providerId }).update({
        container_name: containerName,
        container_status: 'running',
        last_error: null,
        updated_at: new Date(),
      });
      logger.info({ providerId, containerName }, 'Azure auth sidecar deployed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db('azure_auth_providers').where({ id: providerId }).update({
        container_status: 'error',
        last_error: msg,
        updated_at: new Date(),
      });
      logger.error({ providerId, err: msg }, 'Failed to deploy Azure auth sidecar');
      throw err;
    }
  },

  /**
   * Idempotent bootstrap of the shared Redis backend that every oauth2-proxy sidecar uses for
   * session storage. One instance across all providers — sessions are namespaced by cookie
   * secret anyway, so tenants can't cross-read each other. No persistence (sessions die on
   * Redis restart, forcing users to re-login — acceptable, and avoids managing a volume). Runs
   * with maxmemory + LRU eviction so a runaway session growth caps at 64MB instead of
   * unbounded RAM.
   *
   * Attached to whatever `getProxyNetworkName()` returns so oauth2-proxy sidecars on that same
   * network can reach it via docker DNS at `oblihub-azauth-redis:6379`.
   */
  async ensureAuthRedis(): Promise<void> {
    const docker = await dockerService.forEngine(null);
    const network = await dockerService.getProxyNetworkName();
    // Fast path: container already exists and is running — nothing to do.
    try {
      const existing = docker.getContainer(REDIS_CONTAINER_NAME);
      const info = await existing.inspect();
      if (info.State?.Running) {
        // If somehow present but not on the current proxy network (operator changed the
        // proxy_network_name setting after Redis was first deployed), reconnect it.
        const nets = info.NetworkSettings?.Networks || {};
        if (!nets[network]) {
          try { await docker.getNetwork(network).connect({ Container: info.Id }); }
          catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/already (exists|connected)/i.test(msg)) throw err;
          }
        }
        return;
      }
      // Present but stopped — start it. Faster than a full recreate.
      await existing.start().catch(() => {});
      return;
    } catch { /* not there — full create below */ }

    // Pull the image (idempotent, no-op if cached).
    try {
      const stream = await docker.pull(REDIS_IMAGE);
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err: Error | null) => err ? reject(err) : resolve());
      });
    } catch (err) {
      try { await docker.getImage(REDIS_IMAGE).inspect(); }
      catch { throw new Error(`Failed to pull ${REDIS_IMAGE}: ${err instanceof Error ? err.message : String(err)}`); }
    }

    const c = await docker.createContainer({
      name: REDIS_CONTAINER_NAME,
      Image: REDIS_IMAGE,
      // 64MB cap with LRU eviction — plenty for thousands of concurrent sessions, safe from
      // runaway growth. `save ""` disables RDB snapshots (we don't want disk persistence).
      Cmd: ['redis-server', '--save', '', '--maxmemory', '64mb', '--maxmemory-policy', 'allkeys-lru'],
      Labels: {
        'oblihub.managed': 'true',
        'oblihub.azauth.role': 'session-store',
      },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
      NetworkingConfig: { EndpointsConfig: { [network]: {} } },
    });
    await c.start();
    logger.info({ network }, 'Deployed shared Azure auth Redis session store');
  },

  async tearDownAuthProxy(providerId: number): Promise<void> {
    const containerName = `oblihub-azauth-${providerId}`;
    try {
      const docker = await dockerService.forEngine(null);
      const c = docker.getContainer(containerName);
      await c.stop({ t: 5 }).catch(() => {});
      await c.remove({ force: true }).catch(() => {});
      await db('azure_auth_providers').where({ id: providerId }).update({
        container_status: 'stopped',
        updated_at: new Date(),
      });
    } catch (err) {
      logger.warn({ providerId, err: err instanceof Error ? err.message : String(err) }, 'tearDownAuthProxy failed');
    }
  },

  /** List every proxy_host domain that references this provider — the operator needs to add
   *  each one's `/oauth2/callback` URL to the Azure app's Redirect URIs list. Rendered in
   *  the UI as a copy-friendly list. */
  async listCallbackUrls(providerId: number): Promise<string[]> {
    const hosts = await db('proxy_hosts').where({ azure_auth_provider_id: providerId }).select('domain_names', 'ssl_forced');
    const urls: string[] = [];
    for (const h of hosts) {
      const domains = parseJson(h.domain_names) as string[] | null;
      if (!Array.isArray(domains)) continue;
      const scheme = h.ssl_forced ? 'https' : 'http';
      for (const d of domains) urls.push(`${scheme}://${d}/oauth2/callback`);
    }
    return urls;
  },
};
