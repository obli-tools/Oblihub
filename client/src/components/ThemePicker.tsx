import { Check } from 'lucide-react';
import type { AppTheme } from '@/utils/theme';
import { cn } from '@/utils/cn';

interface ThemePickerProps {
  value: AppTheme;
  onChange: (theme: AppTheme) => void;
}

/* ─── SVG mini-dashboard previews ─────────────────────────────────────────── */

function OperatorPreviewSvg() {
  // Obli Operator : fond bleu nuit, accent bleu Oblihub qui ressort.
  return (
    <svg viewBox="0 0 280 170" xmlns="http://www.w3.org/2000/svg" className="w-full rounded-md">
      <rect width="280" height="170" fill="#0b0d1a" rx="6" />
      <rect x="0" y="0" width="60" height="170" fill="#0f1220" rx="6" />
      <rect x="10" y="12" width="16" height="16" rx="3" fill="#1678cd" />
      <rect x="31" y="15" width="22" height="5" rx="2" fill="#8c93b6" />
      {[40, 62, 84, 106].map((y, i) => (
        <g key={y}>
          <rect x="7" y={y} width="46" height="16" rx="3"
            fill={i === 0 ? 'rgba(22,120,205,0.18)' : 'transparent'} />
          <rect x="13" y={y + 4} width="8" height="8" rx="2"
            fill={i === 0 ? '#488fec' : '#4b5273'} />
          <rect x="25" y={y + 6} width={i === 0 ? 22 : 18} height="4" rx="2"
            fill={i === 0 ? '#e8ecf5' : '#8c93b6'} />
        </g>
      ))}
      <rect x="61" y="0" width="219" height="28" fill="#0f1220" />
      <rect x="70" y="8" width="50" height="12" rx="3" fill="#131728" />
      <rect x="230" y="9" width="44" height="10" rx="4" fill="#131728" />
      {[0, 1, 2, 3].map((i) => {
        const colors = ['#1edd8a', '#1678cd', '#f5a623', '#488fec'];
        const labels = [68, 4, 2, 8];
        const x = 70 + i * 52;
        return (
          <g key={i}>
            <rect x={x} y="36" width="44" height="24" rx="4" fill="#131728" />
            <rect x={x + 4} y="40" width="14" height="3" rx="1.5" fill="#8c93b6" />
            <text x={x + 4} y="55" fill="#e8ecf5" fontSize="9" fontWeight="700"
              fontFamily="'JetBrains Mono', monospace">
              {labels[i]}
            </text>
            <circle cx={x + 38} cy="44" r="2" fill={colors[i]} />
          </g>
        );
      })}
      <rect x="70" y="68" width="200" height="58" rx="4" fill="#131728" />
      <rect x="78" y="76" width="50" height="5" rx="2" fill="#e8ecf5" />
      <rect x="78" y="86" width="184" height="3" rx="1.5" fill="#181c30" />
      <rect x="78" y="86" width="120" height="3" rx="1.5" fill="#1678cd" />
      <rect x="78" y="96" width="184" height="3" rx="1.5" fill="#181c30" />
      <rect x="78" y="96" width="80" height="3" rx="1.5" fill="#1edd8a" />
      <rect x="78" y="106" width="184" height="3" rx="1.5" fill="#181c30" />
      <rect x="78" y="106" width="55" height="3" rx="1.5" fill="#f5a623" />
      <rect x="70" y="132" width="200" height="30" rx="4" fill="#131728" />
      <rect x="78" y="140" width="35" height="4" rx="2" fill="#e8ecf5" />
      <rect x="78" y="150" width="90" height="3" rx="1.5" fill="#181c30" />
      <rect x="78" y="150" width="55" height="3" rx="1.5" fill="#1678cd" />
    </svg>
  );
}

