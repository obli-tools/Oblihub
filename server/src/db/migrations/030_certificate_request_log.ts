import type { Knex } from 'knex';

/**
 * Per-certificate request log.
 *
 * Until now the LE provisioning flow only wrote to pino — useful for ops with shell access,
 * not for the operator using the UI who'd just see "error" with whatever short message we
 * happened to surface. The new `request_log` column stores a JSON array of
 * `{ at, level, message }` entries appended during the request so the UI can render the full
 * play-by-play (account creation, order, challenge writes, validation, finalize, …) and the
 * operator can self-diagnose: bad DNS, port 80 not reachable, rate limit, etc.
 *
 * Capped at ~200 entries client-side; the column itself is unbounded — easier to truncate on
 * read than to rebuild after a longer-than-usual session.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('certificates', (t) => {
    t.jsonb('request_log').notNullable().defaultTo(JSON.stringify([]));
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('certificates', (t) => {
    t.dropColumn('request_log');
  });
}
