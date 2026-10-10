import { useEffect, useState } from 'react';

export interface HostGpuStat {
  index: string;
  name: string;
  utilPercent: number | null;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryPercent: number | null;
  powerDrawWatts: number | null;
  powerLimitWatts: number | null;
  temperatureCelsius: number | null;
  fanSpeedPercent: number | null;
}

export interface HostStats {
  cpu: {
    percent: number | null;
    cores: number;
    model: string | null;
    temperatureCelsius: number | null;
  };
  ram: { used: number; total: number; percent: number | null };
  disk: { used: number; total: number; percent: number | null; path: string };
  gpus: HostGpuStat[];
  loadAvg: [number, number, number];
  measuredAt: string;
  /** The engine behind Oblihub's own socket. These numbers always describe that host (the hub),
   *  never a remote engine; absent from servers that predate multi-engine resources. */
  localEngine?: { id: number; name: string } | null;
}

/**
 * Poll `/api/system/host-stats` every N seconds. Shared across every component that consumes
 * it (there's only one, the header indicator, but keeping the pattern for future dashboards).
 * Failures are swallowed silently — the indicator just shows dashes and moves on.
 */
export function useHostStats(intervalMs = 5000): HostStats | null {
  const [stats, setStats] = useState<HostStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () => {
      fetch('/api/system/host-stats', { credentials: 'include' })
        .then(r => r.json())
        .then((d: { success: boolean; data?: HostStats }) => {
          if (!cancelled && d.success && d.data) setStats(d.data);
        })
        .catch(() => { /* soft failure */ });
    };
    fetchOnce();
    const id = setInterval(fetchOnce, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs]);

  return stats;
}
