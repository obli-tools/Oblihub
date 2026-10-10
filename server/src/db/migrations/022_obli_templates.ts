import type { Knex } from 'knex';

/**
 * App Store curation:
 *  - Remove Uptime Kuma (replaced by Obliview in the obli.tools ecosystem)
 *  - Add Obliance, Oblimap, Obliguard, Obliview as one-click templates
 *
 * Each Obli* compose mirrors the reference docker-compose.yml from the upstream repo,
 * with env vars rendered as form fields (env_schema) so the wizard auto-prompts.
 */

export async function up(knex: Knex): Promise<void> {
  // Remove Uptime Kuma — kept only if user hasn't customised it. Built-in deletes are
  // gated by is_builtin server-side, but the migration scrubs it unconditionally because
  // it was a pure seed with no expected user mutation.
  await knex('app_templates').where({ slug: 'uptime-kuma', is_builtin: true }).delete();

  const obliviewCompose = `services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: obliview
      POSTGRES_USER: obliview
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U obliview"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 60s

  server:
    image: meejay/obliview-server:\${OBLIVIEW_VERSION:-latest}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: 3001
      DATABASE_URL: postgres://obliview:\${DB_PASSWORD}@postgres:5432/obliview
      SESSION_SECRET: \${SESSION_SECRET}
      CLIENT_ORIGIN: \${CLIENT_ORIGIN:-http://localhost}
      DEFAULT_ADMIN_USERNAME: \${DEFAULT_ADMIN_USERNAME:-admin}
      DEFAULT_ADMIN_PASSWORD: \${DEFAULT_ADMIN_PASSWORD:-admin123}
      FORCE_HTTPS: \${FORCE_HTTPS:-false}
    volumes:
      - obliview_custom:/custom

  client:
    image: meejay/obliview-client:\${OBLIVIEW_VERSION:-latest}
    restart: unless-stopped
    depends_on:
      server:
        condition: service_healthy
    ports:
      - "\${LISTEN_PORT:-3000}:80"

volumes:
  postgres_data:
  obliview_custom:
`;

  const oblianceCompose = `services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: obliance
      POSTGRES_USER: obliance
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U obliance"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 60s

  server:
    image: meejay/obliance-server:\${OBLIANCE_VERSION:-latest}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: 3001
      DATABASE_URL: postgres://obliance:\${DB_PASSWORD}@postgres:5432/obliance
      SESSION_SECRET: \${SESSION_SECRET}
      CLIENT_ORIGIN: \${CLIENT_ORIGIN:-http://localhost}
      DEFAULT_ADMIN_USERNAME: \${DEFAULT_ADMIN_USERNAME:-admin}
      DEFAULT_ADMIN_PASSWORD: \${DEFAULT_ADMIN_PASSWORD:-admin123}
    volumes:
      - obliance_custom:/custom

  client:
    image: meejay/obliance-client:\${OBLIANCE_VERSION:-latest}
    restart: unless-stopped
    depends_on:
      server:
        condition: service_healthy
    ports:
      - "\${LISTEN_PORT:-3003}:80"

volumes:
  postgres_data:
  obliance_custom:
`;

  const obliguardCompose = `services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: obliguard
      POSTGRES_USER: obliguard
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U obliguard"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 60s

  server:
    image: meejay/obliguard-server:\${OBLIGUARD_VERSION:-latest}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: 3001
      DATABASE_URL: postgres://obliguard:\${DB_PASSWORD}@postgres:5432/obliguard
      SESSION_SECRET: \${SESSION_SECRET}
      CLIENT_ORIGIN: \${CLIENT_ORIGIN:-http://localhost}
      DEFAULT_ADMIN_USERNAME: \${DEFAULT_ADMIN_USERNAME:-admin}
      DEFAULT_ADMIN_PASSWORD: \${DEFAULT_ADMIN_PASSWORD:-admin123}
    volumes:
      - obliguard_custom:/custom

  client:
    image: meejay/obliguard-client:\${OBLIGUARD_VERSION:-latest}
    restart: unless-stopped
    depends_on:
      server:
        condition: service_healthy
    ports:
      - "\${LISTEN_PORT:-3001}:80"

volumes:
  postgres_data:
  obliguard_custom:
`;

  const oblimapCompose = `services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: oblimap
      POSTGRES_USER: oblimap
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U oblimap"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 60s

  server:
    image: meejay/oblimap-server:\${OBLIMAP_VERSION:-latest}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3002/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    environment:
      NODE_ENV: production
      PORT: 3002
      DATABASE_URL: postgres://oblimap:\${DB_PASSWORD}@postgres:5432/oblimap
      SESSION_SECRET: \${SESSION_SECRET}
      CLIENT_ORIGIN: \${CLIENT_ORIGIN:-http://localhost}
      DEFAULT_ADMIN_USERNAME: \${DEFAULT_ADMIN_USERNAME:-admin}
      DEFAULT_ADMIN_PASSWORD: \${DEFAULT_ADMIN_PASSWORD:-admin123}
    volumes:
      - oblimap_custom:/custom

  client:
    image: meejay/oblimap-client:\${OBLIMAP_VERSION:-latest}
    restart: unless-stopped
    depends_on:
      server:
        condition: service_healthy
    ports:
      - "\${LISTEN_PORT:-3002}:80"

volumes:
  postgres_data:
  oblimap_custom:
`;

  // Common env schema for Obli* apps — DB pwd, session secret, listen port, admin creds.
  const obliEnvSchema = (defaultListenPort: string, versionVar: string) => [
    { key: 'DB_PASSWORD', label: 'Database Password', type: 'password', required: true, default: '', description: 'PostgreSQL password (used internally between server and postgres)' },
    { key: 'SESSION_SECRET', label: 'Session Secret', type: 'password', required: true, default: '', description: 'Random string used to sign session cookies — generate with `openssl rand -hex 32`' },
    { key: 'LISTEN_PORT', label: 'HTTP Port', type: 'number', required: false, default: defaultListenPort, description: 'Port exposed on the host' },
    { key: 'DEFAULT_ADMIN_USERNAME', label: 'Admin Username', type: 'text', required: false, default: 'admin', description: 'Created on first boot only' },
    { key: 'DEFAULT_ADMIN_PASSWORD', label: 'Admin Password', type: 'password', required: false, default: 'admin123', description: 'Created on first boot only — change immediately' },
    { key: 'CLIENT_ORIGIN', label: 'Client Origin', type: 'text', required: false, default: 'http://localhost', description: 'CORS origin (your public URL if behind a proxy)' },
    { key: versionVar, label: 'Image Version', type: 'text', required: false, default: 'latest', description: 'Docker tag (latest, or a specific version like 1.0.5)' },
  ];

  const templates = [
    {
      name: 'Obliview',
      slug: 'obliview',
      icon: '👁️',
      category: 'monitoring',
      description: 'Self-hosted uptime & infrastructure monitoring — 13 monitor types (HTTP, Ping, TCP, DNS, SSL, Docker, Game Server, Browser…), native Go agent with CPU/RAM/GPU/temperature metrics, 10 notification channels, 5 remediation actions, maintenance windows, multi-tenant + RBAC.',
      default_proxy_port: 80,
      documentation_url: 'https://obli.tools',
      compose_template: obliviewCompose,
      env_schema: JSON.stringify([
        ...obliEnvSchema('3000', 'OBLIVIEW_VERSION'),
        { key: 'FORCE_HTTPS', label: 'Force HTTPS cookies', type: 'select', required: false, default: 'false', description: 'Set to true when served behind an HTTPS reverse proxy', options: ['false', 'true'] },
      ]),
      is_builtin: true,
    },
    {
      name: 'Obliance',
      slug: 'obliance',
      icon: '🛠️',
      category: 'monitoring',
      description: 'Self-hosted RMM — Go endpoint agents for Windows/Linux/macOS with real-time metrics, script library, remote SSH/CMD/PowerShell terminals, ObliReach screen streaming, file explorer, process & service managers, OS update management (Windows Update / apt / yum / brew / winget).',
      default_proxy_port: 80,
      documentation_url: 'https://obli.tools',
      compose_template: oblianceCompose,
      env_schema: JSON.stringify(obliEnvSchema('3003', 'OBLIANCE_VERSION')),
      is_builtin: true,
    },
    {
      name: 'Obliguard',
      slug: 'obliguard',
      icon: '🛡️',
      category: 'security',
      description: 'Self-hosted network IPS — detects brute-force across SSH/RDP/Nginx/Apache/IIS/FTP/Mail/MySQL and bans attackers globally at the firewall level (nftables, firewalld, ufw, iptables, Windows netsh, macOS pf). Real-time NetMap visualization, IP reputation, hierarchical CIDR whitelists.',
      default_proxy_port: 80,
      documentation_url: 'https://obli.tools',
      compose_template: obliguardCompose,
      env_schema: JSON.stringify(obliEnvSchema('3001', 'OBLIGUARD_VERSION')),
      is_builtin: true,
    },
    {
      name: 'Oblimap',
      slug: 'oblimap',
      icon: '🗺️',
      category: 'monitoring',
      description: 'Self-hosted IPAM — distributed Go probes auto-discover subnets via ARP/DNS/port scan, MAC-based inventory with 30k+ vendor OUI lookup, IP reservations, subnet heatmaps (D3.js), IP takeover & instability alerts, hierarchical site management, multi-tenant + RBAC.',
      default_proxy_port: 80,
      documentation_url: 'https://obli.tools',
      compose_template: oblimapCompose,
      env_schema: JSON.stringify(obliEnvSchema('3002', 'OBLIMAP_VERSION')),
      is_builtin: true,
    },
  ];

  for (const t of templates) {
    // Upsert by slug — re-running the migration on an already-seeded DB is a no-op for content.
    const existing = await knex('app_templates').where({ slug: t.slug }).first();
    if (existing) {
      await knex('app_templates').where({ slug: t.slug }).update({
        name: t.name,
        icon: t.icon,
        category: t.category,
        description: t.description,
        default_proxy_port: t.default_proxy_port,
        documentation_url: t.documentation_url,
        compose_template: t.compose_template,
        env_schema: t.env_schema,
        is_builtin: true,
        updated_at: new Date(),
      });
    } else {
      await knex('app_templates').insert(t);
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('app_templates').whereIn('slug', ['obliview', 'obliance', 'obliguard', 'oblimap']).delete();
  // Note: down() does NOT restore Uptime Kuma — if you need it back, re-run migration 012's seed manually.
}
