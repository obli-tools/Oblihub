import { useEffect, useState } from 'react';
import { History, RotateCcw, CheckCircle2, XCircle } from 'lucide-react';
import { managedStacksApi } from '@/api/managed-stacks.api';
import type { ManagedStack, ManagedStackDeployHistoryEntry } from '@oblihub/shared';
import toast from 'react-hot-toast';
import { apiErrorMessage } from '@/utils/apiError';

/**
 * Deploy history + rollback for a git-sourced managed stack.
 *
 * Each row corresponds to a past `deploy` / `redeploy` / `rollback` / auto poll-triggered deploy.
 * The current stack ref is highlighted; every other entry with a git_ref exposes a "Redeploy this
 * version" button that checks out that ref and re-runs compose up (`--build` when the stack has
 * build_enabled). Non-git stacks show a stub message — rollback is only meaningful when there's
 * a repo to check out from.
 */
export function DeployHistoryPanel({ stack, onStackUpdated }: { stack: ManagedStack; onStackUpdated: (s: ManagedStack) => void }) {
  const [history, setHistory] = useState<ManagedStackDeployHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    managedStacksApi.getDeployHistory(stack.id)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, [stack.id]);

  const handleRollback = async (entry: ManagedStackDeployHistoryEntry) => {
    if (!entry.gitRef) return;
    if (!confirm(`Redeploy ${stack.name} at ${entry.gitRef}? This will check out that commit and re-run compose up${stack.buildEnabled ? ' --build' : ''}.`)) return;
    setBusy(true);
    try {
      const updated = await managedStacksApi.rollback(stack.id, entry.gitRef);
      toast.success(`Rolled back to ${entry.gitRef}`);
      onStackUpdated(updated);
      load();
    } catch (err) {
      // Surface the server's `{ error }` text (e.g. the 409 "retry in a few seconds" while a
      // background compose run holds the stack lock) instead of axios's generic status message.
      toast.error(apiErrorMessage(err, 'Rollback failed'));
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        <History size={14} className="text-text-muted" />
        <h2 className="text-sm font-semibold text-text-secondary">Deploy history</h2>
        <span className="text-[11px] text-text-muted ml-auto">
          {stack.sourceType === 'git' ? 'Click Redeploy on any past commit to roll back' : 'Rollback requires a git source'}
        </span>
      </div>
      <div className="p-4">
        {loading ? (
          <p className="text-xs text-text-muted">Loading…</p>
        ) : history.length === 0 ? (
          <p className="text-xs text-text-muted">
            No deploys recorded yet. History accumulates automatically on each deploy / rollback / auto-pull.
          </p>
        ) : (
          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            {history.map(entry => {
              const isCurrent = stack.gitRef && entry.gitRef === stack.gitRef;
              const canRollback = stack.sourceType === 'git' && !!entry.gitRef && !isCurrent && entry.success;
              return (
                <div
                  key={entry.id}
                  className={`flex items-start gap-3 rounded-md border px-3 py-2 text-xs ${
                    isCurrent
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-border bg-bg-tertiary'
                  }`}
                >
                  <div className="mt-0.5">
                    {entry.success
                      ? <CheckCircle2 size={14} className="text-status-up" />
                      : <XCircle size={14} className="text-status-down" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {entry.gitRef && <code className="font-mono text-[11px] bg-bg-primary px-1.5 py-0.5 rounded">{entry.gitRef}</code>}
                      {entry.gitBranch && <span className="text-text-muted">on {entry.gitBranch}</span>}
                      {isCurrent && <span className="text-[10px] uppercase tracking-wider text-accent font-semibold">current</span>}
                      {entry.buildEnabled && <span className="text-[10px] uppercase tracking-wider text-text-muted">--build</span>}
                    </div>
                    <div className="text-text-muted mt-0.5">
                      {new Date(entry.deployedAt).toLocaleString()}
                      {entry.notes && <span className="ml-2 italic">— {entry.notes}</span>}
                    </div>
                  </div>
                  {canRollback && (
                    <button
                      onClick={() => void handleRollback(entry)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-50"
                      title="Check out this commit and re-run compose up"
                    >
                      <RotateCcw size={11} /> Redeploy
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
