import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('username', 64).notNullable().unique();
    t.string('password_hash', 255).nullable();
    t.string('display_name', 128).nullable();
    t.string('role', 16).notNullable().defaultTo('user');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.string('email', 255).nullable();
    t.string('preferred_language', 10).defaultTo('en');
    t.string('foreign_source', 50).nullable();
    t.integer('foreign_id').nullable();
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('users');
}
