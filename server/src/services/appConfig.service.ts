import { db } from '../db';

// ── Obligate settings ─────────────────────────────────────────────────────────
// app_config keys: obligate_url, obligate_api_key, obligate_enabled, and the
// optional one below. Environment override (optional, harmless when unset or
// empty — the compose files pass it through with an empty default):
//   OBLIGATE_INBOUND_SECRET — a secret distinct from the API key that Obligate
//     must present (Bearer) on its calls to this server. Unset → the Settings
//     value → the API key (today's behaviour).
// The browser-facing client_id is always the public id sha256(API key) (see
// obligateService.authorizeClientId): the former OBLIGATE_CLIENT_ID_MODE
// environment variable is ignored.

/** app_config key of the optional Obligate inbound secret. */
export const OBLIGATE_INBOUND_SECRET_KEY = 'obligate_inbound_secret';
/** A distinct inbound secret shorter than this is refused (Settings). */
export const OBLIGATE_INBOUND_SECRET_MIN_LENGTH = 16;
/**
 * Internal app_config keys `obligate_sync_disabled:<local user id>`: og_
 * accounts disabled by the Obligate sync (not by an Oblihub admin), see
 * obligateCallback.routes.ts. Never shown nor written by Settings.
 */
export const OBLIGATE_SYNC_DISABLED_KEY_PREFIX = 'obligate_sync_disabled:';

export function envInboundSecret(): string | null {
  const v = process.env.OBLIGATE_INBOUND_SECRET?.trim();
  return v ? v : null;
}

export const appConfigService = {
  async get(key: string): Promise<string | null> {
    const row = await db('app_config').where({ key }).first() as { value: string | null } | undefined;
    return row?.value ?? null;
  },

  async set(key: string, value: string | null): Promise<void> {
    await db('app_config').insert({ key, value }).onConflict('key').merge({ value });
  },

  async getAll(): Promise<Record<string, string | null>> {
    const rows = await db('app_config').select('key', 'value') as Array<{ key: string; value: string | null }>;
    const result: Record<string, string | null> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  },

  /**
   * Effective Obligate settings (environment overrides applied).
   *  - apiKey: the app's Obligate API key — outbound Bearer (this server →
   *    Obligate) and, unless an inbound secret is set, the secret Obligate
   *    presents on its calls to this server. Never the browser-facing
   *    client_id (always the public id, obligateService.authorizeClientId).
   *  - inboundSecret: optional distinct secret expected from Obligate.
   */
  async getObligateRaw(): Promise<{
    url: string | null; apiKey: string | null; enabled: boolean;
    inboundSecret: string | null;
  }> {
    const rows = await db('app_config')
      .whereIn('key', ['obligate_url', 'obligate_api_key', 'obligate_enabled', OBLIGATE_INBOUND_SECRET_KEY])
      .select('key', 'value') as Array<{ key: string; value: string | null }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const storedSecret = map.get(OBLIGATE_INBOUND_SECRET_KEY)?.trim();
    return {
      // Without a trailing slash: `${url}/authorize`, `${url}/api/...`
      url: (map.get('obligate_url') ?? '').trim().replace(/\/+$/, '') || null,
      apiKey: map.get('obligate_api_key') || null,
      enabled: map.get('obligate_enabled') === 'true',
      inboundSecret: envInboundSecret() ?? (storedSecret ? storedSecret : null),
    };
  },
};
