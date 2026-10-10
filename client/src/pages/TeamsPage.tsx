import { useEffect, useState } from 'react';
import { RefreshCw, Plus, Trash2, Edit2, Users, UserPlus, Save, X, ChevronDown, ChevronRight } from 'lucide-react';
import { teamsApi } from '@/api/teams.api';
import { stacksApi } from '@/api/stacks.api';
import { usersApi } from '@/api/users.api';
import type { Team, Stack, User } from '@oblihub/shared';
import toast from 'react-hot-toast';

interface ResourceSelection {
  allResources: boolean;
  stacks: Set<number>; // selected stack IDs
  containers: Set<number>; // individually selected container IDs
  excludedContainers: Set<number>; // containers excluded from selected stacks
}

export function TeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', description: '' });
  const [editingResources, setEditingResources] = useState<{ teamId: number; selection: ResourceSelection } | null>(null);
  const [addMemberTeamId, setAddMemberTeamId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = async () => {
    try {
      const [t, s, u] = await Promise.all([teamsApi.list(), stacksApi.list(), usersApi.list().catch(() => [])]);
      setTeams(t); setStacks(s); setAllUsers(u);
    } catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!createForm.name.trim()) return;
    try {
      await teamsApi.create(createForm);
      toast.success('Team created');
      setCreateForm({ name: '', description: '' }); setShowCreate(false); load();
    } catch { toast.error('Failed to create'); }
  };

  const startEditResources = (team: Team) => {
    const selection: ResourceSelection = {
      allResources: team.allResources,
      stacks: new Set(team.resources.filter(r => r.resourceType === 'stack' && !r.excluded).map(r => r.resourceId)),
      containers: new Set(team.resources.filter(r => r.resourceType === 'container' && !r.excluded).map(r => r.resourceId)),
      excludedContainers: new Set(team.resources.filter(r => r.resourceType === 'container' && r.excluded).map(r => r.resourceId)),
    };
    setEditingResources({ teamId: team.id, selection });
  };

  const toggleAll = () => {
    if (!editingResources) return;
    const next = !editingResources.selection.allResources;
    setEditingResources({ ...editingResources, selection: { allResources: next, stacks: new Set(), containers: new Set(), excludedContainers: new Set() } });
  };

  const toggleStack = (stackId: number) => {
    if (!editingResources) return;
    const s = editingResources.selection;
    const stacks = new Set(s.stacks);
    const excludedContainers = new Set(s.excludedContainers);
    if (stacks.has(stackId)) {
      stacks.delete(stackId);
      // Remove excluded containers of this stack
      const stack = stacks.values();
      for (const ec of excludedContainers) {
        const container = allContainers().find(c => c.id === ec);
        if (container && container.stackId === stackId) excludedContainers.delete(ec);
      }
    } else {
      stacks.add(stackId);
    }
    setEditingResources({ ...editingResources, selection: { ...s, stacks, excludedContainers } });
  };

  const toggleContainer = (containerId: number, stackId: number | null) => {
    if (!editingResources) return;
    const s = editingResources.selection;
    const containers = new Set(s.containers);
    const excludedContainers = new Set(s.excludedContainers);
    const stacks = new Set(s.stacks);
    const stackSelected = stackId && (stacks.has(stackId) || s.allResources);

    if (stackSelected) {
      // Container is part of a selected stack → toggle exclusion
      if (excludedContainers.has(containerId)) excludedContainers.delete(containerId);
      else excludedContainers.add(containerId);
    } else {
      // Individual container toggle
      if (containers.has(containerId)) containers.delete(containerId);
      else containers.add(containerId);
    }
    setEditingResources({ ...editingResources, selection: { ...s, containers, excludedContainers } });
  };

  const saveResources = async () => {
    if (!editingResources) return;
    const { teamId, selection } = editingResources;
    try {
      await teamsApi.update(teamId, { allResources: selection.allResources });
      const resources: { type: 'stack' | 'container'; id: number; excluded?: boolean }[] = [];
      for (const id of selection.stacks) resources.push({ type: 'stack', id });
      for (const id of selection.containers) resources.push({ type: 'container', id });
      for (const id of selection.excludedContainers) resources.push({ type: 'container', id, excluded: true });
      await teamsApi.setResources(teamId, resources);
      toast.success('Resources saved');
      setEditingResources(null); load();
    } catch { toast.error('Failed to save'); }
  };

  const allContainers = () => stacks.flatMap(s => s.containers.map(c => ({ ...c, stackName: s.name })));

  const isContainerSelected = (containerId: number, stackId: number | null): boolean => {
    if (!editingResources) return false;
    const s = editingResources.selection;
    if (s.allResources && !s.excludedContainers.has(containerId)) return true;
    if (stackId && s.stacks.has(stackId) && !s.excludedContainers.has(containerId)) return true;
    return s.containers.has(containerId);
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Users size={20} /> Teams</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowCreate(v => !v)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover"><Plus size={14} /> New Team</button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover"><RefreshCw size={14} /></button>
        </div>
      </div>

      {showCreate && (
        <div className="rounded-xl border border-border bg-bg-secondary p-4 mb-6 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input value={createForm.name} onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))} placeholder="Team name" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <input value={createForm.description} onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))} placeholder="Description" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Create</button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          </div>
        </div>
      )}

      {/* Resource editor modal */}
      {editingResources && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/50" onClick={() => setEditingResources(null)}>
          <div className="rounded-xl border border-border bg-bg-primary w-full max-w-lg max-h-[75vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">Edit Resources</h2>
              <button onClick={() => setEditingResources(null)} className="p-1 rounded hover:bg-bg-hover text-text-muted"><X size={16} /></button>
            </div>
            <div className="p-4 space-y-1">
              {/* All resources */}
              <button onClick={toggleAll}
                className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 text-sm transition-colors ${editingResources.selection.allResources ? 'bg-accent/10 text-accent font-medium' : 'hover:bg-bg-hover text-text-primary'}`}>
                <div className={`h-3.5 w-3.5 rounded border flex items-center justify-center shrink-0 ${editingResources.selection.allResources ? 'bg-accent border-accent' : 'border-border'}`}>
                  {editingResources.selection.allResources && <span className="text-white text-[8px]">✓</span>}
                </div>
                <span className="font-semibold">All resources</span>
                <span className="text-[10px] text-text-muted ml-auto">includes future stacks</span>
              </button>

              {/* Stacks + containers tree */}
              {stacks.map(stack => {
                const stackSelected = editingResources.selection.allResources || editingResources.selection.stacks.has(stack.id);
                const someContainers = stack.containers.some(c => isContainerSelected(c.id, stack.id));
                const allContainersSelected = stack.containers.every(c => isContainerSelected(c.id, stack.id));
                return (
                  <div key={stack.id}>
                    <button onClick={() => !editingResources.selection.allResources && toggleStack(stack.id)}
                      className={`w-full text-left px-3 py-1.5 pl-6 rounded-lg flex items-center gap-2 text-xs transition-colors ${stackSelected ? 'text-accent' : 'hover:bg-bg-hover text-text-primary'}`}>
                      <div className={`h-3 w-3 rounded border flex items-center justify-center shrink-0 ${allContainersSelected || stackSelected ? 'bg-accent border-accent' : someContainers ? 'bg-accent/30 border-accent' : 'border-border'}`}>
                        {(allContainersSelected || stackSelected) && <span className="text-white text-[7px]">✓</span>}
                        {someContainers && !allContainersSelected && !stackSelected && <span className="text-white text-[7px]">-</span>}
                      </div>
                      <span className="font-medium">{stack.name}</span>
                      <span className="text-[9px] text-text-muted">{stack.containers.length} containers</span>
                    </button>
                    {stack.containers.map(c => {
                      const selected = isContainerSelected(c.id, stack.id);
                      return (
                        <button key={c.id} onClick={() => toggleContainer(c.id, stack.id)}
                          className={`w-full text-left px-3 py-1 pl-12 rounded flex items-center gap-2 text-[11px] transition-colors ${selected ? 'text-text-primary' : 'text-text-muted hover:bg-bg-hover/50'}`}>
                          <div className={`h-2.5 w-2.5 rounded border flex items-center justify-center shrink-0 ${selected ? 'bg-accent border-accent' : 'border-border'}`}>
                            {selected && <span className="text-white text-[6px]">✓</span>}
                          </div>
                          <span>{c.containerName}</span>
                          <span className="text-[9px] text-text-muted font-mono ml-auto">{c.image}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button onClick={() => setEditingResources(null)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
              <button onClick={saveResources} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover flex items-center gap-1.5"><Save size={14} /> Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Add member modal */}
      {addMemberTeamId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setAddMemberTeamId(null)}>
          <div className="rounded-xl border border-border bg-bg-primary w-96 p-6 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-text-primary mb-3">Add Member</h3>
            <div className="space-y-1 max-h-60 overflow-auto">
              {allUsers.filter(u => !teams.find(t => t.id === addMemberTeamId)?.members.some(m => m.userId === u.id)).map(u => (
                <button key={u.id} onClick={async () => {
                  try { await teamsApi.addMember(addMemberTeamId, u.id); toast.success('Member added'); setAddMemberTeamId(null); load(); }
                  catch { toast.error('Failed'); }
                }} className="w-full text-left px-3 py-2 rounded-lg hover:bg-bg-hover text-sm text-text-primary flex items-center justify-between">
                  <span>{u.displayName || u.username}</span>
                  {u.foreignSource && <span className="text-[9px] px-1 py-0.5 rounded bg-[#6366f1]/10 text-[#6366f1]">SSO</span>}
                </button>
              ))}
            </div>
            <button onClick={() => setAddMemberTeamId(null)} className="mt-3 w-full px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Close</button>
          </div>
        </div>
      )}

      {/* Teams list */}
      <div className="space-y-3">
        {teams.map(team => (
          <div key={team.id} className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
            <div className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-bg-hover/50" onClick={() => setExpanded(p => { const n = new Set(p); n.has(team.id) ? n.delete(team.id) : n.add(team.id); return n; })}>
              {expanded.has(team.id) ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
              <div className="flex-1">
                <span className="text-sm font-medium text-text-primary">{team.name}</span>
                {team.description && <span className="text-xs text-text-muted ml-2">{team.description}</span>}
              </div>
              <span className="text-[10px] text-text-muted">{team.members.length} members</span>
              {team.allResources ? (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-status-up/10 text-status-up">All resources</span>
              ) : (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">{team.resources.filter(r => !r.excluded).length} resources</span>
              )}
              <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                <button onClick={() => startEditResources(team)} className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover" title="Edit resources"><Edit2 size={14} /></button>
                <button onClick={() => setAddMemberTeamId(team.id)} className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover" title="Add member"><UserPlus size={14} /></button>
                <button onClick={async () => { if (confirm('Delete?')) { await teamsApi.delete(team.id); toast.success('Deleted'); load(); } }}
                  className="p-1 rounded text-text-muted hover:text-status-down hover:bg-bg-hover"><Trash2 size={14} /></button>
              </div>
            </div>
            {expanded.has(team.id) && (
              <div className="border-t border-border p-4 grid grid-cols-2 gap-4">
                <div>
                  <div className="text-[10px] font-semibold text-text-muted uppercase mb-2">Members</div>
                  {team.members.length > 0 ? team.members.map(m => (
                    <div key={m.id} className="flex items-center justify-between py-1">
                      <span className="text-xs text-text-primary">{m.displayName || m.username}</span>
                      <button onClick={async () => { await teamsApi.removeMember(team.id, m.userId); toast.success('Removed'); load(); }}
                        className="p-0.5 text-text-muted hover:text-status-down"><Trash2 size={10} /></button>
                    </div>
                  )) : <span className="text-[10px] text-text-muted">No members</span>}
                </div>
                <div>
                  <div className="text-[10px] font-semibold text-text-muted uppercase mb-2">Resources</div>
                  {team.allResources ? (
                    <span className="text-xs text-status-up">All current & future resources</span>
                  ) : team.resources.filter(r => !r.excluded).length > 0 ? team.resources.filter(r => !r.excluded).map(r => (
                    <div key={r.id} className="text-xs text-text-primary py-0.5">
                      <span className="text-[9px] px-1 py-0.5 rounded bg-bg-tertiary text-text-muted mr-1">{r.resourceType}</span>
                      {r.resourceName}
                    </div>
                  )) : <span className="text-[10px] text-text-muted">No resources assigned</span>}
                </div>
                {/* Limits */}
                <div className="col-span-2 border-t border-border pt-3 mt-2">
                  <div className="text-[10px] font-semibold text-text-muted uppercase mb-2">Limits</div>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { key: 'maxStacks', label: 'Stacks' },
                      { key: 'maxContainers', label: 'Containers' },
                      { key: 'maxCertificates', label: 'SSL Certs' },
                      { key: 'maxProxyHosts', label: 'Proxy Hosts' },
                    ].map(({ key, label }) => (
                      <div key={key}>
                        <label className="text-[9px] text-text-muted block mb-0.5">{label}</label>
                        <input type="number" min={0} defaultValue={((team as unknown as Record<string, unknown>)[key] as number) || ''}
                          placeholder="∞"
                          onBlur={async (e) => {
                            const val = e.target.value ? parseInt(e.target.value) : null;
                            await teamsApi.update(team.id, { [key]: val } as Record<string, number | null>);
                            toast.success('Limit updated');
                            load();
                          }}
                          className="w-full rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary text-center focus:outline-none focus:ring-1 focus:ring-accent" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
        {teams.length === 0 && <div className="text-center py-12 text-text-muted">No teams configured</div>}
      </div>
    </div>
  );
}