function DaylightPreviewSvg() {
  // Obli Daylight (Nordic Mist) : Snow Storm bg #e5e9f0, cards #eceff4, Polar Night text.
  return (
    <svg viewBox="0 0 280 170" xmlns="http://www.w3.org/2000/svg" className="w-full rounded-md">
      <rect width="280" height="170" fill="#e5e9f0" rx="6" />
      <rect x="0" y="0" width="60" height="170" fill="#eceff4" rx="6" />
      <rect x="60" y="0" width="1" height="170" fill="#d4dce7" />
      <rect x="10" y="12" width="16" height="16" rx="3" fill="#1678cd" />
      <rect x="31" y="15" width="22" height="5" rx="2" fill="#818da1" />
      {[40, 62, 84, 106].map((y, i) => (
        <g key={y}>
          <rect x="7" y={y} width="46" height="16" rx="3"
            fill={i === 0 ? 'rgba(22,120,205,0.10)' : 'transparent'} />
          <rect x="13" y={y + 4} width="8" height="8" rx="2"
            fill={i === 0 ? '#1678cd' : '#818da1'} />
          <rect x="25" y={y + 6} width={i === 0 ? 22 : 18} height="4" rx="2"
            fill={i === 0 ? '#2e3440' : '#4c566a'} />
        </g>
      ))}
      <rect x="61" y="0" width="219" height="28" fill="#eceff4" />
      <rect x="61" y="28" width="219" height="1" fill="#d4dce7" />
      <rect x="70" y="8" width="50" height="12" rx="3" fill="#d8dee9" />
      <rect x="230" y="9" width="44" height="10" rx="4" fill="#d8dee9" />
      {[0, 1, 2, 3].map((i) => {
        const colors = ['#10a360', '#1678cd', '#d97706', '#488fec'];
        const labels = [68, 4, 2, 8];
        const x = 70 + i * 52;
        return (
          <g key={i}>
            <rect x={x} y="36" width="44" height="24" rx="4" fill="#eceff4" />
            <rect x={x + 4} y="41" width="6" height="6" rx="3" fill={colors[i]} />
            <rect x={x + 12} y="41" width={labels[i]} height="4" rx="2" fill={colors[i]} opacity="0.7" />
            <rect x={x + 12} y="48" width="20" height="3" rx="2" fill="#818da1" />
          </g>
        );
      })}
      <rect x="70" y="68" width="200" height="58" rx="4" fill="#eceff4" />
      <rect x="78" y="76" width="50" height="5" rx="2" fill="#2e3440" />
      <rect x="78" y="86" width="184" height="3" rx="1.5" fill="#d8dee9" />
      <rect x="78" y="86" width="120" height="3" rx="1.5" fill="#1678cd" />
      <rect x="78" y="96" width="184" height="3" rx="1.5" fill="#d8dee9" />
      <rect x="78" y="96" width="80" height="3" rx="1.5" fill="#10a360" />
      <rect x="78" y="106" width="184" height="3" rx="1.5" fill="#d8dee9" />
      <rect x="78" y="106" width="55" height="3" rx="1.5" fill="#d97706" />
      <rect x="70" y="132" width="200" height="30" rx="4" fill="#eceff4" />
      <rect x="78" y="140" width="35" height="4" rx="2" fill="#2e3440" />
      <rect x="78" y="150" width="90" height="3" rx="1.5" fill="#d8dee9" />
      <rect x="78" y="150" width="55" height="3" rx="1.5" fill="#1678cd" />
    </svg>
  );
}

