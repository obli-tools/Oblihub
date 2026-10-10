import { useEffect, useState } from 'react';
import { RefreshCw, Plus, Trash2, ShieldCheck, ChevronDown, ChevronRight, UserPlus, Globe, Pencil, Check, X } from 'lucide-react';
import { proxyApi } from '@/api/proxy.api';
import type { AccessList } from '@oblihub/shared';
import toast from 'react-hot-toast';

export function AccessListsPage() {
  const [lists, setLists] = useState<AccessList[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [clientForm, setClientForm] = useState<{ listId: number; address: string; directive: 'allow' | 'deny' } | null>(null);
  const [authForm, setAuthForm] = useState<{ listId: number; username: string; password: string } | null>(null);
  // Inline edit states. Each is null when not editing; populated with the in-progress draft.
  const [renameForm, setRenameForm] = useState<{ listId: number; name: string } | null>(null);
  const [editClientForm, setEditClientForm] = useState<{ listId: number; clientId: number; address: string; directive: 'allow' | 'deny' } | null>(null);
  const [editAuthForm, setEditAuthForm] = useState<{ listId: number; authId: number; username: string; password: string } | null>(null);

  const load = async () => {
    try { setLists(await proxyApi.listAccessLists()); }
    catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const toggleExpand = (id: number) => {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const handleCreate = async () => {
    if (!createName.trim()) return;
    try {
      await proxyApi.createAccessList({ name: createName });
      toast.success('Access list created');
      setCreateName(''); setShowCreate(false); load();
    } catch { toast.error('Failed to create'); }
  };

  const handleAddClient = async () => {
    if (!clientForm?.address.trim()) return;
    try {
      await proxyApi.addAccessListClient(clientForm.listId, clientForm.address, clientForm.directive);
      toast.success('Rule added');
      setClientForm(null); load();
    } catch { toast.error('Failed to add rule'); }
  };

  const handleAddAuth = async () => {
    if (!authForm?.username.trim() || !authForm?.password.trim()) return;
    try {
      await proxyApi.addAccessListAuth(authForm.listId, authForm.username, authForm.password);
      toast.success('Auth user added');
      setAuthForm(null); load();
    } catch { toast.error('Failed to add auth'); }
  };

  const handleRename = async () => {
    if (!renameForm || !renameForm.name.trim()) return;
    try {
      await proxyApi.updateAccessList(renameForm.listId, { name: renameForm.name });
      toast.success('Renamed');
      setRenameForm(null); load();
    } catch { toast.error('Rename failed'); }
  };

  const handleSaveClient = async () => {
    if (!editClientForm || !editClientForm.address.trim()) return;
    try {
      await proxyApi.updateAccessListClient(editClientForm.listId, editClientForm.clientId, {
        address: editClientForm.address,
        directive: editClientForm.directive,
      });
      toast.success('Rule updated');
      setEditClientForm(null); load();
    } catch { toast.error('Update failed'); }
  };

  const handleSaveAuth = async () => {
    if (!editAuthForm || !editAuthForm.username.trim()) return;
    try {
      // Empty password = keep existing — the backend treats undefined `password` as no rotation.
      await proxyApi.updateAccessListAuth(editAuthForm.listId, editAuthForm.authId, {
        username: editAuthForm.username,
        password: editAuthForm.password || undefined,
      });
      toast.success('User updated');
      setEditAuthForm(null); load();
    } catch { toast.error('Update failed'); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><ShieldCheck size={20} /> Access Lists</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowCreate(v => !v)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover"><Plus size={14} /> Add</button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover"><RefreshCw size={14} /></button>
        </div>
      </div>

      {showCreate && (
        <div className="rounded-xl border border-border bg-bg-secondary p-4 mb-6 space-y-3">
          <input value={createName} onChange={e => setCreateName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCreate()} placeholder="Access list name"
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Create</button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {lists.map(list => (
          <div key={list.id} className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
            <div className="px-4 py-3 flex items-center gap-3 hover:bg-bg-hover/50">
              <button onClick={() => toggleExpand(list.id)} className="text-text-muted hover:text-text-primary">
                {expanded.has(list.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              {renameForm?.listId === list.id ? (
                <>
                  <input
                    autoFocus
                    value={renameForm.name}
                    onChange={e => setRenameForm({ listId: list.id, name: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenameForm(null); }}
                    className="flex-1 rounded border border-accent bg-bg-tertiary px-2 py-1 text-sm text-text-primary focus:outline-none"
                  />
                  <button onClick={handleRename} className="p-1 rounded text-status-up hover:bg-bg-hover" title="Save"><Check size={14} /></button>
                  <button onClick={() => setRenameForm(null)} className="p-1 rounded text-text-muted hover:bg-bg-hover" title="Cancel"><X size={14} /></button>
                </>
              ) : (
                <>
                  <button onClick={() => toggleExpand(list.id)} className="text-sm font-medium text-text-primary flex-1 text-left cursor-pointer">{list.name}</button>
                  <span className="text-[10px] text-text-muted">{list.clients.length} IP rules, {list.auth.length} users</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setRenameForm({ listId: list.id, name: list.name }); }}
                    className="p-1.5 rounded-md text-text-muted hover:text-accent hover:bg-bg-hover"
                    title="Rename"
                  ><Pencil size={14} /></button>
                  <button onClick={e => { e.stopPropagation(); if (confirm('Delete?')) { proxyApi.deleteAccessList(list.id).then(() => { toast.success('Deleted'); load(); }); } }}
                    className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-bg-hover"><Trash2 size={14} /></button>
                </>
              )}
            </div>
            {expanded.has(list.id) && (
              <div className="border-t border-border p-4 space-y-4">
                {/* IP Rules */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] font-semibold text-text-muted uppercase flex items-center gap-1"><Globe size={10} /> IP Rules</div>
                    <button onClick={() => setClientForm({ listId: list.id, address: '', directive: 'allow' })} className="text-[10px] text-accent hover:text-accent-hover flex items-center gap-0.5"><Plus size={10} /> Add rule</button>
                  </div>
                  {clientForm?.listId === list.id && (
                    <div className="flex gap-2 mb-2">
                      <select value={clientForm.directive} onChange={e => setClientForm(f => f ? { ...f, directive: e.target.value as 'allow' | 'deny' } : null)}
                        className="rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                        <option value="allow">Allow</option>
                        <option value="deny">Deny</option>
                      </select>
                      <input value={clientForm.address} onChange={e => setClientForm(f => f ? { ...f, address: e.target.value } : null)} placeholder="192.168.1.0/24"
                        onKeyDown={e => e.key === 'Enter' && handleAddClient()}
                        className="flex-1 rounded border border-border bg-bg-tertiary px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                      <button onClick={handleAddClient} className="px-2 py-1 text-xs rounded bg-accent text-white hover:bg-accent-hover">Add</button>
                      <button onClick={() => setClientForm(null)} className="px-2 py-1 text-xs rounded border border-border text-text-muted hover:bg-bg-hover">Cancel</button>
                    </div>
                  )}
                  {list.clients.length > 0 ? list.clients.map(c => {
                    const editing = editClientForm?.clientId === c.id;
                    return (
                      <div key={c.id} className="flex items-center gap-2 text-xs py-1">
                        {editing ? (
                          <>
                            <select
                              value={editClientForm.directive}
                              onChange={e => setEditClientForm(f => f ? { ...f, directive: e.target.value as 'allow' | 'deny' } : null)}
                              className="rounded border border-accent bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-primary focus:outline-none"
                            >
                              <option value="allow">allow</option>
                              <option value="deny">deny</option>
                            </select>
                            <input
                              autoFocus
                              value={editClientForm.address}
                              onChange={e => setEditClientForm(f => f ? { ...f, address: e.target.value } : null)}
                              onKeyDown={e => { if (e.key === 'Enter') handleSaveClient(); if (e.key === 'Escape') setEditClientForm(null); }}
                              className="flex-1 rounded border border-accent bg-bg-tertiary px-2 py-0.5 text-xs font-mono text-text-primary focus:outline-none"
                            />
                            <button onClick={handleSaveClient} className="p-0.5 text-status-up hover:text-status-up" title="Save"><Check size={12} /></button>
                            <button onClick={() => setEditClientForm(null)} className="p-0.5 text-text-muted" title="Cancel"><X size={12} /></button>
                          </>
                        ) : (
                          <>
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${c.directive === 'allow' ? 'bg-status-up/10 text-status-up' : 'bg-status-down/10 text-status-down'}`}>{c.directive}</span>
                            <span className="font-mono text-text-primary flex-1">{c.address}</span>
                            <button
                              onClick={() => setEditClientForm({ listId: list.id, clientId: c.id, address: c.address, directive: c.directive })}
                              className="p-0.5 text-text-muted hover:text-accent"
                              title="Edit"
                            ><Pencil size={12} /></button>
                            <button onClick={() => proxyApi.removeAccessListClient(list.id, c.id).then(() => { toast.success('Removed'); load(); })}
                              className="p-0.5 text-text-muted hover:text-status-down"><Trash2 size={12} /></button>
                          </>
                        )}
                      </div>
                    );
                  }) : <div className="text-[10px] text-text-muted">No IP rules</div>}
                </div>

                {/* Basic Auth */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] font-semibold text-text-muted uppercase flex items-center gap-1"><UserPlus size={10} /> Basic Auth</div>
                    <button onClick={() => setAuthForm({ listId: list.id, username: '', password: '' })} className="text-[10px] text-accent hover:text-accent-hover flex items-center gap-0.5"><Plus size={10} /> Add user</button>
                  </div>
                  {authForm?.listId === list.id && (
                    <div className="flex gap-2 mb-2">
                      <input value={authForm.username} onChange={e => setAuthForm(f => f ? { ...f, username: e.target.value } : null)} placeholder="Username"
                        className="flex-1 rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                      <input value={authForm.password} onChange={e => setAuthForm(f => f ? { ...f, password: e.target.value } : null)} placeholder="Password" type="password"
                        onKeyDown={e => e.key === 'Enter' && handleAddAuth()}
                        className="flex-1 rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                      <button onClick={handleAddAuth} className="px-2 py-1 text-xs rounded bg-accent text-white hover:bg-accent-hover">Add</button>
                      <button onClick={() => setAuthForm(null)} className="px-2 py-1 text-xs rounded border border-border text-text-muted hover:bg-bg-hover">Cancel</button>
                    </div>
                  )}
                  {list.auth.length > 0 ? list.auth.map(a => {
                    const editing = editAuthForm?.authId === a.id;
                    return (
                      <div key={a.id} className="flex items-center gap-2 text-xs py-1">
                        {editing ? (
                          <>
                            <input
                              autoFocus
                              value={editAuthForm.username}
                              onChange={e => setEditAuthForm(f => f ? { ...f, username: e.target.value } : null)}
                              placeholder="username"
                              className="flex-1 rounded border border-accent bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary focus:outline-none"
                            />
                            <input
                              value={editAuthForm.password}
                              onChange={e => setEditAuthForm(f => f ? { ...f, password: e.target.value } : null)}
                              onKeyDown={e => { if (e.key === 'Enter') handleSaveAuth(); if (e.key === 'Escape') setEditAuthForm(null); }}
                              type="password"
                              placeholder="(leave blank to keep)"
                              className="flex-1 rounded border border-accent bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary focus:outline-none"
                            />
                            <button onClick={handleSaveAuth} className="p-0.5 text-status-up" title="Save"><Check size={12} /></button>
                            <button onClick={() => setEditAuthForm(null)} className="p-0.5 text-text-muted" title="Cancel"><X size={12} /></button>
                          </>
                        ) : (
                          <>
                            <span className="font-mono text-text-primary flex-1">{a.username}</span>
                            <button
                              onClick={() => setEditAuthForm({ listId: list.id, authId: a.id, username: a.username, password: '' })}
                              className="p-0.5 text-text-muted hover:text-accent"
                              title="Rename / change password"
                            ><Pencil size={12} /></button>
                            <button onClick={() => proxyApi.removeAccessListAuth(list.id, a.id).then(() => { toast.success('Removed'); load(); })}
                              className="p-0.5 text-text-muted hover:text-status-down"><Trash2 size={12} /></button>
                          </>
                        )}
                      </div>
                    );
                  }) : <div className="text-[10px] text-text-muted">No auth users</div>}
                </div>
              </div>
            )}
          </div>
        ))}
        {lists.length === 0 && <div className="text-center py-12 text-text-muted">No access lists configured</div>}
      </div>
    </div>
  );
}
