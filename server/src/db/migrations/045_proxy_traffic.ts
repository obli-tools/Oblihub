import type { Knex } from 'knex';

/**
 * Time-series storage for proxy host traffic. Two buckets:
 *   - proxy_traffic_1m: raw 1-minute aggregates, 7-day retention
 *   - proxy_traffic_1h: 1-hour rollup for anything beyond 7 days, 90-day retention
 *
 * Retention + downsample enforced by a dedicated worker (see workers/TrafficDownsampleWorker).
 * Postgres pure — indexed on (proxy_host_id, ts) descending because every dashboard query is
 * "give me the last N minutes/hours for host X". No TimescaleDB dependency; if a huge install
 * hits perf walls we can adopt it later (schema is compatible: convert to hypertable in-place).
 *
 * ip_geo_cache: MaxMind lookups are cheap but not free — cache by IP with a TTL. Populated by
 * the log aggregator on first sighting, refreshed on stale reads.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('proxy_traffic_1m', (t) => {
    t.increments('id').primary();
    t.integer('proxy_host_id').notNullable().references('id').inTable('proxy_hosts').onDelete('CASCADE');
    t.timestamp('ts').notNullable(); // Start of the 1-minute bucket, always aligned to :00 seconds.
    t.integer('req_count').notNullable().defaultTo(0);
    t.bigInteger('bytes_out').notNullable().defaultTo(0);
    t.bigInteger('bytes_in').notNullable().defaultTo(0);
    t.integer('status_2xx').notNullable().defaultTo(0);
    t.integer('status_3xx').notNullable().defaultTo(0);
    t.integer('status_4xx').notNullable().defaultTo(0);
    t.integer('status_5xx').notNullable().defaultTo(0);
    // Latency stats — sum + count lets us compute avg, and we approximate p95 by remembering the
    // max we've seen. Full percentile buckets would need histograms; skipping for v1 to keep
    // rows tiny (13 int columns per row × 1440 rows/day × 100 hosts = ~1.9M cells, trivial).
    t.integer('latency_ms_sum').notNullable().defaultTo(0);
    t.integer('latency_ms_max').notNullable().defaultTo(0);
    t.integer('unique_ips').notNullable().defaultTo(0); // approx — count of distinct IPs seen in the bucket
    t.unique(['proxy_host_id', 'ts']);
    t.index(['proxy_host_id', 'ts']);
  });

  await knex.schema.createTable('proxy_traffic_1h', (t) => {
    t.increments('id').primary();
    t.integer('proxy_host_id').notNullable().references('id').inTable('proxy_hosts').onDelete('CASCADE');
    t.timestamp('ts').notNullable(); // Aligned to :00:00
    t.integer('req_count').notNullable().defaultTo(0);
    t.bigInteger('bytes_out').notNullable().defaultTo(0);
    t.bigInteger('bytes_in').notNullable().defaultTo(0);
    t.integer('status_2xx').notNullable().defaultTo(0);
    t.integer('status_3xx').notNullable().defaultTo(0);
    t.integer('status_4xx').notNullable().defaultTo(0);
    t.integer('status_5xx').notNullable().defaultTo(0);
    t.integer('latency_ms_sum').notNullable().defaultTo(0);
    t.integer('latency_ms_max').notNullable().defaultTo(0);
    t.integer('unique_ips').notNullable().defaultTo(0);
    t.unique(['proxy_host_id', 'ts']);
    t.index(['proxy_host_id', 'ts']);
  });

  // Per-URI + per-IP top-lists tracked in 1h buckets — full log volume is too much, but we
  // keep the top-K per bucket for the "who is hitting me" / "which endpoint is hot" widgets.
  await knex.schema.createTable('proxy_traffic_top_ips_1h', (t) => {
    t.increments('id').primary();
    t.integer('proxy_host_id').notNullable().references('id').inTable('proxy_hosts').onDelete('CASCADE');
    t.timestamp('ts').notNullable();
    t.string('ip', 45).notNullable(); // IPv6 max length
    t.integer('req_count').notNullable().defaultTo(0);
    t.bigInteger('bytes_out').notNullable().defaultTo(0);
    t.unique(['proxy_host_id', 'ts', 'ip']);
    t.index(['proxy_host_id', 'ts']);
  });

  await knex.schema.createTable('proxy_traffic_top_uris_1h', (t) => {
    t.increments('id').primary();
    t.integer('proxy_host_id').notNullable().references('id').inTable('proxy_hosts').onDelete('CASCADE');
    t.timestamp('ts').notNullable();
    t.string('uri', 512).notNullable();
    t.integer('req_count').notNullable().defaultTo(0);
    t.integer('avg_latency_ms').notNullable().defaultTo(0);
    t.unique(['proxy_host_id', 'ts', 'uri']);
    t.index(['proxy_host_id', 'ts']);
  });

  await knex.schema.createTable('ip_geo_cache', (t) => {
    t.string('ip', 45).primary();
    t.string('country_code', 2).nullable();
    t.string('country_name', 128).nullable();
    t.string('city', 128).nullable();
    t.decimal('latitude', 10, 7).nullable();
    t.decimal('longitude', 10, 7).nullable();
    t.string('org', 128).nullable();
    t.timestamp('looked_up_at').notNullable().defaultTo(knex.fn.now());
    t.index('country_code');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ip_geo_cache');
  await knex.schema.dropTableIfExists('proxy_traffic_top_uris_1h');
  await knex.schema.dropTableIfExists('proxy_traffic_top_ips_1h');
  await knex.schema.dropTableIfExists('proxy_traffic_1h');
  await knex.schema.dropTableIfExists('proxy_traffic_1m');
}
