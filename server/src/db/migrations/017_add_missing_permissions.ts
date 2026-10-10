import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const newPerms = [
    // Uptime
    { key: 'uptime.view', category: 'uptime', label: 'View Uptime Monitors', default_admin: true, default_user: true, default_viewer: true },
    { key: 'uptime.manage', category: 'uptime', label: 'Create/Edit/Delete Monitors', default_admin: true, default_user: false, default_viewer: false },
    { key: 'uptime.status_pages', category: 'uptime', label: 'Manage Status Pages', default_admin: true, default_user: false, default_viewer: false },

    // Custom pages
    { key: 'proxy.custom_pages', category: 'proxy', label: 'Manage Custom Error Pages', default_admin: true, default_user: false, default_viewer: false },

    // Templates / App Store
    { key: 'templates.view', category: 'templates', label: 'View App Store', default_admin: true, default_user: true, default_viewer: true },
    { key: 'templates.deploy', category: 'templates', label: 'Deploy Templates', default_admin: true, default_user: false, default_viewer: false },

    // Teams
    { key: 'system.teams', category: 'system', label: 'Manage Teams', default_admin: true, default_user: false, default_viewer: false },
  ];

  // Insert new permissions (ignore if already exist)
  for (const p of newPerms) {
    const exists = await knex('permissions').where({ key: p.key }).first();
    if (!exists) await knex('permissions').insert(p);
  }

  // Add permissions to existing system roles
  const adminRole = await knex('roles').where({ name: 'admin' }).first();
  const userRole = await knex('roles').where({ name: 'user' }).first();
  const viewerRole = await knex('roles').where({ name: 'viewer' }).first();

  for (const p of newPerms) {
    if (p.default_admin && adminRole) {
      await knex('role_permissions').insert({ role_id: adminRole.id, permission_key: p.key, granted: true }).onConflict(['role_id', 'permission_key']).ignore();
    }
    if (p.default_user && userRole) {
      await knex('role_permissions').insert({ role_id: userRole.id, permission_key: p.key, granted: true }).onConflict(['role_id', 'permission_key']).ignore();
    }
    if (p.default_viewer && viewerRole) {
      await knex('role_permissions').insert({ role_id: viewerRole.id, permission_key: p.key, granted: true }).onConflict(['role_id', 'permission_key']).ignore();
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  const keys = ['uptime.view', 'uptime.manage', 'uptime.status_pages', 'proxy.custom_pages', 'templates.view', 'templates.deploy', 'system.teams'];
  await knex('role_permissions').whereIn('permission_key', keys).delete();
  await knex('permissions').whereIn('key', keys).delete();
}
