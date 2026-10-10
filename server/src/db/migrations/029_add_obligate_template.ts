import type { Knex } from 'knex';

/**
 * Add Obligate to the app store.
 *
 * Obligate is the centralized SSO gateway for the Obli* ecosystem — OAuth2 provider, 2FA
 * (TOTP), account/profile management, and the canonical user identity store that the other
 * Obli apps redirect to for sign-in and /account.
 *
 * Same shape as the other Obli* templates (migration 022): postgres + server + client, env
 * vars rendered as form fields by the wizard. The one Obligate-specific knob is the
 * `ENCRYPTION_KEY` used to encrypt foreign-provider credentials (LDAP bind passwords, OIDC
 * client secrets, etc.) stored in its DB — we expose it as an optional field with a clear
 * "auto-generated if blank" hint so first-run still works.
 */

export async function up(knex: Knex): Promise<void> {
  const obligateCompose = `services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: obligate
      POSTGRES_USER: obligate
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U obligate"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 60s

  server:
    image: meejay/obligate-server:\${OBLIGATE_VERSION:-latest}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: 3010
      DATABASE_URL: postgres://obligate:\${DB_PASSWORD}@postgres:5432/obligate
      SESSION_SECRET: \${SESSION_SECRET}
      CLIENT_ORIGIN: \${CLIENT_ORIGIN:-http://localhost}
      DEFAULT_ADMIN_USERNAME: \${DEFAULT_ADMIN_USERNAME:-admin}
      DEFAULT_ADMIN_PASSWORD: \${DEFAULT_ADMIN_PASSWORD:-admin123}
      ENCRYPTION_KEY: \${ENCRYPTION_KEY:-}

  client:
    image: meejay/obligate-client:\${OBLIGATE_VERSION:-latest}
    restart: unless-stopped
    depends_on:
      server:
        condition: service_healthy
    ports:
      - "\${LISTEN_PORT:-3020}:80"

volumes:
  postgres_data:
`;

  const envSchema = [
    { key: 'DB_PASSWORD', label: 'Database Password', type: 'password', required: true, default: '', description: 'PostgreSQL password (used internally between server and postgres)' },
    { key: 'SESSION_SECRET', label: 'Session Secret', type: 'password', required: true, default: '', description: 'Random string used to sign session cookies — generate with `openssl rand -hex 32`' },
    { key: 'ENCRYPTION_KEY', label: 'Encryption Key', type: 'password', required: false, default: '', description: 'AES-256 key (64 hex chars) used to encrypt foreign-provider credentials (LDAP bind passwords, OIDC secrets…). Leave blank for auto-generation on first boot. Generate with `openssl rand -hex 32`.' },
    { key: 'LISTEN_PORT', label: 'HTTP Port', type: 'number', required: false, default: '3020', description: 'Port exposed on the host' },
    { key: 'DEFAULT_ADMIN_USERNAME', label: 'Admin Username', type: 'text', required: false, default: 'admin', description: 'Created on first boot only' },
    { key: 'DEFAULT_ADMIN_PASSWORD', label: 'Admin Password', type: 'password', required: false, default: 'admin123', description: 'Created on first boot only — change immediately' },
    { key: 'CLIENT_ORIGIN', label: 'Client Origin', type: 'text', required: false, default: 'http://localhost', description: 'CORS origin (your public URL if behind a proxy)' },
    { key: 'OBLIGATE_VERSION', label: 'Image Version', type: 'text', required: false, default: 'latest', description: 'Docker tag (latest, or a specific version like 1.0.5)' },
  ];

  const template = {
    name: 'Obligate',
    slug: 'obligate',
    icon: '🔐',
    category: 'identity',
    description: 'Self-hosted SSO gateway for the Obli* ecosystem — OAuth2/OIDC provider, TOTP 2FA, LDAP/SAML foreign-provider bridge, account & profile management, theme preferences sync, RBAC, and a centralised user identity store the other Obli apps redirect to for sign-in.',
    default_proxy_port: 80,
    documentation_url: 'https://obli.tools',
    compose_template: obligateCompose,
    env_schema: JSON.stringify(envSchema),
    is_builtin: true,
  };

  // Upsert by slug — re-running this migration on an already-seeded DB just refreshes content
  // and never duplicates the entry.
  const existing = await knex('app_templates').where({ slug: template.slug }).first();
  if (existing) {
    await knex('app_templates').where({ slug: template.slug }).update({
      name: template.name,
      icon: template.icon,
      category: template.category,
      description: template.description,
      default_proxy_port: template.default_proxy_port,
      documentation_url: template.documentation_url,
      compose_template: template.compose_template,
      env_schema: template.env_schema,
      is_builtin: true,
      updated_at: new Date(),
    });
  } else {
    await knex('app_templates').insert(template);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('app_templates').where({ slug: 'obligate', is_builtin: true }).delete();
}
