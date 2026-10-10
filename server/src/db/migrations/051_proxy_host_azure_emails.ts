import type { Knex } from 'knex';

/**
 * Per-proxy_host restriction on Azure identity: emails/domains.
 *
 * Complements 046 (per-host `azure_auth_allowed_groups`). Same enforcement model — the
 * provider's global filters still apply at the sidecar; this column is a further restriction
 * applied by nginx post-auth via `if ($auth_email !~ regex) { return 403; }`.
 *
 * Semantics of a list entry:
 *   - "user@example.com" → exact email match
 *   - "example.com"      → any user whose email ends with @example.com
 *
 * Combined with `azure_auth_allowed_groups` by AND: when both are set, a user must satisfy
 * both to reach this host (same convention oauth2-proxy uses between EMAIL_DOMAINS and
 * ALLOWED_GROUPS).
 *
 * Null / empty = no per-host email restriction (only provider-level filter, if any, applies).
 * Stored as jsonb array of strings.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.jsonb('azure_auth_allowed_emails').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.dropColumn('azure_auth_allowed_emails');
  });
}
