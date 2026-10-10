import { db } from '../db';
import type { ProxyHost, ProxyHostRoute, RedirectionHost, StreamHost, DeadHost, AccessList, Certificate, CustomPage } from '@oblihub/shared';
import { logger } from '../utils/logger';

// ── Helpers ──

function certRow(row: Record<string, unknown>): Certificate {
  let requestLog: Certificate['requestLog'] = [];
  const raw = row.request_log;
  if (Array.isArray(raw)) requestLog = raw as Certificate['requestLog'];
  else if (typeof raw === 'string' && raw) { try { requestLog = JSON.parse(raw); } catch { /* ignore */ } }
  return {
    id: row.id as number,
    domainNames: (row.domain_names as string[]) || [],
    provider: row.provider as Certificate['provider'],
    expiresAt: row.expires_at ? (row.expires_at as Date).toISOString() : null,
    status: row.status as Certificate['status'],
    errorMessage: (row.error_message as string) || null,
    acmeEmail: (row.acme_email as string) || null,
    requestLog,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function routeRow(row: Record<string, unknown>): ProxyHostRoute {
  const parseIds = (raw: unknown): number[] => {
    if (Array.isArray(raw)) return raw as number[];
    if (typeof raw === 'string' && raw) { try { return JSON.parse(raw) as number[]; } catch { return []; } }
    return [];
  };
  return {
    id: row.id as number,
    proxyHostId: row.proxy_host_id as number,
    sortOrder: (row.sort_order as number) || 0,
    pathIn: row.path_in as string,
    pathRewrite: (row.path_rewrite as string) || null,
    forwardScheme: (row.forward_scheme as 'http' | 'https') || 'http',
    forwardHost: row.forward_host as string,
    forwardPort: row.forward_port as number,
    authMode: (row.auth_mode as 'inherit' | 'none' | 'override') || 'inherit',
    azureAuthProviderOverrideId: (row.azure_auth_provider_override_id as number) || null,
    accessListMode: (row.access_list_mode as 'inherit' | 'none' | 'override') || 'inherit',
    accessListOverrideIds: parseIds(row.access_list_override_ids),
    websocketSupport: row.websocket_support as boolean | null ?? null,
    proxyBuffering: row.proxy_buffering as boolean | null ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

async function getHoneypotPathsForHost(proxyHostId: number): Promise<{ id: number; path: string; enabled: boolean }[]> {
  const rows = await db('honeypot_paths').where({ proxy_host_id: proxyHostId, enabled: true }).select('id', 'path', 'enabled').orderBy('path');
  return rows.map(r => ({ id: r.id as number, path: r.path as string, enabled: !!r.enabled }));
}

async function getRoutesForHost(proxyHostId: number): Promise<ProxyHostRoute[]> {
  const rows = await db('proxy_host_routes').where({ proxy_host_id: proxyHostId }).orderBy('sort_order').orderBy('id');
  return rows.map(routeRow);
}

/**
 * Replace all routes for a proxy host in one shot. Cheaper than diffing (route rows are cheap,
 * no cascading FKs to worry about) and it means the UI can freely reorder / add / remove without
 * having to track per-row PKs.
 */
async function setRoutesForHost(proxyHostId: number, routes: Partial<ProxyHostRoute>[] | undefined): Promise<void> {
  if (routes === undefined) return; // caller doesn't want to touch routes
  await db('proxy_host_routes').where({ proxy_host_id: proxyHostId }).delete();
  if (routes.length === 0) return;
  await db('proxy_host_routes').insert(routes.map((r, idx) => ({
    proxy_host_id: proxyHostId,
    sort_order: r.sortOrder ?? idx,
    path_in: r.pathIn,
    path_rewrite: r.pathRewrite || null,
    forward_scheme: r.forwardScheme || 'http',
    forward_host: r.forwardHost,
    forward_port: r.forwardPort,
    auth_mode: r.authMode || 'inherit',
    azure_auth_provider_override_id: r.azureAuthProviderOverrideId || null,
    access_list_mode: r.accessListMode || 'inherit',
    access_list_override_ids: r.accessListOverrideIds ? JSON.stringify(r.accessListOverrideIds) : null,
    websocket_support: r.websocketSupport ?? null,
    proxy_buffering: r.proxyBuffering ?? null,
  })));
}

function proxyRow(row: Record<string, unknown>, cert?: Certificate | null, accessListIds: number[] = [], routes: ProxyHostRoute[] = [], honeypotPaths: { id: number; path: string; enabled: boolean }[] = []): ProxyHost {
  return {
    id: row.id as number,
    domainNames: (row.domain_names as string[]) || [],
    forwardScheme: (row.forward_scheme as 'http' | 'https') || 'http',
    forwardHost: row.forward_host as string,
    forwardPort: row.forward_port as number,
    certificateId: (row.certificate_id as number) || null,
    sslForced: row.ssl_forced as boolean,
    http2Support: row.http2_support as boolean,
    hstsEnabled: row.hsts_enabled as boolean,
    hstsSubdomains: row.hsts_subdomains as boolean,
    blockExploits: row.block_exploits as boolean,
    cachingEnabled: row.caching_enabled as boolean,
    websocketSupport: row.websocket_support as boolean,
    accessListIds,
    accessListId: accessListIds[0] ?? ((row.access_list_id as number) || null),
    advancedConfig: (row.advanced_config as string) || null,
    enabled: row.enabled as boolean,
    stackId: (row.stack_id as number) || null,
    clientMaxBodySize: (row.client_max_body_size as string) || null,
    proxyConnectTimeout: (row.proxy_connect_timeout as number) || null,
    proxySendTimeout: (row.proxy_send_timeout as number) || null,
    proxyReadTimeout: (row.proxy_read_timeout as number) || null,
    proxyBuffering: row.proxy_buffering as boolean | null ?? null,
    rateLimitRps: (row.rate_limit_rps as number) || null,
    rateLimitBurst: (row.rate_limit_burst as number) || null,
    gzipEnabled: (row.gzip_enabled as boolean) || false,
    corsEnabled: (row.cors_enabled as boolean) || false,
    customResponseHeaders: (row.custom_response_headers as { name: string; value: string; action: 'add' | 'remove' }[]) || null,
    errorPageId: (row.error_page_id as number) || null,
    wakeContainerId: (row.wake_container_id as number) || null,
    wakeExtraContainerIds: ((): number[] => {
      const raw = row.wake_extra_container_ids;
      if (Array.isArray(raw)) return raw as number[];
      if (typeof raw === 'string' && raw) { try { return JSON.parse(raw) as number[]; } catch { return []; } }
      return [];
    })(),
    wakingPageId: (row.waking_page_id as number) || null,
    autoMonitor: (row.auto_monitor as boolean) || false,
    dockerNetwork: (row.docker_network as string) || null,
    azureAuthProviderId: (row.azure_auth_provider_id as number) || null,
    azureAuthAllowedGroups: ((): string[] | null => {
      const raw = row.azure_auth_allowed_groups;
      if (raw == null) return null;
      if (Array.isArray(raw)) return raw as string[];
      if (typeof raw === 'string' && raw) { try { return JSON.parse(raw) as string[]; } catch { return null; } }
      return null;
    })(),
    azureAuthAllowedEmails: ((): string[] | null => {
      const raw = row.azure_auth_allowed_emails;
      if (raw == null) return null;
      if (Array.isArray(raw)) return raw as string[];
      if (typeof raw === 'string' && raw) { try { return JSON.parse(raw) as string[]; } catch { return null; } }
      return null;
    })(),
    honeypotEnabled: !!row.honeypot_enabled,
    honeypotBanAclViolations: !!row.honeypot_ban_acl_violations,
    honeypotBanDurationSeconds: (row.honeypot_ban_duration_seconds as number) || null,
    honeypotPaths,
    routes,
    certificate: cert || null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function redirectRow(row: Record<string, unknown>, cert?: Certificate | null): RedirectionHost {
  return {
    id: row.id as number,
    domainNames: (row.domain_names as string[]) || [],
    forwardScheme: (row.forward_scheme as 'http' | 'https') || 'https',
    forwardDomain: row.forward_domain as string,
    forwardPath: (row.forward_path as string) || '/',
    preservePath: row.preserve_path as boolean,
    certificateId: (row.certificate_id as number) || null,
    sslForced: row.ssl_forced as boolean,
    http2Support: row.http2_support as boolean,
    hstsEnabled: row.hsts_enabled as boolean,
    blockExploits: row.block_exploits as boolean,
    advancedConfig: (row.advanced_config as string) || null,
    enabled: row.enabled as boolean,
    certificate: cert || null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function streamRow(row: Record<string, unknown>): StreamHost {
  return {
    id: row.id as number,
    incomingPort: row.incoming_port as number,
    forwardingHost: row.forwarding_host as string,
    forwardingPort: row.forwarding_port as number,
    tcpForwarding: row.tcp_forwarding as boolean,
    udpForwarding: row.udp_forwarding as boolean,
    enabled: row.enabled as boolean,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function deadRow(row: Record<string, unknown>, cert?: Certificate | null): DeadHost {
  return {
    id: row.id as number,
    domainNames: (row.domain_names as string[]) || [],
    certificateId: (row.certificate_id as number) || null,
    sslForced: row.ssl_forced as boolean,
    http2Support: row.http2_support as boolean,
    hstsEnabled: row.hsts_enabled as boolean,
    advancedConfig: (row.advanced_config as string) || null,
    enabled: row.enabled as boolean,
    certificate: cert || null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

async function getCert(id: number | null): Promise<Certificate | null> {
  if (!id) return null;
  const row = await db('certificates').where({ id }).first();
  return row ? certRow(row) : null;
}

/** Read all access list ids attached to a proxy host via the junction table. */
async function getAccessListIds(proxyHostId: number): Promise<number[]> {
  const rows = await db('proxy_host_access_lists').where({ proxy_host_id: proxyHostId }).select('access_list_id');
  return rows.map(r => r.access_list_id as number);
}

/** Replace a proxy host's set of attached access lists (deletes existing rows, inserts new). */
async function setAccessListIds(proxyHostId: number, ids: number[]): Promise<void> {
  const unique = [...new Set(ids.filter(id => Number.isInteger(id) && id > 0))];
  await db('proxy_host_access_lists').where({ proxy_host_id: proxyHostId }).delete();
  if (unique.length > 0) {
    await db('proxy_host_access_lists').insert(
      unique.map(access_list_id => ({ proxy_host_id: proxyHostId, access_list_id })),
    );
  }
}

// ── Certificates ──

export const certificateService = {
  async getAll(): Promise<Certificate[]> {
    const rows = await db('certificates').orderBy('id');
    return rows.map(certRow);
  },

  async getById(id: number): Promise<Certificate | null> {
    const row = await db('certificates').where({ id }).first();
    return row ? certRow(row) : null;
  },

  async create(data: { domainNames: string[]; provider: string; acmeEmail?: string }): Promise<Certificate> {
    const [row] = await db('certificates').insert({
      domain_names: JSON.stringify(data.domainNames),
      provider: data.provider || 'letsencrypt',
      acme_email: data.acmeEmail || null,
      status: 'pending',
    }).returning('*');
    return certRow(row);
  },

  async updateStatus(id: number, status: string, paths?: { cert?: string; key?: string; chain?: string; expiresAt?: Date }, errorMessage?: string | null): Promise<void> {
    const update: Record<string, unknown> = { status, updated_at: new Date() };
    if (paths?.cert) update.certificate_path = paths.cert;
    if (paths?.key) update.key_path = paths.key;
    if (paths?.chain) update.chain_path = paths.chain;
    if (paths?.expiresAt) update.expires_at = paths.expiresAt;
    if (errorMessage !== undefined) update.error_message = errorMessage;
    await db('certificates').where({ id }).update(update);
  },

  async delete(id: number): Promise<void> {
    await db('certificates').where({ id }).delete();
  },
};

// ── Proxy Hosts ──

export const proxyHostService = {
  async getAll(): Promise<ProxyHost[]> {
    const rows = await db('proxy_hosts').orderBy('id');
    return Promise.all(rows.map(async (r) => proxyRow(r, await getCert(r.certificate_id), await getAccessListIds(r.id), await getRoutesForHost(r.id), await getHoneypotPathsForHost(r.id))));
  },

  async getById(id: number): Promise<ProxyHost | null> {
    const row = await db('proxy_hosts').where({ id }).first();
    return row ? proxyRow(row, await getCert(row.certificate_id), await getAccessListIds(row.id), await getRoutesForHost(row.id), await getHoneypotPathsForHost(row.id)) : null;
  },

  async getByStackId(stackId: number): Promise<ProxyHost[]> {
    const rows = await db('proxy_hosts').where({ stack_id: stackId }).orderBy('id');
    return Promise.all(rows.map(async (r) => proxyRow(r, await getCert(r.certificate_id), await getAccessListIds(r.id), await getRoutesForHost(r.id), await getHoneypotPathsForHost(r.id))));
  },

  async create(data: Partial<ProxyHost>): Promise<ProxyHost> {
    const [row] = await db('proxy_hosts').insert({
      domain_names: JSON.stringify(data.domainNames || []),
      forward_scheme: data.forwardScheme || 'http',
      forward_host: data.forwardHost,
      forward_port: data.forwardPort || 80,
      certificate_id: data.certificateId || null,
      ssl_forced: data.sslForced || false,
      http2_support: data.http2Support || false,
      hsts_enabled: data.hstsEnabled || false,
      hsts_subdomains: data.hstsSubdomains || false,
      block_exploits: data.blockExploits || false,
      caching_enabled: data.cachingEnabled || false,
      websocket_support: data.websocketSupport || false,
      access_list_id: data.accessListId || null,
      advanced_config: data.advancedConfig || null,
      enabled: data.enabled !== false,
      stack_id: data.stackId || null,
      client_max_body_size: data.clientMaxBodySize || null,
      proxy_connect_timeout: data.proxyConnectTimeout || null,
      proxy_send_timeout: data.proxySendTimeout || null,
      proxy_read_timeout: data.proxyReadTimeout || null,
      proxy_buffering: data.proxyBuffering ?? null,
      rate_limit_rps: data.rateLimitRps || null,
      rate_limit_burst: data.rateLimitBurst || null,
      gzip_enabled: data.gzipEnabled || false,
      cors_enabled: data.corsEnabled || false,
      custom_response_headers: data.customResponseHeaders ? JSON.stringify(data.customResponseHeaders) : null,
      error_page_id: data.errorPageId || null,
      wake_container_id: data.wakeContainerId || null,
      wake_extra_container_ids: JSON.stringify(data.wakeExtraContainerIds || []),
      waking_page_id: data.wakingPageId || null,
      auto_monitor: data.autoMonitor || false,
      docker_network: data.dockerNetwork || null,
      azure_auth_provider_id: data.azureAuthProviderId || null,
      azure_auth_allowed_groups: data.azureAuthAllowedGroups && data.azureAuthAllowedGroups.length ? JSON.stringify(data.azureAuthAllowedGroups) : null,
      azure_auth_allowed_emails: data.azureAuthAllowedEmails && data.azureAuthAllowedEmails.length ? JSON.stringify(data.azureAuthAllowedEmails) : null,
      honeypot_enabled: data.honeypotEnabled || false,
      honeypot_ban_acl_violations: data.honeypotBanAclViolations || false,
      honeypot_ban_duration_seconds: data.honeypotBanDurationSeconds ?? null,
    }).returning('*');
    // Hydrate the junction from accessListIds[] if provided; otherwise fall back to the
    // legacy single accessListId so older clients still work.
    const ids = data.accessListIds ?? (data.accessListId ? [data.accessListId] : []);
    await setAccessListIds(row.id, ids);
    await setRoutesForHost(row.id, data.routes);
    return proxyRow(row, await getCert(row.certificate_id), await getAccessListIds(row.id), await getRoutesForHost(row.id), await getHoneypotPathsForHost(row.id));
  },

  async update(id: number, data: Partial<ProxyHost>): Promise<ProxyHost | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.domainNames !== undefined) update.domain_names = JSON.stringify(data.domainNames);
    if (data.forwardScheme !== undefined) update.forward_scheme = data.forwardScheme;
    if (data.forwardHost !== undefined) update.forward_host = data.forwardHost;
    if (data.forwardPort !== undefined) update.forward_port = data.forwardPort;
    if (data.certificateId !== undefined) update.certificate_id = data.certificateId;
    if (data.sslForced !== undefined) update.ssl_forced = data.sslForced;
    if (data.http2Support !== undefined) update.http2_support = data.http2Support;
    if (data.hstsEnabled !== undefined) update.hsts_enabled = data.hstsEnabled;
    if (data.hstsSubdomains !== undefined) update.hsts_subdomains = data.hstsSubdomains;
    if (data.blockExploits !== undefined) update.block_exploits = data.blockExploits;
    if (data.cachingEnabled !== undefined) update.caching_enabled = data.cachingEnabled;
    if (data.websocketSupport !== undefined) update.websocket_support = data.websocketSupport;
    if (data.accessListId !== undefined) update.access_list_id = data.accessListId;
    if (data.advancedConfig !== undefined) update.advanced_config = data.advancedConfig;
    if (data.enabled !== undefined) update.enabled = data.enabled;
    if (data.stackId !== undefined) update.stack_id = data.stackId;
    if (data.clientMaxBodySize !== undefined) update.client_max_body_size = data.clientMaxBodySize;
    if (data.proxyConnectTimeout !== undefined) update.proxy_connect_timeout = data.proxyConnectTimeout;
    if (data.proxySendTimeout !== undefined) update.proxy_send_timeout = data.proxySendTimeout;
    if (data.proxyReadTimeout !== undefined) update.proxy_read_timeout = data.proxyReadTimeout;
    if (data.proxyBuffering !== undefined) update.proxy_buffering = data.proxyBuffering;
    if (data.rateLimitRps !== undefined) update.rate_limit_rps = data.rateLimitRps;
    if (data.rateLimitBurst !== undefined) update.rate_limit_burst = data.rateLimitBurst;
    if (data.gzipEnabled !== undefined) update.gzip_enabled = data.gzipEnabled;
    if (data.corsEnabled !== undefined) update.cors_enabled = data.corsEnabled;
    if (data.customResponseHeaders !== undefined) update.custom_response_headers = data.customResponseHeaders ? JSON.stringify(data.customResponseHeaders) : null;
    if (data.errorPageId !== undefined) update.error_page_id = data.errorPageId;
    if (data.wakeContainerId !== undefined) update.wake_container_id = data.wakeContainerId;
    if (data.wakeExtraContainerIds !== undefined) update.wake_extra_container_ids = JSON.stringify(data.wakeExtraContainerIds);
    if (data.wakingPageId !== undefined) update.waking_page_id = data.wakingPageId;
    if (data.autoMonitor !== undefined) update.auto_monitor = data.autoMonitor;
    if (data.dockerNetwork !== undefined) update.docker_network = data.dockerNetwork;
    if (data.azureAuthProviderId !== undefined) update.azure_auth_provider_id = data.azureAuthProviderId;
    if (data.azureAuthAllowedGroups !== undefined) {
      update.azure_auth_allowed_groups = data.azureAuthAllowedGroups && data.azureAuthAllowedGroups.length ? JSON.stringify(data.azureAuthAllowedGroups) : null;
    }
    if (data.azureAuthAllowedEmails !== undefined) {
      update.azure_auth_allowed_emails = data.azureAuthAllowedEmails && data.azureAuthAllowedEmails.length ? JSON.stringify(data.azureAuthAllowedEmails) : null;
    }
    if (data.honeypotEnabled !== undefined) update.honeypot_enabled = data.honeypotEnabled;
    if (data.honeypotBanAclViolations !== undefined) update.honeypot_ban_acl_violations = data.honeypotBanAclViolations;
    if (data.honeypotBanDurationSeconds !== undefined) update.honeypot_ban_duration_seconds = data.honeypotBanDurationSeconds;
    const [row] = await db('proxy_hosts').where({ id }).update(update).returning('*');
    if (!row) return null;
    // Sync junction when the caller passed an explicit list (empty array = "clear all").
    if (data.accessListIds !== undefined) {
      await setAccessListIds(row.id, data.accessListIds);
    } else if (data.accessListId !== undefined) {
      // Legacy single-id path — replace junction with at most one entry.
      await setAccessListIds(row.id, data.accessListId ? [data.accessListId] : []);
    }
    await setRoutesForHost(row.id, data.routes);
    return proxyRow(row, await getCert(row.certificate_id), await getAccessListIds(row.id), await getRoutesForHost(row.id), await getHoneypotPathsForHost(row.id));
  },

  async delete(id: number): Promise<void> {
    await db('proxy_hosts').where({ id }).delete();
  },

  async getEnabled(): Promise<ProxyHost[]> {
    const rows = await db('proxy_hosts').where({ enabled: true }).orderBy('id');
    return Promise.all(rows.map(async (r) => proxyRow(r, await getCert(r.certificate_id), await getAccessListIds(r.id), await getRoutesForHost(r.id), await getHoneypotPathsForHost(r.id))));
  },
};

// ── Redirection Hosts ──

export const redirectionService = {
  async getAll(): Promise<RedirectionHost[]> {
    const rows = await db('redirection_hosts').orderBy('id');
    return Promise.all(rows.map(async (r) => redirectRow(r, await getCert(r.certificate_id))));
  },

  async create(data: Partial<RedirectionHost>): Promise<RedirectionHost> {
    const [row] = await db('redirection_hosts').insert({
      domain_names: JSON.stringify(data.domainNames || []),
      forward_scheme: data.forwardScheme || 'https',
      forward_domain: data.forwardDomain,
      forward_path: data.forwardPath || '/',
      preserve_path: data.preservePath !== false,
      certificate_id: data.certificateId || null,
      ssl_forced: data.sslForced || false,
      http2_support: data.http2Support || false,
      hsts_enabled: data.hstsEnabled || false,
      block_exploits: data.blockExploits || false,
      advanced_config: data.advancedConfig || null,
      enabled: data.enabled !== false,
    }).returning('*');
    return redirectRow(row, await getCert(row.certificate_id));
  },

  async update(id: number, data: Partial<RedirectionHost>): Promise<RedirectionHost | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.domainNames !== undefined) update.domain_names = JSON.stringify(data.domainNames);
    if (data.forwardScheme !== undefined) update.forward_scheme = data.forwardScheme;
    if (data.forwardDomain !== undefined) update.forward_domain = data.forwardDomain;
    if (data.forwardPath !== undefined) update.forward_path = data.forwardPath;
    if (data.preservePath !== undefined) update.preserve_path = data.preservePath;
    if (data.certificateId !== undefined) update.certificate_id = data.certificateId;
    if (data.sslForced !== undefined) update.ssl_forced = data.sslForced;
    if (data.http2Support !== undefined) update.http2_support = data.http2Support;
    if (data.hstsEnabled !== undefined) update.hsts_enabled = data.hstsEnabled;
    if (data.blockExploits !== undefined) update.block_exploits = data.blockExploits;
    if (data.advancedConfig !== undefined) update.advanced_config = data.advancedConfig;
    if (data.enabled !== undefined) update.enabled = data.enabled;
    const [row] = await db('redirection_hosts').where({ id }).update(update).returning('*');
    return row ? redirectRow(row, await getCert(row.certificate_id)) : null;
  },

  async delete(id: number): Promise<void> {
    await db('redirection_hosts').where({ id }).delete();
  },
};

// ── Streams ──

export const streamService = {
  async getAll(): Promise<StreamHost[]> {
    const rows = await db('streams').orderBy('id');
    return rows.map(streamRow);
  },

  async create(data: Partial<StreamHost>): Promise<StreamHost> {
    const [row] = await db('streams').insert({
      incoming_port: data.incomingPort,
      forwarding_host: data.forwardingHost,
      forwarding_port: data.forwardingPort,
      tcp_forwarding: data.tcpForwarding !== false,
      udp_forwarding: data.udpForwarding || false,
      enabled: data.enabled !== false,
    }).returning('*');
    return streamRow(row);
  },

  async update(id: number, data: Partial<StreamHost>): Promise<StreamHost | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.incomingPort !== undefined) update.incoming_port = data.incomingPort;
    if (data.forwardingHost !== undefined) update.forwarding_host = data.forwardingHost;
    if (data.forwardingPort !== undefined) update.forwarding_port = data.forwardingPort;
    if (data.tcpForwarding !== undefined) update.tcp_forwarding = data.tcpForwarding;
    if (data.udpForwarding !== undefined) update.udp_forwarding = data.udpForwarding;
    if (data.enabled !== undefined) update.enabled = data.enabled;
    const [row] = await db('streams').where({ id }).update(update).returning('*');
    return row ? streamRow(row) : null;
  },

  async delete(id: number): Promise<void> {
    await db('streams').where({ id }).delete();
  },
};

// ── Dead Hosts ──

export const deadHostService = {
  async getAll(): Promise<DeadHost[]> {
    const rows = await db('dead_hosts').orderBy('id');
    return Promise.all(rows.map(async (r) => deadRow(r, await getCert(r.certificate_id))));
  },

  async create(data: Partial<DeadHost>): Promise<DeadHost> {
    const [row] = await db('dead_hosts').insert({
      domain_names: JSON.stringify(data.domainNames || []),
      certificate_id: data.certificateId || null,
      ssl_forced: data.sslForced || false,
      http2_support: data.http2Support || false,
      hsts_enabled: data.hstsEnabled || false,
      advanced_config: data.advancedConfig || null,
      enabled: data.enabled !== false,
    }).returning('*');
    return deadRow(row, await getCert(row.certificate_id));
  },

  async delete(id: number): Promise<void> {
    await db('dead_hosts').where({ id }).delete();
  },
};

// ── Access Lists ──

export const accessListService = {
  async getAll(): Promise<AccessList[]> {
    const rows = await db('access_lists').orderBy('id');
    return Promise.all(rows.map(async (r) => {
      const clients = await db('access_list_clients').where({ access_list_id: r.id });
      const auth = await db('access_list_auth').where({ access_list_id: r.id });
      return {
        id: r.id as number,
        name: r.name as string,
        satisfyAny: r.satisfy_any as boolean,
        passAuth: r.pass_auth as boolean,
        clients: clients.map((c: Record<string, unknown>) => ({ id: c.id as number, address: c.address as string, directive: c.directive as 'allow' | 'deny' })),
        auth: auth.map((a: Record<string, unknown>) => ({ id: a.id as number, username: a.username as string })),
        createdAt: (r.created_at as Date).toISOString(),
        updatedAt: (r.updated_at as Date).toISOString(),
      };
    }));
  },

  async create(data: { name: string; satisfyAny?: boolean; passAuth?: boolean }): Promise<AccessList> {
    const [row] = await db('access_lists').insert({
      name: data.name,
      satisfy_any: data.satisfyAny || false,
      pass_auth: data.passAuth || false,
    }).returning('*');
    return { id: row.id, name: row.name, satisfyAny: row.satisfy_any, passAuth: row.pass_auth, clients: [], auth: [], createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
  },

  /** Update the access list itself (rename + toggle flags). Returns the fresh record or null. */
  async update(id: number, data: { name?: string; satisfyAny?: boolean; passAuth?: boolean }): Promise<AccessList | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.satisfyAny !== undefined) update.satisfy_any = data.satisfyAny;
    if (data.passAuth !== undefined) update.pass_auth = data.passAuth;
    await db('access_lists').where({ id }).update(update);
    const all = await this.getAll();
    return all.find(l => l.id === id) || null;
  },

  async addClient(accessListId: number, address: string, directive: 'allow' | 'deny'): Promise<void> {
    await db('access_list_clients').insert({ access_list_id: accessListId, address, directive });
  },

  /** Update an existing IP rule in place (address and/or directive). */
  async updateClient(clientId: number, data: { address?: string; directive?: 'allow' | 'deny' }): Promise<void> {
    const update: Record<string, unknown> = {};
    if (data.address !== undefined) update.address = data.address;
    if (data.directive !== undefined) update.directive = data.directive;
    if (Object.keys(update).length === 0) return;
    await db('access_list_clients').where({ id: clientId }).update(update);
  },

  async removeClient(id: number): Promise<void> {
    await db('access_list_clients').where({ id }).delete();
  },

  async addAuth(accessListId: number, username: string, passwordHash: string): Promise<void> {
    await db('access_list_auth').insert({ access_list_id: accessListId, username, password_hash: passwordHash });
  },

  /**
   * Update an existing basic-auth entry. `passwordHash` is optional — omit it to keep the
   * existing password (e.g. when the operator only wants to rename the user).
   */
  async updateAuth(authId: number, data: { username?: string; passwordHash?: string }): Promise<void> {
    const update: Record<string, unknown> = {};
    if (data.username !== undefined) update.username = data.username;
    if (data.passwordHash !== undefined) update.password_hash = data.passwordHash;
    if (Object.keys(update).length === 0) return;
    await db('access_list_auth').where({ id: authId }).update(update);
  },

  async removeAuth(id: number): Promise<void> {
    await db('access_list_auth').where({ id }).delete();
  },

  async delete(id: number): Promise<void> {
    await db('access_lists').where({ id }).delete();
  },
};

// ── Custom Pages ──

function customPageRow(row: Record<string, unknown>): CustomPage {
  return {
    id: row.id as number,
    name: row.name as string,
    description: (row.description as string) || null,
    errorCodes: (row.error_codes as number[]) || [],
    htmlContent: row.html_content as string,
    theme: (row.theme as string) || 'custom',
    isBuiltin: row.is_builtin as boolean,
    isWakingPage: (row.is_waking_page as boolean) || false,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export const customPageService = {
  async getAll(): Promise<CustomPage[]> {
    const rows = await db('custom_pages').orderBy('is_builtin', 'desc').orderBy('name');
    return rows.map(customPageRow);
  },

  async getById(id: number): Promise<CustomPage | null> {
    const row = await db('custom_pages').where({ id }).first();
    return row ? customPageRow(row) : null;
  },

  async create(data: { name: string; description?: string; errorCodes: number[]; htmlContent: string; theme?: string; isWakingPage?: boolean }): Promise<CustomPage> {
    const [row] = await db('custom_pages').insert({
      name: data.name,
      description: data.description || null,
      error_codes: JSON.stringify(data.errorCodes),
      html_content: data.htmlContent,
      theme: data.theme || 'custom',
      is_builtin: false,
      is_waking_page: data.isWakingPage || false,
    }).returning('*');
    return customPageRow(row);
  },

  async update(id: number, data: { name?: string; description?: string; errorCodes?: number[]; htmlContent?: string; isWakingPage?: boolean }): Promise<CustomPage | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.errorCodes !== undefined) update.error_codes = JSON.stringify(data.errorCodes);
    if (data.htmlContent !== undefined) update.html_content = data.htmlContent;
    if (data.isWakingPage !== undefined) update.is_waking_page = data.isWakingPage;
    const [row] = await db('custom_pages').where({ id }).update(update).returning('*');
    return row ? customPageRow(row) : null;
  },

  async delete(id: number): Promise<void> {
    const page = await db('custom_pages').where({ id }).first();
    if (page?.is_builtin) throw new Error('Cannot delete built-in page');
    await db('custom_pages').where({ id }).delete();
  },
};
