import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // SSL certificates
  await knex.schema.createTable('certificates', (t) => {
    t.increments('id').primary();
    t.jsonb('domain_names').notNullable(); // ["example.com"]
    t.string('provider', 20).notNullable().defaultTo('letsencrypt'); // letsencrypt, custom, selfsigned
    t.text('certificate_path').nullable();
    t.text('key_path').nullable();
    t.text('chain_path').nullable();
    t.timestamp('expires_at').nullable();
    t.string('status', 20).notNullable().defaultTo('pending'); // pending, valid, expired, error
    t.text('error_message').nullable();
    t.string('acme_email', 255).nullable();
    t.timestamps(true, true);
  });

  // Access control lists
  await knex.schema.createTable('access_lists', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.boolean('satisfy_any').notNullable().defaultTo(false);
    t.boolean('pass_auth').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('access_list_auth', (t) => {
    t.increments('id').primary();
    t.integer('access_list_id').notNullable().references('id').inTable('access_lists').onDelete('CASCADE');
    t.string('username', 255).notNullable();
    t.string('password_hash', 255).notNullable();
  });

  await knex.schema.createTable('access_list_clients', (t) => {
    t.increments('id').primary();
    t.integer('access_list_id').notNullable().references('id').inTable('access_lists').onDelete('CASCADE');
    t.string('address', 255).notNullable(); // IP or CIDR
    t.string('directive', 10).notNullable().defaultTo('allow'); // allow, deny
  });

  // Proxy hosts
  await knex.schema.createTable('proxy_hosts', (t) => {
    t.increments('id').primary();
    t.jsonb('domain_names').notNullable(); // ["example.com", "www.example.com"]
    t.string('forward_scheme', 10).notNullable().defaultTo('http');
    t.string('forward_host', 255).notNullable();
    t.integer('forward_port').notNullable().defaultTo(80);
    t.integer('certificate_id').nullable().references('id').inTable('certificates').onDelete('SET NULL');
    t.boolean('ssl_forced').notNullable().defaultTo(false);
    t.boolean('http2_support').notNullable().defaultTo(false);
    t.boolean('hsts_enabled').notNullable().defaultTo(false);
    t.boolean('hsts_subdomains').notNullable().defaultTo(false);
    t.boolean('block_exploits').notNullable().defaultTo(false);
    t.boolean('caching_enabled').notNullable().defaultTo(false);
    t.boolean('websocket_support').notNullable().defaultTo(false);
    t.integer('access_list_id').nullable().references('id').inTable('access_lists').onDelete('SET NULL');
    t.text('advanced_config').nullable(); // custom nginx directives
    t.boolean('enabled').notNullable().defaultTo(true);
    t.integer('stack_id').nullable().references('id').inTable('stacks').onDelete('SET NULL'); // link to managed stack
    t.timestamps(true, true);
  });

  // Redirection hosts
  await knex.schema.createTable('redirection_hosts', (t) => {
    t.increments('id').primary();
    t.jsonb('domain_names').notNullable();
    t.string('forward_scheme', 10).notNullable().defaultTo('https');
    t.string('forward_domain', 255).notNullable();
    t.string('forward_path', 255).notNullable().defaultTo('/');
    t.boolean('preserve_path').notNullable().defaultTo(true);
    t.integer('certificate_id').nullable().references('id').inTable('certificates').onDelete('SET NULL');
    t.boolean('ssl_forced').notNullable().defaultTo(false);
    t.boolean('http2_support').notNullable().defaultTo(false);
    t.boolean('hsts_enabled').notNullable().defaultTo(false);
    t.boolean('block_exploits').notNullable().defaultTo(false);
    t.text('advanced_config').nullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });

  // TCP/UDP streams
  await knex.schema.createTable('streams', (t) => {
    t.increments('id').primary();
    t.integer('incoming_port').notNullable();
    t.string('forwarding_host', 255).notNullable();
    t.integer('forwarding_port').notNullable();
    t.boolean('tcp_forwarding').notNullable().defaultTo(true);
    t.boolean('udp_forwarding').notNullable().defaultTo(false);
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });

  // 404 hosts
  await knex.schema.createTable('dead_hosts', (t) => {
    t.increments('id').primary();
    t.jsonb('domain_names').notNullable();
    t.integer('certificate_id').nullable().references('id').inTable('certificates').onDelete('SET NULL');
    t.boolean('ssl_forced').notNullable().defaultTo(false);
    t.boolean('http2_support').notNullable().defaultTo(false);
    t.boolean('hsts_enabled').notNullable().defaultTo(false);
    t.text('advanced_config').nullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });

  // Custom error pages
  await knex.schema.createTable('proxy_settings', (t) => {
    t.string('key', 255).primary();
    t.text('value').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('proxy_settings');
  await knex.schema.dropTableIfExists('dead_hosts');
  await knex.schema.dropTableIfExists('streams');
  await knex.schema.dropTableIfExists('redirection_hosts');
  await knex.schema.dropTableIfExists('proxy_hosts');
  await knex.schema.dropTableIfExists('access_list_clients');
  await knex.schema.dropTableIfExists('access_list_auth');
  await knex.schema.dropTableIfExists('access_lists');
  await knex.schema.dropTableIfExists('certificates');
}