function DimPreviewSvg() {
  // Obli Dim : Nord "Polar Night" neutrals, dark companion of Obli Daylight (same
  // geometry, colours swapped). Chrome (topbar + sidebar) one step darker than the
  // page, no separators (depth via bg delta, like Operator). Accent = Oblihub brand
  // blue, identical to Operator: Dim changes neutrals only.
  const bg     = '#2e3440';   // page
  const chrome = '#282d37';   // topbar + sidebar
  const card   = '#3b4252';   // cards / surfaces
  const raised = '#434c5e';   // inputs / pill containers / tracks
  const text   = '#eceff4';
  const text2  = '#d8dee9';
  const muted  = '#a3abbc';
  const up     = '#6ccb8f';
  const warn   = '#ebcb8b';
  const accent  = '#1678cd';  // Operator --c-accent
  const accent2 = '#488fec';  // Operator --c-accent-hover
  return (
    <svg viewBox="0 0 280 170" xmlns="http://www.w3.org/2000/svg" className="w-full rounded-md">
      <rect width="280" height="170" fill={bg} rx="6" />
      <rect x="0" y="0" width="60" height="170" fill={chrome} rx="6" />
      <rect x="10" y="12" width="16" height="16" rx="3" fill={accent} />
      <rect x="31" y="15" width="22" height="5" rx="2" fill={muted} />
      {[40, 62, 84, 106].map((y, i) => (
        <g key={y}>
          <rect x="7" y={y} width="46" height="16" rx="3"
            fill={i === 0 ? 'rgba(22,120,205,0.18)' : 'transparent'} />
          <rect x="13" y={y + 4} width="8" height="8" rx="2"
            fill={i === 0 ? accent2 : muted} />
          <rect x="25" y={y + 6} width={i === 0 ? 22 : 18} height="4" rx="2"
            fill={i === 0 ? text : text2} />
        </g>
      ))}
      <rect x="61" y="0" width="219" height="28" fill={chrome} />
      <rect x="70" y="8" width="50" height="12" rx="3" fill={raised} />
      <rect x="230" y="9" width="44" height="10" rx="4" fill={raised} />
      {[0, 1, 2, 3].map((i) => {
        const colors = [up, accent, warn, accent2];
        const labels = [68, 4, 2, 8];
        const x = 70 + i * 52;
        return (
          <g key={i}>
            <rect x={x} y="36" width="44" height="24" rx="4" fill={card} />
            <rect x={x + 4} y="41" width="6" height="6" rx="3" fill={colors[i]} />
            <rect x={x + 12} y="41" width={labels[i]} height="4" rx="2" fill={colors[i]} opacity="0.7" />
            <rect x={x + 12} y="48" width="20" height="3" rx="2" fill={muted} />
          </g>
        );
      })}
      <rect x="70" y="68" width="200" height="58" rx="4" fill={card} />
      <rect x="78" y="76" width="50" height="5" rx="2" fill={text} />
      <rect x="78" y="86" width="184" height="3" rx="1.5" fill={raised} />
      <rect x="78" y="86" width="120" height="3" rx="1.5" fill={accent} />
      <rect x="78" y="96" width="184" height="3" rx="1.5" fill={raised} />
      <rect x="78" y="96" width="80" height="3" rx="1.5" fill={up} />
      <rect x="78" y="106" width="184" height="3" rx="1.5" fill={raised} />
      <rect x="78" y="106" width="55" height="3" rx="1.5" fill={warn} />
      <rect x="70" y="132" width="200" height="30" rx="4" fill={card} />
      <rect x="78" y="140" width="35" height="4" rx="2" fill={text} />
      <rect x="78" y="150" width="90" height="3" rx="1.5" fill={raised} />
      <rect x="78" y="150" width="55" height="3" rx="1.5" fill={accent} />
    </svg>
  );
}

function ModernPreviewSvg() {
  // Modern UI : fond très sombre, teinte bleue ultra-subtile (couleur app)
  return (
    <svg viewBox="0 0 280 170" xmlns="http://www.w3.org/2000/svg" className="w-full rounded-md">
      <rect width="280" height="170" fill="#0b0c12" rx="6" />
      <rect x="0" y="0" width="60" height="170" fill="#11131c" rx="6" />
      <rect x="60" y="0" width="1" height="170" fill="#30384e" />
      <rect x="10" y="12" width="16" height="16" rx="3" fill="#1678cd" opacity="0.95" />
      <rect x="31" y="15" width="22" height="5" rx="2" fill="#88899c" />
      {[40, 62, 84, 106].map((y, i) => (
        <g key={y}>
          <rect x="7" y={y} width="46" height="16" rx="3"
            fill={i === 0 ? '#23283f' : 'transparent'} />
          <rect x="13" y={y + 4} width="8" height="8" rx="2"
            fill={i === 0 ? '#1678cd' : '#6b7385'} />
          <rect x="25" y={y + 6} width={i === 0 ? 22 : 18} height="4" rx="2"
            fill={i === 0 ? '#e6ebf5' : '#88899c'} />
        </g>
      ))}
      <rect x="61" y="0" width="219" height="28" fill="#11131c" />
      <rect x="61" y="28" width="219" height="1" fill="#30384e" />
      <rect x="70" y="8" width="50" height="12" rx="3" fill="#0b0c12" />
      <rect x="230" y="9" width="44" height="10" rx="4" fill="#171a25" stroke="#30384e" strokeWidth="0.5" />
      {[0, 1, 2, 3].map((i) => {
        const colors = ['#2ea043', '#1678cd', '#d29922', '#488fec'];
        const labels = [68, 4, 2, 8];
        const x = 70 + i * 52;
        return (
          <g key={i}>
            <rect x={x} y="36" width="44" height="24" rx="4" fill="#11131c" stroke="#30384e" strokeWidth="0.5" />
            <rect x={x + 4} y="41" width="6" height="6" rx="3" fill={colors[i]} />
            <rect x={x + 12} y="41" width={labels[i]} height="4" rx="2" fill={colors[i]} opacity="0.7" />
            <rect x={x + 12} y="48" width="20" height="3" rx="2" fill="#6b7385" />
          </g>
        );
      })}
      {[0, 1, 2].map((i) => {
        const statusColors = ['#2ea043', '#f85149', '#2ea043'];
        const x = 70 + i * 69;
        return (
          <g key={i}>
            <rect x={x} y="68" width="62" height="50" rx="4" fill="#11131c" stroke="#30384e" strokeWidth="0.5" />
            <rect x={x} y="68" width="2.5" height="50" rx="2" fill={statusColors[i]} />
            <rect x={x + 7} y="76" width="6" height="6" rx="3" fill={statusColors[i]} />
            <rect x={x + 17} y="77" width={i === 1 ? 30 : 35} height="4" rx="2" fill="#e6ebf5" />
            <rect x={x + 17} y="84" width="25" height="3" rx="2" fill="#6b7385" />
            <rect x={x + 7} y="110" width="18" height="3" rx="2" fill="#88899c" />
            <rect x={x + 40} y="110" width="15" height="3" rx="2" fill={statusColors[i]} opacity="0.8" />
          </g>
        );
      })}
      <rect x="70" y="126" width="200" height="36" rx="4" fill="#11131c" stroke="#30384e" strokeWidth="0.5" />
      <rect x="78" y="132" width="5" height="5" rx="2.5" fill="#2ea043" />
      <rect x="87" y="133" width="35" height="4" rx="2" fill="#e6ebf5" />
      <rect x="78" y="143" width="90" height="3" rx="2" fill="#171a25" />
      <rect x="78" y="143" width="55" height="3" rx="2" fill="#1678cd" opacity="0.9" />
      <rect x="175" y="143" width="88" height="3" rx="2" fill="#171a25" />
      <rect x="175" y="143" width="40" height="3" rx="2" fill="#1678cd" opacity="0.9" />
    </svg>
  );
}

