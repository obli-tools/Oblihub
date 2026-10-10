import { useEffect, useState } from 'react';
import { Plus, Trash2, Edit2, Play, Key, Server, Workflow as WorkflowIcon, RefreshCw, Copy, Clock, AlertTriangle, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import type { SshKey, WorkflowTarget, Workflow, WorkflowRun, WorkflowActionType, WorkflowTriggerType, Stack, Certificate, Team } from '@oblihub/shared';
import { sshKeysApi, workflowTargetsApi, workflowsApi } from '@/api/automation.api';
import { proxyApi } from '@/api/proxy.api';
import { stacksApi } from '@/api/stacks.api';
import { teamsApi } from '@/api/teams.api';

type Tab = 'workflows' | 'targets' | 'ssh_keys';

/**
 * Unified Automation page. Three inter-linked resources: SSH keys → used by → Targets → used by
 * → Workflows. Presented as tabs so an operator sees the whole chain in one place. Each tab has
 * its own list + modal editor.
 */
export function AutomationPage() {
  const [tab, setTab] = useState<Tab>('workflows');
  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-text-primary">Automation</h1>
      </div>
      <div className="border-b border-border flex gap-1 mb-6">
        <TabButton icon={WorkflowIcon} label="Workflows"     active={tab === 'workflows'} onClick={() => setTab('workflows')} />
        <TabButton icon={Server}       label="Targets"       active={tab === 'targets'}   onClick={() => setTab('targets')} />
        <TabButton icon={Key}          label="SSH Keys"      active={tab === 'ssh_keys'}  onClick={() => setTab('ssh_keys')} />
      </div>
      {tab === 'workflows' && <WorkflowsSection />}
      {tab === 'targets'   && <TargetsSection />}
      {tab === 'ssh_keys'  && <SshKeysSection />}
    </div>
  );
}

