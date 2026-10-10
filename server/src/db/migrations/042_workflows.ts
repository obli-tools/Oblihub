import type { Knex } from 'knex';

/**
 * Extensible automation. One row = one workflow: (trigger) → (action). The action_type +
 * trigger_type discriminants pick which sub-schema of action_config / trigger_config is expected
 * — validated at the service layer, not by the DB. Cheap to add new action / trigger types
 * without a migration each time.
 *
 * Action types (v1):
 *   - ssl-export-sftp: on trigger, take a certificate + its key, push both files to a
 *     workflow_target using its ssh_key. Config: `{ certificate_id: number, target_id: number,
 *     also_export_chain?: boolean }`.
 *   - restart-stacks: on trigger, restart the compose stacks matching a scope. Config: `{
 *     scope: 'stack' | 'team' | 'all', stack_id?: number, team_id?: number }`.
 *
 * Trigger types (v1):
 *   - on-cert-renew: fires when a specific certificate finishes a successful renewal. Config:
 *     `{ certificate_id: number }`. Wired via a hook in certificate.service.ts.
 *   - schedule-interval: fires every N seconds. Config: `{ interval_seconds: number }`.
 *   - schedule-cron: fires on a cron expression. Config: `{ cron: string, timezone?: string }`.
 *   - on-demand: never fires automatically — only the "Run now" button. No config.
 *
 * Concurrency: skip + warn log if a previous run is still active. `last_run_id` points at the
 * most recent workflow_runs row for quick UI display.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('workflows', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.text('description').nullable();
    // Ownership — same tri-state as ssh_keys / workflow_targets.
    t.integer('team_id').nullable().references('id').inTable('teams').onDelete('CASCADE');
    t.integer('owner_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    // Action
    t.string('action_type', 64).notNullable();
    t.jsonb('action_config').notNullable().defaultTo('{}');
    // Trigger
    t.string('trigger_type', 64).notNullable();
    t.jsonb('trigger_config').notNullable().defaultTo('{}');
    // Runtime state
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamp('last_fired_at').nullable();
    t.timestamp('next_fire_at').nullable();
    t.integer('last_run_id').nullable(); // FK added post-hoc after workflow_runs table exists
    t.integer('created_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index('team_id');
    t.index('owner_user_id');
    t.index('trigger_type');
    t.index('enabled');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('workflows');
}
