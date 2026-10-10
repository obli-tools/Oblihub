import { useEffect, useMemo, useState } from 'react';
import { HardDrive, Loader2, AlertTriangle, X } from 'lucide-react';
import { parseDocument } from 'yaml';
import toast from 'react-hot-toast';
import type { VolumeSpec } from '@oblihub/shared';
import { dockerApi } from '@/api/docker.api';
import { apiErrorMessage } from '@/utils/apiError';
import { VolumeForm, emptyVolumeSpec } from './VolumeForm';
import { addVolumeToCompose, listServices } from '@/utils/composeVolumes';

/**
 * Stack editor "Add volume": creates the volume on the stack's engine (or picks an existing one),
 * then mounts it in a service of the compose — comments and layout kept (`yaml` Document API).
 * A mount already on the same container path is replaced (the FERRY_DATA → SMB case).
 */

export interface AddVolumeModalProps {
  composeContent: string;
  engineId: number | null;
  /** Compose comes from git: the edit is overwritten at the next pull. */
  gitSourced: boolean;
  onClose: () => void;
  onApply: (content: string) => void;
}

export function AddVolumeModal({ composeContent, engineId, gitSourced, onClose, onApply }: AddVolumeModalProps) {
  const services = useMemo(() => {
    try { return listServices(parseDocument(composeContent)); } catch { return []; }
  }, [composeContent]);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [spec, setSpec] = useState<VolumeSpec>(emptyVolumeSpec());
  const [existing, setExisting] = useState<string[]>([]);
  const [existingName, setExistingName] = useState('');
  const [service, setService] = useState(services[0]?.name ?? '');
  const [target, setTarget] = useState('/data');
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dockerApi.listVolumes(engineId).then(vs => setExisting(vs.map(v => v.name).filter(n => !n.startsWith('oblihub-voltest-')).sort()))
      .catch(() => setExisting([]));
  }, [engineId]);

  const imageChoices = services.filter(s => s.image).map(s => ({ label: s.name, image: s.image! }));
  // Detect the selected service's image first.
  const orderedChoices = [...imageChoices].sort((a, b) => (a.label === service ? -1 : b.label === service ? 1 : 0));

  const volumeName = mode === 'new' ? spec.name.trim() : existingName;
  const managedLocal = mode === 'new' && spec.kind === 'local' && !spec.local?.hostPath?.trim();
  const snippet = volumeName && service && target
    ? `services:\n  ${service}:\n    volumes:\n      - ${volumeName}:${target}${readOnly ? ':ro' : ''}\n\nvolumes:\n  ${volumeName}:${managedLocal ? '' : '\n    external: true'}`
    : '';

  const apply = async () => {
    if (!volumeName) { toast.error('Volume name required'); return; }
    if (!service) { toast.error('Pick a service'); return; }
    if (!target.startsWith('/')) { toast.error('Container path must be absolute (e.g. /data)'); return; }
    setBusy(true);
    try {
      // Validate the compose edit before creating anything on the engine.
      addVolumeToCompose(composeContent, service, volumeName, target, !managedLocal, readOnly);
      if (mode === 'new' && !managedLocal) {
        await dockerApi.createVolumeFromSpec(spec, engineId);
        toast.success(`Volume ${volumeName} created`);
      }
      const { content, replaced } = addVolumeToCompose(composeContent, service, volumeName, target, !managedLocal, readOnly);
      onApply(content);
      toast.success(replaced ? `Replaced "${replaced}" in ${service} — save and redeploy to apply` : `Mounted in ${service} — save and redeploy to apply`);
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not add the volume'));
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="rounded-xl border border-border bg-bg-primary w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border flex items-center gap-2">
          <HardDrive size={16} className="text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Add volume</h2>
          <button onClick={onClose} className="ml-auto text-text-muted hover:text-text-primary"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          {gitSourced && (
            <div className="flex gap-2 text-xs text-status-pending border border-status-pending/40 rounded-lg p-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              This stack's compose comes from git: the next pull overwrites this edit. Commit the same change in the repo (snippet below).
            </div>
          )}

          <div className="flex bg-bg-tertiary rounded-lg p-0.5 w-fit">
            {(['new', 'existing'] as const).map(m => (
              <button key={m} type="button" onClick={() => setMode(m)}
                className={`px-3 py-1 text-xs rounded-md ${mode === m ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'}`}>
                {m === 'new' ? 'New volume' : 'Existing volume'}
              </button>
            ))}
          </div>

          {mode === 'new' ? (
            <VolumeForm spec={spec} onChange={setSpec} engineId={engineId} imageChoices={orderedChoices} />
          ) : (
            <label className="block">
              <span className="text-xs text-text-muted block mb-1">Volume on this engine</span>
              <select value={existingName} onChange={e => setExistingName(e.target.value)}
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm font-mono text-text-primary">
                <option value="">— pick a volume —</option>
                {existing.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          )}

          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="text-xs text-text-secondary">Mount in</div>
            <div className="grid grid-cols-2 gap-2">
              <select value={service} onChange={e => setService(e.target.value)}
                className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary">
                {services.length === 0 && <option value="">No service found</option>}
                {services.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
              <input value={target} onChange={e => setTarget(e.target.value)} placeholder="/data"
                className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm font-mono text-text-primary" />
            </div>
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              <input type="checkbox" checked={readOnly} onChange={e => setReadOnly(e.target.checked)} /> Read-only in the container
            </label>
            <div className="text-[11px] text-text-muted">A mount already on this path in the service is replaced.</div>
          </div>

          {snippet && (
            <pre className="rounded-lg bg-[#0d1117] border border-border p-2 font-mono text-[11px] text-text-secondary whitespace-pre">{snippet}</pre>
          )}
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          <button onClick={() => void apply()} disabled={busy || !volumeName || !service}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50">
            {busy && <Loader2 size={14} className="animate-spin" />}
            {mode === 'new' && !managedLocal ? 'Create & mount' : 'Mount'}
          </button>
        </div>
      </div>
    </div>
  );
}
