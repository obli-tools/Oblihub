import { useMemo, useState } from 'react';
import { formatShortNumber } from './LineChart';

/**
 * Minimalist world map with country hotspots. Pure SVG, no external deps.
 *
 * The continent outlines are drawn as very-simplified polygons — enough to give a "world map"
 * visual anchor without shipping ~200KB of country geometry. Each data point (a `Country` row
 * with lat/lon + reqCount) is projected via an equirectangular projection and rendered as a
 * radial hotspot: radius scales with log(reqCount) so a country with 10× more traffic doesn't
 * become a giant blob crowding the others out.
 *
 * Interactive: hover a hotspot to see country name + count in the tooltip layer above.
 */

export interface Country {
  code: string;
  name: string;
  reqCount: number;
  lat: number;
  lon: number;
}

// Very simplified continent outlines — 6-30 points per continent, meant as a stylized backdrop.
// Coordinates are [lon, lat] pairs; projected below via equirectangular. Not geographically
// precise — the goal is visual anchoring for the dots, not cartography.
const CONTINENTS: [number, number][][] = [
  // North America
  [
    [-168, 66], [-140, 71], [-95, 82], [-63, 82], [-52, 60], [-80, 25],
    [-100, 15], [-118, 24], [-125, 40], [-140, 60],
  ],
  // Central America
  [
    [-98, 18], [-77, 8], [-83, 7], [-92, 15],
  ],
  // South America
  [
    [-80, 12], [-70, 12], [-50, 5], [-35, -6], [-40, -22], [-55, -35],
    [-70, -55], [-72, -50], [-72, -20], [-80, -5],
  ],
  // Europe
  [
    [-10, 36], [-10, 60], [5, 71], [30, 71], [40, 65], [45, 55], [40, 45],
    [30, 40], [20, 40], [10, 45],
  ],
  // Africa
  [
    [-17, 15], [-17, 30], [10, 36], [30, 32], [35, 32], [43, 12], [51, 12],
    [40, -5], [40, -25], [25, -35], [15, -35], [10, -5],
  ],
  // Asia
  [
    [30, 40], [40, 42], [50, 45], [60, 55], [80, 70], [100, 75], [140, 75],
    [170, 68], [180, 65], [155, 45], [140, 30], [125, 22], [110, 20], [100, 12],
    [95, 20], [80, 8], [75, 8], [70, 25], [55, 25], [45, 30], [40, 35],
  ],
  // South Asia peninsula (India)
  [
    [70, 25], [90, 22], [88, 10], [77, 8], [70, 15],
  ],
  // Australia
  [
    [113, -22], [130, -12], [145, -12], [153, -25], [148, -38], [130, -35],
    [115, -35],
  ],
  // Antarctica
  [
    [-180, -75], [180, -75], [180, -85], [-180, -85],
  ],
];

const VIEW_W = 1000;
const VIEW_H = 500;

// Equirectangular projection: linear map from lon/lat to x/y. Simple, fast, gives the classic
// "world map" look. Not equal-area but perfectly fine for a hotspot overlay.
function project(lon: number, lat: number): [number, number] {
  const x = ((lon + 180) / 360) * VIEW_W;
  const y = ((90 - lat) / 180) * VIEW_H;
  return [x, y];
}

function polygonPath(points: [number, number][]): string {
  if (points.length === 0) return '';
  const projected = points.map(([lon, lat]) => project(lon, lat));
  return `M${projected.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')} Z`;
}

