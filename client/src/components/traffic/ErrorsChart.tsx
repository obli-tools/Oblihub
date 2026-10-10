import { LineChart } from '../LineChart';
import type { TrafficPoint } from '@/api/traffic.api';

/**
 * Dedicated "Errors over time" chart. On healthy services 5xx is 0.01% of traffic and completely
 * invisible on the shared y-axis of Requests-over-time — a dedicated chart is the only way error
 * spikes are legible during the actual incident. Rendered only when the range shows non-zero
 * errors (caller decides via the `hasErrors` prop).
 */
export function ErrorsChart({ points }: { points: TrafficPoint[] }) {
  const labels = points.map(p => new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  return (
    <LineChart labels={labels} yLabel="errors / bucket" height={180}
      series={[
        { name: '4xx', color: '#f59e0b', values: points.map(p => p.status4xx) },
        { name: '5xx', color: '#ef4444', values: points.map(p => p.status5xx) },
      ]}
    />
  );
}
