import type { Knex } from 'knex';

/**
 * `stacks.compose_project` was UNIQUE globally, but a compose project name is only unique
 * WITHIN a Docker engine. Two engines legitimately can (and do) run the same project name
 * — a fleet of nodes each hosting their own `ldm-otaku-nest`, for example.
 *
 * Symptom before the fix: syncWithDocker picks up a container on engine=1, looks up
 * `(compose_project, engine_id=1)`, doesn't find the pre-created row that was written with
 * `engine_id=null` (non-admin create flow forgot to propagate the engine_id), tries to
 * INSERT, hits the global UNIQUE constraint, and the whole discovery pass dies. Container
 * is orphaned from Oblihub's POV until manual intervention.
 */
export async function up(knex: Knex): Promise<void> {
  // Postgres constraint name is generated deterministically as <table>_<col>_unique. Drop by
  // that name; the column itself is not touched.
  await knex.schema.alterTable('stacks', (t) => {
    t.dropUnique(['compose_project'], 'stacks_compose_project_unique');
  });
  await knex.schema.alterTable('stacks', (t) => {
    t.unique(['compose_project', 'engine_id'], { indexName: 'stacks_compose_project_engine_unique' });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('stacks', (t) => {
    t.dropUnique(['compose_project', 'engine_id'], 'stacks_compose_project_engine_unique');
  });
  await knex.schema.alterTable('stacks', (t) => {
    t.unique(['compose_project'], { indexName: 'stacks_compose_project_unique' });
  });
}
