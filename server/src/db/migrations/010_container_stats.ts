import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('container_stats', (t) => {
    t.bigIncrements('id').primary();
    t.string('container_docker_id', 12).notNullable().index();
    t.string('container_name', 255).notNullable();
    t.float('cpu_percent').notNullable();
    t.bigInteger('memory_usage').notNullable();
    t.bigInteger('memory_limit').notNullable();
    t.bigInteger('network_rx').notNullable().defaultTo(0);
    t.bigInteger('network_tx').notNullable().defaultTo(0);
    t.timestamp('timestamp').notNullable().defaultTo(knex.fn.now()).index();
  });

  await knex.schema.createTable('resource_alerts', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('metric', 20).notNullable(); // cpu, memory
    t.float('threshold').notNullable(); // percentage
    t.string('operator', 5).notNullable().defaultTo('gt'); // gt, lt
    t.integer('stack_id').nullable().references('id').inTable('stacks').onDelete('CASCADE');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.integer('cooldown_minutes').notNullable().defaultTo(60);
    t.timestamp('last_triggered_at').nullable();
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('resource_alerts');
  await knex.schema.dropTableIfExists('container_stats');
}
