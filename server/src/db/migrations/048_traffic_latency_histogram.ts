import type { Knex } from 'knex';

/**
 * Latency histogram for p50/p95/p99 + upstream vs edge split.
 *
 * `avg latency` (already stored as `latency_ms_sum` / `req_count`) hides the tail — a healthy
 * service with 999/1000 requests at 20ms and one at 4000ms looks fine on average but the p99
 * is atrocious. Every serious observability tool leads with p95/p99. Storing a small histogram
 * per bucket (9 int columns) lets us compute percentiles at query time via linear interpolation
 * between adjacent buckets without materializing the raw latency stream.
 *
 * Also splits `$request_time` (edge, client-facing) from `$upstream_response_time` (backend):
 *   - lat_upstream_* → time spent waiting for the upstream to respond
 *   - lat_edge_* stays as the existing latency_ms_sum / _max (nginx-side)
 * The self-hoster gets to see "my proxy is fast but Home Assistant is slow" vs
 * "everything is fine but my nginx is misbehaving" — impossible to disambiguate from avg alone.
 *
 * Bucket boundaries (ms): 50, 100, 250, 500, 1000, 2500, 5000, 10000. Anything longer lands
 * in _ge_10000. 9 buckets = 36 bytes/row. Rolls into 1h identically.
 */

const BUCKETS = ['lt_50', 'lt_100', 'lt_250', 'lt_500', 'lt_1000', 'lt_2500', 'lt_5000', 'lt_10000', 'ge_10000'] as const;

async function addLatencyColumns(knex: Knex, table: string): Promise<void> {
  await knex.schema.alterTable(table, (t) => {
    // Edge (nginx-side, from $request_time) histogram
    for (const b of BUCKETS) t.integer(`lat_edge_${b}`).notNullable().defaultTo(0);
    // Upstream (from $upstream_response_time) — same buckets, tracked separately.
    // Requests with no upstream (early 4xx, static file cache hit) are counted in lat_edge only.
    for (const b of BUCKETS) t.integer(`lat_up_${b}`).notNullable().defaultTo(0);
    // Upstream aggregates alongside the existing edge ones — same rationale as latency_ms_sum/max
    t.integer('lat_up_sum').notNullable().defaultTo(0);
    t.integer('lat_up_max').notNullable().defaultTo(0);
    t.integer('lat_up_count').notNullable().defaultTo(0); // requests that HAD an upstream
  });
}

export async function up(knex: Knex): Promise<void> {
  await addLatencyColumns(knex, 'proxy_traffic_1m');
  await addLatencyColumns(knex, 'proxy_traffic_1h');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_traffic_1h', (t) => {
    for (const b of BUCKETS) t.dropColumn(`lat_edge_${b}`);
    for (const b of BUCKETS) t.dropColumn(`lat_up_${b}`);
    t.dropColumn('lat_up_sum');
    t.dropColumn('lat_up_max');
    t.dropColumn('lat_up_count');
  });
  await knex.schema.alterTable('proxy_traffic_1m', (t) => {
    for (const b of BUCKETS) t.dropColumn(`lat_edge_${b}`);
    for (const b of BUCKETS) t.dropColumn(`lat_up_${b}`);
    t.dropColumn('lat_up_sum');
    t.dropColumn('lat_up_max');
    t.dropColumn('lat_up_count');
  });
}
