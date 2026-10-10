import type { Knex } from 'knex';

/**
 * Multi-container wake for a single proxy host.
 *
 * `wake_container_id` (added in 021) stays as the *primary* — it's the container the proxy_host
 * actually forwards to, so its readiness governs when the waking page redirects. This migration
 * adds an optional array of *extra* containers that should also be woken in parallel, e.g. when
 * a front-end on this proxy_host depends on a backend container hosted under a different
 * compose service or even a different stack.
 *
 * Stored as JSON to keep the schema flat and avoid a junction table for what is, in practice,
 * a short list (typically 1-3 entries) — same pattern as default_notification_channel_ids in
 * app_config.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.jsonb('wake_extra_container_ids').notNullable().defaultTo(JSON.stringify([]));
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.dropColumn('wake_extra_container_ids');
  });
}
