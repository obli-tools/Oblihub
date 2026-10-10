import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Teams
  await knex.schema.createTable('teams', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable().unique();
    t.text('description').nullable();
    t.boolean('all_resources').notNullable().defaultTo(false); // "Tout" = future stacks auto-added
    t.timestamps(true, true);
  });

  // Team members
  await knex.schema.createTable('team_members', (t) => {
    t.increments('id').primary();
    t.integer('team_id').notNullable().references('id').inTable('teams').onDelete('CASCADE');
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.unique(['team_id', 'user_id']);
  });

  // Team resource assignments (stack or container level)
  await knex.schema.createTable('team_resources', (t) => {
    t.increments('id').primary();
    t.integer('team_id').notNullable().references('id').inTable('teams').onDelete('CASCADE');
    t.string('resource_type', 20).notNullable(); // 'stack' or 'container'
    t.integer('resource_id').notNullable(); // stack.id or container.id
    t.boolean('excluded').notNullable().defaultTo(false); // for deselecting individual containers within a selected stack
    t.unique(['team_id', 'resource_type', 'resource_id']);
  });

  // Link stacks to teams for ownership (when user creates a stack, assigns to team)
  await knex.schema.alterTable('stacks', (t) => {
    t.integer('team_id').nullable().references('id').inTable('teams').onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('stacks', (t) => { t.dropColumn('team_id'); });
  await knex.schema.dropTableIfExists('team_resources');
  await knex.schema.dropTableIfExists('team_members');
  await knex.schema.dropTableIfExists('teams');
}
