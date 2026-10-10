import { useEffect, useState } from 'react';
import { RefreshCw, Plus, Trash2, Edit2, Users, Power, PowerOff, Shield, ExternalLink, X, Save } from 'lucide-react';
import { usersApi } from '@/api/users.api';
import { permissionsApi, type Role } from '@/api/permissions.api';
import type { User } from '@oblihub/shared';
import toast from 'react-hot-toast';

function RoleBadge({ role }: { role: string }) {
  return role === 'admin'
    ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium">Admin</span>
    : <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted font-medium">User</span>;
}

function SsoBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[#6366f1]/10 text-[#6366f1] border border-[#6366f1]/20 font-medium">
      <Shield size={8} /> SSO
    </span>
  );
}

export function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [roles, setRoles] = useState<Role[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [createForm, setCreateForm] = useState({ username: '', password: '', displayName: '', email: '', role: 'user' });
  const [editForm, setEditForm] = useState({ displayName: '', email: '', role: '', password: '' });

  const load = async () => {
    try {
      const [u, r] = await Promise.all([
        usersApi.list(),
        permissionsApi.getRoles().catch(() => [
          { id: 0, name: 'admin', label: 'Administrator', description: null, isSystem: true, permissions: [], createdAt: '', updatedAt: '' },
          { id: 0, name: 'user', label: 'User', description: null, isSystem: true, permissions: [], createdAt: '', updatedAt: '' },
          { id: 0, name: 'viewer', label: 'Viewer', description: null, isSystem: true, permissions: [], createdAt: '', updatedAt: '' },
        ]),
      ]);
      setUsers(u); setRoles(r);
    }
    catch { toast.error('Failed to load users'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!createForm.username.trim() || !createForm.password.trim()) { toast.error('Username and password required'); return; }
    if (createForm.password.length < 6) { toast.error('Password must be at least 6 characters'); return; }
    try {
      await usersApi.create(createForm);
      toast.success('User created');
      setShowCreate(false);
      setCreateForm({ username: '', password: '', displayName: '', email: '', role: 'user' });
      load();
    } catch { toast.error('Failed to create user'); }
  };

  const startEdit = (user: User) => {
    setEditingId(user.id);
    setEditForm({ displayName: user.displayName || '', email: user.email || '', role: user.role, password: '' });
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    try {
      const data: Record<string, string> = {};
      if (editForm.displayName) data.displayName = editForm.displayName;
      if (editForm.email) data.email = editForm.email;
      if (editForm.role) data.role = editForm.role;
      if (editForm.password) data.password = editForm.password;
      await usersApi.update(editingId, data);
      toast.success('User updated');
      setEditingId(null);
      load();
    } catch { toast.error('Failed to update user'); }
  };

  const handleToggle = async (user: User) => {
    try {
      await usersApi.toggleActive(user.id);
      toast.success(user.isActive ? 'User deactivated' : 'User activated');
      load();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed';
      toast.error(msg);
    }
  };

  const handleDelete = async (user: User) => {
    if (!confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    try {
      await usersApi.delete(user.id);
      toast.success('User deleted');
      load();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed';
      toast.error(msg);
    }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Users size={20} /> Users</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowCreate(v => !v)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Add User
          </button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="rounded-xl border border-border bg-bg-secondary p-4 mb-6 space-y-3">
          <h3 className="text-sm font-semibold text-text-secondary">New Local User</h3>
          <div className="grid grid-cols-2 gap-3">
            <input value={createForm.username} onChange={e => setCreateForm(f => ({ ...f, username: e.target.value }))} placeholder="Username"
              className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <input value={createForm.password} onChange={e => setCreateForm(f => ({ ...f, password: e.target.value }))} placeholder="Password" type="password"
              className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <input value={createForm.displayName} onChange={e => setCreateForm(f => ({ ...f, displayName: e.target.value }))} placeholder="Display name (optional)"
              className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <input value={createForm.email} onChange={e => setCreateForm(f => ({ ...f, email: e.target.value }))} placeholder="Email (optional)" type="email"
              className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
          <select value={createForm.role} onChange={e => setCreateForm(f => ({ ...f, role: e.target.value }))}
            className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
            {roles.map(r => <option key={r.name} value={r.name}>{r.label}</option>)}
          </select>
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Create</button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          </div>
        </div>
      )}

      {/* Users table */}
      <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-tertiary">
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">User</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Email</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Role</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Type</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Status</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-text-muted w-32">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map(user => (
              <tr key={user.id} className={`hover:bg-bg-hover/50 ${!user.isActive ? 'opacity-50' : ''}`}>
                <td className="px-4 py-2.5">
                  {editingId === user.id && !user.foreignSource ? (
                    <input value={editForm.displayName} onChange={e => setEditForm(f => ({ ...f, displayName: e.target.value }))} placeholder={user.username}
                      className="rounded border border-border bg-bg-tertiary px-2 py-0.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-40" />
                  ) : (
                    <div>
                      <div className="text-text-primary font-medium">{user.displayName || user.username}</div>
                      {user.displayName && <div className="text-[10px] text-text-muted font-mono">{user.username}</div>}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {editingId === user.id && !user.foreignSource ? (
                    <input value={editForm.email} onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} placeholder="email"
                      className="rounded border border-border bg-bg-tertiary px-2 py-0.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-48" />
                  ) : (
                    <span className="text-text-muted text-xs">{user.email || '-'}</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {editingId === user.id ? (
                    <select value={editForm.role} onChange={e => setEditForm(f => ({ ...f, role: e.target.value }))}
                      className="rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                      {roles.map(r => <option key={r.name} value={r.name}>{r.label}</option>)}
                    </select>
                  ) : (
                    <RoleBadge role={user.role} />
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {user.foreignSource ? <SsoBadge /> : <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">Local</span>}
                </td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${user.isActive ? 'bg-status-up/10 text-status-up' : 'bg-status-down/10 text-status-down'}`}>
                    {user.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center gap-1 justify-end">
                    {editingId === user.id ? (
                      <>
                        {!user.foreignSource && (
                          <input value={editForm.password} onChange={e => setEditForm(f => ({ ...f, password: e.target.value }))} placeholder="New password" type="password"
                            className="rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-28" />
                        )}
                        <button onClick={handleSaveEdit} className="p-1 rounded text-status-up hover:bg-bg-hover" title="Save"><Save size={14} /></button>
                        <button onClick={() => setEditingId(null)} className="p-1 rounded text-text-muted hover:bg-bg-hover" title="Cancel"><X size={14} /></button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => startEdit(user)} className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover" title="Edit"><Edit2 size={14} /></button>
                        <button onClick={() => handleToggle(user)} className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover" title={user.isActive ? 'Deactivate' : 'Activate'}>
                          {user.isActive ? <PowerOff size={14} /> : <Power size={14} />}
                        </button>
                        <button onClick={() => handleDelete(user)} className="p-1 rounded text-text-muted hover:text-status-down hover:bg-bg-hover" title="Delete"><Trash2 size={14} /></button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted">No users</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
