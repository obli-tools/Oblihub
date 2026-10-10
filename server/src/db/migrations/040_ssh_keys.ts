import type { Knex } from 'knex';

/**
 * Managed SSH keypair store. Used by workflow actions that need to push to a remote server
 * (SFTP export of a renewed cert, remote command via SSH, ...). One key = one row.
 *
 * Ownership model (mirrored on workflow_targets and workflows):
 *   - team_id set, owner_user_id null → visible to team members
 *   - owner_user_id set, team_id null → personal, visible to owner + admins
 *   - both null                       → global (admin-managed, visible to everyone with the
 *                                       `ssh_keys.view` permission)
 * Exactly one of {team_id, owner_user_id, both-null} — validated at the service layer.
 *
 * The private key never leaves the DB. It's encrypted with the app's data key (utils/crypto,
 * AES-256-GCM) so a leaked DB dump alone doesn't hand out shell access. Only the public key
 * and fingerprint are ever surfaced via the API.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ssh_keys', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.text('description').nullable();
    // Ownership — nullable pair, exactly-one-set enforced at service layer.
    t.integer('team_id').nullable().references('id').inTable('teams').onDelete('CASCADE');
    t.integer('owner_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    // Key material
    t.enu('key_type', ['ed25519', 'rsa']).notNullable().defaultTo('ed25519');
    t.text('public_key').notNullable();       // OpenSSH format, single line ("ssh-ed25519 AAAA... comment")
    t.text('private_key_enc').notNullable();  // AES-256-GCM encrypted
    t.string('fingerprint', 128).notNullable(); // SHA256:base64 — matches ssh-keygen -l
    // Convenience metadata
    t.integer('created_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index('team_id');
    t.index('owner_user_id');
    t.index('fingerprint');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ssh_keys');
}
