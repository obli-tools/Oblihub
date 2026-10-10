import type { Knex } from 'knex';

/**
 * Honeypot + centralized IP ban system.
 *
 * Model:
 *   - banned_ips: one row per banned IP. `banned_until` NULL = permanent. Row is shared across
 *     ALL proxy_hosts (default scope = global) — a scanner caught on host A is banned on hosts
 *     B, C, D by construction (nginx map lookup). Local per-host overrides are opt-in later.
 *   - honeypot_paths: per-host list of URI patterns whose access triggers an auto-ban. Simple
 *     path match (nginx `location <path>`), not regex.
 *   - proxy_hosts columns: honeypot_enabled (master switch), honeypot_ban_acl_violations
 *     (extends the ban to any IP that fails an access-list check), honeypot_ban_duration_seconds
 *     (per-host override; falls back to app_config default).
 *   - app_config keys: obliguard_url + obliguard_api_key (server-to-server notify), and
 *     default_honeypot_paths (jsonb array preset used when the operator clicks
 *     "Add common exploit URLs" in the UI).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('banned_ips', (t) => {
    t.increments('id').primary();
    // IPv4 or IPv6, string form. Not a cidr yet — v1 is /32-per-IP, ranges are a follow-up.
    t.string('ip', 45).notNullable();
    // NULL = permanent. Populated by "ban for N seconds" flows; the retention worker only
    // drops rows whose banned_until < now(), permanent rows survive.
    t.timestamp('banned_until').nullable();
    // Human-readable reason surfaced in the /bans UI ("Hit honeypot /wp-login.php on gitea.tld").
    t.string('reason', 512).nullable();
    // How the ban was created — used for stats + filtering.
    t.enu('source_type', ['honeypot-path', 'honeypot-acl', 'manual', 'obliguard-sync']).notNullable();
    // Nullable FK to the proxy_host that first caught the IP. Deleting the host doesn't lift
    // the ban — the IP stays global.
    t.integer('source_proxy_host_id').nullable().references('id').inTable('proxy_hosts').onDelete('SET NULL');
    t.timestamp('first_seen_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_hit_at').notNullable().defaultTo(knex.fn.now());
    t.integer('hit_count').notNullable().defaultTo(1);
    // Once Obliguard confirmed reception (or we gave up), mark this so the sync worker knows
    // not to retry indefinitely.
    t.timestamp('sent_to_obliguard_at').nullable();
    t.string('obliguard_error', 512).nullable();
    // Enforcement toggle — allows manual "soft delete" without dropping the audit trail.
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('banned_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['ip']);
    t.index(['is_active', 'banned_until']);
    t.index(['source_type']);
  });

  await knex.schema.createTable('honeypot_paths', (t) => {
    t.increments('id').primary();
    t.integer('proxy_host_id').notNullable().references('id').inTable('proxy_hosts').onDelete('CASCADE');
    // The URI PREFIX that triggers the ban. E.g. "/wp-login.php", "/.env", "/admin".
    // nginx `location <path>` uses prefix match by default, which is exactly the semantic we
    // want ("/admin" also catches "/admin/login").
    t.string('path', 256).notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamps(true, true);
    t.unique(['proxy_host_id', 'path']);
    t.index(['proxy_host_id']);
  });

  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.boolean('honeypot_enabled').notNullable().defaultTo(false);
    t.boolean('honeypot_ban_acl_violations').notNullable().defaultTo(false);
    // NULL = permanent (matches banned_ips.banned_until semantic). 0 or positive = seconds.
    t.integer('honeypot_ban_duration_seconds').nullable();
  });

  // Seed the operator's "quick-add" preset — a well-known list of scanner targets covering
  // WordPress, PHP admin, CI leakage, cloud metadata, framework endpoints. Roughly matches
  // the top surface of any Shodan crawl. The operator can edit or replace anytime.
  const DEFAULT_HONEYPOT_PATHS = [
    '/admin', '/admin.php', '/administrator',
    '/wp-login.php', '/wp-admin', '/wp-admin/',
    '/phpmyadmin', '/pma', '/mysql', '/dbadmin',
    '/xmlrpc.php',
    '/.env', '/.env.local', '/.env.production',
    '/.git/config', '/.git/HEAD',
    '/.aws/credentials', '/.aws/config',
    '/config.php', '/config.yml', '/config.json',
    '/actuator', '/actuator/env', '/actuator/health',
    '/api/actuator', '/api/v1/actuator',
    '/console', '/manager/html', '/manager/status',
    '/server-status', '/server-info',
    '/vendor/phpunit',
    '/.svn', '/.hg', '/.bzr',
    '/backup', '/backup.zip', '/backup.tar.gz',
    '/telescope', '/horizon',
    '/api/jsonws/invoke', // Liferay
    '/HNAP1', // D-Link
  ];
  await knex('app_config').insert({ key: 'default_honeypot_paths', value: JSON.stringify(DEFAULT_HONEYPOT_PATHS) }).onConflict('key').ignore();
  await knex('app_config').insert({ key: 'obliguard_url', value: '' }).onConflict('key').ignore();
  await knex('app_config').insert({ key: 'obliguard_api_key', value: '' }).onConflict('key').ignore();
  await knex('app_config').insert({ key: 'default_honeypot_ban_duration_seconds', value: '' }).onConflict('key').ignore(); // empty = permanent
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.dropColumn('honeypot_enabled');
    t.dropColumn('honeypot_ban_acl_violations');
    t.dropColumn('honeypot_ban_duration_seconds');
  });
  await knex.schema.dropTableIfExists('honeypot_paths');
  await knex.schema.dropTableIfExists('banned_ips');
  await knex('app_config').whereIn('key', ['default_honeypot_paths', 'obliguard_url', 'obliguard_api_key', 'default_honeypot_ban_duration_seconds']).delete();
}
