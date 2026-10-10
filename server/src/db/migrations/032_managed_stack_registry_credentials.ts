import type { Knex } from 'knex';

/**
 * Per-stack registry credentials.
 *
 * Lets a managed stack carry credentials for arbitrary container registries (private Gitea,
 * GHCR, GitLab, Quay, self-hosted Harbor, …) without resorting to a host-level `docker login`
 * that would leak across stacks and persist beyond Oblihub's control. Each row is a JSON array
 * of `{ registry, username, password_enc }` — `password_enc` is AES-256-GCM ciphertext using
 * the same scheme as engine SSH keys (`utils/crypto.ts`).
 *
 * At deploy time, compose.service writes a temp `DOCKER_CONFIG` directory with a `config.json`
 * that encodes these auths, then sets `DOCKER_CONFIG=<tmp>` for the `docker compose` subprocess.
 * `docker compose pull` reads it transparently. The temp dir is cleaned up after the command
 * finishes. Stacks without credentials see no behaviour change.
 *
 * The column is also useful for ANY field that needs a token (deploy keys for git, OAuth refresh
 * tokens, etc.) but we restrict it semantically to container registries for now to avoid
 * sprawling secrets storage.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('managed_stacks', (t) => {
    t.jsonb('registry_credentials').notNullable().defaultTo(JSON.stringify([]));
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('managed_stacks', (t) => {
    t.dropColumn('registry_credentials');
  });
}
