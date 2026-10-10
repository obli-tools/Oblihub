import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Sparkline } from '../Sparkline';

/**
 * Stat card with sparkline + delta chip vs previous period.
 *
 * Delta computation is left to the caller — it needs semantic context for the "good direction":
 * fewer errors is good (green delta down = ↓ colored green), lower latency is good, more
 * bandwidth is neutral. Caller sets `goodDirection`.
 *
 * Displayed value is expected to be pre-formatted (e.g. "2.3k", "1.4GB", "3.2%") — the card
 * only handles presentation.
 */
export function StatCardDelta({
  label, value, icon: Icon, spark, sparkColor, deltaText, deltaKind,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  spark: number[];
  sparkColor: string;
  deltaText: string | null;
  deltaKind: 'good' | 'bad' | 'neutral' | null; // colors + arrow direction on the chip
}) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <div className="flex items-center gap-2 text-xs text-text-muted mb-1">
        <Icon size={12} /> {label}
      </div>
      <div className="flex items-baseline gap-2 mb-2 flex-wrap">
        <div className="text-2xl font-semibold text-text-primary font-mono">{value}</div>
        {deltaText && <DeltaChip kind={deltaKind ?? 'neutral'} text={deltaText} />}
      </div>
      {spark.length >= 2 && <Sparkline data={spark} width={180} height={30} color={sparkColor} />}
    </div>
  );
}

function DeltaChip({ kind, text }: { kind: 'good' | 'bad' | 'neutral'; text: string }) {
  const colorCls = {
    good: 'bg-status-up/10 text-status-up',
    bad: 'bg-status-down/10 text-status-down',
    neutral: 'bg-bg-tertiary text-text-muted',
  }[kind];
  // Text is expected to already include the sign — the arrow is a redundant, discoverable cue.
  const Arrow = text.startsWith('▲') || text.startsWith('+') ? ArrowUp
             : text.startsWith('▼') || text.startsWith('-') ? ArrowDown
             : Minus;
  const cleaned = text.replace(/^[▲▼+-]\s*/, '');
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono ${colorCls}`}>
      <Arrow size={10} /> {cleaned}
    </span>
  );
}
