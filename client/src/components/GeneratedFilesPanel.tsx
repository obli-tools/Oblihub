import { useEffect, useState, type ReactNode } from 'react';
import { FileCog, ChevronDown, ChevronRight, RefreshCw, Layers, HardDrive, Network, Gauge, FileCode } from 'lucide-react';
import { managedStacksApi } from '@/api/managed-stacks.api';
import { apiErrorMessage } from '@/utils/apiError';
import type { GeneratedComposeFile, GeneratedComposeFileKind, ManagedStack } from '@oblihub/shared';

// A server older than the client sends only { name, path, content, exists }: every newer field
// may be missing at runtime, so the kind falls back to the file name.
type GenFile = Partial<GeneratedComposeFile> & Pick<GeneratedComposeFile, 'name' | 'path' | 'content' | 'exists'>;

const LEGACY_NAME_BY_KIND: Partial<Record<GeneratedComposeFileKind, string>> = {
  proxy: 'docker-compose.override.yml',
  resources: 'docker-compose.override.oblihub.yml',
  volumes: 'docker-compose.volumes.yml',
};

function findByKind(files: GenFile[], kind: GeneratedComposeFileKind): GenFile | undefined {
  return files.find(f => f.kind === kind)
    ?? (LEGACY_NAME_BY_KIND[kind] ? files.find(f => f.kind == null && f.name === LEGACY_NAME_BY_KIND[kind]) : undefined);
}

function FilePre({ content }: { content: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded bg-bg-primary border border-border p-3 font-mono text-[11px] text-text-secondary leading-relaxed">
{content}
    </pre>
  );
}

