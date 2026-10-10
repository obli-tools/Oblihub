import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('managed_stacks', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable().unique();
    t.text('compose_content').notNullable();
    t.text('env_content').nullable();
    t.string('status', 30).notNullable().defaultTo('draft');
    t.string('compose_project', 128).notNullable();
    t.text('error_message').nullable();
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('managed_stacks');
}
