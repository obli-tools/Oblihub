import type { Knex } from 'knex';

/**
 * Trame PLM-style deployment support.
 *
 * A "Git → build → deploy" workflow needs Oblihub to know things it didn't track before:
 *   - `compose_path`         where the compose file lives INSIDE the repo (e.g. `stack/docker-compose.yml`).
 *                            Absent for the legacy root-only assumption. When set, both the
 *                            source sync (probe) AND the compose CLI invocation (`-f <path>`
 *                            + `--project-directory <dir>`) key off this so relative
 *                            build.context paths resolve correctly.
 *   - `git_username`         Gitea/GitHub deploy-token username. Injected at clone/pull time
 *                            via URL rewrite `https://<user>:<token>@host/...`. Optional —
 *                            public repos still work when both fields are null.
 *   - `git_token_enc`        AES-GCM-encrypted deploy token (same scheme as engine SSH keys
 *                            + registry_credentials, see utils/crypto.ts). Never returned in
 *                            plaintext through the API — only a `hasGitToken` flag.
 *   - `build_enabled`        Opt-in build. When true, deploy/redeploy add `--build` to the
 *                            `docker compose` command. Off by default so existing pull-only
 *                            stacks keep their fast redeploy semantics unchanged.
 *   - `env_content_enc`      AES-GCM ciphertext for env vars. When present, decrypted on
 *                            demand at deploy time and written to a temp `.env` (chmod 0o600),
 *                            deleted after the compose subprocess exits. Legacy `env_content`
 *                            remains for backward-compat; a follow-up migration can drop it
 *                            once all rows are re-saved with the encrypted variant.
 *   - `poll_git_interval_s`  When > 0, a background worker runs `git ls-remote` on this
 *                            interval and triggers a pull+rebuild if the branch HEAD moved.
 *                            0 (default) = disabled, operator triggers redeploys manually.
 *
 * Also creates `managed_stack_deploy_history`: append-only log of every successful deploy,
 * used for the rollback UI (redeploy an earlier git_ref) and for the unified timeline that
 * merges git deploys with the existing registry-digest `update_history`.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('managed_stacks', (t) => {
    t.string('compose_path').nullable();
    t.string('git_username').nullable();
    t.text('git_token_enc').nullable();
    t.boolean('build_enabled').notNullable().defaultTo(false);
    t.text('env_content_enc').nullable();
    t.integer('poll_git_interval_s').notNullable().defaultTo(0);
    t.timestamp('last_git_poll_at').nullable();
  });

  await knex.schema.createTable('managed_stack_deploy_history', (t) => {
    t.increments('id').primary();
    t.integer('managed_stack_id').notNullable().references('id').inTable('managed_stacks').onDelete('CASCADE');
    t.string('source_type').notNullable();
    t.string('git_url').nullable();
    t.string('git_branch').nullable();
    t.string('git_ref').nullable();
    t.string('compose_path').nullable();
    t.boolean('build_enabled').notNullable().defaultTo(false);
    t.boolean('success').notNullable().defaultTo(true);
    t.text('notes').nullable();
    t.timestamp('deployed_at').notNullable().defaultTo(knex.fn.now());
    t.integer('deployed_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.index(['managed_stack_id', 'deployed_at'], 'msdh_stack_time_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('managed_stack_deploy_history');
  await knex.schema.alterTable('managed_stacks', (t) => {
    t.dropColumn('last_git_poll_at');
    t.dropColumn('poll_git_interval_s');
    t.dropColumn('env_content_enc');
    t.dropColumn('build_enabled');
    t.dropColumn('git_token_enc');
    t.dropColumn('git_username');
    t.dropColumn('compose_path');
  });
}
