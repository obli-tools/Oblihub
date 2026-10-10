import type { Knex } from 'knex';

/**
 * Maintenance windows for automatic updates.
 *
 * - stacks.maintenance_window (jsonb, null = inherit the global setting): { mode: 'always' } or
 *   { mode: 'custom', window: { start: 'HH:MM', end: 'HH:MM', days?: number[] } }.
 * - The global setting lives in app_config `maintenance_window` (JSON): { enabled, window, timezone }.
 *   Absent = off, as before: updates run at any time.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('stacks', 'maintenance_window');
  if (!has) {
    await knex.schema.alterTable('stacks', (t) => {
      t.jsonb('maintenance_window').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('stacks', 'maintenance_window');
  if (has) {
    await knex.schema.alterTable('stacks', (t) => {
      t.dropColumn('maintenance_window');
    });
  }
}
