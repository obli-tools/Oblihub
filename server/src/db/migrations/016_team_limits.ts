import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('teams', (t) => {
    t.integer('max_stacks').nullable(); // null = unlimited
    t.integer('max_containers').nullable();
    t.integer('max_certificates').nullable();
    t.integer('max_proxy_hosts').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('teams', (t) => {
    t.dropColumn('max_stacks');
    t.dropColumn('max_containers');
    t.dropColumn('max_certificates');
    t.dropColumn('max_proxy_hosts');
  });
}
