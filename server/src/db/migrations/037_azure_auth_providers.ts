import type { Knex } from 'knex';

/**
 * Azure AD (Entra ID) auth providers for the reverse-proxy.
 *
 * Each row is one Azure app registration (tenant + client_id + secret) that Oblihub uses to
 * spin up a dedicated `oauth2-proxy` sidecar container on the shared `proxy` network. Nginx
 * then delegates its `auth_request` for any proxy_host that references this provider to that
 * sidecar — sidecar answers 2xx (session valid) or 401 (redirect to Azure sign-in).
 *
 * client_secret is AES-GCM at rest (utils/crypto). cookie_secret is generated once per
 * provider and reused across restarts so existing sessions survive.
 *
 * container_name / container_status are populated by the service after `deployAuthProxy` and
 * are the source of truth for "is my sidecar actually running right now" surfaced in the UI.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('azure_auth_providers', (t) => {
    t.increments('id').primary();
    t.string('name').notNullable();
    t.string('tenant_id').notNullable();
    t.string('client_id').notNullable();
    t.text('client_secret_enc').notNullable();
    t.text('cookie_secret').notNullable();
    t.jsonb('allowed_emails').nullable();
    t.jsonb('allowed_groups').nullable();
    t.string('container_name').nullable();
    t.string('container_status').nullable();
    t.text('last_error').nullable();
    t.timestamps(true, true);
  });
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.integer('azure_auth_provider_id').references('id').inTable('azure_auth_providers').onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.dropColumn('azure_auth_provider_id');
  });
  await knex.schema.dropTable('azure_auth_providers');
}
