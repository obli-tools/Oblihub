import type { Knex } from 'knex';

/**
 * Indexes for the hourly retention purges (workers/RetentionWorker.ts).
 *
 * - ip_geo_cache(looked_up_at): rows older than 30 days are deleted.
 * - update_history(started_at): rows older than 365 days are deleted.
 *
 * managed_stack_deploy_history is already covered by msdh_stack_time_idx
 * (managed_stack_id, deployed_at) from migration 035.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE INDEX IF NOT EXISTS ip_geo_cache_looked_up_at_idx ON ip_geo_cache (looked_up_at)');
  await knex.raw('CREATE INDEX IF NOT EXISTS update_history_started_at_idx ON update_history (started_at)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS update_history_started_at_idx');
  await knex.raw('DROP INDEX IF EXISTS ip_geo_cache_looked_up_at_idx');
}
