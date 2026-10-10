import type { Knex } from 'knex';

/**
 * History of workflow executions. One row per fire. Retention policy applied by the runs-purge
 * worker: keep the last 100 runs per workflow OR anything within the last 30 days (whichever
 * set is larger). Anything falling outside both windows is deleted on the hourly sweep.
 *
 * `output_log` is a jsonb array of `{ ts, level, message }` for step-by-step traceability. Not
 * a text blob so we can filter / display structured, but bounded — we cap at ~200 lines per run
 * to keep row size sane.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('workflow_runs', (t) => {
    t.increments('id').primary();
    t.integer('workflow_id').notNullable().references('id').inTable('workflows').onDelete('CASCADE');
    t.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('finished_at').nullable();
    t.enu('status', ['running', 'success', 'failed', 'skipped']).notNullable().defaultTo('running');
    t.enu('trigger_source', ['scheduler', 'on-demand', 'on-cert-renew', 'external']).notNullable().defaultTo('scheduler');
    t.jsonb('output_log').notNullable().defaultTo('[]');
    t.text('error_message').nullable();
    t.integer('duration_ms').nullable();
    t.index(['workflow_id', 'started_at']);
  });

  // Now that workflow_runs exists we can wire the last_run_id FK on workflows. Kept as a
  // separate ALTER because migration 042 needs to run first (chicken-and-egg on the reference).
  await knex.schema.alterTable('workflows', (t) => {
    t.foreign('last_run_id').references('id').inTable('workflow_runs').onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('workflows', (t) => {
    t.dropForeign(['last_run_id']);
  });
  await knex.schema.dropTableIfExists('workflow_runs');
}
