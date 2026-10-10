import type { Knex } from 'knex';

/**
 * Granular status-code counters + status_class labels for top-N tables.
 *
 * The dashboard currently only knows counts per status *class* (2xx/3xx/4xx/5xx). Operators
 * hit an unactionable wall on the badge "247 err" — 4xx and 5xx get lumped together, and even
 * once split, they need to know if it's 404 scanners (ignore), 429 rate-limits (tune limits),
 * or 502 upstream failures (page someone). Adding per-code counters answers "which code is
 * spiking" without extra log parses. 9 int columns × 1440 rows/day × 100 hosts stays well
 * under 2M rows for the 1m table, easy in postgres.
 *
 * The `status_class` column on top_ips_1h / top_uris_1h lets us slice the top-N by 4xx/5xx
 * without re-aggregating — critical for "top erroring URIs" widget in the drill-down.
 */

const GRANULAR_CODES = ['401', '403', '404', '429', '499', '500', '502', '503', '504'] as const;

async function addCounterColumns(knex: Knex, table: string): Promise<void> {
  await knex.schema.alterTable(table, (t) => {
    for (const code of GRANULAR_CODES) {
      t.integer(`status_${code}`).notNullable().defaultTo(0);
    }
  });
}

export async function up(knex: Knex): Promise<void> {
  await addCounterColumns(knex, 'proxy_traffic_1m');
  await addCounterColumns(knex, 'proxy_traffic_1h');

  // Top-N tables get a `status_class` discriminator: 'all' | '2xx' | '3xx' | '4xx' | '5xx'.
  // 'all' rows are what the log worker writes today; 'Nxx' rows are populated in parallel so
  // "top erroring URIs" and "top erroring IPs" are cheap point queries instead of full scans.
  await knex.schema.alterTable('proxy_traffic_top_ips_1h', (t) => {
    t.string('status_class', 4).notNullable().defaultTo('all');
    t.dropUnique(['proxy_host_id', 'ts', 'ip']);
    t.unique(['proxy_host_id', 'ts', 'status_class', 'ip']);
    t.index(['proxy_host_id', 'ts', 'status_class']);
  });
  await knex.schema.alterTable('proxy_traffic_top_uris_1h', (t) => {
    t.string('status_class', 4).notNullable().defaultTo('all');
    t.dropUnique(['proxy_host_id', 'ts', 'uri']);
    t.unique(['proxy_host_id', 'ts', 'status_class', 'uri']);
    t.index(['proxy_host_id', 'ts', 'status_class']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_traffic_top_uris_1h', (t) => {
    t.dropUnique(['proxy_host_id', 'ts', 'status_class', 'uri']);
    t.dropIndex(['proxy_host_id', 'ts', 'status_class']);
    t.dropColumn('status_class');
    t.unique(['proxy_host_id', 'ts', 'uri']);
  });
  await knex.schema.alterTable('proxy_traffic_top_ips_1h', (t) => {
    t.dropUnique(['proxy_host_id', 'ts', 'status_class', 'ip']);
    t.dropIndex(['proxy_host_id', 'ts', 'status_class']);
    t.dropColumn('status_class');
    t.unique(['proxy_host_id', 'ts', 'ip']);
  });
  await knex.schema.alterTable('proxy_traffic_1h', (t) => {
    for (const code of GRANULAR_CODES) t.dropColumn(`status_${code}`);
  });
  await knex.schema.alterTable('proxy_traffic_1m', (t) => {
    for (const code of GRANULAR_CODES) t.dropColumn(`status_${code}`);
  });
}
