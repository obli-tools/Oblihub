import { useEffect, useState } from 'react';
import { RefreshCw, Plus, Trash2, Shield, Save } from 'lucide-react';
import { permissionsApi, type Permission, type Role } from '@/api/permissions.api';
import toast from 'react-hot-toast';

const CATEGORY_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  stacks: 'Stacks',
  containers: 'Containers',
  docker: 'Docker Resources',
  proxy: 'Proxy / Nginx',
  system: 'System',
};

export function RolesPage() {
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', label: '', description: '' });
  const [editedPerms, setEditedPerms] = useState<Record<number, Set<string>>>({});

  const load = async () => {
    try {
      const [p, r] = await Promise.all([permissionsApi.getPermissions(), permissionsApi.getRoles()]);
      setPermissions(p);
      setRoles(r);
      const initial: Record<number, Set<string>> = {};
      r.forEach(role => { initial[role.id] = new Set(role.permissions); });
      setEditedPerms(initial);
    } catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const togglePerm = async (roleId: number, permKey: string) => {
    const next = { ...editedPerms };
    const set = new Set(next[roleId] || []);
    set.has(permKey) ? set.delete(permKey) : set.add(permKey);
    next[roleId] = set;
    setEditedPerms(next);
    // Auto-save immediately
    try {
      await permissionsApi.updateRolePermissions(roleId, Array.from(set));
    } catch { toast.error('Failed to save permission'); }
  };

  const handleCreate = async () => {
    if (!createForm.name.trim() || !createForm.label.trim()) { toast.error('Name and label required'); return; }
    try {
      await permissionsApi.createRole(createForm);
      toast.success('Role created');
      setCreateForm({ name: '', label: '', description: '' });
      setShowCreate(false);
      load();
    } catch { toast.error('Failed to create role'); }
  };

  const handleDelete = async (role: Role) => {
    if (role.isSystem) { toast.error('Cannot delete system role'); return; }
    if (!confirm(`Delete role "${role.label}"?`)) return;
    try {
      await permissionsApi.deleteRole(role.id);
      toast.success('Role deleted');
      load();
    } catch { toast.error('Failed to delete'); }
  };

  const categories = [...new Set(permissions.map(p => p.category))];

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Shield size={20} /> Roles & Permissions</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowCreate(v => !v)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover"><Plus size={14} /> New Role</button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover"><RefreshCw size={14} /></button>
        </div>
      </div>

      {showCreate && (
        <div className="rounded-xl border border-border bg-bg-secondary p-4 mb-6 space-y-3">
          <h3 className="text-sm font-semibold text-text-secondary">New Custom Role</h3>
          <div className="grid grid-cols-3 gap-3">
            <input value={createForm.name} onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))} placeholder="role-name" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <input value={createForm.label} onChange={e => setCreateForm(f => ({ ...f, label: e.target.value }))} placeholder="Display Label" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <input value={createForm.description} onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))} placeholder="Description (optional)" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Create</button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          </div>
        </div>
      )}

      {/* Permission Matrix */}
      <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-tertiary">
              <th className="text-left px-4 py-3 text-xs font-semibold text-text-muted sticky left-0 bg-bg-tertiary min-w-[200px]">Permission</th>
              {roles.map(role => (
                <th key={role.id} className="text-center px-3 py-3 min-w-[100px]">
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs font-semibold text-text-primary">{role.label}</span>
                    {role.isSystem && <span className="text-[9px] px-1 py-0.5 rounded bg-accent/10 text-accent">System</span>}
                    <div className="flex items-center gap-1">
                      {!role.isSystem && (
                        <button onClick={() => handleDelete(role)} className="p-0.5 rounded text-text-muted hover:text-status-down hover:bg-bg-hover" title="Delete"><Trash2 size={12} /></button>
                      )}
                    </div>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map(cat => (
              <>
                <tr key={`cat-${cat}`} className="bg-bg-tertiary/50">
                  <td colSpan={1 + roles.length} className="px-4 py-1.5 text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                    {CATEGORY_LABELS[cat] || cat}
                  </td>
                </tr>
                {permissions.filter(p => p.category === cat).map(perm => (
                  <tr key={perm.key} className="border-t border-border/50 hover:bg-bg-hover/30">
                    <td className="px-4 py-2 sticky left-0 bg-bg-secondary">
                      <div className="text-xs text-text-primary">{perm.label}</div>
                      {perm.description && <div className="text-[10px] text-text-muted">{perm.description}</div>}
                    </td>
                    {roles.map(role => {
                      const granted = editedPerms[role.id]?.has(perm.key) || false;
                      return (
                        <td key={role.id} className="text-center px-3 py-2">
                          <button onClick={() => togglePerm(role.id, perm.key)}
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${granted ? 'bg-accent' : 'bg-bg-tertiary border border-border'}`}>
                            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${granted ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
