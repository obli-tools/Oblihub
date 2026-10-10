import type { Knex } from 'knex';

const DEFAULT_WAKING_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Waking up {{APP_NAME}}…</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d1a;color:#e8ecf5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}.card{max-width:480px;padding:32px;text-align:center}.spinner{width:48px;height:48px;margin:0 auto 24px;border:3px solid rgba(45,78,201,.2);border-top-color:#2d4ec9;border-radius:50%;animation:spin .9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}h1{font-size:20px;margin:0 0 8px;font-weight:600}p{margin:0;color:#8c93b6;font-size:14px;line-height:1.5}.elapsed{margin-top:16px;font-family:'JetBrains Mono',Consolas,monospace;font-size:12px;color:#5a78e8}.error{color:#e03a3a;margin-top:16px;display:none}.error.visible{display:block}</style>
</head><body><div class="card"><div class="spinner"></div><h1>Waking up {{APP_NAME}}…</h1><p>The application was idle and shut down to save resources. It's starting back up — this can take up to a minute for AI workloads.</p><div class="elapsed"><span id="elapsed">0</span>s elapsed</div><div class="error" id="error">Wake failed — <a href="javascript:location.reload()" style="color:#5a78e8">retry</a></div></div>
<script>(function(){var host={{PROXY_HOST_ID}};var start=Date.now();var el=document.getElementById('elapsed');var err=document.getElementById('error');setInterval(function(){el.textContent=Math.floor((Date.now()-start)/1000);},250);function poll(){fetch('/__oblihub_internal/wake/status?host='+host,{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){if(d&&d.success&&d.data&&d.data.ready){location.reload();}else if(d&&d.data&&d.data.state==='wake_failed'){err.classList.add('visible');}else{setTimeout(poll,1500);}}).catch(function(){setTimeout(poll,2000);});}fetch('/__oblihub_internal/wake?host='+host,{method:'POST',cache:'no-store'}).finally(function(){poll();});})();</script>
</body></html>`;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.integer('wake_container_id').nullable().references('id').inTable('containers').onDelete('SET NULL');
    t.integer('waking_page_id').nullable().references('id').inTable('custom_pages').onDelete('SET NULL');
  });
  await knex.schema.alterTable('custom_pages', (t) => {
    t.boolean('is_waking_page').notNullable().defaultTo(false);
  });
  await knex('custom_pages').insert({
    name: 'Default Waking Page',
    description: 'Built-in loading screen for proxy hosts with sleep mode enabled',
    error_codes: JSON.stringify([]),
    html_content: DEFAULT_WAKING_HTML,
    theme: 'obli-operator',
    is_builtin: true,
    is_waking_page: true,
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('proxy_hosts', (t) => {
    t.dropColumn('wake_container_id');
    t.dropColumn('waking_page_id');
  });
  await knex.schema.alterTable('custom_pages', (t) => {
    t.dropColumn('is_waking_page');
  });
}