function NeonPreviewSvg() {
  // Neon UI : bleu électrique avec effets de glow
  return (
    <svg viewBox="0 0 280 170" xmlns="http://www.w3.org/2000/svg" className="w-full rounded-md">
      <defs>
        <filter id="oh-glow-blue" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="oh-glow-green" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="oh-glow-red" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <linearGradient id="oh-headerGlow" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="transparent" />
          <stop offset="30%" stopColor="rgba(72,143,236,0.15)" />
          <stop offset="50%" stopColor="rgba(72,143,236,0.8)" />
          <stop offset="70%" stopColor="rgba(72,143,236,0.15)" />
          <stop offset="100%" stopColor="transparent" />
        </linearGradient>
      </defs>
      <rect width="280" height="170" fill="#07080a" rx="6" />
      <rect x="0" y="0" width="60" height="170" fill="#0d0e11" rx="6" />
      <line x1="60" y1="0" x2="60" y2="170" stroke="#323339" strokeWidth="1" />
      <rect x="10" y="12" width="16" height="16" rx="3" fill="#488fec" opacity="0.95" filter="url(#oh-glow-blue)" />
      <rect x="31" y="15" width="22" height="5" rx="2" fill="#8a90b0" />
      {[40, 62, 84, 106].map((y, i) => (
        <g key={y}>
          {i === 0 && (
            <rect x="7" y={y} width="3" height="16" rx="1.5"
              fill="#488fec" filter="url(#oh-glow-blue)" />
          )}
          <rect x="10" y={y} width="43" height="16" rx="3"
            fill={i === 0 ? 'rgba(72,143,236,0.12)' : 'transparent'} />
          <rect x="13" y={y + 4} width="8" height="8" rx="2"
            fill={i === 0 ? '#488fec' : '#5b6080'}
            filter={i === 0 ? 'url(#oh-glow-blue)' : undefined} />
          <rect x="25" y={y + 6} width={i === 0 ? 22 : 18} height="4" rx="2"
            fill={i === 0 ? '#488fec' : '#5b6080'}
            filter={i === 0 ? 'url(#oh-glow-blue)' : undefined} />
        </g>
      ))}
      <rect x="61" y="0" width="219" height="28" fill="#0d0e11" />
      <line x1="61" y1="28" x2="280" y2="28" stroke="url(#oh-headerGlow)" strokeWidth="1" />
      <rect x="70" y="8" width="50" height="12" rx="3" fill="#07080a" />
      <rect x="230" y="9" width="44" height="10" rx="4" fill="#13141a" stroke="#323339" strokeWidth="0.5" />
      {[0, 1, 2, 3].map((i) => {
        const colors  = ['#00dc6e', '#ff3860', '#ffbe00', '#488fec'];
        const filters = ['url(#oh-glow-green)', 'url(#oh-glow-red)', undefined, 'url(#oh-glow-blue)'];
        const labels  = [68, 4, 2, 8];
        const x = 70 + i * 52;
        return (
          <g key={i}>
            <rect x={x} y="36" width="44" height="24" rx="4" fill="#0d0e11" stroke="#323339" strokeWidth="0.5" />
            <rect x={x + 4} y="41" width="6" height="6" rx="3" fill={colors[i]} filter={filters[i]} />
            <rect x={x + 12} y="41" width={labels[i]} height="4" rx="2" fill={colors[i]} opacity="0.75" />
            <rect x={x + 12} y="48" width="20" height="3" rx="2" fill="#5b6080" />
          </g>
        );
      })}
      {[0, 1, 2].map((i) => {
        const statusColors  = ['#00dc6e', '#ff3860', '#00dc6e'];
        const statusFilters = ['url(#oh-glow-green)', 'url(#oh-glow-red)', 'url(#oh-glow-green)'];
        const x = 70 + i * 69;
        return (
          <g key={i}>
            <rect x={x} y="68" width="62" height="50" rx="4" fill="#0d0e11" stroke="#323339" strokeWidth="0.5" />
            <rect x={x} y="68" width="2.5" height="50" rx="2" fill={statusColors[i]} filter={statusFilters[i]} />
            <rect x={x + 7} y="76" width="6" height="6" rx="3" fill={statusColors[i]} filter={statusFilters[i]} />
            <rect x={x + 17} y="77" width={i === 1 ? 30 : 35} height="4" rx="2" fill="#ebf0fa" />
            <rect x={x + 17} y="84" width="25" height="3" rx="2" fill="#5b6080" />
            <rect x={x + 7} y="110" width="18" height="3" rx="2" fill="#8a90b0" />
            <rect x={x + 40} y="110" width="15" height="3" rx="2" fill={statusColors[i]} opacity="0.8" />
          </g>
        );
      })}
      <rect x="70" y="126" width="200" height="36" rx="4" fill="#0d0e11" stroke="#323339" strokeWidth="0.5" />
      <rect x="78" y="132" width="5" height="5" rx="2.5" fill="#00dc6e" filter="url(#oh-glow-green)" />
      <rect x="87" y="133" width="35" height="4" rx="2" fill="#ebf0fa" />
      <rect x="78" y="143" width="90" height="3" rx="2" fill="#13141a" />
      <rect x="78" y="143" width="55" height="3" rx="2" fill="#488fec" opacity="0.95" filter="url(#oh-glow-blue)" />
      <rect x="175" y="143" width="88" height="3" rx="2" fill="#13141a" />
      <rect x="175" y="143" width="40" height="3" rx="2" fill="#488fec" opacity="0.9" filter="url(#oh-glow-blue)" />
    </svg>
  );
}

