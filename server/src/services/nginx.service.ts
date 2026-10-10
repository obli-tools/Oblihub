import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { db } from '../db';
import { dockerService } from './docker.service';
import { proxyHostService, redirectionService, streamService, deadHostService, accessListService, customPageService } from './proxy.service';
import type { ProxyHost, RedirectionHost, DeadHost, AccessList } from '@oblihub/shared';
import { logger } from '../utils/logger';

const PROXY_DIR = path.join(config.stacksDir, '_proxy');

// Default waking page — used when a proxy host has no waking_page_id and no custom default exists.
// Tokens: {{APP_NAME}}, {{PROXY_HOST_ID}}
const DEFAULT_WAKING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Waking up {{APP_NAME}}…</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0b0d1a; color: #e8ecf5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .card { max-width: 480px; padding: 32px; text-align: center; }
  .spinner { width: 48px; height: 48px; margin: 0 auto 24px; border: 3px solid rgba(45,78,201,0.2); border-top-color: #2d4ec9; border-radius: 50%; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 20px; margin: 0 0 8px; font-weight: 600; }
  p { margin: 0; color: #8c93b6; font-size: 14px; line-height: 1.5; }
  .progress { margin: 18px auto 6px; width: 100%; height: 6px; background: rgba(45,78,201,0.15); border-radius: 3px; overflow: hidden; display: none; }
  .progress.visible { display: block; }
  .progress > .bar { height: 100%; width: 0; background: linear-gradient(90deg, #2d4ec9, #5a78e8); border-radius: 3px; transition: width 0.3s ease-out; }
  .progress.indeterminate > .bar { width: 100% !important; animation: shimmer 1.6s ease-in-out infinite; }
  @keyframes shimmer { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
  .elapsed { margin-top: 8px; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 12px; color: #5a78e8; }
  .hint { margin-top: 10px; font-size: 12px; color: #ffb454; display: none; }
  .hint.visible { display: block; }
  .error { color: #e03a3a; margin-top: 16px; display: none; }
  .error.visible { display: block; }
</style>
</head>
<body>
<div class="card">
  <div class="spinner"></div>
  <h1>Waking up {{APP_NAME}}…</h1>
  <p>The application was idle and shut down to save resources. It's starting back up.</p>
  <div class="progress" id="progress"><div class="bar" id="bar"></div></div>
  <div class="elapsed"><span id="elapsed">0</span>s<span id="estimated"></span></div>
  <div class="hint" id="hint">It's taking longer than usual — please wait a bit more…</div>
  <div class="error" id="error">Wake failed — <a href="javascript:location.reload()" style="color:#5a78e8">retry</a></div>
</div>
<script>
(function(){
  var host = {{PROXY_HOST_ID}};
  var start = Date.now();
  var el = document.getElementById('elapsed');
  var est = document.getElementById('estimated');
  var bar = document.getElementById('bar');
  var progress = document.getElementById('progress');
  var hint = document.getElementById('hint');
  var err = document.getElementById('error');
  // null = unknown (first wake, no history). number = ms estimate from rolling avg.
  var estimatedMs = null;

  function tick(){
    var elapsedMs = Date.now() - start;
    el.textContent = Math.floor(elapsedMs / 1000);
    if (estimatedMs && estimatedMs > 0) {
      progress.classList.add('visible');
      progress.classList.remove('indeterminate');
      var pct = Math.min(100, (elapsedMs / estimatedMs) * 100);
      bar.style.width = pct + '%';
      // Once we overshoot the estimate, pin the bar at 100% and reveal the "longer than usual" hint.
      if (elapsedMs > estimatedMs) {
        hint.classList.add('visible');
      }
    } else if (estimatedMs === 0) {
      // No history yet — show an indeterminate shimmer so the page doesn't feel dead.
      progress.classList.add('visible');
      progress.classList.add('indeterminate');
    }
  }
  setInterval(tick, 250);

  function poll(){
    fetch('/__oblihub_internal/wake/status?host=' + host, { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || !d.data) { setTimeout(poll, 1500); return; }
        // Refresh estimate on every poll — first-time visitors get it after the first response,
        // and a wake that produces a fresh sample mid-poll will refine it for subsequent ticks.
        if (typeof d.data.estimatedMs === 'number') {
          estimatedMs = d.data.estimatedMs;
          if (estimatedMs > 0) {
            est.textContent = ' / ~' + Math.round(estimatedMs / 1000) + 's expected';
          }
        } else if (d.data.estimatedMs === null) {
          estimatedMs = 0;
        }
        if (d.data.ready) {
          location.reload();
        } else if (d.data.state === 'wake_failed') {
          err.classList.add('visible');
        } else {
          setTimeout(poll, 1500);
        }
      })
      .catch(function(){ setTimeout(poll, 2000); });
  }
  // Kick off the wake then start polling
  fetch('/__oblihub_internal/wake?host=' + host, { method: 'POST', cache: 'no-store' })
    .finally(function(){ poll(); });
})();
</script>
</body>
</html>
`;

const CONF_DIR = path.join(PROXY_DIR, 'conf.d');
const STREAM_DIR = path.join(PROXY_DIR, 'stream.d');
const CERTS_DIR = path.join(PROXY_DIR, 'certs');
const ACME_DIR = path.join(PROXY_DIR, 'acme-challenge');
const HTPASSWD_DIR = path.join(PROXY_DIR, 'htpasswd');
const ERROR_PAGES_DIR = path.join(PROXY_DIR, 'error_pages');
// Ban map — referenced by the http-level `include /etc/nginx/ban_map.conf;` inside the
// `map $remote_addr $is_banned {}` block. Must exist (even empty) or nginx fails to load.
const BAN_MAP_FILE = path.join(PROXY_DIR, 'ban_map.conf');

function ensureDirs() {
  for (const dir of [PROXY_DIR, CONF_DIR, STREAM_DIR, CERTS_DIR, ACME_DIR, HTPASSWD_DIR, ERROR_PAGES_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  // Ensure acme-challenge is world-readable for nginx
  try { fs.chmodSync(ACME_DIR, 0o755); } catch { /* ignore */ }
  // Ensure ban_map.conf exists (empty) so the http-level include doesn't fail on fresh installs.
  if (!fs.existsSync(BAN_MAP_FILE)) {
    fs.writeFileSync(BAN_MAP_FILE, '# Auto-generated by Oblihub — one line per active banned IP\n');
  }
}

// ── Config snippets ──

function blockExploitsSnippet(): string {
  return `
    # Block common exploits
    location ~* "(\\.\\.)" { deny all; }
    location ~* "(~)$" { deny all; }
    location ~* "(\\.(?:bak|conf|dist|fla|in[ci]|log|psd|sh|sql|sw[op]|env))$" { deny all; }
    location ~* "/(wp-config\\.php|xmlrpc\\.php)" { deny all; }`;
}

function cachingSnippet(): string {
  return `
    # Cache static assets
    location ~* \\.(css|js|jpg|jpeg|png|gif|ico|svg|woff|woff2|ttf|eot|webp|avif)$ {
        proxy_pass $upstream;
        proxy_cache proxy_cache;
        proxy_cache_valid 200 1d;
        add_header X-Cache-Status $upstream_cache_status;
        expires 1d;
    }`;
}

function gzipSnippet(): string {
  return `
    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_min_length 1000;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;`;
}

function corsSnippet(): string {
  return `
    # CORS headers
    add_header Access-Control-Allow-Origin * always;
    add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, PATCH, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Authorization, Content-Type, Accept, Origin, X-Requested-With" always;
    add_header Access-Control-Max-Age 86400 always;
    if ($request_method = 'OPTIONS') {
        return 204;
    }`;
}

function rateLimitDirective(hostId: number, burst: number): string {
  return `    limit_req zone=rl_${hostId} burst=${burst} nodelay;`;
}

function customHeadersSnippet(headers: { name: string; value: string; action: 'add' | 'remove' }[]): string {
  return headers.map(h => {
    const name = sanitizeForNginx(h.name);
    const value = sanitizeForNginx(h.value);
    if (h.action === 'remove') return `    proxy_hide_header ${name};`;
    return `    add_header ${name} "${value}" always;`;
  }).join('\n');
}

function hstsSnippet(subdomains: boolean): string {
  const sub = subdomains ? '; includeSubDomains' : '';
  return `    add_header Strict-Transport-Security "max-age=63072000${sub}" always;`;
}

function sslBlock(certPath: string, keyPath: string, http2: boolean): string {
  const h2 = http2 ? '\n    http2 on;' : '';
  return `    listen 443 ssl;
    listen [::]:443 ssl;${h2}
    ssl_certificate ${certPath};
    ssl_certificate_key ${keyPath};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_prefer_server_ciphers off;`;
}

/**
 * Combined access list block for a proxy host. Takes every access list attached to the host
 * (via the junction table) and emits a single nginx block that's the UNION of their rules:
 *
 *   - Allow IPs: every `allow X` from any list is emitted. Duplicates deduped. If at least one
 *     `allow` exists across all lists, we append `deny all` to lock out everyone else (standard
 *     nginx allowlist pattern).
 *   - Deny IPs: emitted before allows (nginx evaluates in order, first-match-wins).
 *   - Basic auth: if any list has auth users, we point at a per-host combined htpasswd file
 *     (`htpasswd/proxy_host_<id>`) written by the regenerate flow. `auth_basic_user_file`
 *     supports only one path, so we cannot reference multiple list-level files.
 *   - satisfy: if ANY attached list has satisfyAny=true, the whole host inherits `satisfy any`
 *     (most permissive interpretation, matches the "stack multiple lists for flexibility" mental
 *     model). Otherwise `satisfy all`.
 */
/**
 * Options for {@link combinedAccessListBlock}. `htpasswdKey` is the basename under
 * `/etc/nginx/htpasswd/` that will hold the merged auth users for this scope — must match
 * whatever the htpasswd writer produces on disk (see the regen loop below). `indent` is the
 * leading whitespace applied to each emitted line — 4 spaces for server-scope, 8 for
 * location-scope. Split from the block builder so per-route overrides can reuse it verbatim.
 */
interface CombinedAclOpts { htpasswdKey: string; indent: string; }

function combinedAccessListBlock(lists: AccessList[], opts: CombinedAclOpts): string {
  if (lists.length === 0) return '';
  const allClients = lists.flatMap(l => l.clients.map(c => ({ ...c, listName: l.name })));
  const allAuth = lists.flatMap(l => l.auth);
  if (allClients.length === 0 && allAuth.length === 0) return '';

  const I = opts.indent;
  let conf = `\n${I}# Access lists (union): ${lists.map(l => l.name).join(', ')}\n`;

  if (allClients.length > 0) {
    // Deny rules first so they're evaluated before any explicit allow further down.
    const seenAllow = new Set<string>();
    const seenDeny = new Set<string>();
    for (const c of allClients) {
      const addr = c.address.replace(/[;\n\r{}#'"\\]/g, '');
      if (c.directive === 'deny') {
        if (seenDeny.has(addr)) continue;
        seenDeny.add(addr);
        conf += `${I}deny ${addr};   # from "${c.listName}"\n`;
      }
    }
    for (const c of allClients) {
      const addr = c.address.replace(/[;\n\r{}#'"\\]/g, '');
      if (c.directive === 'allow') {
        if (seenAllow.has(addr)) continue;
        seenAllow.add(addr);
        conf += `${I}allow ${addr};   # from "${c.listName}"\n`;
      }
    }
    if (seenAllow.size > 0) conf += `${I}deny all;\n`;
  }

  if (allAuth.length > 0) {
    const anySatisfyAny = lists.some(l => l.satisfyAny);
    if (allClients.length > 0) {
      conf += `${I}satisfy ${anySatisfyAny ? 'any' : 'all'};\n`;
    }
    conf += `${I}auth_basic "Restricted";\n`;
    conf += `${I}auth_basic_user_file /etc/nginx/htpasswd/${opts.htpasswdKey};\n`;
  }

  return conf;
}

// ── Proxy Host config ──

function sanitizeForNginx(value: string): string {
  return value.replace(/[;\n\r{}#'"\\]/g, '');
}

/**
 * Emit an `if ($auth_groups !~ ...) { return 403; }` guard when the proxy_host restricts by
 * Azure group. Empty / null list = no guard (auth is enough). Group tokens are cleaned to
 * `[A-Za-z0-9._:-]+` so they can go verbatim inside a regex — Entra group IDs are GUIDs so
 * this is a no-op in practice, but keeps us safe from operator-typed junk.
 *
 * Note: $auth_groups is populated by auth_request_set at server scope; guards inside a location
 * see it correctly. The regex uses `(^|,)(g1|g2)(,|$)` so a substring match on a longer GUID
 * doesn't accidentally succeed (e.g. group "abc" shouldn't match "abcd,xyz").
 */
function azureGroupGuardLines(host: ProxyHost, indent: string): string {
  const groups = host.azureAuthAllowedGroups;
  if (!groups || groups.length === 0) return '';
  const clean = groups
    .map(g => g.replace(/[^A-Za-z0-9._:-]/g, ''))
    .filter(g => g.length > 0);
  if (clean.length === 0) return '';
  const regex = `(^|,)(${clean.join('|')})(,|$)`;
  return `${indent}if ($auth_groups !~ "${regex}") { return 403; }\n`;
}

/**
 * Emit an `if ($auth_email !~ ...) { return 403; }` guard when the proxy_host restricts by
 * Azure email. Empty / null list = no guard. Each entry becomes one alternative in the regex:
 *   - contains `@`  → treated as a FULL EMAIL, matched exactly (`^user@example\.com$`)
 *   - no `@`        → treated as a DOMAIN,      suffix-matched (`@example\.com$`)
 *
 * Emitted as a SECOND independent `if` after the group guard (see caller). Two `if` statements
 * combine with AND — each failure returns 403 on its own — so a host with both filters set
 * requires the user to match BOTH, mirroring oauth2-proxy's own combination of
 * EMAIL_DOMAINS + ALLOWED_GROUPS. Never widens access, only narrows it.
 *
 * Sanitization: characters outside the RFC-5322-lite set `A-Za-z0-9._+-@` are dropped from
 * each entry before regex assembly, so a stray comma or quote can't break out. Dots are
 * escaped for regex literalness. Empty results after cleaning skip the guard entirely
 * rather than emitting a match-nothing regex that would 403 everyone.
 */
function azureEmailGuardLines(host: ProxyHost, indent: string): string {
  const emails = host.azureAuthAllowedEmails;
  if (!emails || emails.length === 0) return '';
  const escapeRegex = (s: string): string => s.replace(/[.+\-]/g, m => `\\${m}`);
  const alts: string[] = [];
  for (const raw of emails) {
    const clean = raw.trim().toLowerCase().replace(/[^a-z0-9._+\-@]/g, '');
    if (!clean) continue;
    if (clean.includes('@')) {
      alts.push(`^${escapeRegex(clean)}$`);
    } else {
      alts.push(`@${escapeRegex(clean)}$`);
    }
  }
  if (alts.length === 0) return '';
  const regex = `(${alts.join('|')})`;
  // `~*` = case-insensitive: Azure returns UPN with the casing the user typed at sign-up,
  // which may not match the operator's config (`Alice@Example.com` vs `alice@example.com`).
  return `${indent}if ($auth_email !~* "${regex}") { return 403; }\n`;
}

function generateProxyHostConfig(host: ProxyHost, accessLists: AccessList[] = []): string {
  const domains = host.domainNames.map(d => sanitizeForNginx(d)).join(' ');
  const upstream = `${sanitizeForNginx(host.forwardScheme)}://${sanitizeForNginx(host.forwardHost)}:${host.forwardPort}`;
  // Resolve the cert file paths through the compat helper — tries the new `<domain>_<id>`
  // scheme first, falls back to the legacy `<domain>` naming for certs not yet renewed under
  // the new convention. Returns null if neither variant exists on disk.
  const resolved = host.certificate ? nginxService.resolveExistingCertFile(host.certificate) : null;
  const hasCert = !!(host.certificate && host.certificate.status === 'valid' && host.certificateId && resolved);

  let conf = `# Proxy Host ${host.id} - ${domains}\n`;

  // HTTP server block
  if (host.sslForced && hasCert) {
    conf += `server {
    listen 80;
    listen [::]:80;
    server_name ${domains};

    # ACME challenge — must bypass server-level access list (IP allow/deny + auth_basic)
    # so Let's Encrypt's HTTP-01 validator can always reach the token regardless of what
    # the operator has gated the host with.
    location /.well-known/acme-challenge/ {
        alias /etc/nginx/acme-challenge/;
        allow all;
        auth_basic off;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}\n\n`;
  }

  // Main server block
  conf += `server {\n`;

  if (hasCert && resolved) {
    // Resolved paths are absolute host paths (server-side); nginx needs the in-container mount
    // point `/etc/nginx/certs/<filename>`. The filename is the tail of the resolved path — the
    // compat helper already picked new-vs-legacy, we just re-emit as a container path.
    const fullchainBasename = path.basename(resolved.fullchain);
    const keyBasename = path.basename(resolved.key);
    conf += sslBlock(
      `/etc/nginx/certs/${fullchainBasename}`,
      `/etc/nginx/certs/${keyBasename}`,
      host.http2Support,
    ) + '\n';
  }

  if (!host.sslForced || !hasCert) {
    conf += `    listen 80;\n    listen [::]:80;\n`;
  }

  conf += `    server_name ${domains};\n\n`;

  // Ban check — first thing after server_name. Any IP flagged in the http-level ban_map gets
  // a 404 regardless of the URL requested. 404 (not 403) is intentional: an attacker probing
  // for /admin gets the same response as a real 404, so they can't tell whether they were
  // banned or the site simply doesn't have that path. Silently opaque = harder to script
  // around.
  // Use the gated variant, not raw $is_banned — see the map declaration in nginx.conf for
  // why (short version: raw $is_banned loops on the internal error-page redirect and nginx
  // bails to its default 404 instead of the custom page).
  conf += `    if ($oblihub_ban_gate) { return 404; }\n\n`;

  // ACME challenge (always serve) — `allow all` + `auth_basic off` are critical: without them
  // any attached access list (IP allowlist or basic auth) on the host would 403 the Let's
  // Encrypt validator and break renewals silently for the lifetime of the cert.
  conf += `    location /.well-known/acme-challenge/ {
        alias /etc/nginx/acme-challenge/;
        allow all;
        auth_basic off;
    }\n\n`;

  // Honeypot locations — one nginx location per enabled honeypot path. Each sets the
  // $oblihub_is_honeypot flag (read by the server-scope access_log below) and returns 404.
  // Why the flag rather than an in-location access_log: any host with a custom 404 error_page
  // triggers an internal redirect on `return 404`, and the log line is written against the
  // error page's location instead of the honeypot's — the honeypot log stays empty, the
  // worker never bans anyone. Server-scope `access_log if=$oblihub_is_honeypot` fires on the
  // FINAL request close regardless of internal redirects.
  //
  // Order matters: honeypot locations come BEFORE the access list block. If we put ACL first,
  // an IP not in the allowlist would hit ACL 403 before ever triggering the flag.
  //
  // Route override: when the operator has declared a sub-route on the same path as a honeypot
  // bait (e.g. Vaultwarden `/admin` is a REAL admin panel we want to gate with an ACL, not a
  // scanner trap), the route wins — we skip the bait. Otherwise nginx would refuse to start
  // with "duplicate location /admin". The security semantics still hold: put an ACL on the
  // route and enable `honeypotBanAclViolations` on the host, and any non-whitelisted IP that
  // touches /admin gets a 403 → intercepted by @_oblihub_acl_honeypot → same flag+ban.
  // Whitelisted IPs pass through the ACL and reach the real backend. Best of both worlds.
  const hasHoneypotPaths = host.honeypotEnabled && host.honeypotPaths && host.honeypotPaths.length > 0;
  const hasAclHoneypot = host.honeypotBanAclViolations;
  // Normalize trailing slashes when comparing route paths vs honeypot bait — `/admin` and
  // `/admin/` are semantically the same "the operator claimed this prefix" from an override
  // standpoint. Without this, a route declared as `/admin/` would fail to override the bait
  // `/admin`, both would end up in the config, and a request to bare `/admin` (no slash) would
  // match the shorter bait prefix and ban the operator. Root `/` is preserved as-is.
  const stripSlash = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
  const routePaths = new Set((host.routes || []).map(r => stripSlash(r.pathIn)));
  if (hasHoneypotPaths || hasAclHoneypot) {
    // Server-scope honeypot access_log — fires only when a honeypot location set the flag.
    // Additive w/ other access_log directives at same scope (nginx allows multiple).
    conf += `    access_log /etc/nginx/oblihub_honeypot.log oblihub_honeypot if=$oblihub_is_honeypot;\n\n`;
  }
  if (hasHoneypotPaths) {
    for (const p of host.honeypotPaths!) {
      const safe = sanitizeForNginx(p.path);
      if (!safe) continue;
      if (routePaths.has(stripSlash(safe))) {
        conf += `    # Honeypot bait for ${safe} skipped — overridden by a sub-route.\n`;
        conf += `    # Non-whitelisted access is banned via honeypotBanAclViolations on the route's ACL.\n\n`;
        continue;
      }
      conf += `    location ${safe} {\n`;
      conf += `        set $oblihub_is_honeypot 1;\n`;
      conf += `        return 404;\n`;
      conf += `    }\n\n`;
    }
  }

  if (host.hstsEnabled && hasCert) {
    conf += hstsSnippet(host.hstsSubdomains) + '\n\n';
  }

  if (host.blockExploits) {
    conf += blockExploitsSnippet() + '\n\n';
  }

  // Collect every attached access list — prefer the new array, fall back to the legacy single id.
  const attachedIds = host.accessListIds && host.accessListIds.length > 0
    ? host.accessListIds
    : (host.accessListId ? [host.accessListId] : []);
  const attached = attachedIds
    .map(id => accessLists.find(al => al.id === id))
    .filter((al): al is AccessList => !!al);
  if (attached.length > 0) {
    conf += combinedAccessListBlock(attached, { htpasswdKey: `proxy_host_${host.id}`, indent: '    ' }) + '\n\n';
  }

  // ACL-violation honeypot: any 403 from `allow/deny` (whether at server scope from the host
  // ACL, or from a per-route override) gets intercepted and routed through the named location,
  // which sets the honeypot flag → the server-scope access_log picks it up → worker bans the
  // source IP globally. Returns 404 (not 403) so the attacker can't tell they hit an allowlist.
  //
  // The trap is armed whenever `honeypotBanAclViolations` is ON and AT LEAST ONE IP-based ACL
  // source exists — host-level OR any route with `accessListMode='override'` whose selected
  // lists have `clients.length > 0`. Basic-auth-only lists don't reject at the ACL layer
  // (nginx serves the challenge), so an all-auth ACL wouldn't trigger the trap regardless.
  //
  // Why the trap is at server scope (not per-location): nginx inherits `error_page` from
  // server → location unless the location declares its own. Emitting it once at server scope
  // covers both host-level ACL violations AND route-level ones without duplication.
  const routeHasIpAcl = (host.routes || []).some(r =>
    r.accessListMode === 'override'
    && r.accessListOverrideIds.length > 0
    && r.accessListOverrideIds.some(id => {
      const al = accessLists.find(a => a.id === id);
      return al && al.clients.length > 0;
    }),
  );
  const hostHasIpAcl = attached.some(al => al.clients.length > 0);
  if (host.honeypotBanAclViolations && (hostHasIpAcl || routeHasIpAcl)) {
    conf += `    # ACL violations are trapped as honeypot events → global ban. Same flag +\n`;
    conf += `    # server-scope access_log pattern as the path honeypot above.\n`;
    conf += `    error_page 403 = @_oblihub_acl_honeypot;\n`;
    conf += `    location @_oblihub_acl_honeypot {\n`;
    conf += `        set $oblihub_is_honeypot 1;\n`;
    conf += `        return 404;\n`;
    conf += `    }\n\n`;
  }

  // Azure AD forward-auth via oauth2-proxy sidecar. Emitted only when the proxy_host
  // references a provider — nginx delegates each request's auth check to the sidecar via
  // auth_request, and the /oauth2/ subpath is proxied through to the sidecar for the sign-in
  // + callback flow. Stacks on top of Access Lists (satisfy defaults handled by nginx).
  if (host.azureAuthProviderId) {
    const sidecar = `oblihub-azauth-${host.azureAuthProviderId}`;
    // CRITICAL: use `set $var` + `proxy_pass $var` (not the literal URL) so nginx resolves
    // the sidecar hostname AT RUNTIME via docker DNS, not once at boot. Without this, a sidecar
    // that got recreated (IP changed) leaves nginx tapping the stale cached IP forever — every
    // auth_request fails silently, error_page 500 kicks in, and the operator sees an Oblihub
    // error page that just LOOKS like the app is up. Been there.
    conf += `    # Azure AD forward-auth via oauth2-proxy sidecar (provider ${host.azureAuthProviderId})\n`;
    // NO resolver directive here — nginx.service already emits one at server level for the
    // main upstream. Duplicating it here makes nginx refuse `-s reload` with "directive is
    // duplicate", nginx keeps running the OLD config, and the operator sees mysterious 200s
    // from the upstream because the auth_request block never became active. The server-level
    // resolver is inherited into this scope, `$oblihub_fa_upstream` is resolved at runtime
    // with the same TTL/family settings.
    conf += `    set $oblihub_fa_upstream http://${sidecar}:4180;\n`;
    conf += `    auth_request /_oblihub_fa/auth;\n`;
    conf += `    auth_request_set $auth_user $upstream_http_x_auth_request_user;\n`;
    conf += `    auth_request_set $auth_email $upstream_http_x_auth_request_email;\n`;
    conf += `    auth_request_set $auth_groups $upstream_http_x_auth_request_groups;\n`;
    // Preferred-username is the readable form (UPN / email) — X-Auth-Request-User carries the
    // Entra objectId `sub` claim which is opaque and useless to display. Capture both; expose
    // the readable one under a dedicated header for apps that want to show "Signed in as X".
    conf += `    auth_request_set $auth_preferred_username $upstream_http_x_auth_request_preferred_username;\n`;
    // Response-side identity headers — emitted at SERVER scope so they inherit into `location /`
    // and every sub-route without needing to duplicate them per-location. The `add_header`
    // directive has the SAME inheritance-kills-parent-set rule as `proxy_set_header`: declare
    // one add_header in a child location and the entire parent set is dropped. Keeping every
    // add_header (HSTS + user's customResponseHeaders + these identity headers) at the same
    // scope means one inheritance ruling covers all of them.
    // `always` = emit even on 4xx/5xx responses (default drops them). Access-Control-Expose-
    // Headers lets JS running under a different origin read them via fetch().
    conf += `    add_header X-Auth-User $auth_user always;\n`;
    conf += `    add_header X-Auth-Email $auth_email always;\n`;
    conf += `    add_header X-Auth-Groups $auth_groups always;\n`;
    conf += `    add_header X-Auth-Preferred-Username $auth_preferred_username always;\n`;
    conf += `    add_header Access-Control-Expose-Headers "X-Auth-User, X-Auth-Email, X-Auth-Groups, X-Auth-Preferred-Username" always;\n`;
    // NOTE: the corresponding `proxy_set_header X-Auth-*` lines are NOT emitted here at the
    // server scope on purpose. nginx does NOT merge proxy_set_header from parent into a child
    // location — the moment `location /` declares any proxy_set_header of its own, it REPLACES
    // the entire inherited set. Declaring X-Auth-* here would silently drop them at the app
    // upstream. They're injected inside `location /` right next to the proxy_pass instead.
    conf += `    error_page 401 = @_oblihub_fa_signin;\n\n`;
    conf += `    location @_oblihub_fa_signin {\n`;
    conf += `        return 302 /oauth2/start?rd=$scheme://$http_host$request_uri;\n`;
    conf += `    }\n\n`;
    conf += `    location = /_oblihub_fa/auth {\n`;
    conf += `        internal;\n`;
    conf += `        proxy_pass $oblihub_fa_upstream/oauth2/auth;\n`;
    conf += `        proxy_pass_request_body off;\n`;
    conf += `        proxy_set_header Content-Length "";\n`;
    // oauth2-proxy echoes X-Auth-Request-Groups on this subrequest — for users in many AAD
    // groups (50+) that single header value alone blows past nginx's default 8k proxy_buffer_size
    // and triggers "upstream sent too big header" → auth_request 502 → visible 500 to the user.
    // 64k comfortably covers 200+ groups plus the other X-Auth-Request-* headers and cookies.
    conf += `        proxy_buffer_size 64k;\n`;
    conf += `        proxy_buffers 4 64k;\n`;
    conf += `        proxy_busy_buffers_size 64k;\n`;
    // CRITICAL: forward Host + X-Forwarded-Host so oauth2-proxy (with REVERSE_PROXY=true)
    // reconstructs the original request URL as the user's domain, not "<sidecar-name>:4180".
    // Without this, the sidecar sees a Host it doesn't recognize, considers the session cookie
    // (set on the user-facing domain) as belonging to a different site, and returns 401
    // immediately after every successful callback — the classic "login succeeds, next request
    // 401s" symptom.
    conf += `        proxy_set_header Host $http_host;\n`;
    conf += `        proxy_set_header X-Original-URI $request_uri;\n`;
    conf += `        proxy_set_header X-Forwarded-Host $http_host;\n`;
    conf += `        proxy_set_header X-Forwarded-Proto $scheme;\n`;
    conf += `        proxy_set_header X-Forwarded-For $remote_addr;\n`;
    conf += `    }\n\n`;
    conf += `    location /oauth2/ {\n`;
    // CRITICAL: bypass auth_request here — /oauth2/* IS the sign-in flow itself. Without this
    // override, the server-level auth_request runs on /oauth2/start, gets 401, redirects to
    // /oauth2/start?rd=<current URL>, which triggers auth_request again → infinite redirect
    // loop → ERR_TOO_MANY_REDIRECTS. Same reason /oauth2/callback must be reachable
    // unauthenticated (Azure hits it before any session exists).
    conf += `        auth_request off;\n`;
    conf += `        proxy_pass $oblihub_fa_upstream;\n`;
    conf += `        proxy_set_header Host $http_host;\n`;
    conf += `        proxy_set_header X-Forwarded-Host $http_host;\n`;
    conf += `        proxy_set_header X-Forwarded-Proto $scheme;\n`;
    conf += `        proxy_set_header X-Forwarded-For $remote_addr;\n`;
    conf += `        proxy_set_header X-Real-IP $remote_addr;\n`;
    conf += `    }\n\n`;
  }

  if (host.cachingEnabled) {
    conf += cachingSnippet() + '\n\n';
  }

  if (host.gzipEnabled) {
    conf += gzipSnippet() + '\n\n';
  }

  if (host.corsEnabled) {
    conf += corsSnippet() + '\n\n';
  }

  if (host.clientMaxBodySize) {
    conf += `    client_max_body_size ${sanitizeForNginx(host.clientMaxBodySize)};\n\n`;
  }

  if (host.rateLimitRps) {
    conf += rateLimitDirective(host.id, host.rateLimitBurst || 10) + '\n\n';
  }

  if (host.customResponseHeaders?.length) {
    conf += customHeadersSnippet(host.customResponseHeaders) + '\n\n';
  }

  // Error pages — per-code custom pages with dynamic content.
  //
  // Two exclusions:
  //   - `wakeContainerId` reserves 502/503/504 for the waking page (declared below).
  //   - When the ACL-violation honeypot trap is armed, we MUST NOT map 403 to the custom
  //     error page. nginx last-definition-wins for a given code at the same scope, so a
  //     later `error_page 403 /oblihub_err_..._403.html;` would override the earlier
  //     `error_page 403 = @_oblihub_acl_honeypot;` and the trap would never fire.
  //     Symptom: attacker gets the custom page but no log line, no ban. We skip 403 here
  //     and let the trap own it — the trap ends with `return 404`, which then goes through
  //     the custom 404 page below, so the attacker still sees the operator's editorial
  //     content indistinguishable from a normal 404.
  if (host.errorPageId) {
    const trapArmsFor403 = host.honeypotBanAclViolations && (hostHasIpAcl || routeHasIpAcl);
    const errorCodes = host.wakeContainerId
      ? [400, 401, 403, 404, 500]
      : [400, 401, 403, 404, 500, 502, 503, 504];
    const filteredCodes = trapArmsFor403 ? errorCodes.filter(c => c !== 403) : errorCodes;
    for (const code of filteredCodes) {
      conf += `    error_page ${code} /oblihub_err_${host.errorPageId}_${code}.html;\n`;
    }
    for (const code of filteredCodes) {
      conf += `    location = /oblihub_err_${host.errorPageId}_${code}.html {\n`;
      conf += `        internal;\n`;
      conf += `        alias /etc/nginx/error_pages/page_${host.errorPageId}_${code}.html;\n`;
      conf += `    }\n`;
    }
    conf += '\n';
  }

  // Sleep mode wake — intercept 502/503/504 (upstream down) with the waking page,
  // and proxy the polling endpoints to the Oblihub server via a private location.
  if (host.wakeContainerId) {
    conf += `    # Sleep/wake — container ${host.wakeContainerId}\n`;
    // error_page → URI (not a named location). nginx triggers an internal subrequest to that
    // URI, which is matched by the `location =` block below. We can't use a named location
    // here because nginx forbids `alias` inside them.
    conf += `    error_page 502 503 504 /__oblihub_waking_${host.id}.html;\n`;
    conf += `    location = /__oblihub_waking_${host.id}.html {\n`;
    conf += `        internal;\n`;
    conf += `        alias /etc/nginx/error_pages/waking_${host.id}.html;\n`;
    conf += `    }\n`;
    conf += `    location /__oblihub_internal/ {\n`;
    // Compose service name = "server" (overridable via OBLIHUB_SERVER_HOST env on the proxy generator side).
    conf += `        proxy_pass http://${process.env.OBLIHUB_SERVER_HOST || 'server'}:3001/__oblihub_internal/;\n`;
    conf += `        proxy_set_header X-Oblihub-Internal "${process.env.OBLIHUB_INTERNAL_TOKEN || 'oblihub-internal'}";\n`;
    conf += `        proxy_set_header Host $host;\n`;
    conf += `        proxy_http_version 1.1;\n`;
    conf += `    }\n`;
    // Activity log — one line per request, parsed by ActivityTracker. $proxy_host_id is set
    // via the http-level `map $host …` in nginx.conf, keyed on this host's domain names.
    conf += `    access_log /etc/nginx/sleep_activity.log sleep_activity;\n`;
    conf += '\n';
  }

  // Resolver for dynamic upstream DNS:
  //  - 127.0.0.11 is Docker's embedded resolver (resolves Docker service names)
  //  - 100.100.100.100 is Tailscale's MagicDNS (resolves *.ts.net Tailnet names).
  //    Only useful when the proxy container shares the tailscale netns
  //    (PROXY_NETWORK_MODE=service:tailscale). When that's not the case the line
  //    is harmless — nginx just tries both for any upstream lookup.
  conf += `    resolver 127.0.0.11${process.env.PROXY_TAILSCALE_DNS === 'true' ? ' 100.100.100.100' : ''} valid=10s ipv6=off;\n`;
  conf += `    set $upstream ${upstream};\n\n`;

  // ── Per-path sub-routes ──
  // Emitted BEFORE `location /` so nginx picks the most specific prefix. We also sort by
  // path length descending as a defensive measure — nginx does prefix-longest-wins natively,
  // but a stable order keeps the emitted config diff-friendly across reloads.
  if (host.routes && host.routes.length > 0) {
    const routes = [...host.routes].sort((a, b) => b.pathIn.length - a.pathIn.length);
    for (const route of routes) {
      const rPath = sanitizeForNginx(route.pathIn);
      const rScheme = route.forwardScheme === 'https' ? 'https' : 'http';
      const rHost = sanitizeForNginx(route.forwardHost);
      const rPort = route.forwardPort;
      // Path-rewrite trick: `proxy_pass http://host:port/newprefix` (trailing URI) tells nginx
      // to strip the location's matched prefix from $uri and prepend /newprefix before sending
      // upstream. Without a trailing URI, nginx passes the full request URI through unchanged.
      const rewrite = (route.pathRewrite || '').trim();
      const rUpstream = rewrite.length > 0
        ? `${rScheme}://${rHost}:${rPort}${rewrite.startsWith('/') ? rewrite : '/' + rewrite}`
        : `${rScheme}://${rHost}:${rPort}`;

      conf += `    location ${rPath} {\n`;
      // Auth mode:
      //   'inherit' → nothing to emit; server-scope `auth_request` (if any) applies via inheritance.
      //   'none'    → `auth_request off` — this route bypasses the sidecar completely (useful for
      //               API webhook endpoints called by external services that can't do OIDC).
      //   'override'→ v1 falls back to 'inherit' with a log warning. Emitting a per-route
      //               `auth_request` targeting a different sidecar would also need per-route
      //               /oauth2/ callback paths + Azure app redirect URIs, out of scope for v1.
      if (route.authMode === 'none') {
        conf += `        auth_request off;\n`;
      } else if (route.authMode === 'override') {
        logger.warn({ hostId: host.id, routeId: route.id }, 'route.authMode=override not yet supported — treating as inherit');
      }
      // Access list mode:
      //   'inherit' → server-scope `allow/deny` + `auth_basic` are inherited automatically.
      //   'none'    → `auth_basic off` disables basic-auth; `allow all` is a best-effort reset
      //               of the IP allow-list (nginx can't "unset" a `deny all` from parent scope,
      //               so this is not a hermetic bypass — document that access-list bypass on a
      //               route only makes sense when the host uses basic-auth OR when the parent
      //               ACL has no explicit `deny all`).
      //   'override'→ emit the route's OWN access-list block. Two nginx inheritance rules to
      //               keep straight:
      //                 - `allow`/`deny`: as soon as the location has ANY allow/deny of its
      //                   own, ALL server-scope allow/deny are dropped for that location
      //                   (nginx replaces, doesn't stack). So a route override with its own
      //                   IP rules is fully independent — can be broader OR narrower than the
      //                   host, doesn't matter. This is what makes "host=ACL1, /admin=ACL2"
      //                   just work.
      //                 - `auth_basic`: also replacement, but we emit `auth_basic off` FIRST
      //                   so operators overriding IP-only lists don't inadvertently inherit
      //                   the host's basic-auth realm on top of their route rules.
      //               Edge case: if the override lists have ONLY auth users and ZERO IP
      //               clients, combinedAccessListBlock() emits no allow/deny, and server-scope
      //               allow/deny then still apply via inheritance. That's usually fine (the
      //               host's ACL still filters as intended), but if the host had `deny all`
      //               and the operator meant to widen access via route override, they'd need
      //               to add at least one dummy `allow` (e.g. include the range they want) to
      //               force nginx to drop the parent block.
      if (route.accessListMode === 'none') {
        conf += `        auth_basic off;\n`;
        conf += `        allow all;\n`;
      } else if (route.accessListMode === 'override' && route.accessListOverrideIds.length > 0) {
        const overrideAttached = route.accessListOverrideIds
          .map(id => accessLists.find(al => al.id === id))
          .filter((al): al is AccessList => !!al);
        if (overrideAttached.length > 0) {
          conf += `        auth_basic off;\n`;
          conf += combinedAccessListBlock(overrideAttached, {
            htpasswdKey: `proxy_host_${host.id}_route_${route.id}`,
            indent: '        ',
          });
        }
      }
      conf += `        proxy_pass ${rUpstream};\n`;
      conf += `        proxy_set_header Host $host;\n`;
      conf += `        proxy_set_header X-Real-IP $remote_addr;\n`;
      conf += `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n`;
      conf += `        proxy_set_header X-Forwarded-Proto $scheme;\n`;
      conf += `        proxy_set_header X-Forwarded-Host $host;\n`;
      conf += `        proxy_set_header X-Forwarded-Port $server_port;\n`;
      // Identity headers — same multi-convention block as `location /` (X-Auth-* / X-Forwarded-*
      // / Remote-*), plus the response-side add_header block for static SPAs. Only emitted when
      // the host has forward-auth AND this route inherits it.
      if (host.azureAuthProviderId && route.authMode !== 'none') {
        // Per-host group + email guards apply to sub-routes that inherit auth too. Combined
        // with AND: two independent `if` returns 403, matching the semantics on `location /`.
        conf += azureGroupGuardLines(host, '        ');
        conf += azureEmailGuardLines(host, '        ');
        conf += `        proxy_set_header X-Auth-User $auth_user;\n`;
        conf += `        proxy_set_header X-Auth-Email $auth_email;\n`;
        conf += `        proxy_set_header X-Auth-Groups $auth_groups;\n`;
        conf += `        proxy_set_header X-Auth-Preferred-Username $auth_preferred_username;\n`;
        conf += `        proxy_set_header X-Forwarded-User $auth_user;\n`;
        conf += `        proxy_set_header X-Forwarded-Email $auth_email;\n`;
        conf += `        proxy_set_header X-Forwarded-Groups $auth_groups;\n`;
        conf += `        proxy_set_header X-Forwarded-Preferred-Username $auth_preferred_username;\n`;
        conf += `        proxy_set_header Remote-User $auth_user;\n`;
        conf += `        proxy_set_header Remote-Email $auth_email;\n`;
        conf += `        proxy_set_header Remote-Name $auth_preferred_username;\n`;
        conf += `        proxy_set_header Remote-Groups $auth_groups;\n`;
        // Response-side add_header block lives at server scope — it inherits into this
        // location automatically (see the auth_request_set block earlier). Adding them here
        // would trigger the same "child overrides parent set" inheritance rule and would
        // silently drop HSTS + the user's customResponseHeaders for this route.
      }
      conf += `        proxy_http_version 1.1;\n`;
      // Per-route override for websocket / buffering; null = fall back to host-level defaults
      // (which get applied to `location /` further down but NOT here — we're isolated).
      const wsOn = route.websocketSupport ?? host.websocketSupport;
      if (wsOn) {
        conf += `        proxy_set_header Upgrade $http_upgrade;\n`;
        conf += `        proxy_set_header Connection $http_connection;\n`;
      }
      const bufOff = (route.proxyBuffering ?? host.proxyBuffering) === false;
      if (bufOff) {
        conf += `        proxy_buffering off;\n`;
      }
      const rConnect = host.proxyConnectTimeout || 60;
      const rSend = host.proxySendTimeout || 60;
      const rRead = host.proxyReadTimeout || 60;
      conf += `        proxy_connect_timeout ${rConnect}s;\n`;
      conf += `        proxy_send_timeout ${rSend}s;\n`;
      conf += `        proxy_read_timeout ${rRead}s;\n`;
      conf += `    }\n\n`;
    }
  }

  // Main location
  conf += `    location / {\n`;
  conf += `        proxy_pass $upstream;\n`;
  conf += `        proxy_set_header Host $host;\n`;
  conf += `        proxy_set_header X-Real-IP $remote_addr;\n`;
  conf += `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n`;
  conf += `        proxy_set_header X-Forwarded-Proto $scheme;\n`;
  conf += `        proxy_set_header X-Forwarded-Host $host;\n`;
  conf += `        proxy_set_header X-Forwarded-Port $server_port;\n`;
  // Identity headers from the Azure auth sidecar — MUST be declared inside this location, not
  // at server scope. nginx REPLACES (not merges) the entire proxy_set_header set the moment a
  // child location declares any of its own, so server-scoped headers would silently drop off
  // for every request to the upstream. `$auth_*` variables are populated by the
  // `auth_request_set` directives at server scope (those DO inherit correctly).
  //
  // Emitted under multiple naming conventions so upstream apps recognize the identity out of
  // the box regardless of which ecosystem they follow:
  //   - X-Auth-*        (Oblihub-native convention)
  //   - X-Forwarded-*   (oauth2-proxy classic, Grafana, most Node/Go apps)
  //   - Remote-*        (Authelia / Traefik forward-auth, Nextcloud, Jellyfin, ...)
  // Cheap redundancy — three extra strings per request beats "the SSO integration doesn't work
  // out of the box" as a support ticket.
  if (host.azureAuthProviderId) {
    // Per-host Azure group + email restriction. Enforced HERE (post-auth) rather than at the
    // sidecar because one sidecar is shared across every proxy_host using the same provider —
    // any sidecar-side filter would apply uniformly to all of them. Per-host filters live in
    // nginx via `if ($auth_groups !~ ...) / if ($auth_email !~ ...) { return 403; }`. Two
    // independent `if`s = AND: when both filters are set, the user must satisfy both to reach
    // this host. Same semantics as oauth2-proxy's own EMAIL_DOMAINS ∧ ALLOWED_GROUPS.
    conf += azureGroupGuardLines(host, '        ');
    conf += azureEmailGuardLines(host, '        ');
    // Request headers → upstream. Kept here (not at server scope) because proxy_set_header does
    // NOT inherit into a child location that declares its own. Server-scope add_header block
    // above handles the response side — that inheritance IS fine as long as nothing in this
    // location adds its own add_header.
    conf += `        proxy_set_header X-Auth-User $auth_user;\n`;
    conf += `        proxy_set_header X-Auth-Email $auth_email;\n`;
    conf += `        proxy_set_header X-Auth-Groups $auth_groups;\n`;
    conf += `        proxy_set_header X-Auth-Preferred-Username $auth_preferred_username;\n`;
    conf += `        proxy_set_header X-Forwarded-User $auth_user;\n`;
    conf += `        proxy_set_header X-Forwarded-Email $auth_email;\n`;
    conf += `        proxy_set_header X-Forwarded-Groups $auth_groups;\n`;
    conf += `        proxy_set_header X-Forwarded-Preferred-Username $auth_preferred_username;\n`;
    conf += `        proxy_set_header Remote-User $auth_user;\n`;
    conf += `        proxy_set_header Remote-Email $auth_email;\n`;
    conf += `        proxy_set_header Remote-Name $auth_preferred_username;\n`;
    conf += `        proxy_set_header Remote-Groups $auth_groups;\n`;
  }
  conf += `        proxy_http_version 1.1;\n`;

  // When a wake target is set, intercept 5xx responses from the upstream too — not just
  // connection failures. nginx defaults to off, which means a 502/503/504 returned BY the
  // upstream (e.g. when there's a reverse proxy in front of the sleeping container that
  // reports the backend as down) gets passed through to the client transparently. With
  // proxy_intercept_errors on, those responses flow into our error_page → waking page.
  if (host.wakeContainerId) {
    conf += `        proxy_intercept_errors on;\n`;
  }

  if (host.websocketSupport) {
    conf += `        proxy_set_header Upgrade $http_upgrade;\n`;
    conf += `        proxy_set_header Connection $http_connection;\n`;
  }

  if (host.proxyBuffering === false) {
    conf += `        proxy_buffering off;\n`;
  }

  const connectTimeout = host.proxyConnectTimeout || 60;
  const sendTimeout = host.proxySendTimeout || 60;
  const readTimeout = host.proxyReadTimeout || 60;
  conf += `        proxy_connect_timeout ${connectTimeout}s;\n`;
  conf += `        proxy_send_timeout ${sendTimeout}s;\n`;
  conf += `        proxy_read_timeout ${readTimeout}s;\n`;
  conf += `    }\n`;

  if (host.advancedConfig) {
    conf += `\n    # Advanced config\n    ${host.advancedConfig.replace(/\n/g, '\n    ')}\n`;
  }

  conf += `}\n`;

  return conf;
}

// ── Redirection Host config ──

function generateRedirectionConfig(host: RedirectionHost): string {
  const domains = host.domainNames.join(' ');
  const target = `${host.forwardScheme}://${host.forwardDomain}${host.forwardPath}`;
  const resolved = host.certificate ? nginxService.resolveExistingCertFile(host.certificate) : null;
  const hasCert = !!(host.certificate && host.certificate.status === 'valid' && host.certificateId && resolved);

  let conf = `# Redirection ${host.id} - ${domains}\nserver {\n`;

  if (hasCert && resolved) {
    conf += sslBlock(
      `/etc/nginx/certs/${path.basename(resolved.fullchain)}`,
      `/etc/nginx/certs/${path.basename(resolved.key)}`,
      host.http2Support,
    ) + '\n';
  }
  conf += `    listen 80;\n    listen [::]:80;\n`;
  conf += `    server_name ${domains};\n\n`;

  // ACME challenge — MUST come before the redirect. Otherwise `location /` catches
  // /.well-known/acme-challenge/ first and emits a 301, breaking cert issuance/renewal for
  // any domain that has a Redirection entry alongside a proxy_host requesting LE.
  conf += `    location /.well-known/acme-challenge/ {\n        alias /etc/nginx/acme-challenge/;\n        allow all;\n        auth_basic off;\n    }\n\n`;

  const redirect = host.preservePath ? `${target}$request_uri` : target;
  conf += `    location / {\n        return 301 ${redirect};\n    }\n`;
  conf += `}\n`;

  return conf;
}

// ── Dead Host config ──

function generateDeadHostConfig(host: DeadHost): string {
  const domains = host.domainNames.join(' ');

  let conf = `# 404 Host ${host.id} - ${domains}\nserver {\n`;
  conf += `    listen 80;\n    listen [::]:80;\n`;
  conf += `    server_name ${domains};\n`;
  // Same rationale as Redirection: serve ACME even on a dead host so its domain can still
  // be certified (useful when a domain is temporarily parked but must keep a valid cert).
  conf += `    location /.well-known/acme-challenge/ {\n        alias /etc/nginx/acme-challenge/;\n        allow all;\n        auth_basic off;\n    }\n`;
  conf += `    location / { return 404; }\n`;
  conf += `}\n`;

  return conf;
}

// ── Main nginx.conf ──

function generateMainConfig(
  rateLimitedHosts: { id: number; rps: number }[] = [],
  hostIdMap: { hostId: number; domains: string[] }[] = [],
): string {
  const rateLimitZones = rateLimitedHosts.map(h => `    limit_req_zone $binary_remote_addr zone=rl_${h.id}:10m rate=${h.rps}r/s;`).join('\n');

  // Static map from request Host header → proxy_host_id. Populated with EVERY enabled proxy_host
  // (not just wake-enabled ones) so both the sleep-activity log_format AND the traffic log_format
  // resolve their host id from one shared http-context map. Declaring the variable via `map`
  // also satisfies nginx's parse-time requirement that log_format variables exist at http scope,
  // which a server-block `set` doesn't.
  //
  // Dedup by domain — nginx refuses a `map` with two entries on the same key ("conflicting
  // parameter ... in nginx.conf"). Operators legitimately have two proxy_hosts pointing at the
  // same domain (one legacy left disabled, or a stub / staging). First occurrence wins; the
  // request-side routing (server_name matching per vhost) is unaffected — this only picks
  // which host id is stamped in the traffic / sleep logs.
  const seenDomains = new Set<string>();
  const hostMapLines: string[] = [];
  for (const h of hostIdMap) {
    for (const d of h.domains) {
      const safe = sanitizeForNginx(d);
      if (!safe || seenDomains.has(safe)) continue;
      seenDomains.add(safe);
      hostMapLines.push(`        "${safe}" "${h.hostId}";`);
    }
  }
  const hostMapEntries = hostMapLines.join('\n');
  const wakeMapBlock = hostMapEntries
    ? `    map $host $proxy_host_id {\n        default "0";\n${hostMapEntries}\n    }`
    : `    map $host $proxy_host_id { default "0"; }`;

  return `user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    # Sleep activity log — pipe-separated, parsed by Oblihub's ActivityTracker.
    # $proxy_host_id is mapped from the request Host header via the map below (covers ALL
    # enabled proxy_hosts, not just wake-enabled ones — same variable feeds the traffic log
    # too).
${wakeMapBlock}
    log_format sleep_activity '$proxy_host_id|$msec|$status|$http_user_agent|$request_uri';

    # Traffic stats log — pipe-separated, parsed by Oblihub's TrafficLogWorker to feed the
    # per-host time-series (req/s, bytes, latency, top IPs / URIs). $request_time is nginx's
    # own timing (client-to-client), rounded to ms via $request_time*1000. Empty
    # $upstream_response_time (no upstream contacted — early 4xx, cached response) logs as "-".
    # Path is /etc/nginx/... NOT /var/log/nginx/... — the /etc/nginx dir is bind-mounted from
    # the host's <stacksDir>/_proxy/ so the log file surfaces where the Oblihub server can tail
    # it. /var/log/nginx stays inside the proxy container and would never be readable by the
    # server (same trick sleep_activity.log has been using).
    #
    # Field list (14 fields):
    #   1  $proxy_host_id       (from the host→id map above)
    #   2  $msec                (unix timestamp with ms, e.g. 1728000000.123)
    #   3  $status              (HTTP status code)
    #   4  $body_bytes_sent     (response body bytes)
    #   5  $request_length      (request bytes)
    #   6  $request_time        (edge latency in seconds, e.g. "0.024")
    #   7  $upstream_response_time (upstream latency; "-" if no upstream contacted)
    #   8  $remote_addr         (source IP)
    #   9  $request_method      (GET/POST/...)
    #  10  $request_uri         (URI with querystring)
    #  11  $http_user_agent
    #  12  $http_referer
    #  13  $upstream_cache_status (HIT/MISS/BYPASS/EXPIRED/UPDATING/STALE; "-" no cache config)
    #  14  $server_protocol     (HTTP/1.1, HTTP/2.0)
    # Any embedded pipes in UA/referer/URI would break the split; nginx escapes special chars
    # with \x00 style by default, no operator action needed.
    log_format oblihub_traffic '$proxy_host_id|$msec|$status|$body_bytes_sent|$request_length|$request_time|$upstream_response_time|$remote_addr|$request_method|$request_uri|$http_user_agent|$http_referer|$upstream_cache_status|$server_protocol';

    # Honeypot log — a request that hits either (a) a honeypot path or (b) an access-list-
    # protected host from an IP not on the list writes one line here. The Oblihub server's
    # HoneypotWorker tails it and issues a global ban via banService, which regenerates the
    # ban_map file included below.
    log_format oblihub_honeypot '$proxy_host_id|$msec|$remote_addr|$request_uri|$server_name';

    # Ban map — the entries file is generated by the server from banned_ips (one "ip" 1; line
    # per active ban). The include lives INSIDE the map body so entries auto-load. Ensured to
    # exist (empty) at startup by ensureDirs so the include never fails.
    map $remote_addr $is_banned {
        default 0;
        include /etc/nginx/ban_map.conf;
    }

    # Honeypot flag — set to "1" inside honeypot locations (path bait + ACL-violation named
    # location) and read by a server-scope 'access_log ... if=$oblihub_is_honeypot' in each
    # vhost. Rationale: putting the access_log directly inside the honeypot location works
    # only when the response is 404 straight from 'return 404;'. As soon as the host has a
    # custom error_page for 404, nginx does an internal redirect to the error page's location
    # and — per nginx's rules — the access_log used for the FINAL log line is the one from
    # the location that actually served the response, not the honeypot one. Result: the log
    # line silently disappears and the worker never sees the hit. Using a variable flag that
    # survives internal redirects and reading it at server scope with 'if=' sidesteps that.
    map $host $oblihub_is_honeypot { default ""; }

    # Ban gate — a wrapping of $is_banned that ALSO checks $uri to skip the ban check on the
    # internal error-page redirect. Without this, 'if ($is_banned) { return 404; }' at server
    # scope fires on the ORIGINAL request (fine, redirects to /oblihub_err_X_404.html) AND
    # AGAIN on the internal redirect (because 'if' re-runs the rewrite phase for every internal
    # redirect). The second fire returns 404 too, which loops back to error_page 404, which
    # loops back to the if... nginx caps this to a handful of redirects, then serves its
    # DEFAULT 404 instead of the operator's custom page. Symptom: banned users get nginx's
    # ugly 404 even when the vhost has a beautiful custom error page. This map short-circuits
    # to 0 whenever $uri looks like our internal error page path, breaking the loop.
    #
    # $uri changes on internal redirect (unlike $request_uri, which stays as the original).
    # Negative lookahead: matches "1:*" ONLY when the URI does NOT start with /oblihub_err_.
    #
    # 'volatile' is REQUIRED: nginx caches a map value for the whole request, internal redirects
    # included. Without it the gate computed on the original URI (1) is reused on the redirect to
    # /oblihub_err_*, 'return 404' fires again, and with recursive_error_pages on nginx ends in
    # "rewrite or internal redirection cycle" = a 500 for every banned IP on every vhost.
    map "$is_banned:$uri" $oblihub_ban_gate {
        volatile;
        default 0;
        "~^1:(?!/oblihub_err_)" 1;
    }

    access_log /var/log/nginx/access.log main;
    access_log /etc/nginx/oblihub_traffic.log oblihub_traffic;

    # Allow error_page directives to chain. Default is OFF: nginx only follows ONE internal
    # redirect from an error_page, then serves the raw error. Our honeypot trap needs two:
    # ACL 403 -> error_page 403 = @_oblihub_acl_honeypot (redirect #1) -> set flag; return 404
    # -> error_page 404 = /oblihub_err_*_404.html (redirect #2, blocked without this). Same
    # goes for the ban check: 'if ($is_banned) { return 404; }' uses one redirect to hit the
    # custom 404 page — fine in isolation, but if that request comes in via a URL that would
    # otherwise cause its own error_page redirect, the two would compose to two hops. Turning
    # this ON keeps the operator's custom pages visible everywhere. Depth is capped to 10 by
    # nginx internally, so it's not a footgun.
    recursive_error_pages on;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    client_max_body_size 100m;

${rateLimitZones ? `    # Rate limit zones\n${rateLimitZones}\n` : ''}    # WebSocket support
    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }
    map $http_upgrade $http_connection {
        default upgrade;
        '' "";
    }

    # Proxy cache
    proxy_cache_path /tmp/nginx-cache levels=1:2 keys_zone=proxy_cache:10m max_size=1g inactive=60m;

    # Default server - catch all with error page
    server {
        listen 80 default_server;
        listen [::]:80 default_server;
        listen 443 ssl default_server;
        listen [::]:443 ssl default_server;
        server_name _;

        # Self-signed fallback cert for default server (prevents SSL errors on unknown hosts)
        ssl_reject_handshake on;

        location /.well-known/acme-challenge/ {
            alias /etc/nginx/acme-challenge/;
            allow all;
            auth_basic off;
        }

        location / {
            return 444;
        }
    }

    include /etc/nginx/conf.d/*.conf;
}

stream {
    include /etc/nginx/stream.d/*.conf;
}
`;
}

// ── Stream config ──

function generateStreamConfig(s: { id: number; incomingPort: number; forwardingHost: string; forwardingPort: number; tcpForwarding: boolean; udpForwarding: boolean }): string {
  let conf = `# Stream ${s.id}\n`;
  if (s.tcpForwarding) {
    conf += `server {\n    listen ${s.incomingPort};\n    proxy_pass ${s.forwardingHost}:${s.forwardingPort};\n}\n`;
  }
  if (s.udpForwarding) {
    conf += `server {\n    listen ${s.incomingPort} udp;\n    proxy_pass ${s.forwardingHost}:${s.forwardingPort};\n}\n`;
  }
  return conf;
}

// ── Public API ──

export const nginxService = {
  /**
   * Regenerate ONLY the ban_map.conf file from the current banned_ips list, then send SIGHUP
   * to nginx (map file re-reads on reload). Fast path used by the HoneypotWorker every time a
   * ban is created — cheaper than a full config regen.
   *
   * The file uses nginx map syntax:
   *   "1.2.3.4" 1;
   *   "5.6.7.8" 1;
   * Written under quoted keys so IPv6 with colons parses correctly and no CIDR shortcut is
   * misinterpreted as a variable.
   */
  async writeBanMap(): Promise<void> {
    ensureDirs();
    const { banService } = await import('./ban.service');
    const ips = await banService.listActiveIps();
    const header = '# Auto-generated by Oblihub — do not edit; regenerated on every ban change\n';
    const body = ips.map(ip => `    "${ip.replace(/[";\n]/g, '')}" 1;`).join('\n');
    fs.writeFileSync(BAN_MAP_FILE, header + body + '\n');
    // Nginx sighup re-reads included files. `nginx -s reload` sends the signal.
    await this.reloadProxy();
  },

  /** Write all configs and reload nginx */
  async regenerateAndReload(): Promise<void> {
    ensureDirs();
    // Always refresh the ban_map alongside a full regen — otherwise a fresh regen would lose
    // any ban that came in between full regens.
    try {
      const { banService } = await import('./ban.service');
      const ips = await banService.listActiveIps();
      const header = '# Auto-generated by Oblihub\n';
      const body = ips.map(ip => `    "${ip.replace(/[";\n]/g, '')}" 1;`).join('\n');
      fs.writeFileSync(BAN_MAP_FILE, header + body + '\n');
    } catch { /* first-boot or migration in flight — ban_map stays empty */ }

    // Get global default error page
    const { appConfigService } = await import('./appConfig.service');
    const defaultErrorPageIdStr = await appConfigService.get('default_error_page_id');
    const defaultErrorPageId = defaultErrorPageIdStr ? parseInt(defaultErrorPageIdStr) : null;

    // Get enabled proxy hosts for rate limit zones
    const enabledHosts = await proxyHostService.getEnabled();
    const rateLimitedHosts = enabledHosts.filter(h => h.rateLimitRps).map(h => ({ id: h.id, rps: h.rateLimitRps! }));
    // Every enabled proxy_host contributes to the $host → $proxy_host_id map — used by both
    // sleep_activity AND oblihub_traffic log formats to tag each request line with its host id.
    const hostIdMap = enabledHosts.map(h => ({ hostId: h.id, domains: h.domainNames || [] }));

    // Write main config (with rate limit zones + host id map)
    fs.writeFileSync(path.join(PROXY_DIR, 'nginx.conf'), generateMainConfig(rateLimitedHosts, hostIdMap));

    // Write custom error pages to disk (one file per error code with dynamic replacement).
    // Always write files for ALL 8 codes referenced in generateProxyHostConfig — codes that
    // aren't in the page's declared errorCodes still get a rendered file (with the correct
    // code label) so nginx's error_page directive never points to a missing file.
    const ERROR_MESSAGES: Record<number, string> = {
      400: 'Bad Request', 401: 'Unauthorized', 403: 'Access Denied', 404: 'Page Not Found',
      500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
    };
    const ALL_ERROR_CODES = [400, 401, 403, 404, 500, 502, 503, 504];
    const customPages = await customPageService.getAll();
    for (const page of customPages) {
      for (const code of ALL_ERROR_CODES) {
        const message = ERROR_MESSAGES[code] || `Error ${code}`;
        const html = page.htmlContent
          .replace(/\{\{CODE\}\}/g, String(code))
          .replace(/\{\{MESSAGE\}\}/g, message);
        fs.writeFileSync(path.join(ERROR_PAGES_DIR, `page_${page.id}_${code}.html`), html);
      }
      // Generic fallback (no specific code)
      const fallbackHtml = page.htmlContent
        .replace(/\{\{CODE\}\}/g, 'Error')
        .replace(/\{\{MESSAGE\}\}/g, 'Something went wrong');
      fs.writeFileSync(path.join(ERROR_PAGES_DIR, `page_${page.id}.html`), fallbackHtml);
    }

    // Clear old waking HTML files (regenerated below per-host)
    for (const f of fs.readdirSync(ERROR_PAGES_DIR).filter(f => f.startsWith('waking_'))) {
      fs.unlinkSync(path.join(ERROR_PAGES_DIR, f));
    }

    // Clear old configs
    for (const f of fs.readdirSync(CONF_DIR)) fs.unlinkSync(path.join(CONF_DIR, f));
    for (const f of fs.readdirSync(STREAM_DIR)) fs.unlinkSync(path.join(STREAM_DIR, f));

    // Generate proxy host configs (named by primary domain)
    // Load access lists for config generation
    const allAccessLists = await accessListService.getAll();

    // Waking page templates available to proxy hosts
    const wakingPages = customPages.filter(p => p.isWakingPage);
    const defaultWakingHtml = wakingPages[0]?.htmlContent || DEFAULT_WAKING_HTML;

    // Include disabled hosts with return 503 so they keep their cert and don't leak to other vhosts
    const allProxyHosts = await proxyHostService.getAll();
    for (const host of allProxyHosts) {
      if (!host.enabled) {
        // Disabled host: keep server_name + SSL but return 503
        const domains = host.domainNames.map(d => sanitizeForNginx(d)).join(' ');
        const resolved = host.certificate ? this.resolveExistingCertFile(host.certificate) : null;
        const hasCert = host.certificate?.status === 'valid' && resolved;

        let conf = `# Disabled: ${domains}\nserver {\n    listen 80;\n    listen [::]:80;\n`;
        if (hasCert && resolved) {
          conf += `    listen 443 ssl;\n    listen [::]:443 ssl;\n    http2 on;\n`;
          conf += `    ssl_certificate /etc/nginx/certs/${path.basename(resolved.fullchain)};\n`;
          conf += `    ssl_certificate_key /etc/nginx/certs/${path.basename(resolved.key)};\n`;
        }
        conf += `    server_name ${domains};\n    return 503;\n}\n`;
        fs.writeFileSync(path.join(CONF_DIR, `${host.domainNames[0] || `proxy_${host.id}`}.conf`), conf);
      } else {
        // Apply default error page
        if (!host.errorPageId && defaultErrorPageId) host.errorPageId = defaultErrorPageId;
        // Render waking page for this host if sleep mode is enabled
        if (host.wakeContainerId) {
          const tplPage = host.wakingPageId ? wakingPages.find(p => p.id === host.wakingPageId) : null;
          const tpl = tplPage?.htmlContent || defaultWakingHtml;
          const rendered = tpl
            .replace(/\{\{PROXY_HOST_ID\}\}/g, String(host.id))
            .replace(/\{\{APP_NAME\}\}/g, sanitizeForNginx(host.domainNames[0] || `app-${host.id}`));
          fs.writeFileSync(path.join(ERROR_PAGES_DIR, `waking_${host.id}.html`), rendered);
        }
        fs.writeFileSync(path.join(CONF_DIR, `${host.domainNames[0] || `proxy_${host.id}`}.conf`), generateProxyHostConfig(host, allAccessLists));
      }
    }

    // Generate redirection configs
    const redirections = await redirectionService.getAll();
    for (const host of redirections.filter(r => r.enabled)) {
      const filename = `redir_${host.domainNames[0] || host.id}.conf`;
      fs.writeFileSync(path.join(CONF_DIR, filename), generateRedirectionConfig(host));
    }

    // Generate dead host configs
    const deadHosts = await deadHostService.getAll();
    for (const host of deadHosts.filter(h => h.enabled)) {
      const filename = `dead_${host.domainNames[0] || host.id}.conf`;
      fs.writeFileSync(path.join(CONF_DIR, filename), generateDeadHostConfig(host));
    }

    // Generate stream configs
    const streams = await streamService.getAll();
    for (const s of streams.filter(s => s.enabled)) {
      const filename = `stream_${s.id}.conf`;
      fs.writeFileSync(path.join(STREAM_DIR, filename), generateStreamConfig(s));
    }

    // Generate htpasswd files for access lists (using stored hashes)
    const accessLists = await accessListService.getAll();
    for (const list of accessLists) {
      const authRows = await db('access_list_auth').where({ access_list_id: list.id });
      const htpasswdContent = authRows.map((a: { username: string; password_hash: string }) => `${a.username}:${a.password_hash}`).join('\n');
      fs.writeFileSync(path.join(HTPASSWD_DIR, `access_list_${list.id}`), htpasswdContent);
    }

    // Per-proxy_host combined htpasswd: nginx's `auth_basic_user_file` only accepts one path,
    // so when a host stacks multiple access lists with auth users we have to write a single
    // file that's the union. Dedupe by username (last-wins — same as nginx's first-match).
    for (const host of allProxyHosts) {
      const attachedIds = host.accessListIds && host.accessListIds.length > 0
        ? host.accessListIds
        : (host.accessListId ? [host.accessListId] : []);
      const path_ = path.join(HTPASSWD_DIR, `proxy_host_${host.id}`);
      if (attachedIds.length === 0) {
        try { fs.unlinkSync(path_); } catch { /* not there, fine */ }
        continue;
      }
      const byUser = new Map<string, string>();
      for (const id of attachedIds) {
        const rows = await db('access_list_auth').where({ access_list_id: id });
        for (const r of rows) byUser.set(r.username as string, r.password_hash as string);
      }
      const merged = [...byUser.entries()].map(([u, h]) => `${u}:${h}`).join('\n');
      fs.writeFileSync(path_, merged);
    }

    // Per-route combined htpasswd for routes with accessListMode='override'. Same union +
    // last-wins-by-username as per-host; scoped by `proxy_host_<hid>_route_<rid>` so a route
    // override with its own set of auth users doesn't collide with the host's file. When a
    // route no longer uses override (or has no auth users in its override lists), unlink the
    // file so stale credentials don't linger on disk.
    for (const host of allProxyHosts) {
      if (!host.routes) continue;
      for (const route of host.routes) {
        const routePath = path.join(HTPASSWD_DIR, `proxy_host_${host.id}_route_${route.id}`);
        if (route.accessListMode !== 'override' || route.accessListOverrideIds.length === 0) {
          try { fs.unlinkSync(routePath); } catch { /* not there, fine */ }
          continue;
        }
        const byUser = new Map<string, string>();
        for (const id of route.accessListOverrideIds) {
          const rows = await db('access_list_auth').where({ access_list_id: id });
          for (const r of rows) byUser.set(r.username as string, r.password_hash as string);
        }
        if (byUser.size === 0) {
          try { fs.unlinkSync(routePath); } catch { /* not there, fine */ }
          continue;
        }
        const merged = [...byUser.entries()].map(([u, h]) => `${u}:${h}`).join('\n');
        fs.writeFileSync(routePath, merged);
      }
    }

    logger.info({ proxyHosts: allProxyHosts.length, redirections: redirections.length, streams: streams.length }, 'Nginx configs regenerated');

    // Reload nginx container (SIGHUP is safe - nginx keeps old config if new one is invalid)
    await this.reloadProxy();
  },

  /** Reload the proxy nginx container */
  async reloadProxy(): Promise<void> {
    try {
      const docker = (await import('dockerode')).default;
      const d = new docker({ socketPath: config.dockerSocket });
      const containers = await d.listContainers({ all: false });
      const proxy = containers.find(c => {
        const labels = c.Labels || {};
        return labels['oblihub.proxy'] === 'true';
      });

      if (!proxy) {
        logger.warn('No proxy container found (label oblihub.proxy=true). Configs written but not reloaded.');
        return;
      }

      const container = d.getContainer(proxy.Id);
      // Use docker exec to reload nginx (PID 1 may be sh, not nginx)
      const exec = await container.exec({
        Cmd: ['nginx', '-s', 'reload'],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({});
      // Collect output for logging
      let output = '';
      await new Promise<void>((resolve) => {
        stream.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        stream.on('end', resolve);
        stream.on('error', resolve);
      });
      if (output.trim()) logger.info({ output: output.trim() }, 'Nginx reload output');
      logger.info('Nginx proxy reloaded');
    } catch (err) {
      logger.error({ err }, 'Failed to reload nginx proxy');
    }
  },

  /** Test nginx config before applying */
  async testConfig(): Promise<{ valid: boolean; error?: string }> {
    try {
      const docker = (await import('dockerode')).default;
      const d = new docker({ socketPath: config.dockerSocket });
      const containers = await d.listContainers({ all: false });
      const proxy = containers.find(c => (c.Labels || {})['oblihub.proxy'] === 'true');
      if (!proxy) return { valid: true }; // Can't test without container

      const container = d.getContainer(proxy.Id);
      const exec = await container.exec({ Cmd: ['nginx', '-t'], AttachStdout: true, AttachStderr: true });
      const stream = await exec.start({});

      return new Promise((resolve) => {
        let output = '';
        stream.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        stream.on('end', async () => {
          const info = await exec.inspect();
          resolve({ valid: info.ExitCode === 0, error: info.ExitCode !== 0 ? output : undefined });
        });
      });
    } catch {
      return { valid: true };
    }
  },

  /**
   * File naming convention for a certificate.
   *
   * Historical scheme was `<primary-domain>.fullchain.crt`, which collided as soon as two certs
   * shared a primary domain — typical case: an initial multi-SAN LE cert with `[a.com, b.com]`,
   * then the user drops proxy_host `b.com`, recreates it and requests a fresh single-SAN cert
   * `[b.com]`. Both certs render to `b.com.fullchain.crt` on disk → the multi-SAN cert's file
   * gets silently overwritten by the single-SAN one, the vhost still linked to the multi-SAN
   * cert reads a file that no longer covers its domain, browser errors out with wrong-cert.
   *
   * New scheme: `<sanitized-primary-domain>_<id>.fullchain.crt`. Unique by construction (id),
   * lisible on disk for manual export. `<id>` is the certificate's DB PK.
   *
   * Reading: callers must pass the FULL cert row (id + domainNames). Writing: same.
   *
   * Backward-compat: `resolveExistingCertFile()` tries the new name first, falls back to the
   * legacy `<domain>.fullchain.crt` if not found. This lets a running install keep serving its
   * old certs after upgrade; each certificate migrates naturally on its next renewal (LE writes
   * under the new name, nginx vhost is regenerated with the new path).
   */
  getCertPaths(cert: { id: number; domainNames: string[] }) {
    const primaryDomain = cert.domainNames[0] || 'unknown';
    const safeDomain = primaryDomain.replace(/[^a-zA-Z0-9._-]/g, '_');
    const stem = `${safeDomain}_${cert.id}`;
    return {
      cert: path.join(CERTS_DIR, `${stem}.crt`),
      key: path.join(CERTS_DIR, `${stem}.key`),
      chain: path.join(CERTS_DIR, `${stem}.chain.crt`),
      fullchain: path.join(CERTS_DIR, `${stem}.fullchain.crt`),
    };
  },

  /**
   * Try the new `<domain>_<id>` naming first, fall back to legacy `<domain>` for certs that
   * haven't been re-written since the naming change. Returns { fullchain, key } on success or
   * null when neither exists. Used by vhost generation to decide whether the cert is usable.
   */
  resolveExistingCertFile(cert: { id: number; domainNames: string[] } | null): { fullchain: string; key: string } | null {
    if (!cert) return null;
    const primaryDomain = cert.domainNames[0] || '';
    if (!primaryDomain) return null;
    const modern = this.getCertPaths(cert);
    if (fs.existsSync(modern.fullchain) && fs.existsSync(modern.key)) {
      return { fullchain: modern.fullchain, key: modern.key };
    }
    const safeDomain = primaryDomain.replace(/[^a-zA-Z0-9._-]/g, '_');
    const legacyFullchain = path.join(CERTS_DIR, `${safeDomain}.fullchain.crt`);
    const legacyKey = path.join(CERTS_DIR, `${safeDomain}.key`);
    if (fs.existsSync(legacyFullchain) && fs.existsSync(legacyKey)) {
      return { fullchain: legacyFullchain, key: legacyKey };
    }
    return null;
  },

  /** @deprecated kept for legacy call sites — new code should use getCertPaths(cert). */
  getCertPathsByDomain(domain: string) {
    const safeDomain = domain.replace(/[^a-zA-Z0-9._-]/g, '_');
    return {
      cert: path.join(CERTS_DIR, `${safeDomain}.crt`),
      key: path.join(CERTS_DIR, `${safeDomain}.key`),
      chain: path.join(CERTS_DIR, `${safeDomain}.chain.crt`),
      fullchain: path.join(CERTS_DIR, `${safeDomain}.fullchain.crt`),
    };
  },

  /** Write certificate files under the `<domain>_<id>` scheme. */
  writeCertFiles(cert: { id: number; domainNames: string[] }, certContent: string, key: string, chain?: string): void {
    ensureDirs();
    const paths = this.getCertPaths(cert);
    fs.writeFileSync(paths.cert, certContent);
    fs.writeFileSync(paths.key, key, { mode: 0o600 });
    if (chain) fs.writeFileSync(paths.chain, chain);
    const fullchain = chain ? certContent + '\n' + chain : certContent;
    fs.writeFileSync(paths.fullchain, fullchain);
  },

  /** Get the ACME challenge directory path */
  getAcmeDir(): string {
    ensureDirs();
    return ACME_DIR;
  },

  /** Get the proxy config directory */
  getProxyDir(): string {
    return PROXY_DIR;
  },
};
