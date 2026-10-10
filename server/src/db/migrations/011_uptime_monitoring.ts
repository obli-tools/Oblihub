import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('uptime_monitors', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('url', 500).notNullable();
    t.string('type', 20).notNullable().defaultTo('http'); // http, tcp, keyword
    t.integer('interval_seconds').notNullable().defaultTo(60);
    t.integer('timeout_ms').notNullable().defaultTo(5000);
    t.integer('expected_status').notNullable().defaultTo(200);
    t.string('keyword', 255).nullable();
    t.integer('proxy_host_id').nullable().references('id').inTable('proxy_hosts').onDelete('SET NULL');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('current_status', 10).notNullable().defaultTo('pending'); // up, down, pending
    t.integer('consecutive_failures').notNullable().defaultTo(0);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('uptime_heartbeats', (t) => {
    t.bigIncrements('id').primary();
    t.integer('monitor_id').notNullable().references('id').inTable('uptime_monitors').onDelete('CASCADE');
    t.string('status', 10).notNullable(); // up, down
    t.integer('response_time_ms').nullable();
    t.integer('status_code').nullable();
    t.string('message', 500).nullable();
    t.timestamp('timestamp').notNullable().defaultTo(knex.fn.now()).index();
  });

  await knex.schema.createTable('status_pages', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('slug', 64).notNullable().unique();
    t.boolean('is_public').notNullable().defaultTo(true);
    t.text('custom_css').nullable();
    t.jsonb('monitor_ids').notNullable().defaultTo('[]');
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('status_pages');
  await knex.schema.dropTableIfExists('uptime_heartbeats');
  await knex.schema.dropTableIfExists('uptime_monitors');
}
