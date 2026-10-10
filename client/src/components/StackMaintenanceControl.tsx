import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Clock } from 'lucide-react';
import { DEFAULT_MAINTENANCE_WINDOW, describeWindow, type Stack, type StackMaintenance, type MaintenanceWindow } from '@oblihub/shared';
import { stacksApi, type MaintenanceStatus } from '@/api/stacks.api';
import { apiErrorMessage } from '@/utils/apiError';
import { MaintenanceWindowEditor } from './MaintenanceWindowEditor';

/** Stack config: maintenance window — inherit the global one, any time, or a custom window. */
export function StackMaintenanceControl({ stack, onSaved }: { stack: Stack; onSaved: (s: Stack) => void }) {
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [draft, setDraft] = useState<MaintenanceWindow>(
    stack.maintenanceWindow?.mode === 'custom' ? stack.maintenanceWindow.window : { ...DEFAULT_MAINTENANCE_WINDOW },
  );
  const mode = stack.maintenanceWindow?.mode ?? 'inherit';
  const draftChanged = stack.maintenanceWindow?.mode === 'custom' && JSON.stringify(draft) !== JSON.stringify(stack.maintenanceWindow.window);

  const refresh = () => { stacksApi.getMaintenance(stack.id).then(setStatus).catch(() => setStatus(null)); };
  useEffect(refresh, [stack.id, JSON.stringify(stack.maintenanceWindow)]);

  const save = async (value: StackMaintenance) => {
    try {
      const updated = await stacksApi.update(stack.id, { maintenanceWindow: value });
      onSaved(updated);
      toast.success('Maintenance window saved');
    } catch (err) { toast.error(apiErrorMessage(err, 'Could not save the maintenance window')); }
  };

  const eff = status?.effective;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-text-primary flex items-center gap-1.5"><Clock size={14} /> Maintenance window</div>
          <div className="text-xs text-text-muted">Scheduled checks and auto-update only run inside it. Manual actions always work.</div>
        </div>
        <select value={mode} onChange={e => {
          const m = e.target.value;
          void save(m === 'inherit' ? null : m === 'always' ? { mode: 'always' } : { mode: 'custom', window: draft });
        }} className="rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary">
          <option value="inherit">Global setting</option>
          <option value="always">Any time</option>
          <option value="custom">Custom window</option>
        </select>
      </div>
      {mode === 'custom' && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <MaintenanceWindowEditor value={draft} onChange={setDraft} />
          {draftChanged && (
            <button type="button" onClick={() => void save({ mode: 'custom', window: draft })}
              className="px-3 py-1 text-xs rounded-md bg-accent text-white hover:bg-accent-hover">Save window</button>
          )}
        </div>
      )}
      {eff && (
        <div className={`text-xs ${status!.allowedNow ? 'text-status-up' : 'text-status-pending'}`}>
          {!eff.restricted
            ? 'Updates allowed at any time'
            : `${eff.source === 'global' ? 'Global window' : 'Window'} ${describeWindow(eff.window!)} (${eff.timezone}) — ${status!.allowedNow ? 'open now' : `closed now${status!.nextOpening ? `, opens ${new Date(status!.nextOpening).toLocaleString()}` : ''}`}`}
        </div>
      )}
    </div>
  );
}
