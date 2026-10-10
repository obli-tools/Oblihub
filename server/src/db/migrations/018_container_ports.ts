import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('containers', (t) => {
    t.jsonb('ports').notNullable().defaultTo('[]');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('containers', (t) => {
    t.dropColumn('ports');
  });
}
