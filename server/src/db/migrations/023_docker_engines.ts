import type { Knex } from 'knex';

/**
 * Multi-engine support.
 *
 * Adds the `docker_engines` table and the `engine_id` FK on containers / stacks / proxy_hosts.
 *
 * A single built-in "Local" engine is seeded (id=1) pointing at the host's docker socket — every
 * pre-existing container/stack/proxy_host is migrated to reference it, so existing single-host
 * installs keep working with zero config.
 *
 * Credentials (SSH private keys, API keys, TLS keys) are stored as ciphertext blobs — encrypted
 * by engine.service using AES-256-GCM with a key derived from SESSION_SECRET (or
 * OBLIHUB_ENCRYPTION_KEY if set). The migration only allocates the columns — encryption is
 * applied at insert/update time, never at the DB layer.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('docker_engines', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    // 'local' | 'ssh' | 'https-apikey' | 'tls'
    t.string('type', 20).notNullable();
    // Host + port (unused for 'local')
    t.string('host', 255).nullable();
    t.integer('port').nullable();
    // SSH-specific
    t.string('ssh_user', 64).nullable();
    t.text('ssh_private_key_enc').nullable(); // encrypted
    t.text('ssh_known_host').nullable(); // optional host key pin (single line)
    // HTTPS API-key specific (socket-proxy pattern)
    t.text('api_key_enc').nullable(); // encrypted
    t.string('api_key_header', 64).nullable().defaultTo('X-API-Key');
    // TLS mTLS specific
    t.text('tls_ca').nullable();
    t.text('tls_cert').nullable();
    t.text('tls_key_enc').nullable(); // encrypted
    // Status
    t.boolean('is_default').notNullable().defaultTo(false);
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamp('last_ping_at').nullable();
    t.string('last_ping_status', 16).nullable(); // 'ok' | 'error'
    t.text('last_ping_message').nullable();
    t.timestamps(true, true);
  });

  // Seed the default "Local" engine. Pre-existing containers/stacks/proxy_hosts attach to it.
  const [{ id: localEngineId }] = await knex('docker_engines').insert({
    name: 'Local',
    type: 'local',
    is_default: true,
    enabled: true,
  }).returning('id') as Array<{ id: number }>;

  // Add engine_id FK columns (default to the Local engine for existing rows)
  await knex.schema.alterTable('containers', (t) => {
    t.integer('engine_id').nullable().references('id').inTable('docker_engines').onDelete('SET NULL');
  });
  await knex.schema.alterTable('stacks', (t) => {
    t.integer('engine_id').nullable().references('id').inTable('docker_engines').onDelete('SET NULL');
  });
  await knex.schema.alterTable('proxy_hosts', (t) => {
    // Used by the wake routes to resolve which daemon hosts wake_container_id.
    // For local-only proxy hosts this stays null.
    t.integer('engine_id').nullable().references('id').inTable('docker_engines').onDelete('SET NULL');
  });
  await knex.schema.alterTable('managed_stacks', (t) => {
    t.integer('engine_id').nullable().references('id').inTable('docker_engines').onDelete('SET NULL');
  });

  // Backfill existing rows to the Local engine
  await knex('containers').whereNull('engine_id').update({ engine_id: localEngineId });
  await knex('stacks').whereNull('engine_id').update({ engine_id: localEngineId });
  await knex('managed_stacks').whereNull('engine_id').update({ engine_id: localEngineId });
  // proxy_hosts are intentionally left NULL by default — engine_id is only meaningful when
  // wake_container_id is set, and that's a per-host opt-in.
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => { t.dropColumn('engine_id'); });
  await knex.schema.alterTable('managed_stacks', (t) => { t.dropColumn('engine_id'); });
  await knex.schema.alterTable('stacks', (t) => { t.dropColumn('engine_id'); });
  await knex.schema.alterTable('containers', (t) => { t.dropColumn('engine_id'); });
  await knex.schema.dropTableIfExists('docker_engines');
}
