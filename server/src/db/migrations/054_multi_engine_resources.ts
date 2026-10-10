import type { Knex } from 'knex';

/**
 * Multi-engine resources:
 *  - docker_engines.host_agent_mode ('auto' | 'always' | 'off'): policy for the labelled host-metrics
 *    agent container Oblihub may run on an engine. 'auto' only runs it on GPU-capable engines, so
 *    installs without GPUs never get a new container. Existing https-apikey engines are set to 'off':
 *    that transport is plain HTTP to a socket proxy, so Oblihub must not start creating containers
 *    there unless an admin opts in.
 *  - container_stats.engine_id: engine of the sampled container, because a 12-char docker id is only
 *    unique per daemon. Nullable: historical rows stay NULL. No index on purpose: the table is large,
 *    per-engine reads go through the in-memory latest-stats map, and building an index at boot would
 *    block inserts.
 *  - gpu_power_limits: desired host-wide power limit per (engine, GPU uuid). Oblihub re-applies it
 *    after a host reboot or driver reload, because nvidia-smi -pl does not persist.
 *  - priority_yields: journal of what the priority watchdog paused or stopped (an intent row is
 *    written before acting). A restart then resumes exactly those containers on the right engine,
 *    instead of blindly starting every Opportunistic stack.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('docker_engines', (t) => {
    t.string('host_agent_mode', 16).notNullable().defaultTo('auto');
  });
  await knex('docker_engines').where({ type: 'https-apikey' }).update({ host_agent_mode: 'off' });
  await knex.schema.alterTable('container_stats', (t) => {
    t.integer('engine_id').nullable();
  });
  await knex.schema.createTable('gpu_power_limits', (t) => {
    t.increments('id').primary();
    t.integer('engine_id').notNullable().references('id').inTable('docker_engines').onDelete('CASCADE');
    t.string('gpu_uuid', 96).notNullable();    // 'GPU-…', or 'idx:<n>' when the driver reports no uuid
    t.string('gpu_index', 8).nullable();       // last known index, display only
    t.integer('watts').notNullable();
    t.integer('updated_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['engine_id', 'gpu_uuid']);
  });
  await knex.schema.createTable('priority_yields', (t) => {
    t.integer('stack_id').primary().references('id').inTable('stacks').onDelete('CASCADE');
    t.integer('engine_id').nullable();
    t.string('mode', 8).notNullable();         // 'pause' | 'stop'
    t.jsonb('containers').notNullable();       // [{ dockerId, name, service }]
    t.string('reason', 64).nullable();
    t.timestamp('yielded_at').notNullable().defaultTo(knex.fn.now());
  });

  // One-time backfill. The pre-upgrade non-admin managed-stack create pre-created the stacks row
  // with engine_id = stack.engineId ?? null, so undeployed local drafts sit on NULL, which is now
  // treats as orphaned (engine deleted): they would lose their team link to a fresh row at the first
  // deploy. Such rows are pointed at the local engine, picked like
  // engineFactsService.resolveLocalEngineId. Guards:
  //  - MIN(id) per project, and no project that already has a local-type row: the
  //    (compose_project, engine_id) unique constraint, and no adoption of a deleted engine's orphan;
  //  - no resource_limits and no priority_yields row: the same guard as discovery's orphan adoption
  //    in stack.service syncWithDocker;
  //  - no container rows: rows still holding a deleted engine's containers stay orphaned;
  //  - a managed stack of that project on the legacy NULL engine or a local-type engine.
  // Rows are updated in place, so team_id and the team resource links are kept.
  await knex.raw(`
    UPDATE stacks s SET engine_id = le.id
    FROM (SELECT id FROM docker_engines WHERE type = 'local' ORDER BY is_default DESC, id ASC LIMIT 1) le
    WHERE s.id IN (
      SELECT MIN(s1.id) FROM stacks s1
      WHERE s1.engine_id IS NULL
        AND s1.compose_project IS NOT NULL
        AND s1.resource_limits IS NULL
        AND NOT EXISTS (SELECT 1 FROM priority_yields py WHERE py.stack_id = s1.id)
        AND NOT EXISTS (SELECT 1 FROM containers c WHERE c.stack_id = s1.id)
        AND EXISTS (
          SELECT 1 FROM managed_stacks m LEFT JOIN docker_engines me ON me.id = m.engine_id
          WHERE m.compose_project = s1.compose_project AND (m.engine_id IS NULL OR me.type = 'local')
        )
        AND NOT EXISTS (
          SELECT 1 FROM stacks s2 JOIN docker_engines e2 ON e2.id = s2.engine_id
          WHERE s2.compose_project = s1.compose_project AND e2.type = 'local'
        )
      GROUP BY s1.compose_project
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('priority_yields');
  await knex.schema.dropTableIfExists('gpu_power_limits');
  await knex.schema.alterTable('container_stats', (t) => { t.dropColumn('engine_id'); });
  await knex.schema.alterTable('docker_engines', (t) => { t.dropColumn('host_agent_mode'); });
}
