import { useMemo, type MouseEvent } from 'react';
import { Globe } from 'lucide-react';
import { buildPortChips } from '@oblihub/shared';
import type { ContainerPort, PortChipModel } from '@oblihub/shared';

function cmpText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Chips for an aggregated view (several containers on one card). Built per container and then
 * concatenated: buildPortChips compacts adjacent ports, and across containers that would fold
 * prometheus 9090 + pushgateway 9091 into one '9090-9091' chip that reads as a single container
 * publishing a range. Identical chips (replicas of one service) are shown once.
 */
export function buildGroupedPortChips(groups: ContainerPort[][], includeInternal: boolean): PortChipModel[] {
  const byKey = new Map<string, PortChipModel>();
  for (const group of groups) {
    for (const chip of buildPortChips(group ?? [], { includeInternal })) {
      // chip.key omits the range end (unique within one compacted list, not across containers):
      // internal 3000-3001 on one container and internal 3000 on another are different chips.
      const key = `${chip.key}|${chip.containerEnd}`;
      if (!byKey.has(key)) byKey.set(key, { ...chip, key });
    }
  }
  const chips = [...byKey.values()];
  // Same order as buildPortChips: published by host port, then internal by container port.
  const published = chips.filter((c) => c.kind === 'published').sort((a, b) =>
    (a.hostStart! - b.hostStart!)
    || cmpText(a.protocol, b.protocol)
    || cmpText(a.hostIp ?? '', b.hostIp ?? '')
    || a.containerStart - b.containerStart);
  const internal = chips.filter((c) => c.kind !== 'published').sort((a, b) =>
    a.containerStart - b.containerStart || cmpText(a.protocol, b.protocol));
  return [...published, ...internal];
}

/**
 * Compact port list: published ports as the dashboard's grey chips with a globe, internal
 * (exposed but not published) ports as dashed chips, loopback-only bindings in warning colour
 * because they are unreachable from other machines. Ranges arrive pre-compacted from
 * buildPortChips, so a 10000-port UDP range is one chip. Pass `portGroups` (one list per
 * container) instead of `ports` when a card aggregates several containers.
 */
export function PortChips({
  ports,
  portGroups,
  showInternal = true,
  max = 8,
  size = 'xs',
  onPick,
  highlightContainerPort = null,
  emptyLabel = null,
  className = '',
}: {
  ports?: ContainerPort[];
  portGroups?: ContainerPort[][];
  showInternal?: boolean;
  max?: number;
  size?: 'xs' | 'sm';
  onPick?: (chip: PortChipModel) => void;
  highlightContainerPort?: number | null;
  emptyLabel?: string | null;
  className?: string;
}) {
  const chips = useMemo(
    () => portGroups
      ? buildGroupedPortChips(portGroups, showInternal)
      : buildPortChips(ports ?? [], { includeInternal: showInternal }),
    [ports, portGroups, showInternal],
  );

  const sizeCls = size === 'sm' ? 'text-[11px] px-2' : 'text-[10px] px-1.5';

  if (chips.length === 0) {
    return emptyLabel ? <span className={`text-text-muted ${size === 'sm' ? 'text-[11px]' : 'text-[10px]'} ${className}`}>{emptyLabel}</span> : null;
  }

  const limit = Math.max(0, max);
  const visible = chips.length > limit ? chips.slice(0, limit) : chips;
  const hidden = chips.length > limit ? chips.slice(limit) : [];

  const renderLabel = (chip: PortChipModel) => {
    // Dim the container side of a mapping like today's dashboard chips, so the host port (the
    // part people type into a browser) stands out.
    const arrow = chip.kind === 'published' ? chip.label.indexOf('→') : -1;
    if (arrow < 0) return chip.label;
    return <>{chip.label.slice(0, arrow)}<span className="opacity-50">{chip.label.slice(arrow)}</span></>;
  };

  const renderChip = (chip: PortChipModel) => {
    const highlighted = highlightContainerPort != null
      && highlightContainerPort >= chip.containerStart && highlightContainerPort <= chip.containerEnd;
    const look = chip.kind === 'published'
      ? `gap-0.5 bg-bg-tertiary ${chip.loopback ? 'text-status-warning' : 'text-text-secondary'}`
      : 'border border-dashed border-border text-text-muted';
    const cls = `inline-flex items-center py-0.5 rounded font-mono ${sizeCls} ${look}${highlighted ? ' ring-1 ring-accent' : ''}`;
    const content = (
      <>
        {chip.kind === 'published' && <Globe size={8} className="opacity-60 shrink-0" />}
        {renderLabel(chip)}
      </>
    );
    if (onPick) {
      return (
        <button
          key={chip.key}
          type="button"
          title={chip.title}
          // Dashboard cards navigate on click; picking a port must not open the stack.
          onClick={(e: MouseEvent) => { e.stopPropagation(); onPick(chip); }}
          className={`${cls} hover:bg-bg-hover transition-colors`}
        >
          {content}
        </button>
      );
    }
    return <span key={chip.key} title={chip.title} className={cls}>{content}</span>;
  };

  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {visible.map(renderChip)}
      {hidden.length > 0 && (
        <span
          className={`inline-flex items-center py-0.5 rounded font-mono bg-bg-tertiary text-text-muted ${sizeCls}`}
          title={hidden.map((c) => c.label).join(', ')}
        >
          +{hidden.length}
        </span>
      )}
    </div>
  );
}
