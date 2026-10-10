import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Search, Package, Rocket, ExternalLink } from 'lucide-react';
import { templatesApi } from '@/api/templates.api';
import type { AppTemplate, EnvSchemaField } from '@oblihub/shared';
import toast from 'react-hot-toast';

const CATEGORY_LABELS: Record<string, string> = {
  cms: 'CMS', storage: 'Storage', devtools: 'Dev Tools', security: 'Security',
  monitoring: 'Monitoring', automation: 'Automation', database: 'Database', other: 'Other',
};

export function AppStorePage() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<AppTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [deploying, setDeploying] = useState<AppTemplate | null>(null);
  const [stackName, setStackName] = useState('');
  const [envValues, setEnvValues] = useState<Record<string, string>>({});

  const load = async () => {
    try { setTemplates(await templatesApi.list()); }
    catch { toast.error('Failed to load templates'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const sanitizeStackName = (v: string) => v.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

  const startDeploy = (t: AppTemplate) => {
    setDeploying(t);
    setStackName(sanitizeStackName(t.slug));
    const defaults: Record<string, string> = {};
    t.envSchema.forEach(f => { defaults[f.key] = f.default || ''; });
    setEnvValues(defaults);
  };

  const handleDeploy = async () => {
    if (!deploying || !stackName.trim()) { toast.error('Stack name required'); return; }
    // Validate required fields
    for (const field of deploying.envSchema) {
      if (field.required && !envValues[field.key]) { toast.error(`${field.label} is required`); return; }
    }
    try {
      const result = await templatesApi.deploy(deploying.id, stackName, envValues);
      toast.success(`Deploying ${deploying.name}...`);
      setDeploying(null);
      navigate(`/stack-editor/${result.stackId}`);
    } catch { toast.error('Deploy failed'); }
  };

  const filtered = templates.filter(t => !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.category.includes(search.toLowerCase()));
  const categories = [...new Set(filtered.map(t => t.category))];

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Package size={20} /> App Store</h1>
        <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover"><RefreshCw size={14} /></button>
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search templates..."
          className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-border bg-bg-secondary text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
      </div>

      {/* Deploy modal */}
      {deploying && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/50" onClick={() => setDeploying(null)}>
          <div className="rounded-xl border border-border bg-bg-primary w-full max-w-lg max-h-[80vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                <span className="text-lg">{deploying.icon}</span> Deploy {deploying.name}
              </h2>
              {deploying.description && <p className="text-xs text-text-muted mt-1">{deploying.description}</p>}
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Stack Name</label>
                <input value={stackName} onChange={e => setStackName(sanitizeStackName(e.target.value))}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                <p className="text-[10px] text-text-muted mt-1">Lowercase letters, digits, <code className="bg-bg-tertiary px-1 rounded">-</code> and <code className="bg-bg-tertiary px-1 rounded">_</code> only (Docker project naming rules)</p>
              </div>
              {deploying.envSchema.map((field: EnvSchemaField) => (
                <div key={field.key}>
                  <label className="text-xs font-medium text-text-secondary block mb-1.5">
                    {field.label} {field.required && <span className="text-status-down">*</span>}
                  </label>
                  {field.type === 'select' ? (
                    <select value={envValues[field.key] || ''} onChange={e => setEnvValues(v => ({ ...v, [field.key]: e.target.value }))}
                      className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                      {field.options?.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                      value={envValues[field.key] || ''} onChange={e => setEnvValues(v => ({ ...v, [field.key]: e.target.value }))}
                      placeholder={field.default || field.description}
                      className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                  )}
                  {field.description && <p className="text-[10px] text-text-muted mt-0.5">{field.description}</p>}
                </div>
              ))}
            </div>
            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button onClick={() => setDeploying(null)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
              <button onClick={handleDeploy} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover flex items-center gap-1.5">
                <Rocket size={14} /> Deploy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Templates grid by category */}
      {categories.map(cat => (
        <div key={cat} className="mb-8">
          <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wider mb-3">{CATEGORY_LABELS[cat] || cat}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {filtered.filter(t => t.category === cat).map(t => (
              <div key={t.id} className="rounded-xl border border-border bg-bg-secondary p-4 hover:border-accent/30 transition-colors">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xl">{t.icon || '📦'}</span>
                  <h3 className="text-sm font-semibold text-text-primary">{t.name}</h3>
                </div>
                {t.description && <p className="text-xs text-text-muted mb-3 line-clamp-2">{t.description}</p>}
                <div className="flex items-center gap-2">
                  <button onClick={() => startDeploy(t)} className="flex items-center gap-1 px-3 py-1 text-xs rounded-lg bg-accent text-white hover:bg-accent-hover">
                    <Rocket size={10} /> Deploy
                  </button>
                  {t.documentationUrl && (
                    <a href={t.documentationUrl} target="_blank" rel="noopener noreferrer" className="p-1 rounded text-text-muted hover:text-accent hover:bg-bg-hover">
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {templates.length === 0 && (
        <div className="text-center py-20">
          <Package size={40} className="mx-auto mb-3 text-text-muted" />
          <p className="text-text-muted">No templates available</p>
        </div>
      )}
    </div>
  );
}
