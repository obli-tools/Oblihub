import { useMemo, useState } from 'react';

/**
 * Multi-series line chart with hover tooltip. Pure SVG, no external deps — coherent with the
 * existing Sparkline component. Y-axis auto-scaled to fit all series, X-axis is time-index
 * (assumes points are evenly spaced within the given range, which the backend guarantees for
 * the 1m / 1h buckets).
 *
 * Not a general-purpose chart lib: fits the "traffic over time" use case (a few dozen to a
 * few thousand points per series). Renders inline so it participates naturally in the theme
 * (background, borders) without ad-hoc dark-mode overrides.
 */
export interface Series {
  name: string;
  color: string;
  values: number[];
  format?: (v: number) => string;
}

export function LineChart({
  series,
  labels,
  height = 220,
  yLabel,
}: {
  series: Series[];
  labels: string[]; // X-axis labels (one per data point). Truncated to ~6 shown labels.
  height?: number;
  yLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const width = 800; // viewBox width — scales to parent via CSS
  const padLeft = 48, padRight = 12, padTop = 12, padBottom = 28;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const { minY, maxY, hasData } = useMemo(() => {
    let mn = Infinity, mx = -Infinity, any = false;
    for (const s of series) for (const v of s.values) {
      if (v == null || isNaN(v)) continue;
      any = true;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!any) return { minY: 0, maxY: 1, hasData: false };
    if (mx === mn) mx = mn + 1;
    // Give a tiny top margin so peaks don't kiss the axis.
    return { minY: 0, maxY: mx * 1.1, hasData: true };
  }, [series]);

  const n = labels.length;
  if (!hasData || n < 2) {
    return (
      <div className="rounded-lg border border-border bg-bg-tertiary/40 flex items-center justify-center text-xs text-text-muted" style={{ height }}>
        No data in this range
      </div>
    );
  }

  const xOf = (i: number) => padLeft + (i / (n - 1)) * chartW;
  const yOf = (v: number) => padTop + chartH - ((v - minY) / (maxY - minY)) * chartH;

  const paths = series.map(s => {
    const parts: string[] = [];
    for (let i = 0; i < s.values.length; i++) {
      const v = s.values[i];
      if (v == null || isNaN(v)) { parts.push('M'); continue; }
      parts.push(`${parts.length === 0 || parts[parts.length - 1] === 'M' ? 'M' : 'L'}${xOf(i)},${yOf(v)}`);
    }
    return parts.join(' ');
  });

  // Y ticks — 4 lines.
  const yTicks = [0, 0.33, 0.66, 1].map(f => {
    const v = minY + (maxY - minY) * f;
    return { v, y: yOf(v) };
  });

  // X labels — show 6 evenly spaced.
  const xLabelIndices = Array.from({ length: 6 }, (_, i) => Math.round((i / 5) * (n - 1)));

  return (
    <div className="rounded-lg border border-border bg-bg-tertiary/40 p-2">
      <div className="flex gap-3 mb-2 text-[10px] items-center flex-wrap">
        {series.map(s => (
          <div key={s.name} className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded" style={{ background: s.color }} />
            <span className="text-text-secondary">{s.name}</span>
          </div>
        ))}
        {yLabel && <span className="text-text-muted ml-auto">{yLabel}</span>}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        onMouseLeave={() => setHover(null)}
        onMouseMove={e => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * width;
          const rawI = ((relX - padLeft) / chartW) * (n - 1);
          const i = Math.max(0, Math.min(n - 1, Math.round(rawI)));
          setHover(i);
        }}
      >
        {/* Y grid + tick labels */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={padLeft} x2={padLeft + chartW} y1={t.y} y2={t.y} stroke="#3a3f4a" strokeDasharray="2 3" strokeWidth={0.5} />
            <text x={padLeft - 6} y={t.y + 3} textAnchor="end" fontSize="9" fill="#8b95a5" fontFamily="ui-monospace, monospace">
              {formatShortNumber(t.v)}
            </text>
          </g>
        ))}
        {/* Series paths */}
        {series.map((s, i) => (
          <path key={i} d={paths[i]} stroke={s.color} strokeWidth={1.6} fill="none" strokeLinejoin="round" />
        ))}
        {/* X labels */}
        {xLabelIndices.map(i => (
          <text key={i} x={xOf(i)} y={height - 8} textAnchor="middle" fontSize="9" fill="#8b95a5" fontFamily="ui-monospace, monospace">
            {labels[i] || ''}
          </text>
        ))}
        {/* Hover cursor + tooltip */}
        {hover != null && (
          <>
            <line x1={xOf(hover)} x2={xOf(hover)} y1={padTop} y2={padTop + chartH} stroke="#8b95a5" strokeWidth={0.5} />
            {series.map((s, i) => {
              const v = s.values[hover];
              if (v == null || isNaN(v)) return null;
              return (
                <circle key={i} cx={xOf(hover)} cy={yOf(v)} r={3} fill={s.color} stroke="#0d1117" strokeWidth={1.5} />
              );
            })}
          </>
        )}
      </svg>
      {/*
        Hover details reserve a constant height even when nothing is hovered — the earlier
        version showed the row only on hover, which shifted every element below it as the mouse
        crossed the chart. Fixed min-height with an empty placeholder keeps the layout stable.
      */}
      <div className="text-[10px] font-mono text-text-secondary mt-1 flex flex-wrap gap-3 min-h-[16px]">
        {hover != null && (
          <>
            <span className="text-text-muted">{labels[hover]}</span>
            {series.map(s => {
              const v = s.values[hover];
              return (
                <span key={s.name} style={{ color: s.color }}>
                  {s.name}: {s.format ? s.format(v ?? 0) : formatShortNumber(v ?? 0)}
                </span>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

export function formatShortNumber(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

export function formatBytes(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}TB`;
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}GB`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}MB`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}kB`;
  return `${v}B`;
}
