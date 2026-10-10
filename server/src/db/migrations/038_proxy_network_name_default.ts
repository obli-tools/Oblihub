import type { Knex } from 'knex';

/**
 * Persist the shared proxy network name as a configurable app-level setting. Historically
 * Oblihub hardcoded "proxy" everywhere, which broke deployments where docker-compose prefixes
 * the network with the project name (e.g. `oblihub_proxy`) — the nginx proxy container ended
 * up on `oblihub_proxy` while the Azure auth sidecar was created on a freshly-made `proxy`
 * network, and the two couldn't talk. Making the name configurable lets the operator align
 * the sidecar / auto-created network with whatever the compose project actually produced.
 */
export async function up(knex: Knex): Promise<void> {
  // Default to "proxy" — the historical value, so nothing changes for existing installs whose
  // network really IS called `proxy`. Operators with the compose-prefix flavour edit this in
  // Settings.
  await knex('app_config')
    .insert({ key: 'proxy_network_name', value: 'proxy' })
    .onConflict('key')
    .ignore();
}

export async function down(knex: Knex): Promise<void> {
  await knex('app_config').where({ key: 'proxy_network_name' }).delete();
}
