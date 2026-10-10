import type { Knex } from 'knex';

/**
 * Multi-engine scoping for managed_stacks.name uniqueness.
 *
 * Migration 004 created `managed_stacks.name` with a global UNIQUE constraint, before multi-engine
 * support existed. After 023 added `engine_id`, the same stack name should be allowed on different
 * engines (e.g. one "petit-studio" on the Local engine and another on a remote Unraid engine).
 *
 * This migration drops the global unique index and replaces it with a composite (engine_id, name)
 * unique constraint. Rows where engine_id is NULL are treated as belonging to the default engine
 * for the purpose of the constraint — but the backfill in 023 already set them to id=1, so in
 * practice no NULL engine_ids exist.
 */

const TABLE = 'managed_stacks';
const OLD_INDEX_NAME = 'managed_stacks_name_unique';
const NEW_INDEX_NAME = 'managed_stacks_engine_name_unique';

export async function up(knex: Knex): Promise<void> {
  // Drop the old single-column unique. The default index name Knex generated is
  // managed_stacks_name_unique — same as the constraint name surfaced in the error.
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropUnique(['name'], OLD_INDEX_NAME);
  });
  await knex.schema.alterTable(TABLE, (t) => {
    t.unique(['engine_id', 'name'], { indexName: NEW_INDEX_NAME });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropUnique(['engine_id', 'name'], NEW_INDEX_NAME);
  });
  await knex.schema.alterTable(TABLE, (t) => {
    t.unique(['name'], { indexName: OLD_INDEX_NAME });
  });
}
