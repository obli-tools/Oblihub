import type { Knex } from 'knex';

/**
 * Register the workflow / SSH key / target permissions and grant them to the built-in admin
 * role. Users and viewers get read-only by default — Automation is a feature that operators
 * opt-in to for their teams, we don't want it enabled for everyone by mistake.
 */
export async function up(knex: Knex): Promise<void> {
  const perms = [
    // Workflows
    { key: 'workflows.view',    category: 'automation', label: 'View Workflows',                              default_admin: true, default_user: true,  default_viewer: true },
    { key: 'workflows.create',  category: 'automation', label: 'Create Workflows',                            default_admin: true, default_user: false, default_viewer: false },
    { key: 'workflows.edit',    category: 'automation', label: 'Edit Workflows',                              default_admin: true, default_user: false, default_viewer: false },
    { key: 'workflows.delete',  category: 'automation', label: 'Delete Workflows',                            default_admin: true, default_user: false, default_viewer: false },
    { key: 'workflows.execute', category: 'automation', label: 'Run Workflows On-Demand',                     default_admin: true, default_user: false, default_viewer: false },
    // SSH keys
    { key: 'ssh_keys.view',     category: 'automation', label: 'View SSH Keys (public + fingerprint)',        default_admin: true, default_user: true,  default_viewer: true },
    { key: 'ssh_keys.create',   category: 'automation', label: 'Create SSH Keys',                             default_admin: true, default_user: false, default_viewer: false },
    { key: 'ssh_keys.delete',   category: 'automation', label: 'Delete SSH Keys',                             default_admin: true, default_user: false, default_viewer: false },
    // Targets
    { key: 'targets.view',      category: 'automation', label: 'View Workflow Targets',                       default_admin: true, default_user: true,  default_viewer: true },
    { key: 'targets.manage',    category: 'automation', label: 'Create/Edit/Delete Workflow Targets',         default_admin: true, default_user: false, default_viewer: false },
  ];
  // Idempotent — a partial migration re-run must not choke on duplicates.
  for (const p of perms) {
    await knex('permissions').insert(p).onConflict('key').ignore();
  }

  // Grant to system roles based on their default_* flag.
  const roles = await knex('roles').whereIn('name', ['admin', 'user', 'viewer']);
  for (const perm of perms) {
    for (const role of roles) {
      const flag = perm[`default_${role.name}` as 'default_admin' | 'default_user' | 'default_viewer'];
      if (flag) {
        await knex('role_permissions').insert({
          role_id: role.id,
          permission_key: perm.key,
          granted: true,
        }).onConflict(['role_id', 'permission_key']).ignore();
      }
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  const keys = [
    'workflows.view', 'workflows.create', 'workflows.edit', 'workflows.delete', 'workflows.execute',
    'ssh_keys.view', 'ssh_keys.create', 'ssh_keys.delete',
    'targets.view', 'targets.manage',
  ];
  await knex('role_permissions').whereIn('permission_key', keys).delete();
  await knex('permissions').whereIn('key', keys).delete();
}
