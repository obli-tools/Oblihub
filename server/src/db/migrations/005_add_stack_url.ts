import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('stacks', (t) => {
    t.string('url', 500).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('stacks', (t) => {
    t.dropColumn('url');
  });
}
