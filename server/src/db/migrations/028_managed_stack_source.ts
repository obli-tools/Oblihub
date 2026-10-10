import type { Knex } from 'knex';

/**
 * Source-of-truth tracking for build-capable managed stacks.
 *
 * Existing managed_stacks are "compose-only": the user pastes a docker-compose.yml + .env and
 * we just run `docker compose up`. This migration adds the columns needed to also support
 * stacks whose source code lives elsewhere and gets built locally:
 *
 *   - source_type      'compose-only' | 'zip' | 'git'
 *                      Default 'compose-only' so existing rows behave exactly as before.
 *   - git_url          Repo URL when source_type='git'
 *   - git_branch       Branch / tag to track (default 'main' on the application side)
 *   - git_ref          The last resolved commit SHA from a successful clone/pull (display only)
 *   - last_source_sync_at  Timestamp of the last successful upload or git pull
 *
 * Source files are stored under STACKS_DIR/<compose_project>/ — same directory the compose
 * service already uses for compose.yml + .env. The build pipeline later reads from there.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('managed_stacks', (t) => {
    t.string('source_type', 16).notNullable().defaultTo('compose-only');
    t.string('git_url', 512).nullable();
    t.string('git_branch', 128).nullable();
    t.string('git_ref', 64).nullable();
    t.timestamp('last_source_sync_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('managed_stacks', (t) => {
    t.dropColumn('last_source_sync_at');
    t.dropColumn('git_ref');
    t.dropColumn('git_branch');
    t.dropColumn('git_url');
    t.dropColumn('source_type');
  });
}