/** One collapsible file: path, present/not generated, owner and whether compose receives it. */
function FileSection({ title, icon, file, fallbackPath, bordered, emptyHint, unknownHint, children }: {
  title: string;
  icon: ReactNode;
  file: GenFile | undefined;
  fallbackPath: string;
  bordered: boolean;
  /** Shown when the file is absent and the server sent no note (older server). */
  emptyHint?: ReactNode;
  /**
   * Set when the panel cannot tell whether an absent file is really absent (load failed, not
   * answered yet, or a server that does not report this file). Replaces the "not generated" badge
   * and the emptyHint, which would otherwise explain an absence nobody observed.
   */
  unknownHint?: ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const exists = !!file?.exists;
  const statusUnknown = !exists && unknownHint != null;
  const operatorOwned = file?.owner === 'operator';
  const passed = file?.passedToCompose;
  return (
    <div className={bordered ? 'border-t border-border pt-3' : ''}>
      <button
        onClick={() => setOpen(v => !v)}
        className="flex flex-wrap items-center gap-2 text-xs text-text-secondary hover:text-text-primary text-left"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {icon}
        <span>{title}</span>
        <code className="font-mono text-text-muted">{file?.path || fallbackPath}</code>
        {!statusUnknown && (
          <span className={`text-[10px] uppercase tracking-wider ${exists ? 'text-status-up' : 'text-text-muted'}`}>
            {exists ? 'present' : 'not generated'}
          </span>
        )}
        {operatorOwned && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 rounded bg-bg-tertiary text-accent">yours</span>
        )}
        {exists && passed !== undefined && (
          <span className={`text-[10px] uppercase tracking-wider ${
            passed ? 'text-text-secondary' : operatorOwned ? 'text-status-warning' : 'text-text-muted'
          }`}>
            {passed ? 'passed to compose' : operatorOwned ? 'not passed' : 'reference only'}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {file?.note && <p className="text-xs text-text-muted">{file.note}</p>}
          {children}
          {exists && file?.content ? (
            <FilePre content={file.content} />
          ) : statusUnknown ? (
            <p className="text-xs text-text-muted italic">{unknownHint}</p>
          ) : !exists && !file?.note && emptyHint ? (
            <p className="text-xs text-text-muted italic">{emptyHint}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Read-only view of the files Oblihub generates or honours next to the operator's compose — the
 * proxy network override, the operator's own override under another compose default name, the
 * resource limits override (rendered from the stack's current limits) and the volumes override —
 * with whether each one is actually passed to compose, plus the merged "effective" compose the CLI
 * sees at up time. Answers "why is/isn't this service on the proxy network / capped" without SSH.
 */
export function GeneratedFilesPanel({ stack }: { stack: ManagedStack }) {
  // null until a load succeeds: an empty list must mean "the server listed nothing", never "no data".
  const [files, setFiles] = useState<GenFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [effective, setEffective] = useState<{ config: string | null; error: string | null } | null>(null);
  const [showEffective, setShowEffective] = useState(false);
  const [loading, setLoading] = useState(true);
  const [effectiveLoading, setEffectiveLoading] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    managedStacksApi.getGeneratedFiles(stack.id)
      .then(setFiles)
      // Keep what was already loaded: a failed refresh says nothing new about the files.
      .catch(err => setError(apiErrorMessage(err, 'Failed to load generated files')))
      .finally(() => setLoading(false));
  };
  // Reload when a deploy finishes too — the volumes override is only written at deploy time.
  useEffect(load, [stack.id, stack.status]);

  const loadEffective = () => {
    setEffectiveLoading(true);
    managedStacksApi.getEffectiveConfig(stack.id)
      .then(setEffective)
      .catch(err => setEffective({ config: null, error: err instanceof Error ? err.message : 'Fetch failed' }))
      .finally(() => setEffectiveLoading(false));
  };

  const list = files ?? [];
  const proxyOverride = findByKind(list, 'proxy');
  const operatorOverride = findByKind(list, 'operator');
  const resourcesOverride = findByKind(list, 'resources');
  const volumesOverride = findByKind(list, 'volumes');
  const boundVolumes = stack.volumePlacements.filter(p => p.hostPath).length;

  // Without a successful load an absent file is unknown, not "not generated".
  const unknownHint = error
    ? 'Status unknown: the generated files could not be loaded.'
    : files === null ? 'Loading…' : undefined;
  // A server older than the resources override sends no `kind` and no entry for it, yet still
  // writes and applies it — its absence from such a payload says nothing about the stack's limits.
  const resourcesUnknownHint = unknownHint
    ?? (resourcesOverride || list.some(f => f.kind != null)
      ? undefined
      : 'This server version does not report the resource limits override.');

  return (
    <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        <FileCog size={14} className="text-text-muted" />
        <h2 className="text-sm font-semibold text-text-secondary">Generated files</h2>
        <span className="text-[11px] text-text-muted ml-auto">
          Written or honoured by Oblihub next to your compose — read-only
        </span>
        <button onClick={load} disabled={loading} className="text-text-muted hover:text-text-primary" title="Refresh">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="p-4 space-y-3">
        {error && (
          <p role="alert" className="text-xs text-status-down">{error}</p>
        )}
        <FileSection
          title="Proxy network override"
          icon={<Network size={12} />}
          file={proxyOverride}
          fallbackPath="docker-compose.override.yml"
          bordered={false}
          unknownHint={unknownHint}
          emptyHint={
            <>
              No override written — either your compose declares its own top-level
              <code className="bg-bg-tertiary px-1 rounded mx-1">networks: proxy</code>
              (Oblihub steps aside), or no proxy_host targets any service in this stack.
            </>
          }
        />

        {operatorOverride && (
          <FileSection
            title="Your compose override"
            icon={<FileCode size={12} />}
            file={operatorOverride}
            fallbackPath={operatorOverride.name}
            bordered
          />
        )}

        <FileSection
          title="Resource limits override"
          icon={<Gauge size={12} />}
          file={resourcesOverride}
          fallbackPath="docker-compose.override.oblihub.yml"
          bordered
          unknownHint={resourcesUnknownHint}
          emptyHint="Nothing to render: the stack's limits do not change any compose service."
        />

        <FileSection
          title="Volumes override"
          icon={<HardDrive size={12} />}
          file={volumesOverride}
          fallbackPath=".oblihub/docker-compose.volumes.yml"
          bordered
          unknownHint={unknownHint}
        >
          <p className="text-[10px] uppercase tracking-wider text-text-muted">
            Storage: {boundVolumes > 0 ? `stacks dir (.volumes) · ${boundVolumes}` : stack.volumesInStacksDir && stack.volumePlacements.length === 0 ? 'decided at deploy' : 'docker default'}
          </p>
          {!stack.volumesInStacksDir ? (
            <p className="text-xs text-text-muted italic">
              This stack was created before volumes moved to the stacks dir — its named volumes stay in
              Docker's default location.
            </p>
          ) : stack.volumePlacements.length === 0 ? (
            <p className="text-xs text-text-muted italic">
              Named volumes will be created under
              <code className="bg-bg-tertiary px-1 rounded mx-1">.volumes/{stack.composeProject}/</code>
              in the stacks dir at the next deploy — local engine only, and only when the stacks dir is a
              host folder (otherwise they stay in Docker's default location; the deploy log says why).
            </p>
          ) : (
            <ul className="space-y-1">
              {stack.volumePlacements.map(p => (
                <li key={p.volume} className="text-xs flex items-center gap-2">
                  <code className="font-mono text-text-primary">{p.volume}</code>
                  <span className="text-text-muted">→</span>
                  {p.hostPath
                    ? <code className="font-mono text-text-secondary break-all">{p.hostPath}</code>
                    : <span className="text-text-muted italic">Docker default location (volume existed before the first deploy)</span>}
                </li>
              ))}
            </ul>
          )}
        </FileSection>

        {/* Effective config */}
        <div className="border-t border-border pt-3">
          <button
            onClick={() => {
              setShowEffective(v => {
                const next = !v;
                if (next && !effective && !effectiveLoading) loadEffective();
                return next;
              });
            }}
            className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary"
          >
            {showEffective ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Layers size={12} />
            <span>Effective compose <span className="text-text-muted">(compose + overrides + env, resolved)</span></span>
            {effectiveLoading && <RefreshCw size={11} className="animate-spin ml-1" />}
          </button>
          {showEffective && (
            <div className="mt-2">
              {effectiveLoading ? (
                <p className="text-xs text-text-muted italic">Running <code className="bg-bg-tertiary px-1 rounded">docker compose config</code>…</p>
              ) : effective?.config ? (
                <pre className="max-h-96 overflow-auto rounded bg-bg-primary border border-border p-3 font-mono text-[11px] text-text-secondary leading-relaxed">
{effective.config}
                </pre>
              ) : effective?.error ? (
                <p className="text-xs text-status-down italic">Failed: {effective.error}</p>
              ) : null}
              {effective && (
                <button onClick={loadEffective} className="mt-2 text-[11px] text-text-muted hover:text-text-primary inline-flex items-center gap-1">
                  <RefreshCw size={10} /> Reload
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
