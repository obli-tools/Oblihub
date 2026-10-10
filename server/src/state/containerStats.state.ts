/**
 * containerStats.state — latest resource sample per (engine, container), in memory.
 *
 * The dashboard used to scan the last 5 minutes of `container_stats` every 5 s for every viewer just
 * to read one value per container. StatsWorker now publishes each engine's latest samples here after
 * every pass (the table keeps the history for charts). Keyed by engine because a 12-char docker id is
 * only unique per daemon.
 *
 * Single-process only, like criticalActivity.state: Oblihub is a self-hosted singleton.
 */

export interface LatestContainerStat {
  engineId: number;
  dockerId: string;
  name: string;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  at: number;
}

interface EngineStats {
  at: number;
  byDockerId: Map<string, LatestContainerStat>;
}

const byEngine = new Map<number, EngineStats>();

/**
 * Replaces the engine's whole map in one assignment, so a reader never sees half of one pass mixed
 * with the previous one, and containers that stopped since the last pass disappear.
 */
export function setEngineStats(engineId: number, rows: LatestContainerStat[]): void {
  const byDockerId = new Map<string, LatestContainerStat>();
  let at = 0;
  for (const row of rows) {
    byDockerId.set(row.dockerId, row);
    if (row.at > at) at = row.at;
  }
  byEngine.set(engineId, { at: at || Date.now(), byDockerId });
}

export function getLatestStat(engineId: number, dockerId: string): LatestContainerStat | null {
  return byEngine.get(engineId)?.byDockerId.get(dockerId) ?? null;
}

export function getLatestForEngine(engineId: number): LatestContainerStat[] {
  const entry = byEngine.get(engineId);
  return entry ? Array.from(entry.byDockerId.values()) : [];
}

/** When the engine's samples were last published, or null when there are none. */
export function getEngineStatsAt(engineId: number): number | null {
  return byEngine.get(engineId)?.at ?? null;
}

export function clearEngine(engineId: number): void {
  byEngine.delete(engineId);
}
