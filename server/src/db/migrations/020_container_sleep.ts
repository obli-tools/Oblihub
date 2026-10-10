import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('containers', (t) => {
    t.boolean('sleep_enabled').notNullable().defaultTo(false);
    t.integer('sleep_after_seconds').notNullable().defaultTo(1800); // 30 min
    t.string('sleep_mode', 10).notNullable().defaultTo('stop'); // 'stop' | 'pause'
    t.timestamp('last_active_at').nullable();
    t.string('sleep_state', 16).notNullable().defaultTo('awake'); // awake|sleeping|waking|wake_failed
    t.timestamp('wake_started_at').nullable();
    // Wake readiness check: optional HTTP path (e.g. '/health'). If null, TCP probe on container's first port.
    t.string('wake_health_path', 255).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('containers', (t) => {
    t.dropColumn('sleep_enabled');
    t.dropColumn('sleep_after_seconds');
    t.dropColumn('sleep_mode');
    t.dropColumn('last_active_at');
    t.dropColumn('sleep_state');
    t.dropColumn('wake_started_at');
    t.dropColumn('wake_health_path');
  });
}
