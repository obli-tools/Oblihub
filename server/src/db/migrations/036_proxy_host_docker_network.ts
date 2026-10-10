import type { Knex } from 'knex';

/**
 * Per-proxy_host Docker network name.
 *
 * Historically the override generator hardcoded the target network as `proxy` — Oblihub's own
 * built-in nginx reverse proxy runs on a shared network by that name. But operators who front
 * their apps with an EXTERNAL reverse proxy (Nginx Proxy Manager on `nginx-proxy-manager_default`,
 * Traefik on `traefik_default`, Caddy on a custom bridge, whatever) still want to use
 * Oblihub's proxy_host as a metadata + auto-network-wiring layer — but the override was
 * attaching the service to the wrong network, so every rebuild silently lost the attach.
 *
 * Nullable + default null → the codepath interprets null as `proxy` (backward-compat). Any
 * proxy_host pointing at an external reverse proxy gets its network name set explicitly.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.string('docker_network').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.dropColumn('docker_network');
  });
}
