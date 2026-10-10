import { formatShortNumber } from './LineChart';

/**
 * Donut chart for HTTP status code distribution. Pure SVG, four fixed segments (2xx/3xx/4xx/5xx)
 * with the color scheme already used by the traffic charts so the whole page stays coherent.
 * Center label shows the total request count.
 */
export function StatusDonut({
  s2xx, s3xx, s4xx, s5xx,
  size = 180,
}: {
  s2xx: number; s3xx: number; s4xx: number; s5xx: number;
  size?: number;
}) {
  const total = s2xx + s3xx + s4xx + s5xx;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 8;
  const stroke = 22;
  const rInner = r - stroke / 2;
  const circumference = 2 * Math.PI * rInner;

  const segments = [
    { label: '2xx', value: s2xx, color: '#22c55e' },
    { label: '3xx', value: s3xx, color: '#4a9eff' },
    { label: '4xx', value: s4xx, color: '#f59e0b' },
    { label: '5xx', value: s5xx, color: '#ef4444' },
  ];

  // Cumulative offset so segments render one after the other around the donut.
  let acc = 0;
  const arcs = segments.map(seg => {
    const frac = total > 0 ? seg.value / total : 0;
    const dash = frac * circumference;
    const gap = circumference - dash;
    // -90° rotation so the arc starts at the top instead of at 3 o'clock.
    const offset = -acc * circumference;
    acc += frac;
    return { ...seg, dash, gap, offset, frac };
  });

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="flex-shrink-0 -rotate-90">
        {/* Background ring — visible when total == 0 or as the "unused" slice */}
        <circle cx={cx} cy={cy} r={rInner} fill="none" stroke="#1f2937" strokeWidth={stroke} />
        {total > 0 && arcs.map((a, i) => (
          <circle
            key={i}
            cx={cx} cy={cy} r={rInner}
            fill="none"
            stroke={a.color}
            strokeWidth={stroke}
            strokeDasharray={`${a.dash} ${a.gap}`}
            strokeDashoffset={a.offset}
            strokeLinecap="butt"
          />
        ))}
      </svg>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div>
          <div className="text-2xl font-semibold text-text-primary font-mono">{formatShortNumber(total)}</div>
          <div className="text-[10px] text-text-muted uppercase tracking-wider">Total responses</div>
        </div>
        {arcs.map(a => (
          <div key={a.label} className="flex items-center gap-2 text-xs">
            <div className="w-2 h-2 rounded-sm" style={{ background: a.color }} />
            <span className="text-text-secondary font-mono w-8">{a.label}</span>
            <span className="text-text-primary font-mono">{formatShortNumber(a.value)}</span>
            <span className="text-text-muted ml-auto">{(a.frac * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
