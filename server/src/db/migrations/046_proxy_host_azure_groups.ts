import type { Knex } from 'knex';

/**
 * Per-proxy_host restriction on Azure AD group memberships.
 *
 * The Azure auth provider's `allowed_groups` is a GLOBAL filter enforced by the oauth2-proxy
 * sidecar: reject any user not in one of those groups at sign-in time. When one provider is
 * shared across several proxy_hosts (single Azure App Registration, multiple callback URLs),
 * that global filter is too coarse — the operator might want group A to reach stack A only,
 * group B to reach stack B only, while both live behind the same provider.
 *
 * Model:
 *   - provider.allowed_groups → still enforced by the sidecar (union filter at auth time)
 *   - proxy_hosts.azure_auth_allowed_groups → additional per-host filter enforced by nginx
 *     via an `if ($auth_groups !~ regex) { return 403; }` guard emitted in the server block.
 *
 * Null / empty = no per-host restriction (only provider-level filter, if any, applies).
 * Stored as a jsonb array of GUID strings to match the provider's storage shape.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.jsonb('azure_auth_allowed_groups').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.dropColumn('azure_auth_allowed_groups');
  });
}
