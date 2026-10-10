import type { Knex } from 'knex';

/**
 * Ring-buffer sample tables — the debugging companions to aggregate stats.
 *
 * Aggregate counters answer "how many"; samples answer "what". "247 errors on this host" leads
 * to a shrug; "GET /api/orders/45 → 502 after 3400ms from 3 French IPs" is a five-second
 * diagnosis. Both tables are size-bounded ring buffers written from the same nginx log ingest
 * that populates the aggregates. Retention worker keeps them tiny.
 *
 * Tables:
 *   - proxy_traffic_error_samples: last N ~500 rows per host, 24h retention. Every 4xx/5xx.
 *   - proxy_traffic_slow_requests: top-K slowest per host per hour, 30d retention.
 *
 * Both keep enough context to be actionable (method, URI, status, IP, country, latency,
 * upstream latency, user-agent, referer) without ballooning into a full log copy.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('proxy_traffic_error_samples', (t) => {
    t.increments('id').primary();
    t.integer('proxy_host_id').notNullable().references('id').inTable('proxy_hosts').onDelete('CASCADE');
    t.timestamp('ts').notNullable();
    t.smallint('status').notNullable(); // HTTP status code
    t.string('method', 8).nullable();   // GET/POST/... — parsed from $request; nullable in case of malformed
    t.string('uri', 1024).notNullable();
    t.string('ip', 45).notNullable();
    t.string('country_code', 2).nullable();
    t.integer('latency_ms').notNullable().defaultTo(0);
    t.integer('upstream_ms').nullable();
    t.string('user_agent', 512).nullable();
    t.string('referer', 512).nullable();
    t.index(['proxy_host_id', 'ts']);
    t.index(['proxy_host_id', 'status']);
  });

  await knex.schema.createTable('proxy_traffic_slow_requests', (t) => {
    t.increments('id').primary();
    t.integer('proxy_host_id').notNullable().references('id').inTable('proxy_hosts').onDelete('CASCADE');
    t.timestamp('ts').notNullable();
    t.smallint('status').notNullable();
    t.string('method', 8).nullable();
    t.string('uri', 1024).notNullable();
    t.string('ip', 45).notNullable();
    t.string('country_code', 2).nullable();
    t.integer('latency_ms').notNullable().defaultTo(0);
    t.integer('upstream_ms').nullable();
    t.string('user_agent', 512).nullable();
    t.string('referer', 512).nullable();
    t.index(['proxy_host_id', 'ts']);
    t.index(['proxy_host_id', 'latency_ms']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('proxy_traffic_slow_requests');
  await knex.schema.dropTableIfExists('proxy_traffic_error_samples');
}