const THEMES: { id: AppTheme; label: string; Preview: () => JSX.Element }[] = [
  { id: 'obli-operator', label: 'Obli Operator', Preview: OperatorPreviewSvg },
  { id: 'obli-daylight', label: 'Obli Daylight', Preview: DaylightPreviewSvg },
  { id: 'obli-dim',      label: 'Obli Dim',      Preview: DimPreviewSvg },
  { id: 'modern',       label: 'Modern UI',     Preview: ModernPreviewSvg },
  { id: 'neon',          label: 'Neon UI',       Preview: NeonPreviewSvg },
];

export function ThemePicker({ value, onChange }: ThemePickerProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {THEMES.map(({ id, label, Preview }) => {
        const selected = value === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={cn(
              'group relative rounded-xl border-2 p-2 text-left transition-all',
              selected
                ? 'border-primary shadow-[0_0_0_1px_rgb(var(--c-primary)/0.3)]'
                : 'border-border hover:border-primary/40 hover:bg-bg-hover',
            )}
          >
            <div className={cn(
              'overflow-hidden rounded-lg ring-0 transition-all',
              selected ? 'ring-2 ring-primary/30' : 'group-hover:ring-1 group-hover:ring-primary/20',
            )}>
              <Preview />
            </div>
            <div className="mt-2.5 flex items-center justify-between px-1 pb-0.5">
              <span className={cn(
                'text-sm font-semibold',
                selected ? 'text-primary' : 'text-text-secondary',
              )}>
                {label}
              </span>
              {selected && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary">
                  <Check size={11} className="text-bg-primary" strokeWidth={3} />
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
