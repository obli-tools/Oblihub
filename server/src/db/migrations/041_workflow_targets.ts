import type { Knex } from 'knex';

/**
 * Reusable remote destination for workflow actions that push somewhere. Broken out into its own
 * table (vs. inlined per-workflow) so an operator can set up "DC-VPN" once and reference it from
 * three cert-export workflows + a nightly log-shipping workflow without repeating the config.
 *
 * Type field lets us grow beyond SFTP later (rsync, S3, HTTP webhook, ...) without another
 * migration — each type reads its own subset of columns. Keeping columns typed rather than
 * jsonb here because they're small, indexable, and 90% shared between transport modes.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('workflow_targets', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.text('description').nullable();
    // Ownership — same tri-state as ssh_keys / workflows.
    t.integer('team_id').nullable().references('id').inTable('teams').onDelete('CASCADE');
    t.integer('owner_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    // Transport
    t.enu('target_type', ['sftp']).notNullable().defaultTo('sftp'); // extensible: rsync, s3, http-webhook, ...
    t.string('host', 255).notNullable();
    t.integer('port').notNullable().defaultTo(22);
    t.string('username', 128).notNullable();
    // Path on the remote where files land. Trailing slash matters for `scp -r`-style semantics —
    // "/etc/ssl/certs/" vs. "/etc/ssl/certs" — we don't normalize, we hand it to the transport verbatim.
    t.string('remote_path', 512).notNullable();
    // SSH auth. `password_enc` reserved for a future password-based mode; today only key-based.
    t.integer('ssh_key_id').nullable().references('id').inTable('ssh_keys').onDelete('RESTRICT');
    // StrictHostKeyChecking — null = accept-new (first-connect gets pinned), string = known
    // fingerprint pinned by the operator. RESTRICT on ssh_key_id delete so the operator can't
    // orphan a target by mistake.
    t.string('host_key_fingerprint', 128).nullable();
    t.integer('created_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index('team_id');
    t.index('owner_user_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('workflow_targets');
}
