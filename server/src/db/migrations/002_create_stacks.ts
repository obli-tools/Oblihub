import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('stacks', (t) => {
    t.increments('id').primary();
    t.string('name', 255).notNullable();
    t.string('compose_project', 255).nullable().unique();
    t.integer('check_interval').notNullable().defaultTo(60);
    t.boolean('auto_update').notNullable().defaultTo(false);
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamp('last_checked_at').nullable();
    t.timestamp('last_updated_at').nullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('containers', (t) => {
    t.increments('id').primary();
    t.integer('stack_id').nullable().references('id').inTable('stacks').onDelete('SET NULL');
    t.string('docker_id', 128).notNullable().unique();
    t.string('container_name', 255).notNullable();
    t.string('image', 512).notNullable();
    t.string('image_tag', 255).notNullable().defaultTo('latest');
    t.string('current_digest', 128).nullable();
    t.string('latest_digest', 128).nullable();
    t.string('status', 30).notNullable().defaultTo('unknown');
    t.text('error_message').nullable();
    t.boolean('excluded').notNullable().defaultTo(false);
    t.jsonb('container_config').nullable();
    t.timestamp('last_checked_at').nullable();
    t.timestamp('last_updated_at').nullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('update_history', (t) => {
    t.increments('id').primary();
    t.integer('stack_id').nullable().references('id').inTable('stacks').onDelete('SET NULL');
    t.integer('container_id').nullable().references('id').inTable('containers').onDelete('SET NULL');
    t.string('container_name', 255).notNullable();
    t.string('image', 512).notNullable();
    t.string('old_digest', 128).nullable();
    t.string('new_digest', 128).nullable();
    t.string('status', 20).notNullable().defaultTo('pending');
    t.text('error_message').nullable();
    t.string('triggered_by', 20).notNullable().defaultTo('auto');
    t.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('completed_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('update_history');
  await knex.schema.dropTableIfExists('containers');
  await knex.schema.dropTableIfExists('stacks');
}
