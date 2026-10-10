import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('notification_channels', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('type', 30).notNullable();
    t.jsonb('config').notNullable();
    t.boolean('is_enabled').notNullable().defaultTo(true);
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('notification_bindings', (t) => {
    t.increments('id').primary();
    t.integer('channel_id').notNullable().references('id').inTable('notification_channels').onDelete('CASCADE');
    t.string('scope', 20).notNullable().defaultTo('global');
    t.integer('scope_id').nullable();
    t.string('override_mode', 10).notNullable().defaultTo('merge');
    t.unique(['channel_id', 'scope', 'scope_id']);
  });

  await knex.schema.createTable('app_config', (t) => {
    t.string('key', 255).primary();
    t.text('value').nullable();
  });

  await knex.schema.createTable('sso_foreign_users', (t) => {
    t.increments('id').primary();
    t.string('foreign_source', 50).notNullable();
    t.integer('foreign_user_id').notNullable();
    t.integer('local_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.unique(['foreign_source', 'foreign_user_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('sso_foreign_users');
  await knex.schema.dropTableIfExists('app_config');
  await knex.schema.dropTableIfExists('notification_bindings');
  await knex.schema.dropTableIfExists('notification_channels');
}
