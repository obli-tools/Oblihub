import type { Knex } from 'knex';

/**
 * Store managed-stack named volumes under `<STACKS_DIR>/.volumes/<project>/<volume>` instead of
 * Docker's default `/var/lib/docker/volumes` — for NEW stacks only.
 *
 *   - volumes_in_stacks_dir  Opt-in flag. FALSE for every pre-existing row so their volumes are
 *                            never touched; managedStackService.create() sets it TRUE.
 *   - volume_placements      Per-volume decision, frozen at the first deploy that sees the volume:
 *                            { "<compose volume key>": { mode: 'bind', device, rel, since }
 *                                                    | { mode: 'plain', since } }
 *                            'bind'  = local volume bound to the host folder `device`
 *                            'plain' = a Docker volume that already existed (adopted stack,
 *                                      leftover volume) — left in Docker's default location.
 *                            See stackVolumes.service.ts for the full lifecycle.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('managed_stacks', (t) => {
    t.boolean('volumes_in_stacks_dir').notNullable().defaultTo(false);
    t.jsonb('volume_placements').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('managed_stacks', (t) => {
    t.dropColumn('volume_placements');
    t.dropColumn('volumes_in_stacks_dir');
  });
}