export function WorldMap({ countries, height = 380 }: { countries: Country[]; height?: number }) {
  const [hover, setHover] = useState<Country | null>(null);

  // Radius scaling — log so a huge-traffic country doesn't drown everyone else. Clamped to
  // sane bounds regardless of the input range.
  const dots = useMemo(() => {
    if (countries.length === 0) return [];
    const maxReq = Math.max(...countries.map(c => c.reqCount));
    return countries.map(c => {
      const [x, y] = project(c.lon, c.lat);
      // log-scaled 0..1 then mapped to radius range
      const norm = maxReq > 1 ? Math.log(c.reqCount + 1) / Math.log(maxReq + 1) : 1;
      const r = 4 + norm * 22;
      return { ...c, x, y, r, norm };
    });
  }, [countries]);

  return (
    <div className="relative rounded-lg border border-border bg-bg-tertiary/40 overflow-hidden" style={{ height }}>
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="w-full h-full">
        {/* Ocean gradient background */}
        <defs>
          <radialGradient id="ocean" cx="50%" cy="50%" r="70%">
            <stop offset="0%"   stopColor="#0f1620" />
            <stop offset="100%" stopColor="#080b10" />
          </radialGradient>
          <radialGradient id="hotspot" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#4a9eff" stopOpacity="0.9" />
            <stop offset="60%"  stopColor="#4a9eff" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#4a9eff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect x={0} y={0} width={VIEW_W} height={VIEW_H} fill="url(#ocean)" />

        {/* Subtle latitude/longitude grid — every 30 degrees, low-opacity dashed lines */}
        {[-60, -30, 0, 30, 60].map(lat => {
          const [, y] = project(0, lat);
          return <line key={`lat${lat}`} x1={0} x2={VIEW_W} y1={y} y2={y} stroke="#1a2130" strokeDasharray="2 6" strokeWidth={0.5} />;
        })}
        {[-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150].map(lon => {
          const [x] = project(lon, 0);
          return <line key={`lon${lon}`} x1={x} x2={x} y1={0} y2={VIEW_H} stroke="#1a2130" strokeDasharray="2 6" strokeWidth={0.5} />;
        })}

        {/* Continent outlines — stylized, not geographically precise. Dashed edge + tinted fill. */}
        {CONTINENTS.map((poly, i) => (
          <path
            key={i}
            d={polygonPath(poly)}
            fill="#1e293b"
            fillOpacity={0.8}
            stroke="#334155"
            strokeWidth={0.8}
          />
        ))}

        {/* Hotspot halos — larger, softer glow layer for visual pop */}
        {dots.map(d => (
          <circle key={`halo-${d.code}`} cx={d.x} cy={d.y} r={d.r * 2} fill="url(#hotspot)" pointerEvents="none" />
        ))}

        {/* Hotspot cores — solid dots that carry the hover interaction */}
        {dots.map(d => (
          <g key={`dot-${d.code}`} className="cursor-pointer" onMouseEnter={() => setHover(d)} onMouseLeave={() => setHover(null)}>
            <circle cx={d.x} cy={d.y} r={d.r} fill="#4a9eff" fillOpacity={0.9} stroke="#0d1117" strokeWidth={1} />
            <circle cx={d.x} cy={d.y} r={d.r * 0.4} fill="#e0efff" fillOpacity={0.95} />
          </g>
        ))}

        {/* Hover tooltip — floats near the pointed dot */}
        {hover && (
          <g pointerEvents="none">
            <rect
              x={Math.min(project(hover.lon, hover.lat)[0] + 12, VIEW_W - 180)}
              y={Math.max(project(hover.lon, hover.lat)[1] - 30, 4)}
              width={170}
              height={40}
              rx={6}
              fill="#0d1117"
              stroke="#334155"
              strokeWidth={0.8}
            />
            <text
              x={Math.min(project(hover.lon, hover.lat)[0] + 20, VIEW_W - 172)}
              y={Math.max(project(hover.lon, hover.lat)[1] - 12, 22)}
              fontSize={14}
              fill="#e0efff"
              fontFamily="ui-sans-serif, system-ui"
              fontWeight={500}
            >
              {countryFlag(hover.code)}  {hover.name}
            </text>
            <text
              x={Math.min(project(hover.lon, hover.lat)[0] + 20, VIEW_W - 172)}
              y={Math.max(project(hover.lon, hover.lat)[1] + 4, 38)}
              fontSize={11}
              fill="#8b95a5"
              fontFamily="ui-monospace, monospace"
            >
              {formatShortNumber(hover.reqCount)} requests
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return '🏳️';
  const A = 0x1F1E6;
  return String.fromCodePoint(A + (code.charCodeAt(0) - 65), A + (code.charCodeAt(1) - 65));
}
