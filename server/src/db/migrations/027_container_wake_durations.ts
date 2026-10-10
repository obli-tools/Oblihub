import type { Knex } from 'knex';

/**
 * Wake-time learning: store the last N wake durations per container so the waking page can
 * render a progress bar based on actual past performance rather than a hardcoded estimate.
 *
 * Stored as a JSONB array of milliseconds. We keep at most 10 entries (FIFO, oldest dropped)
 * to bound the size and let recent runtime characteristics dominate the average — a model
 * reload that used to take 60s but now takes 20s after a host upgrade should reflect quickly.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('containers', (t) => {
    t.jsonb('wake_durations_ms').notNullable().defaultTo(JSON.stringify([]));
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('containers', (t) => {
    t.dropColumn('wake_durations_ms');
  });
}
