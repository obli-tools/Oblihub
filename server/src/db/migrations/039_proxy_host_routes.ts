import type { Knex } from 'knex';

/**
 * Per-proxy_host sub-routes. Each row defines a `location` block that nginx emits BEFORE the
 * host's `location /` — matched by URI prefix specificity descending. Lets an operator
 * cherry-pick paths (`/api/`, `/webhooks/`, ...) to send elsewhere, exempt from forward-auth,
 * exempt from access lists, or rewrite the target path.
 *
 * Auth / access-list modes:
 *   - 'inherit' : the route reuses the host-level provider/list (nothing extra emitted)
 *   - 'none'    : forces `auth_request off;` / `satisfy off` for this location — public passthrough
 *   - 'override': the route swaps in its OWN provider / lists (override_id columns populated)
 *
 * `path_rewrite` is optional. Empty → nginx pass-through, URI preserved. Non-empty → we emit
 * `proxy_pass <upstream><path_rewrite>;` (trailing-slash trick) so nginx strips `path_in` from
 * the request URI and prefixes `path_rewrite` before forwarding.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('proxy_host_routes', (t) => {
    t.increments('id').primary();
    t.integer('proxy_host_id').notNullable().references('id').inTable('proxy_hosts').onDelete('CASCADE');
    // Ordering for the UI — nginx match is by prefix specificity, not this. Kept purely so the
    // list stays stable in the editor between reloads.
    t.integer('sort_order').notNullable().defaultTo(0);
    // URI prefix. Should include a trailing slash for typical prefix matches (`/api/`).
    t.string('path_in').notNullable();
    // Optional target prefix rewrite. NULL / empty = passthrough (URI preserved).
    t.string('path_rewrite').nullable();
    // Forward target — same shape as proxy_hosts.forward_*. Every route MUST have its own target;
    // "inherit host" is modeled by pre-filling the form with host values, not by NULL columns.
    // Simpler than layering another optional-inheritance rule on top of the auth/AL ones.
    t.string('forward_scheme').notNullable().defaultTo('http');
    t.string('forward_host').notNullable();
    t.integer('forward_port').notNullable();
    // Auth mode. See file header.
    t.enu('auth_mode', ['inherit', 'none', 'override']).notNullable().defaultTo('inherit');
    t.integer('azure_auth_provider_override_id').nullable().references('id').inTable('azure_auth_providers').onDelete('SET NULL');
    // Access list mode. See file header.
    t.enu('access_list_mode', ['inherit', 'none', 'override']).notNullable().defaultTo('inherit');
    // JSON array of access_list ids when mode='override'.
    t.jsonb('access_list_override_ids').nullable();
    // Per-route protocol / behavior overrides — null = fall back to host-level.
    t.boolean('websocket_support').nullable();
    t.boolean('proxy_buffering').nullable();
    t.timestamps(true, true);
    t.index('proxy_host_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('proxy_host_routes');
}
