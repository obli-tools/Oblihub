import type { Knex } from 'knex';

/**
 * Multi access list per proxy host.
 *
 * Until now each proxy_host could reference a single `access_list_id`. The new junction table
 * lets the operator stack multiple lists on a host: the resulting nginx config takes the UNION
 * of every list's allow rules (IP allowed if it's in ANY of them) and the UNION of htpasswd
 * users (basic-auth user accepted if it lives in ANY of them).
 *
 * Backfill: every existing proxy_host with a non-null access_list_id gets one row in the
 * junction so behaviour is identical post-migration. The `access_list_id` column is KEPT in
 * place for backward compat (existing API consumers still see it; new code uses the junction).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('proxy_host_access_lists', (t) => {
    t.integer('proxy_host_id').notNullable().references('id').inTable('proxy_hosts').onDelete('CASCADE');
    t.integer('access_list_id').notNullable().references('id').inTable('access_lists').onDelete('CASCADE');
    t.primary(['proxy_host_id', 'access_list_id']);
  });

  // Backfill from the singular column. Idempotent if re-run on a freshly migrated DB because
  // primary key would collide → we insert with onConflict ignore semantics for safety.
  const rows = await knex('proxy_hosts').whereNotNull('access_list_id').select('id', 'access_list_id');
  for (const r of rows) {
    try {
      await knex('proxy_host_access_lists').insert({
        proxy_host_id: r.id as number,
        access_list_id: r.access_list_id as number,
      });
    } catch { /* PK collision = already backfilled, ignore */ }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('proxy_host_access_lists');
}
