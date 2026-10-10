import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('stacks', (t) => {
    // null = use global config, true/false = override
    t.boolean('notify_update_available').nullable();
    t.boolean('notify_update_applied').nullable();
    t.integer('notify_delay').nullable(); // seconds, null = use global
  });

  // Seed global defaults
  await knex('app_config').insert([
    { key: 'notify_update_available', value: 'true' },
    { key: 'notify_update_applied', value: 'true' },
    { key: 'notify_delay', value: '300' },
  ]).onConflict('key').ignore();
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('stacks', (t) => {
    t.dropColumn('notify_update_available');
    t.dropColumn('notify_update_applied');
    t.dropColumn('notify_delay');
  });
  await knex('app_config').whereIn('key', ['notify_update_available', 'notify_update_applied', 'notify_delay']).delete();
}
