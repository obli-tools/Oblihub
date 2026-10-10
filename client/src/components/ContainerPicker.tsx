import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Container as ContainerIcon, Pencil } from 'lucide-react';
import { buildPortChips, formatPortSummary } from '@oblihub/shared';
import type { Container, Stack } from '@oblihub/shared';
import { useStacksList } from '../hooks/useStacksList';
import { useEngineSummaries } from '../hooks/useEngineSummaries';

/**
 * Two-mode input for a proxy target:
 *   - "Container": searchable dropdown of every container Oblihub knows about, grouped by stack.
 *     Selecting emits the container's docker DNS name (its `containerName`).
 *   - "Custom": free-text input, for arbitrary hostnames / IPs (external services, tailscale
 *     addresses, LAN devices...).
 *
 * The picker is stateless w.r.t. Custom vs Container beyond first-render inference: if the
 * initial value matches a known container name, we start in Container mode; otherwise Custom.
 * The user can flip freely with the little pencil icon. `onChange` only ever receives the raw
 * host string — the mode toggle is UI sugar.
 */
export function ContainerPicker({
  value,
  onChange,
  placeholder = 'container-name or IP',
  disabled = false,
  onPickContainer,
}: {
  value: string;
  onChange: (host: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Called with the exact row picked, right after onChange(c.containerName): names are only
   *  unique per daemon, so callers that care about the engine or stack need the row itself. */
  onPickContainer?: (c: Container, s: Stack) => void;
}) {
  // Shared cache: an editor with many sub-routes mounts one picker per route.
  const { stacks, loading } = useStacksList();
  const { engines, byId } = useEngineSummaries();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'container' | 'custom'>('custom');
  const rootRef = useRef<HTMLDivElement>(null);
  // Engine names only disambiguate; a single-engine install keeps today's plain stack headers.
  const multiEngine = engines.length >= 2;

  // Infer mode from the value once containers are loaded. If the value matches a container name
  // we surface it as a selected item; otherwise stay in custom-text mode.
  useEffect(() => {
    if (loading) return;
    const known = new Set(stacks.flatMap(s => s.containers.map(c => c.containerName)));
    setMode(value && known.has(value) ? 'container' : 'custom');
  }, [loading, stacks, value]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stacks
      .map(s => ({
        stack: s,
        containers: s.containers.filter(c =>
          !q || c.containerName.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
        ),
      }))
      .filter(g => g.containers.length > 0);
  }, [stacks, search]);

  if (mode === 'custom') {
    return (
      <div className="flex gap-1">
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => { setMode('container'); setOpen(true); }}
          disabled={disabled || loading}
          title={loading ? 'Loading containers...' : 'Pick from container list'}
          className="px-2 rounded-lg border border-border bg-bg-tertiary text-text-muted hover:text-text-primary disabled:opacity-50"
        >
          <ContainerIcon size={14} />
        </button>
      </div>
    );
  }

  // container mode
  return (
    <div ref={rootRef} className="relative">
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          disabled={disabled}
          className="flex-1 flex items-center justify-between rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary hover:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        >
          <span className={value ? '' : 'text-text-muted'}>{value || placeholder}</span>
          <ChevronDown size={14} className="text-text-muted" />
        </button>
        <button
          type="button"
          onClick={() => { setMode('custom'); setOpen(false); }}
          disabled={disabled}
          title="Enter a custom hostname or IP"
          className="px-2 rounded-lg border border-border bg-bg-tertiary text-text-muted hover:text-text-primary disabled:opacity-50"
        >
          <Pencil size={14} />
        </button>
      </div>
      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 rounded-lg border border-border bg-bg-secondary shadow-lg max-h-72 overflow-hidden flex flex-col">
          <input
            type="text"
            autoFocus
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search container..."
            className="border-b border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none"
          />
          <div className="overflow-y-auto">
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-xs text-text-muted text-center">
                {loading ? 'Loading...' : 'No matching containers'}
              </div>
            )}
            {filtered.map(({ stack, containers }) => {
              const engine = stack.engineId != null ? byId.get(stack.engineId) : undefined;
              const engineName = stack.engineId == null ? 'Unknown engine' : engine?.name ?? null;
              return (
                <div key={stack.id}>
                  <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-text-muted bg-bg-primary/50 flex items-center gap-1.5">
                    <span className="truncate">{stack.name}</span>
                    {multiEngine && engineName && (
                      <span className="normal-case tracking-normal truncate">· {engineName}</span>
                    )}
                    {engine && !engine.isLocal && (
                      <span className="normal-case tracking-normal text-[9px] px-1 rounded bg-accent/10 text-accent flex-shrink-0">remote</span>
                    )}
                  </div>
                  {containers.map((c: Container) => {
                    const summary = formatPortSummary(c.ports ?? []);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => { onChange(c.containerName); onPickContainer?.(c, stack); setOpen(false); setSearch(''); }}
                        className={`w-full text-left px-3 py-1.5 text-sm hover:bg-bg-tertiary flex items-center justify-between ${c.containerName === value ? 'bg-bg-tertiary text-accent' : 'text-text-primary'}`}
                      >
                        <span className="truncate">{c.containerName}</span>
                        {summary && (
                          <span
                            className="text-[11px] text-text-muted ml-2 flex-shrink-0"
                            title={buildPortChips(c.ports ?? []).map(ch => ch.label).join(', ')}
                          >
                            {summary}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