function TabButton({ icon: Icon, label, active, onClick }: { icon: typeof Key; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm border-b-2 transition-colors flex items-center gap-2 ${
        active ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-primary'
      }`}
    >
      <Icon size={14} /> {label}
    </button>
  );
}

// ── Workflows ──

function WorkflowsSection() {
  const [items, setItems] = useState<Workflow[]>([]);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [targets, setTargets] = useState<WorkflowTarget[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [editing, setEditing] = useState<Partial<Workflow> | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [runsOf, setRunsOf] = useState<number | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);

  const load = async () => {
    try {
      const [w, c, s, t, tm] = await Promise.all([
        workflowsApi.list(),
        proxyApi.listCertificates().catch(() => []),
        stacksApi.list().catch(() => []),
        workflowTargetsApi.list().catch(() => []),
        teamsApi.list().catch(() => []),
      ]);
      setItems(w); setCerts(c); setStacks(s); setTargets(t); setTeams(tm);
    } catch { toast.error('Failed to load workflows'); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (runsOf == null) return;
    const fetchRuns = () => workflowsApi.listRuns(runsOf).then(setRuns).catch(() => {});
    fetchRuns();
    const interval = setInterval(fetchRuns, 3000);
    return () => clearInterval(interval);
  }, [runsOf]);

  const startCreate = () => setEditing({
    name: '', enabled: true, actionType: 'ssl-export-sftp', actionConfig: { certificateId: 0, targetId: 0 } as never,
    triggerType: 'on-cert-renew', triggerConfig: { certificateId: 0 } as never,
  });
  const startEdit = (w: Workflow) => { setEditing({ ...w }); setEditId(w.id); };
  const handleSave = async () => {
    if (!editing?.name || !editing.actionType || !editing.triggerType) { toast.error('Missing required fields'); return; }
    try {
      if (editId) await workflowsApi.update(editId, editing);
      else await workflowsApi.create(editing);
      toast.success(editId ? 'Workflow updated' : 'Workflow created');
      setEditing(null); setEditId(null);
      await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed'); }
  };
  const handleDelete = async (id: number) => {
    if (!confirm('Delete this workflow?')) return;
    await workflowsApi.delete(id).then(() => { toast.success('Deleted'); load(); }).catch(e => toast.error(e.message));
  };
  const handleRun = async (id: number) => {
    await workflowsApi.runNow(id).then(() => { toast.success('Started'); setRunsOf(id); }).catch(e => toast.error(e.message));
  };

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button onClick={startCreate} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
          <Plus size={14} /> New Workflow
        </button>
      </div>
      {items.length === 0 ? (
        <div className="text-center py-16 text-text-muted">No workflows yet. Create one to automate SSL exports, stack restarts, etc.</div>
      ) : (
        <div className="space-y-2">
          {items.map(w => (
            <WorkflowRow key={w.id} workflow={w} certs={certs} targets={targets} stacks={stacks}
              onEdit={() => startEdit(w)} onDelete={() => handleDelete(w.id)} onRun={() => handleRun(w.id)}
              onShowRuns={() => setRunsOf(w.id)} />
          ))}
        </div>
      )}

      {editing && (
        <WorkflowEditor
          editing={editing} setEditing={setEditing} editId={editId}
          certs={certs} targets={targets} stacks={stacks} teams={teams}
          onSave={handleSave} onCancel={() => { setEditing(null); setEditId(null); }}
        />
      )}

      {runsOf != null && (
        <RunsModal workflowId={runsOf} runs={runs} onClose={() => setRunsOf(null)} />
      )}
    </div>
  );
}

function WorkflowRow({ workflow: w, certs, targets, stacks, onEdit, onDelete, onRun, onShowRuns }: {
  workflow: Workflow;
  certs: Certificate[]; targets: WorkflowTarget[]; stacks: Stack[];
  onEdit: () => void; onDelete: () => void; onRun: () => void; onShowRuns: () => void;
}) {
  const trigger = describeTrigger(w, certs);
  const action = describeAction(w, certs, targets, stacks);
  return (
    <div className={`rounded-xl border bg-bg-secondary p-3 flex items-center gap-3 ${w.enabled ? 'border-border' : 'border-border opacity-50'}`}>
      <div className={`h-2.5 w-2.5 rounded-full ${w.enabled ? 'bg-status-up' : 'bg-text-muted'}`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary">{w.name}</div>
        <div className="text-xs text-text-muted">
          <span className="text-accent">{trigger}</span> → <span>{action}</span>
        </div>
        {w.description && <div className="text-[11px] text-text-muted mt-0.5">{w.description}</div>}
      </div>
      <div className="flex items-center gap-1">
        <button onClick={onRun} title="Run now" className="p-1.5 rounded-md text-text-muted hover:text-accent hover:bg-bg-hover"><Play size={14} /></button>
        <button onClick={onShowRuns} title="History" className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover"><Clock size={14} /></button>
        <button onClick={onEdit} title="Edit" className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover"><Edit2 size={14} /></button>
        <button onClick={onDelete} title="Delete" className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-bg-hover"><Trash2 size={14} /></button>
      </div>
    </div>
  );
}

function describeTrigger(w: Workflow, certs: Certificate[]): string {
  const cfg = w.triggerConfig as Record<string, unknown>;
  switch (w.triggerType) {
    case 'on-cert-renew': {
      const cert = certs.find(c => c.id === (cfg as { certificateId?: number }).certificateId);
      return `on cert-renew: ${cert?.domainNames?.[0] || `#${(cfg as { certificateId?: number }).certificateId ?? '?'}`}`;
    }
    case 'schedule-interval': return `every ${cfg.intervalSeconds || '?'}s`;
    case 'schedule-cron': return `cron "${cfg.cron || '?'}"`;
    case 'on-demand': return 'on-demand only';
    default: return String(w.triggerType);
  }
}

function describeAction(w: Workflow, certs: Certificate[], targets: WorkflowTarget[], stacks: Stack[]): string {
  const cfg = w.actionConfig as Record<string, unknown>;
  if (w.actionType === 'ssl-export-sftp') {
    const cert = certs.find(c => c.id === cfg.certificateId);
    const target = targets.find(t => t.id === cfg.targetId);
    return `SFTP export ${cert?.domainNames?.[0] || '?'} → ${target?.name || '?'}`;
  }
  if (w.actionType === 'restart-stacks') {
    if (cfg.scope === 'all') return 'restart all stacks';
    if (cfg.scope === 'team') return `restart team stacks (team #${cfg.teamId})`;
    const stack = stacks.find(s => s.id === cfg.stackId);
    return `restart stack ${stack?.name || `#${cfg.stackId}`}`;
  }
  return String(w.actionType);
}

// ── Workflow editor (modal) ──

function WorkflowEditor({ editing, setEditing, editId, certs, targets, stacks, teams, onSave, onCancel }: {
  editing: Partial<Workflow>;
  setEditing: (updater: (prev: Partial<Workflow> | null) => Partial<Workflow> | null) => void;
  editId: number | null;
  certs: Certificate[]; targets: WorkflowTarget[]; stacks: Stack[]; teams: Team[];
  onSave: () => void; onCancel: () => void;
}) {
  const patch = (delta: Partial<Workflow>) => setEditing(e => e ? { ...e, ...delta } : null);
  const patchAction = (delta: Record<string, unknown>) => patch({ actionConfig: { ...(editing.actionConfig as object || {}), ...delta } as never });
  const patchTrigger = (delta: Record<string, unknown>) => patch({ triggerConfig: { ...(editing.triggerConfig as object || {}), ...delta } as never });
  const cfg = (editing.actionConfig || {}) as Record<string, unknown>;
  const tcfg = (editing.triggerConfig || {}) as Record<string, unknown>;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50" onClick={onCancel}>
      <div className="rounded-xl border border-border bg-bg-primary w-full max-w-2xl max-h-[85vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary">{editId ? 'Edit' : 'New'} Workflow</h2>
        </div>
        <div className="p-6 space-y-5">
          {/* General */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-text-secondary block mb-1.5">Name</label>
              <input value={editing.name || ''} onChange={e => patch({ name: e.target.value })}
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            </div>
            <div>
              <label className="text-xs font-medium text-text-secondary block mb-1.5">Scope</label>
              <select
                value={editing.teamId ? `team-${editing.teamId}` : editing.ownerUserId ? 'personal' : 'global'}
                onChange={e => {
                  const v = e.target.value;
                  if (v === 'global')   patch({ teamId: null, ownerUserId: null });
                  else if (v === 'personal') patch({ teamId: null, ownerUserId: null }); // service will fill ownerUserId if needed
                  else                  patch({ teamId: parseInt(v.replace('team-', '')), ownerUserId: null });
                }}
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="global">Global (all admins)</option>
                {teams.map(t => <option key={t.id} value={`team-${t.id}`}>Team: {t.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-text-secondary block mb-1.5">Description</label>
            <input value={editing.description || ''} onChange={e => patch({ description: e.target.value })}
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>

          {/* Trigger */}
          <div className="border-t border-border pt-4">
            <div className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Trigger</div>
            <select
              value={editing.triggerType}
              onChange={e => patch({ triggerType: e.target.value as WorkflowTriggerType, triggerConfig: {} as never })}
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent mb-2"
            >
              <option value="on-cert-renew">On certificate renewal</option>
              <option value="schedule-interval">Every N seconds</option>
              <option value="schedule-cron">Cron expression</option>
              <option value="on-demand">On-demand only (no auto-trigger)</option>
            </select>
            {editing.triggerType === 'on-cert-renew' && (
              <select value={String(tcfg.certificateId ?? '')} onChange={e => patchTrigger({ certificateId: parseInt(e.target.value) || 0 })}
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                <option value="">Select certificate…</option>
                {certs.map(c => <option key={c.id} value={c.id}>{c.domainNames.join(', ')}</option>)}
              </select>
            )}
            {editing.triggerType === 'schedule-interval' && (
              <input type="number" min={10} value={Number(tcfg.intervalSeconds) || 3600} onChange={e => patchTrigger({ intervalSeconds: parseInt(e.target.value) || 3600 })}
                placeholder="Interval in seconds"
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            )}
            {editing.triggerType === 'schedule-cron' && (
              <input value={String(tcfg.cron || '')} onChange={e => patchTrigger({ cron: e.target.value })}
                placeholder="0 3 * * *   (min hour dom month dow)"
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            )}
          </div>

          {/* Action */}
          <div className="border-t border-border pt-4">
            <div className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Action</div>
            <select
              value={editing.actionType}
              onChange={e => patch({ actionType: e.target.value as WorkflowActionType, actionConfig: {} as never })}
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent mb-2"
            >
              <option value="ssl-export-sftp">Export SSL certificate via SFTP</option>
              <option value="restart-stacks">Restart stack(s)</option>
            </select>
            {editing.actionType === 'ssl-export-sftp' && (
              <div className="space-y-2">
                <select value={String(cfg.certificateId ?? '')} onChange={e => patchAction({ certificateId: parseInt(e.target.value) || 0 })}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                  <option value="">Select certificate to export…</option>
                  {certs.map(c => <option key={c.id} value={c.id}>{c.domainNames.join(', ')}</option>)}
                </select>
                <select value={String(cfg.targetId ?? '')} onChange={e => patchAction({ targetId: parseInt(e.target.value) || 0 })}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                  <option value="">Select target…</option>
                  {targets.map(t => <option key={t.id} value={t.id}>{t.name} ({t.username}@{t.host}:{t.port} {t.remotePath})</option>)}
                </select>
                <label className="flex items-center gap-2 text-xs text-text-secondary">
                  <input type="checkbox" checked={!!cfg.alsoExportChain} onChange={e => patchAction({ alsoExportChain: e.target.checked })} />
                  Also export chain file (if present)
                </label>
              </div>
            )}
            {editing.actionType === 'restart-stacks' && (
              <div className="space-y-2">
                <select value={String(cfg.scope || 'stack')} onChange={e => patchAction({ scope: e.target.value, stackId: null, teamId: null })}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                  <option value="stack">Single stack</option>
                  <option value="team">All stacks in a team</option>
                  <option value="all">All stacks</option>
                </select>
                {cfg.scope === 'stack' && (
                  <select value={String(cfg.stackId ?? '')} onChange={e => patchAction({ stackId: parseInt(e.target.value) || 0 })}
                    className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                    <option value="">Select stack…</option>
                    {stacks.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                )}
                {cfg.scope === 'team' && (
                  <select value={String(cfg.teamId ?? '')} onChange={e => patchAction({ teamId: parseInt(e.target.value) || 0 })}
                    className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                    <option value="">Select team…</option>
                    {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" checked={editing.enabled ?? true} onChange={e => patch({ enabled: e.target.checked })} />
              Enabled
            </label>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          <button onClick={onSave} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Runs modal ──

function RunsModal({ workflowId, runs, onClose }: { workflowId: number; runs: WorkflowRun[]; onClose: () => void }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50" onClick={onClose}>
      <div className="rounded-xl border border-border bg-bg-primary w-full max-w-2xl max-h-[85vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">Workflow #{workflowId} — Runs</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">&times;</button>
        </div>
        <div className="p-6 space-y-2">
          {runs.length === 0 && <div className="text-text-muted text-sm text-center py-8">No runs yet.</div>}
          {runs.map(r => (
            <div key={r.id} className="rounded-lg border border-border bg-bg-tertiary/40">
              <button
                onClick={() => setExpanded(x => { const n = new Set(x); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
                className="w-full flex items-center gap-3 px-3 py-2 text-left"
              >
                <div className={`h-2 w-2 rounded-full ${r.status === 'success' ? 'bg-status-up' : r.status === 'failed' ? 'bg-status-down' : r.status === 'running' ? 'bg-accent animate-pulse' : 'bg-text-muted'}`} />
                <span className="text-xs font-mono text-text-primary">{new Date(r.startedAt).toLocaleString()}</span>
                <span className="text-[10px] text-text-muted">{r.triggerSource}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.status === 'success' ? 'bg-status-up/10 text-status-up' : r.status === 'failed' ? 'bg-status-down/10 text-status-down' : r.status === 'skipped' ? 'bg-text-muted/10 text-text-muted' : 'bg-accent/10 text-accent'}`}>{r.status}</span>
                <span className="text-[10px] text-text-muted ml-auto">{r.durationMs ? `${r.durationMs}ms` : ''}</span>
              </button>
              {expanded.has(r.id) && (
                <div className="border-t border-border p-2 bg-[#0d1117] font-mono text-[11px] max-h-64 overflow-auto">
                  {r.outputLog.length === 0 && <div className="text-text-muted">(no log)</div>}
                  {r.outputLog.map((l, i) => (
                    <div key={i} className={l.level === 'error' ? 'text-status-down' : l.level === 'warn' ? 'text-status-pending' : 'text-text-secondary'}>
                      <span className="text-text-muted">[{new Date(l.ts).toLocaleTimeString()}]</span> {l.message}
                    </div>
                  ))}
                  {r.errorMessage && <div className="mt-2 text-status-down"><AlertTriangle size={12} className="inline" /> {r.errorMessage}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Targets ──

function TargetsSection() {
  const [items, setItems] = useState<WorkflowTarget[]>([]);
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [editing, setEditing] = useState<Partial<WorkflowTarget> | null>(null);
  const [editId, setEditId] = useState<number | null>(null);

  const load = async () => {
    const [t, k, tm] = await Promise.all([
      workflowTargetsApi.list().catch(() => []),
      sshKeysApi.list().catch(() => []),
      teamsApi.list().catch(() => []),
    ]);
    setItems(t); setKeys(k); setTeams(tm);
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing?.name || !editing.host || !editing.username || !editing.remotePath || !editing.sshKeyId) {
      toast.error('Missing required fields'); return;
    }
    try {
      if (editId) await workflowTargetsApi.update(editId, editing);
      else await workflowTargetsApi.create(editing);
      toast.success('Saved'); setEditing(null); setEditId(null); load();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed'); }
  };

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button onClick={() => setEditing({ name: '', host: '', port: 22, username: '', remotePath: '/', targetType: 'sftp' })}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
          <Plus size={14} /> New Target
        </button>
      </div>
      {items.length === 0 ? (
        <div className="text-center py-16 text-text-muted">No SFTP targets. Add one to push certificates or files to a remote server.</div>
      ) : (
        <div className="space-y-2">
          {items.map(t => (
            <div key={t.id} className="rounded-xl border border-border bg-bg-secondary p-3 flex items-center gap-3">
              <Server size={14} className="text-text-muted" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-primary">{t.name}</div>
                <div className="text-xs text-text-muted font-mono">{t.username}@{t.host}:{t.port} {t.remotePath}</div>
              </div>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">{t.targetType}</span>
              <div className="flex items-center gap-1">
                <button onClick={() => { setEditing({ ...t }); setEditId(t.id); }} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover"><Edit2 size={14} /></button>
                <button onClick={() => confirm('Delete this target?') && workflowTargetsApi.delete(t.id).then(load).catch(e => toast.error(e.message))} className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-bg-hover"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50" onClick={() => { setEditing(null); setEditId(null); }}>
          <div className="rounded-xl border border-border bg-bg-primary w-full max-w-lg overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border"><h2 className="text-sm font-semibold text-text-primary">{editId ? 'Edit' : 'New'} SFTP Target</h2></div>
            <div className="p-6 space-y-3">
              <Field label="Name"><input value={editing.name || ''} onChange={e => setEditing(x => x ? { ...x, name: e.target.value } : null)} className={inputCls} /></Field>
              <Field label="Description (optional)"><input value={editing.description || ''} onChange={e => setEditing(x => x ? { ...x, description: e.target.value } : null)} className={inputCls} /></Field>
              <div className="grid grid-cols-[1fr_100px] gap-3">
                <Field label="Host"><input value={editing.host || ''} onChange={e => setEditing(x => x ? { ...x, host: e.target.value } : null)} placeholder="192.168.1.10 or dc.internal" className={inputCls} /></Field>
                <Field label="Port"><input type="number" value={editing.port || 22} onChange={e => setEditing(x => x ? { ...x, port: parseInt(e.target.value) || 22 } : null)} className={inputCls} /></Field>
              </div>
              <Field label="Username"><input value={editing.username || ''} onChange={e => setEditing(x => x ? { ...x, username: e.target.value } : null)} className={inputCls} /></Field>
              <Field label="Remote path"><input value={editing.remotePath || ''} onChange={e => setEditing(x => x ? { ...x, remotePath: e.target.value } : null)} placeholder="/etc/ssl/certs/" className={inputCls + ' font-mono'} /></Field>
              <Field label="SSH key">
                <select value={editing.sshKeyId ?? ''} onChange={e => setEditing(x => x ? { ...x, sshKeyId: parseInt(e.target.value) || null } : null)} className={inputCls}>
                  <option value="">Select key…</option>
                  {keys.map(k => <option key={k.id} value={k.id}>{k.name} ({k.fingerprint.slice(0, 20)}…)</option>)}
                </select>
              </Field>
              <Field label="Host key fingerprint (optional, SHA256:...)"><input value={editing.hostKeyFingerprint || ''} onChange={e => setEditing(x => x ? { ...x, hostKeyFingerprint: e.target.value || null } : null)} className={inputCls + ' font-mono'} /></Field>
              <Field label="Scope">
                <select
                  value={editing.teamId ? `team-${editing.teamId}` : 'global'}
                  onChange={e => {
                    const v = e.target.value;
                    setEditing(x => x ? { ...x, teamId: v === 'global' ? null : parseInt(v.replace('team-', '')), ownerUserId: null } : null);
                  }}
                  className={inputCls}
                >
                  <option value="global">Global</option>
                  {teams.map(t => <option key={t.id} value={`team-${t.id}`}>Team: {t.name}</option>)}
                </select>
              </Field>
            </div>
            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button onClick={() => { setEditing(null); setEditId(null); }} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
              <button onClick={save} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── SSH Keys ──

function SshKeysSection() {
  const [items, setItems] = useState<SshKey[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [creating, setCreating] = useState<Partial<SshKey> | null>(null);
  const load = async () => {
    const [k, tm] = await Promise.all([
      sshKeysApi.list().catch(() => []),
      teamsApi.list().catch(() => []),
    ]);
    setItems(k); setTeams(tm);
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!creating?.name) { toast.error('Name required'); return; }
    try {
      await sshKeysApi.create(creating);
      toast.success('Key generated');
      setCreating(null);
      load();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed'); }
  };

  const copyPublic = (k: SshKey) => {
    navigator.clipboard.writeText(k.publicKey);
    toast.success('Public key copied — paste into ~/.ssh/authorized_keys on the remote');
  };

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button onClick={() => setCreating({ name: '', keyType: 'ed25519' })}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
          <Plus size={14} /> New SSH Key
        </button>
      </div>
      {items.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          <Key size={40} className="mx-auto mb-3 text-text-muted" />
          <p>No SSH keys. Create one to authenticate to remote servers used by workflow actions.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(k => (
            <div key={k.id} className="rounded-xl border border-border bg-bg-secondary p-3 flex items-center gap-3">
              <Key size={14} className="text-text-muted" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-primary">{k.name}</div>
                <div className="text-xs text-text-muted font-mono truncate">{k.fingerprint}</div>
              </div>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">{k.keyType}</span>
              <button onClick={() => copyPublic(k)} title="Copy public key" className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover"><Copy size={14} /></button>
              <button onClick={() => confirm('Delete this SSH key?') && sshKeysApi.delete(k.id).then(load).catch(e => toast.error(e.message))} className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-bg-hover"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50" onClick={() => setCreating(null)}>
          <div className="rounded-xl border border-border bg-bg-primary w-full max-w-md overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border"><h2 className="text-sm font-semibold text-text-primary">New SSH Key</h2></div>
            <div className="p-6 space-y-3">
              <Field label="Name"><input value={creating.name || ''} onChange={e => setCreating(x => x ? { ...x, name: e.target.value } : null)} className={inputCls} placeholder="dc-vpn-cert-push" /></Field>
              <Field label="Description (optional)"><input value={creating.description || ''} onChange={e => setCreating(x => x ? { ...x, description: e.target.value } : null)} className={inputCls} /></Field>
              <Field label="Type">
                <select value={creating.keyType || 'ed25519'} onChange={e => setCreating(x => x ? { ...x, keyType: e.target.value as 'ed25519' | 'rsa' } : null)} className={inputCls}>
                  <option value="ed25519">ed25519 (recommended)</option>
                </select>
              </Field>
              <Field label="Scope">
                <select
                  value={creating.teamId ? `team-${creating.teamId}` : 'global'}
                  onChange={e => {
                    const v = e.target.value;
                    setCreating(x => x ? { ...x, teamId: v === 'global' ? null : parseInt(v.replace('team-', '')), ownerUserId: null } : null);
                  }}
                  className={inputCls}
                >
                  <option value="global">Global</option>
                  {teams.map(t => <option key={t.id} value={`team-${t.id}`}>Team: {t.name}</option>)}
                </select>
              </Field>
              <p className="text-[10px] text-text-muted flex items-start gap-1">
                <Check size={12} className="mt-0.5 flex-shrink-0" />
                Private key stays encrypted in Oblihub. Only the public key is exposed.
              </p>
            </div>
            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button onClick={() => setCreating(null)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
              <button onClick={create} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Generate</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Shared ──

const inputCls = 'w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-text-secondary block mb-1.5">{label}</label>
      {children}
    </div>
  );
}
