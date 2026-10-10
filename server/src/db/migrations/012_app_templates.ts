import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('app_templates', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('slug', 64).notNullable().unique();
    t.text('description').nullable();
    t.string('icon', 10).nullable(); // emoji
    t.string('category', 50).notNullable().defaultTo('other');
    t.text('compose_template').notNullable();
    t.jsonb('env_schema').notNullable().defaultTo('[]'); // [{key, label, type, required, default, description}]
    t.integer('default_proxy_port').nullable();
    t.string('documentation_url', 500).nullable();
    t.boolean('is_builtin').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });

  // Seed built-in templates
  const templates = [
    {
      name: 'WordPress', slug: 'wordpress', icon: '📝', category: 'cms',
      description: 'Popular CMS and blogging platform with MariaDB',
      default_proxy_port: 80,
      documentation_url: 'https://hub.docker.com/_/wordpress',
      compose_template: `services:
  wordpress:
    image: wordpress:latest
    restart: unless-stopped
    ports:
      - "\${WP_PORT:-8080}:80"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: \${DB_USER:-wordpress}
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
      WORDPRESS_DB_NAME: \${DB_NAME:-wordpress}
    volumes:
      - wp_data:/var/www/html
    depends_on:
      - db

  db:
    image: mariadb:10
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: \${DB_NAME:-wordpress}
      MYSQL_USER: \${DB_USER:-wordpress}
      MYSQL_PASSWORD: \${DB_PASSWORD}
      MYSQL_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - db_data:/var/lib/mysql

volumes:
  wp_data:
  db_data:`,
      env_schema: JSON.stringify([
        { key: 'DB_PASSWORD', label: 'Database Password', type: 'password', required: true, default: '', description: 'Password for WordPress database user' },
        { key: 'DB_ROOT_PASSWORD', label: 'DB Root Password', type: 'password', required: true, default: '', description: 'Root password for MariaDB' },
        { key: 'DB_USER', label: 'Database User', type: 'text', required: false, default: 'wordpress', description: '' },
        { key: 'DB_NAME', label: 'Database Name', type: 'text', required: false, default: 'wordpress', description: '' },
        { key: 'WP_PORT', label: 'HTTP Port', type: 'number', required: false, default: '8080', description: '' },
      ]),
    },
    {
      name: 'Nextcloud', slug: 'nextcloud', icon: '☁️', category: 'storage',
      description: 'Self-hosted file sync and collaboration platform',
      default_proxy_port: 80,
      compose_template: `services:
  nextcloud:
    image: nextcloud:latest
    restart: unless-stopped
    ports:
      - "\${NC_PORT:-8081}:80"
    environment:
      POSTGRES_HOST: db
      POSTGRES_DB: \${DB_NAME:-nextcloud}
      POSTGRES_USER: \${DB_USER:-nextcloud}
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - nc_data:/var/www/html
    depends_on:
      - db

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: \${DB_NAME:-nextcloud}
      POSTGRES_USER: \${DB_USER:-nextcloud}
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - db_data:/var/lib/postgresql/data

volumes:
  nc_data:
  db_data:`,
      env_schema: JSON.stringify([
        { key: 'DB_PASSWORD', label: 'Database Password', type: 'password', required: true, default: '', description: '' },
        { key: 'NC_PORT', label: 'HTTP Port', type: 'number', required: false, default: '8081', description: '' },
      ]),
    },
    {
      name: 'Gitea', slug: 'gitea', icon: '🍵', category: 'devtools',
      description: 'Lightweight self-hosted Git service',
      default_proxy_port: 3000,
      compose_template: `services:
  gitea:
    image: gitea/gitea:latest
    restart: unless-stopped
    ports:
      - "\${GITEA_PORT:-3000}:3000"
      - "\${SSH_PORT:-2222}:22"
    environment:
      USER_UID: 1000
      USER_GID: 1000
    volumes:
      - gitea_data:/data

volumes:
  gitea_data:`,
      env_schema: JSON.stringify([
        { key: 'GITEA_PORT', label: 'HTTP Port', type: 'number', required: false, default: '3000', description: '' },
        { key: 'SSH_PORT', label: 'SSH Port', type: 'number', required: false, default: '2222', description: '' },
      ]),
    },
    {
      name: 'Vaultwarden', slug: 'vaultwarden', icon: '🔐', category: 'security',
      description: 'Lightweight Bitwarden-compatible password manager',
      default_proxy_port: 80,
      compose_template: `services:
  vaultwarden:
    image: vaultwarden/server:latest
    restart: unless-stopped
    ports:
      - "\${VW_PORT:-8082}:80"
    environment:
      DOMAIN: \${DOMAIN:-https://vault.example.com}
      SIGNUPS_ALLOWED: \${SIGNUPS:-true}
    volumes:
      - vw_data:/data

volumes:
  vw_data:`,
      env_schema: JSON.stringify([
        { key: 'VW_PORT', label: 'HTTP Port', type: 'number', required: false, default: '8082', description: '' },
        { key: 'DOMAIN', label: 'Domain URL', type: 'text', required: true, default: 'https://vault.example.com', description: 'Full URL including https://' },
        { key: 'SIGNUPS', label: 'Allow Signups', type: 'select', required: false, default: 'true', description: '', options: ['true', 'false'] },
      ]),
    },
    {
      name: 'Uptime Kuma', slug: 'uptime-kuma', icon: '📊', category: 'monitoring',
      description: 'Self-hosted monitoring tool',
      default_proxy_port: 3001,
      compose_template: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:latest
    restart: unless-stopped
    ports:
      - "\${UK_PORT:-3001}:3001"
    volumes:
      - uk_data:/app/data

volumes:
  uk_data:`,
      env_schema: JSON.stringify([
        { key: 'UK_PORT', label: 'HTTP Port', type: 'number', required: false, default: '3001', description: '' },
      ]),
    },
    {
      name: 'Grafana', slug: 'grafana', icon: '📈', category: 'monitoring',
      description: 'Analytics and monitoring dashboards',
      default_proxy_port: 3000,
      compose_template: `services:
  grafana:
    image: grafana/grafana:latest
    restart: unless-stopped
    ports:
      - "\${GF_PORT:-3000}:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: \${ADMIN_PASSWORD:-admin}
    volumes:
      - grafana_data:/var/lib/grafana

volumes:
  grafana_data:`,
      env_schema: JSON.stringify([
        { key: 'ADMIN_PASSWORD', label: 'Admin Password', type: 'password', required: true, default: 'admin', description: '' },
        { key: 'GF_PORT', label: 'HTTP Port', type: 'number', required: false, default: '3000', description: '' },
      ]),
    },
    {
      name: 'n8n', slug: 'n8n', icon: '⚡', category: 'automation',
      description: 'Workflow automation tool',
      default_proxy_port: 5678,
      compose_template: `services:
  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    ports:
      - "\${N8N_PORT:-5678}:5678"
    environment:
      N8N_BASIC_AUTH_ACTIVE: "true"
      N8N_BASIC_AUTH_USER: \${N8N_USER:-admin}
      N8N_BASIC_AUTH_PASSWORD: \${N8N_PASSWORD}
    volumes:
      - n8n_data:/home/node/.n8n

volumes:
  n8n_data:`,
      env_schema: JSON.stringify([
        { key: 'N8N_PASSWORD', label: 'Admin Password', type: 'password', required: true, default: '', description: '' },
        { key: 'N8N_PORT', label: 'HTTP Port', type: 'number', required: false, default: '5678', description: '' },
      ]),
    },
    {
      name: 'Redis', slug: 'redis', icon: '🔴', category: 'database',
      description: 'In-memory data store',
      compose_template: `services:
  redis:
    image: redis:alpine
    restart: unless-stopped
    ports:
      - "\${REDIS_PORT:-6379}:6379"
    volumes:
      - redis_data:/data

volumes:
  redis_data:`,
      env_schema: JSON.stringify([
        { key: 'REDIS_PORT', label: 'Port', type: 'number', required: false, default: '6379', description: '' },
      ]),
    },
  ];

  for (const t of templates) {
    await knex('app_templates').insert({ ...t, is_builtin: true });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_templates');
}
