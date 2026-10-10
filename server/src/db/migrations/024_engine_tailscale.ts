import type { Knex } from 'knex';

/**
 * Tailscale identity for remote engines.
 *
 * tailscale_hostname  — MagicDNS name of the remote host on the operator's Tailnet
 *                       (e.g. "unraid.tail-abcd12.ts.net"). When set, proxy_hosts
 *                       targeting containers on this engine use this for upstream
 *                       resolution instead of the public `host` field.
 *
 * tailscale_advertised_routes  — comma-separated CIDR list that this engine's
 *                       Tailscale node advertises (typically the Docker bridge
 *                       subnets, e.g. "172.17.0.0/16,172.18.0.0/16"). When set,
 *                       the nginx proxy can target container bridge IPs directly
 *                       — no published port needed.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('docker_engines', (t) => {
    t.string('tailscale_hostname', 255).nullable();
    t.text('tailscale_advertised_routes').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('docker_engines', (t) => {
    t.dropColumn('tailscale_advertised_routes');
    t.dropColumn('tailscale_hostname');
  });
}
