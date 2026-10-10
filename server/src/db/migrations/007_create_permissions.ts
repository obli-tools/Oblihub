import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Permissions for the app
  await knex.schema.createTable('permissions', (t) => {
    t.increments('id').primary();
    t.string('key', 100).notNullable().unique(); // e.g. 'stacks.view', 'proxy.manage'
    t.string('category', 50).notNullable(); // e.g. 'stacks', 'proxy', 'docker', 'system'
    t.string('label', 128).notNullable();
    t.text('description').nullable();
    t.boolean('default_admin').notNullable().defaultTo(true);
    t.boolean('default_user').notNullable().defaultTo(false);
    t.boolean('default_viewer').notNullable().defaultTo(false);
  });

  // Custom roles
  await knex.schema.createTable('roles', (t) => {
    t.increments('id').primary();
    t.string('name', 64).notNullable().unique();
    t.string('label', 128).notNullable();
    t.text('description').nullable();
    t.boolean('is_system').notNullable().defaultTo(false); // admin/user/viewer are system
    t.timestamps(true, true);
  });

  // Role-permission mapping
  await knex.schema.createTable('role_permissions', (t) => {
    t.increments('id').primary();
    t.integer('role_id').notNullable().references('id').inTable('roles').onDelete('CASCADE');
    t.string('permission_key', 100).notNullable();
    t.boolean('granted').notNullable().defaultTo(true);
    t.unique(['role_id', 'permission_key']);
  });

  // Seed default permissions
  const perms = [
    // Dashboard
    { key: 'dashboard.view', category: 'dashboard', label: 'View Dashboard', default_admin: true, default_user: true, default_viewer: true },

    // Stacks
    { key: 'stacks.view', category: 'stacks', label: 'View Stacks', default_admin: true, default_user: true, default_viewer: true },
    { key: 'stacks.check', category: 'stacks', label: 'Check for Updates', default_admin: true, default_user: true, default_viewer: false },
    { key: 'stacks.update', category: 'stacks', label: 'Update Containers', default_admin: true, default_user: false, default_viewer: false },
    { key: 'stacks.restart', category: 'stacks', label: 'Restart Containers', default_admin: true, default_user: false, default_viewer: false },
    { key: 'stacks.stop', category: 'stacks', label: 'Stop/Start Containers', default_admin: true, default_user: false, default_viewer: false },
    { key: 'stacks.manage', category: 'stacks', label: 'Create/Edit/Delete Stacks', default_admin: true, default_user: false, default_viewer: false },
    { key: 'stacks.deploy', category: 'stacks', label: 'Deploy Managed Stacks', default_admin: true, default_user: false, default_viewer: false },

    // Containers
    { key: 'containers.logs', category: 'containers', label: 'View Container Logs', default_admin: true, default_user: true, default_viewer: true },
    { key: 'containers.inspect', category: 'containers', label: 'Inspect Containers', default_admin: true, default_user: true, default_viewer: true },
    { key: 'containers.console', category: 'containers', label: 'Console Access', default_admin: true, default_user: false, default_viewer: false },

    // Docker
    { key: 'docker.images', category: 'docker', label: 'Manage Images', default_admin: true, default_user: false, default_viewer: false },
    { key: 'docker.networks', category: 'docker', label: 'Manage Networks', default_admin: true, default_user: false, default_viewer: false },
    { key: 'docker.volumes', category: 'docker', label: 'Manage Volumes', default_admin: true, default_user: false, default_viewer: false },
    { key: 'docker.prune', category: 'docker', label: 'Prune Resources', default_admin: true, default_user: false, default_viewer: false },

    // Proxy
    { key: 'proxy.view', category: 'proxy', label: 'View Proxy Hosts', default_admin: true, default_user: true, default_viewer: true },
    { key: 'proxy.manage', category: 'proxy', label: 'Create/Edit/Delete Proxy Hosts', default_admin: true, default_user: false, default_viewer: false },
    { key: 'proxy.certificates', category: 'proxy', label: 'Manage SSL Certificates', default_admin: true, default_user: false, default_viewer: false },
    { key: 'proxy.access_lists', category: 'proxy', label: 'Manage Access Lists', default_admin: true, default_user: false, default_viewer: false },
    { key: 'proxy.nginx', category: 'proxy', label: 'Reload/Test Nginx', default_admin: true, default_user: false, default_viewer: false },

    // System
    { key: 'system.settings', category: 'system', label: 'View/Edit Settings', default_admin: true, default_user: false, default_viewer: false },
    { key: 'system.users', category: 'system', label: 'Manage Users', default_admin: true, default_user: false, default_viewer: false },
    { key: 'system.roles', category: 'system', label: 'Manage Roles & Permissions', default_admin: true, default_user: false, default_viewer: false },
  ];

  await knex('permissions').insert(perms);

  // Seed default system roles
  const [adminRole] = await knex('roles').insert({ name: 'admin', label: 'Administrator', description: 'Full access to everything', is_system: true }).returning('id');
  const [userRole] = await knex('roles').insert({ name: 'user', label: 'User', description: 'Standard user with limited access', is_system: true }).returning('id');
  const [viewerRole] = await knex('roles').insert({ name: 'viewer', label: 'Viewer', description: 'Read-only access', is_system: true }).returning('id');

  // Set permissions for system roles
  for (const perm of perms) {
    if (perm.default_admin) await knex('role_permissions').insert({ role_id: adminRole.id, permission_key: perm.key, granted: true });
    if (perm.default_user) await knex('role_permissions').insert({ role_id: userRole.id, permission_key: perm.key, granted: true });
    if (perm.default_viewer) await knex('role_permissions').insert({ role_id: viewerRole.id, permission_key: perm.key, granted: true });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('role_permissions');
  await knex.schema.dropTableIfExists('roles');
  await knex.schema.dropTableIfExists('permissions');
}
