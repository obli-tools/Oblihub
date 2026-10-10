import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add auto-monitor flag to proxy hosts
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.boolean('auto_monitor').notNullable().defaultTo(false);
  });

  // Add notification_channel_id to uptime_monitors
  await knex.schema.alterTable('uptime_monitors', (t) => {
    t.integer('notification_channel_id').nullable().references('id').inTable('notification_channels').onDelete('SET NULL');
  });

  // Seed global settings defaults
  await knex('app_config').insert([
    { key: 'default_error_page_id', value: null },
    { key: 'default_notification_channel_ids', value: '[]' },
  ]).onConflict('key').ignore();
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => { t.dropColumn('auto_monitor'); });
  await knex.schema.alterTable('uptime_monitors', (t) => { t.dropColumn('notification_channel_id'); });
  await knex('app_config').whereIn('key', ['default_error_page_id', 'default_notification_channel_ids']).delete();
}
