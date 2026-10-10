import type { Knex } from 'knex';

/**
 * Per-stack resource limits + priority tier.
 *
 * jsonb blob on `stacks` — kept as a single column so the whole ResourceLimits struct read/writes
 * atomically and the operator can null it out with one `UPDATE ... SET resource_limits = NULL` to
 * clear all caps. Absolute cpu/ram values are recomputed from percentages at override-write time
 * so the same limits.json survives migrating between hosts with different core counts / RAM.
 *
 * Populated by the /api/stacks/:id/resources endpoint. NULL means "no override" — the stack runs
 * against its plain docker-compose.yml with no override file present.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('stacks', (t) => {
    t.jsonb('resource_limits').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('stacks', (t) => {
    t.dropColumn('resource_limits');
  });
}
