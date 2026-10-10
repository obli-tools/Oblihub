import { useEffect, useRef, useState } from 'react';
import { Upload, GitBranch, FileCode, RefreshCw, FolderTree, ChevronDown, ChevronRight } from 'lucide-react';
import { managedStacksApi } from '@/api/managed-stacks.api';
import type { ManagedStack } from '@oblihub/shared';
import toast from 'react-hot-toast';
import { apiErrorMessage } from '@/utils/apiError';

/**
 * Source panel for a managed stack. Lets the operator point the stack's working directory
 * at one of three things:
 *
 *   - compose-only — legacy mode, no upload, just paste compose + env in the editor
 *   - zip          — upload a tarball (re-uploadable; .env is preserved across replacements)
 *   - git          — clone from a repo URL + branch; refreshable via "Pull latest"
 *
 * The build pipeline (next iteration) reads from the resulting dir. This panel is only
 * about ingesting source — discovery + env-form + build come after.
 */
export function SourcePanel({ stack, onStackUpdated }: { stack: ManagedStack; onStackUpdated: (s: ManagedStack) => void }) {
  const [sourceType, setSourceType] = useState(stack.sourceType);
  const [gitUrl, setGitUrl] = useState(stack.gitUrl || '');
  const [gitBranch, setGitBranch] = useState(stack.gitBranch || 'main');
  const [gitUsername, setGitUsername] = useState(stack.gitUsername || '');
  const [gitToken, setGitToken] = useState('');
  const [composePath, setComposePath] = useState(stack.composePath || '');
  const [buildEnabled, setBuildEnabled] = useState(stack.buildEnabled);
  const [pollGitIntervalS, setPollGitIntervalS] = useState(stack.pollGitIntervalS);
  const [busy, setBusy] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [files, setFiles] = useState<{ path: string; size: number; isDir: boolean }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync local state when the parent feeds in a fresh stack (e.g. after re-fetch).
  useEffect(() => {
    setSourceType(stack.sourceType);
    setGitUrl(stack.gitUrl || '');
    setGitBranch(stack.gitBranch || 'main');
    setGitUsername(stack.gitUsername || '');
    setComposePath(stack.composePath || '');
    setBuildEnabled(stack.buildEnabled);
    setPollGitIntervalS(stack.pollGitIntervalS);
    // Never rehydrate the token from the server — it's write-only and stored encrypted.
    setGitToken('');
  }, [stack.id, stack.sourceType, stack.gitUrl, stack.gitBranch, stack.gitUsername, stack.composePath, stack.buildEnabled, stack.pollGitIntervalS]);

  /** Persist build_enabled + poll_git_interval_s via the standard managed-stack update. Separate
   *  from the git source flow (setGit) so the operator can flip the build toggle without needing
   *  to re-clone the repo. */
  const handleSaveBuildSettings = async () => {
    setBusy(true);
    try {
      const updated = await managedStacksApi.update(stack.id, {
        buildEnabled,
        pollGitIntervalS,
      });
      toast.success('Build settings saved');
      onStackUpdated(updated);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Save failed'));
    } finally { setBusy(false); }
  };

  const buildDirty = buildEnabled !== stack.buildEnabled || pollGitIntervalS !== stack.pollGitIntervalS;

  const handleZipChosen = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast.error('Please choose a .zip file');
      return;
    }
    setBusy(true);
    try {
      const updated = await managedStacksApi.uploadZip(stack.id, file);
      toast.success(`Uploaded ${file.name} (${formatSize(file.size)})`);
      onStackUpdated(updated);
      if (showFiles) void loadFiles();
    } catch (err) {
      const message = apiErrorMessage(err, 'Upload failed');
      toast.error(message);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleGitSet = async () => {
    if (!gitUrl.trim()) { toast.error('Git URL is required'); return; }
    setBusy(true);
    try {
      const updated = await managedStacksApi.setGitSource(stack.id, {
        gitUrl: gitUrl.trim(),
        gitBranch: gitBranch.trim() || 'main',
        gitUsername: gitUsername.trim() || null,
        // Empty token when the operator already has one stored = "keep existing". Only send
        // the token value when they typed a new one to (re)set it.
        gitToken: gitToken ? gitToken : (stack.hasGitToken ? undefined : null),
        composePath: composePath.trim() || null,
      });
      toast.success('Repo cloned');
      onStackUpdated(updated);
      if (showFiles) void loadFiles();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Clone failed'));
    } finally { setBusy(false); }
  };

  const handleGitPull = async () => {
    setBusy(true);
    try {
      const res = await managedStacksApi.gitPull(stack.id);
      // Server returns { data: stack, redeployStarted: bool }. `data` is what the previous API
      // shape returned, so we back-compat the toast copy with the flag when present.
      const updated = res.stack;
      toast.success(
        res.redeployStarted
          ? `Pulled to ${updated.gitRef || 'latest'} — redeploy started`
          : `Pulled to ${updated.gitRef || 'latest'} (deploy manually to apply)`,
      );
      onStackUpdated(updated);
      if (showFiles) void loadFiles();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Pull failed'));
    } finally { setBusy(false); }
  };

  const loadFiles = async () => {
    try {
      setFiles(await managedStacksApi.listSourceFiles(stack.id));
    } catch { /* silent — the dir might be empty */ }
  };

  const toggleFiles = () => {
    setShowFiles(s => {
      const next = !s;
      if (next) void loadFiles();
      return next;
    });
  };

  return (
    <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden mb-4">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        <FileCode size={14} className="text-text-muted" />
        <h2 className="text-sm font-semibold text-text-secondary">Source</h2>
        {stack.lastSourceSyncAt && stack.sourceType !== 'compose-only' && (
          <span className="text-[10px] text-text-muted ml-auto">
            Last sync: {new Date(stack.lastSourceSyncAt).toLocaleString()}
            {stack.gitRef && <span className="font-mono ml-2">@ {stack.gitRef}</span>}
          </span>
        )}
      </div>

      <div className="p-4 space-y-3">
        {/* Source type toggle */}
        <div className="flex gap-1 bg-bg-tertiary rounded-lg p-1 w-fit">
          {(['compose-only', 'zip', 'git'] as const).map(t => (
            <button
              key={t}
              onClick={() => setSourceType(t)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                sourceType === t ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {t === 'compose-only' ? 'Compose only' : t === 'zip' ? 'ZIP upload' : 'Git repo'}
            </button>
          ))}
        </div>

        {sourceType === 'compose-only' && (
          <p className="text-xs text-text-muted">
            Default mode — write your <code className="bg-bg-tertiary px-1 rounded">docker-compose.yml</code>
            {' '}directly in the editor below. No source files to upload.
          </p>
        )}

        {sourceType === 'zip' && (
          <div className="space-y-2">
            <p className="text-xs text-text-muted">
              Upload a <code className="bg-bg-tertiary px-1 rounded">.zip</code> of your project. Re-uploading replaces
              everything cleanly — your <code className="bg-bg-tertiary px-1 rounded">.env</code> is preserved across uploads.
            </p>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                onChange={e => { const f = e.target.files?.[0]; if (f) void handleZipChosen(f); }}
                className="hidden"
                id={`zip-upload-${stack.id}`}
              />
              <label
                htmlFor={`zip-upload-${stack.id}`}
                className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg cursor-pointer ${
                  busy ? 'bg-bg-tertiary text-text-muted cursor-not-allowed' : 'bg-accent text-white hover:bg-accent-hover'
                }`}
              >
                <Upload size={13} /> {stack.sourceType === 'zip' && stack.lastSourceSyncAt ? 'Re-upload ZIP' : 'Upload ZIP'}
              </label>
              {stack.sourceType === 'zip' && stack.lastSourceSyncAt && (
                <span className="text-[11px] text-text-muted">
                  Current sources from {new Date(stack.lastSourceSyncAt).toLocaleString()}
                </span>
              )}
            </div>
          </div>
        )}

        {sourceType === 'git' && (
          <div className="space-y-3">
            <p className="text-xs text-text-muted">
              Clone from a git repo. Use a deploy key or HTTPS-with-token URL for private repos. Use{' '}
              <strong>Pull latest</strong> to grab new commits — auto-redeploys when the stack has already been deployed.
            </p>
            <div className="grid grid-cols-[1fr_140px] gap-2">
              <input
                type="text"
                value={gitUrl}
                onChange={e => setGitUrl(e.target.value)}
                placeholder="https://github.com/user/repo.git"
                className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <input
                type="text"
                value={gitBranch}
                onChange={e => setGitBranch(e.target.value)}
                placeholder="main"
                className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
            {/* Optional private-repo auth (Gitea deploy token, GitHub PAT, GitLab access token).
                Token stored AES-GCM at rest, never returned by the API. Leave blank to keep the
                stored value when re-cloning. */}
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={gitUsername}
                onChange={e => setGitUsername(e.target.value)}
                placeholder="git username (private repos only)"
                autoComplete="off"
                className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <input
                type="password"
                value={gitToken}
                onChange={e => setGitToken(e.target.value)}
                placeholder={stack.hasGitToken ? '••••••• (unchanged — type to replace)' : 'git deploy token (private repos only)'}
                autoComplete="new-password"
                className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
            <input
              type="text"
              value={composePath}
              onChange={e => setComposePath(e.target.value)}
              placeholder="compose path in repo (leave blank for root — e.g. stack/docker-compose.yml)"
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleGitSet()}
                disabled={busy || !gitUrl.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
              >
                <GitBranch size={13} /> {stack.sourceType === 'git' ? 'Re-clone' : 'Clone'}
              </button>
              {stack.sourceType === 'git' && stack.gitUrl && (
                <button
                  onClick={() => void handleGitPull()}
                  disabled={busy}
                  title={stack.status === 'draft' ? 'Pull latest commits into the editor (deploy manually to apply)' : 'Pull latest commits and redeploy — same as the auto-pull worker'}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg border border-border text-text-secondary hover:bg-bg-hover disabled:opacity-50"
                >
                  <RefreshCw size={13} /> Pull latest
                </button>
              )}
            </div>
          </div>
        )}

        {/* Build + poll settings — visible for zip/git sources. Build applies to both (Dockerfiles
            in the source get rebuilt). Poll only applies to git. Save is separate from the git
            source flow so toggling doesn't re-clone. */}
        {sourceType !== 'compose-only' && (
          <div className="border-t border-border pt-3 space-y-2">
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={buildEnabled}
                onChange={e => setBuildEnabled(e.target.checked)}
                className="rounded border-border"
              />
              <span>
                <strong>Build on deploy</strong> — run{' '}
                <code className="bg-bg-tertiary px-1 rounded">docker compose up -d --build</code>{' '}
                so Dockerfiles in the source are rebuilt each time (skips the registry pull step).
              </span>
            </label>
            {sourceType === 'git' && (
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <label className="whitespace-nowrap">
                  <strong>Auto-pull</strong> git every
                </label>
                <input
                  type="number"
                  min={0}
                  value={pollGitIntervalS}
                  onChange={e => setPollGitIntervalS(Math.max(0, parseInt(e.target.value, 10) || 0))}
                  className="w-24 rounded border border-border bg-bg-tertiary px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <span>seconds (0 = disabled). Poll-only, no ingress webhook — works behind NAT.</span>
              </div>
            )}
            {buildDirty && (
              <button
                onClick={() => void handleSaveBuildSettings()}
                disabled={busy}
                className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
              >
                Save build settings
              </button>
            )}
          </div>
        )}

        {/* File listing — collapsed by default, shown when relevant */}
        {sourceType !== 'compose-only' && (
          <div className="border-t border-border pt-3">
            <button
              onClick={toggleFiles}
              className="text-[11px] text-text-muted hover:text-text-primary inline-flex items-center gap-1"
            >
              {showFiles ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              <FolderTree size={11} /> Files on disk{showFiles && files.length > 0 && ` (${files.filter(f => !f.isDir).length})`}
            </button>
            {showFiles && (
              <div className="mt-2 max-h-48 overflow-auto rounded bg-bg-primary border border-border p-2 font-mono text-[10px] leading-relaxed">
                {files.length === 0 ? (
                  <div className="text-text-muted italic">No files yet — upload a ZIP or clone a repo.</div>
                ) : (
                  files.map(f => (
                    <div key={f.path} className={f.isDir ? 'text-accent' : 'text-text-secondary'}>
                      {f.isDir ? '📁 ' : '   '}{f.path}
                      {!f.isDir && <span className="text-text-muted ml-2">{formatSize(f.size)}</span>}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
