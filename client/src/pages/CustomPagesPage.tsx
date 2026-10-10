import { useEffect, useState } from 'react';
import { RefreshCw, Plus, Trash2, Edit2, FileText, Eye, X, Save } from 'lucide-react';
import { proxyApi } from '@/api/proxy.api';
import type { CustomPage } from '@oblihub/shared';
import toast from 'react-hot-toast';

const ERROR_CODE_OPTIONS = [400, 401, 403, 404, 500, 502, 503, 504];

export function CustomPagesPage() {
  const [pages, setPages] = useState<CustomPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<CustomPage> | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [previewId, setPreviewId] = useState<number | null>(null);

  const load = async () => {
    try { setPages(await proxyApi.listCustomPages()); }
    catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const startCreate = () => {
    setEditing({ name: '', description: '', errorCodes: [500, 502, 503, 504], htmlContent: '', theme: 'custom' });
    setEditId(null);
  };

  const startEdit = (page: CustomPage) => {
    setEditing({ ...page });
    setEditId(page.id);
  };

  const handleSave = async () => {
    if (!editing?.name || !editing.htmlContent) { toast.error('Name and HTML content required'); return; }
    try {
      if (editId) {
        await proxyApi.updateCustomPage(editId, editing as CustomPage);
        toast.success('Page updated');
      } else {
        await proxyApi.createCustomPage({ name: editing.name, description: editing.description || undefined, errorCodes: editing.errorCodes || [500], htmlContent: editing.htmlContent, theme: editing.theme, isWakingPage: editing.isWakingPage || false });
        toast.success('Page created');
      }
      setEditing(null); setEditId(null); load();
    } catch { toast.error('Failed to save'); }
  };

  const handleDelete = async (page: CustomPage) => {
    if (page.isBuiltin) { toast.error('Cannot delete built-in page'); return; }
    if (!confirm(`Delete "${page.name}"?`)) return;
    try { await proxyApi.deleteCustomPage(page.id); toast.success('Deleted'); load(); }
    catch { toast.error('Failed to delete'); }
  };

  const toggleCode = (code: number) => {
    setEditing(e => {
      if (!e) return null;
      const codes = e.errorCodes || [];
      return { ...e, errorCodes: codes.includes(code) ? codes.filter(c => c !== code) : [...codes, code] };
    });
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><FileText size={20} /> Custom Error Pages</h1>
        <div className="flex gap-2">
          <button onClick={startCreate} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover"><Plus size={14} /> Add Page</button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover"><RefreshCw size={14} /></button>
        </div>
      </div>

      {/* Editor modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 bg-black/50" onClick={() => { setEditing(null); setEditId(null); }}>
          <div className="rounded-xl border border-border bg-bg-primary w-full max-w-4xl max-h-[85vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">{editId ? 'Edit' : 'New'} Error Page</h2>
              <button onClick={() => { setEditing(null); setEditId(null); }} className="p-1 rounded hover:bg-bg-hover text-text-muted"><X size={16} /></button>
            </div>
            <div className="p-6 grid grid-cols-2 gap-6">
              <div className="space-y-4">
                <input value={editing.name || ''} onChange={e => setEditing(p => p ? { ...p, name: e.target.value } : null)} placeholder="Page name"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                <input value={editing.description || ''} onChange={e => setEditing(p => p ? { ...p, description: e.target.value } : null)} placeholder="Description (optional)"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                <div className="flex items-center justify-between rounded-lg border border-border bg-bg-tertiary/50 px-3 py-2">
                  <div>
                    <div className="text-sm font-medium text-text-primary">Waking page</div>
                    <div className="text-[11px] text-text-muted">Loading screen shown while a sleeping container wakes up (instead of error codes)</div>
                  </div>
                  <button onClick={() => setEditing(p => p ? { ...p, isWakingPage: !p.isWakingPage } : null)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${editing.isWakingPage ? 'bg-accent' : 'bg-bg-hover border border-border'}`}>
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${editing.isWakingPage ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>
                {!editing.isWakingPage && (
                  <div>
                    <label className="text-xs font-medium text-text-secondary block mb-1.5">Error Codes</label>
                    <div className="flex flex-wrap gap-1.5">
                      {ERROR_CODE_OPTIONS.map(code => {
                        const active = editing.errorCodes?.includes(code);
                        return (
                          <button key={code} onClick={() => toggleCode(code)}
                            className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${active ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-muted hover:bg-bg-hover'}`}>
                            {code}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {editing.isWakingPage && (
                  <div className="rounded-lg border border-border bg-bg-tertiary/30 p-2.5 text-[11px] text-text-muted">
                    Placeholders supported in HTML: <code>{`{{APP_NAME}}`}</code>, <code>{`{{PROXY_HOST_ID}}`}</code>. JS will receive <code>fetch('/__oblihub_internal/wake/status?host=...')</code> returning <code>{`{ ready, state, elapsedMs }`}</code>.
                  </div>
                )}
                <div>
                  <label className="text-xs font-medium text-text-secondary block mb-1.5">HTML Content</label>
                  <textarea value={editing.htmlContent || ''} onChange={e => setEditing(p => p ? { ...p, htmlContent: e.target.value } : null)}
                    spellCheck={false} rows={18}
                    className="w-full rounded-lg border border-border bg-[#0d1117] px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none leading-relaxed" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Preview</label>
                <div className="rounded-lg border border-border overflow-hidden bg-white" style={{ height: 'calc(100% - 24px)' }}>
                  <iframe srcDoc={editing.htmlContent || '<p style="padding:40px;color:#888">Enter HTML to preview</p>'} className="w-full h-full border-0" sandbox="allow-same-origin" title="Preview" />
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button onClick={() => { setEditing(null); setEditId(null); }} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
              <button onClick={handleSave} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover flex items-center gap-1.5"><Save size={14} /> Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Preview modal */}
      {previewId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setPreviewId(null)}>
          <div className="w-full max-w-3xl h-[80vh] rounded-xl overflow-hidden border border-border shadow-xl" onClick={e => e.stopPropagation()}>
            <iframe srcDoc={pages.find(p => p.id === previewId)?.htmlContent || ''} className="w-full h-full border-0" sandbox="allow-same-origin" title="Preview" />
          </div>
        </div>
      )}

      {/* Pages grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {pages.map(page => (
          <div key={page.id} className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
            {/* Mini preview */}
            <div className="h-32 bg-white relative cursor-pointer" onClick={() => setPreviewId(page.id)}>
              <iframe srcDoc={page.htmlContent} className="w-full h-full border-0 pointer-events-none" style={{ transform: 'scale(0.5)', transformOrigin: 'top left', width: '200%', height: '200%' }} sandbox="allow-same-origin" title={page.name} />
              <div className="absolute inset-0 bg-transparent hover:bg-black/10 transition-colors flex items-center justify-center">
                <Eye size={20} className="text-white opacity-0 hover:opacity-100 drop-shadow-lg" />
              </div>
            </div>
            <div className="p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-text-primary">{page.name}</span>
                {page.isBuiltin && <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">Built-in</span>}
              </div>
              <div className="flex flex-wrap gap-1 mb-2">
                {page.errorCodes.map(code => (
                  <span key={code} className="text-[9px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted font-mono">{code}</span>
                ))}
              </div>
              {page.description && <p className="text-[10px] text-text-muted mb-2">{page.description}</p>}
              <div className="flex items-center gap-1">
                <button onClick={() => startEdit(page)} className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover"><Edit2 size={14} /></button>
                <button onClick={() => setPreviewId(page.id)} className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover"><Eye size={14} /></button>
                {!page.isBuiltin && (
                  <button onClick={() => handleDelete(page)} className="p-1 rounded text-text-muted hover:text-status-down hover:bg-bg-hover"><Trash2 size={14} /></button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
