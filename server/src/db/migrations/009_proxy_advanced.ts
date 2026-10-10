import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Custom error pages
  await knex.schema.createTable('custom_pages', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.text('description').nullable();
    t.jsonb('error_codes').notNullable(); // [404] or [500, 502, 503, 504]
    t.text('html_content').notNullable();
    t.string('theme', 30).notNullable().defaultTo('custom');
    t.boolean('is_builtin').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });

  // Extended proxy host options
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.string('client_max_body_size', 20).nullable();
    t.integer('proxy_connect_timeout').nullable();
    t.integer('proxy_send_timeout').nullable();
    t.integer('proxy_read_timeout').nullable();
    t.boolean('proxy_buffering').nullable();
    t.integer('rate_limit_rps').nullable();
    t.integer('rate_limit_burst').nullable();
    t.boolean('gzip_enabled').notNullable().defaultTo(false);
    t.boolean('cors_enabled').notNullable().defaultTo(false);
    t.jsonb('custom_response_headers').nullable();
    t.integer('error_page_id').nullable().references('id').inTable('custom_pages').onDelete('SET NULL');
  });

  // Seed built-in error pages (use {{CODE}} and {{MESSAGE}} as dynamic placeholders)
  const ERROR_MESSAGES: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Access Denied', 404: 'Page Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
  void ERROR_MESSAGES; // used at runtime by nginx.service

  await knex('custom_pages').insert([
    {
      name: 'Navy Dark',
      description: 'Dark navy theme with animations and Oblihub branding',
      error_codes: JSON.stringify([400, 401, 403, 404, 500, 502, 503, 504]),
      theme: 'navy-dark',
      is_builtin: true,
      html_content: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{CODE}} – {{MESSAGE}}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;600;700&family=DM+Mono&display=swap');
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  :root{--navy:#0a0f1e;--blue:#4a9eff;--muted:#6b7fa3}
  html,body{height:100%;background:var(--navy);color:#fff;font-family:'DM Sans',sans-serif;overflow:hidden}
  body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(74,158,255,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(74,158,255,0.04) 1px,transparent 1px);background-size:40px 40px;pointer-events:none}
  body::after{content:'';position:fixed;width:500px;height:500px;bottom:-150px;left:-150px;background:radial-gradient(circle,rgba(74,158,255,0.12) 0%,transparent 70%);pointer-events:none}
  .page{height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;z-index:1;padding:40px}
  .code{font-size:clamp(100px,18vw,140px);font-weight:700;line-height:1;letter-spacing:-6px;background:linear-gradient(135deg,#fff 20%,rgba(74,158,255,0.6) 80%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;opacity:0;animation:u .6s .15s ease forwards}
  .sep{width:48px;height:2px;background:linear-gradient(90deg,transparent,var(--blue),transparent);margin:20px auto;opacity:0;animation:u .6s .25s ease forwards}
  .title{font-size:20px;font-weight:600;color:#e0e8ff;margin-bottom:12px;opacity:0;animation:u .6s .3s ease forwards}
  .msg{font-size:14px;color:var(--muted);line-height:1.8;text-align:center;max-width:420px;margin-bottom:36px;opacity:0;animation:u .6s .38s ease forwards}
  .actions{display:flex;gap:12px;opacity:0;animation:u .6s .45s ease forwards}
  .btn{display:inline-flex;align-items:center;gap:8px;padding:12px 28px;background:linear-gradient(135deg,#1a4a8a,#0d2a5c);border:1px solid rgba(74,158,255,0.3);border-radius:6px;color:var(--blue);font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer;transition:all .25s}
  .btn:hover{background:linear-gradient(135deg,#2a5aaa,#1d3a7a);border-color:rgba(74,158,255,0.6)}
  .footer{position:fixed;bottom:0;left:0;right:0;height:32px;display:flex;align-items:center;justify-content:center;opacity:0;animation:f .8s .7s ease forwards}
  .footer a{font-family:'DM Mono',monospace;font-size:10px;color:#1e2d45;text-decoration:none;letter-spacing:0.5px}
  .footer a:hover{color:#3a5070}
  @keyframes u{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
  @keyframes f{to{opacity:1}}
</style>
</head>
<body>
<div class="page">
  <div class="code">{{CODE}}</div>
  <div class="sep"></div>
  <div class="title">{{MESSAGE}}</div>
  <div class="msg">The requested resource could not be served. Please try again or return to the homepage.</div>
  <div class="actions">
    <a class="btn" href="javascript:location.reload()">Try Again</a>
    <a class="btn" href="/">Back to Home</a>
  </div>
</div>
<div class="footer"><a href="https://github.com/obli-tools/oblihub" target="_blank">Powered by Oblihub</a></div>
</body>
</html>`,
    },
    {
      name: 'Terminal Green',
      description: 'Retro terminal style with dynamic error codes',
      error_codes: JSON.stringify([400, 401, 403, 404, 500, 502, 503, 504]),
      theme: 'terminal',
      is_builtin: true,
      html_content: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{CODE}} – {{MESSAGE}}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%;background:#0c0c0c;color:#33ff33;font-family:'JetBrains Mono',monospace}
  body::before{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,rgba(0,255,0,0.03) 0px,transparent 1px,transparent 3px);pointer-events:none}
  .page{height:100vh;display:flex;flex-direction:column;justify-content:center;padding:40px 60px;max-width:700px}
  .prompt{color:#888;font-size:12px;margin-bottom:8px;opacity:0;animation:t .3s .2s forwards}
  .cmd{font-size:14px;margin-bottom:24px;opacity:0;animation:t .3s .4s forwards}.cmd span{color:#ff3333}
  .error-block{border-left:2px solid #33ff33;padding-left:16px;margin-bottom:24px;opacity:0;animation:t .3s .6s forwards}
  .error-code{font-size:48px;font-weight:700;line-height:1.2}
  .error-msg{font-size:13px;color:#aaa;margin-top:8px;line-height:1.6}
  .action{opacity:0;animation:t .3s .8s forwards}
  .action a{color:#33ff33;text-decoration:none;font-size:13px;border-bottom:1px dashed #33ff33;padding-bottom:2px}
  .action a:hover{color:#66ff66}
  .cursor{display:inline-block;width:8px;height:14px;background:#33ff33;animation:b 1s infinite;margin-left:4px;vertical-align:middle}
  .footer{position:fixed;bottom:8px;right:16px;opacity:0;animation:t .3s 1s forwards}
  .footer a{color:#1a1a1a;font-size:9px;text-decoration:none}.footer a:hover{color:#333}
  @keyframes t{to{opacity:1}}
  @keyframes b{0%,100%{opacity:1}50%{opacity:0}}
</style>
</head>
<body>
<div class="page">
  <div class="prompt">user@server:~$</div>
  <div class="cmd">curl -I <span>request_uri</span></div>
  <div class="error-block">
    <div class="error-code">{{CODE}}</div>
    <div class="error-msg">{{MESSAGE}}<br>The upstream server returned an unexpected response.</div>
  </div>
  <div class="action"><a href="/">$ cd /home</a><span class="cursor"></span></div>
</div>
<div class="footer"><a href="https://github.com/obli-tools/oblihub" target="_blank">oblihub</a></div>
</body>
</html>`,
    },
    {
      name: 'Minimal Light',
      description: 'Clean minimal light theme with dynamic codes',
      error_codes: JSON.stringify([400, 401, 403, 404, 500, 502, 503, 504]),
      theme: 'minimal-light',
      is_builtin: true,
      html_content: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{CODE}} – {{MESSAGE}}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%;background:#fafafa;color:#111;font-family:'Inter',sans-serif}
  .page{height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px}
  .code{font-size:120px;font-weight:700;line-height:1;color:#e0e0e0;letter-spacing:-4px}
  .sep{width:40px;height:3px;background:#111;margin:24px 0;border-radius:2px}
  .title{font-size:18px;font-weight:600;color:#333;margin-bottom:8px}
  .msg{font-size:14px;color:#888;line-height:1.7;text-align:center;max-width:380px;margin-bottom:32px}
  .btn{padding:10px 24px;background:#111;color:#fff;border:none;border-radius:6px;font-family:'Inter',sans-serif;font-size:13px;font-weight:500;text-decoration:none;cursor:pointer;transition:background .2s}
  .btn:hover{background:#333}
  .footer{position:fixed;bottom:8px;right:16px}
  .footer a{color:#ddd;font-size:9px;text-decoration:none}.footer a:hover{color:#aaa}
</style>
</head>
<body>
<div class="page">
  <div class="code">{{CODE}}</div>
  <div class="sep"></div>
  <div class="title">{{MESSAGE}}</div>
  <div class="msg">The requested resource is not available. Please try again or return to the homepage.</div>
  <a class="btn" href="/">Go Home</a>
</div>
<div class="footer"><a href="https://github.com/obli-tools/oblihub" target="_blank">Powered by Oblihub</a></div>
</body>
</html>`,
    },
  ]);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.dropColumn('client_max_body_size');
    t.dropColumn('proxy_connect_timeout');
    t.dropColumn('proxy_send_timeout');
    t.dropColumn('proxy_read_timeout');
    t.dropColumn('proxy_buffering');
    t.dropColumn('rate_limit_rps');
    t.dropColumn('rate_limit_burst');
    t.dropColumn('gzip_enabled');
    t.dropColumn('cors_enabled');
    t.dropColumn('custom_response_headers');
    t.dropColumn('error_page_id');
  });
  await knex.schema.dropTableIfExists('custom_pages');
}
