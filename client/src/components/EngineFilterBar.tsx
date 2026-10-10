import { Server } from 'lucide-react';
import type { DockerEngine } from '@oblihub/shared';

/**
 * Row of toggle buttons "All / <engine name> / …" used at the top of any multi-engine list.
 * Shared by Dashboard, ManagedStacks, Images, Networks, Volumes — same visual treatment so
 * filtering feels consistent across the app.
 *
 * Renders nothing when there are fewer than 2 enabled engines (the filter would be noise).
 *
 *   `selected` = null  → "All" is active
 *   `selected` = id    → that specific engine is active
 */
export type EngineFilterValue = number | null;

export function EngineFilterBar({
  engines,
  selected,
  onSelect,
  counts,
  totalCount,
  className = '',
}: {
  // Only these three fields are read, so non-admin pages can pass EngineSummary[] (the full
  // DockerEngine list is admin-only).
  engines: Array<Pick<DockerEngine, 'id' | 'name' | 'enabled'>>;
  selected: EngineFilterValue;
  onSelect: (value: EngineFilterValue) => void;
  counts?: Record<number, number>;
  totalCount?: number;
  className?: string;
}) {
  const enabled = engines.filter(e => e.enabled);
  if (enabled.length < 2) return null;

  const btn = (id: EngineFilterValue, label: string, count: number | undefined) => {
    const active = selected === id;
    return (
      <button
        key={id ?? 'all'}
        onClick={() => onSelect(id)}
        className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium border transition-colors ${
          active
            ? 'border-accent bg-accent/10 text-accent'
            : 'border-border bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary'
        }`}
      >
        {id != null && <Server size={11} />}
        {label}
        {typeof count === 'number' && (
          <span className={`text-[10px] ${active ? 'text-accent/70' : 'text-text-muted'}`}>({count})</span>
        )}
      </button>
    );
  };

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {btn(null, 'All', totalCount)}
      {enabled.map((e) => btn(e.id, e.name, counts?.[e.id]))}
    </div>
  );
}
