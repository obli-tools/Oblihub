/**
 * criticalActivity.state — in-memory map of Critical-stack "busy" timestamps.
 *
 * Written from three input sources (any of them counts as activity):
 *   1. Nginx traffic tailer (PriorityWatchdogWorker) — resolves proxy_host_id → stack_id,
 *      stamps activity when a hit lands on a Critical stack.
 *   2. GPU utilisation poller (GpuUtilPoller) — polls `nvidia-smi` every 2s and stamps activity
 *      when any GPU the Critical stack is visible on exceeds a utilisation threshold.
 *   3. Webhook (POST /api/stacks/:id/notify-busy) — Critical apps that can't be inferred from
 *      nginx or GPU (e.g. background LLM inference bursts) explicitly stamp themselves busy.
 *
 * Read by PriorityWatchdogWorker's evaluator: for every Opportunistic stack, if any of its
 * `yieldsToStackIds` has a busy timestamp within the idle window → yield it. Otherwise resume.
 *
 * Single-process only — a horizontally-scaled server would need this in Redis, but Oblihub is a
 * self-hosted singleton so in-memory is fine.
 */

const busyAt = new Map<number, number>(); // criticalStackId → epoch ms of last activity

export function markCriticalBusy(stackId: number, at: number = Date.now()): void {
  const prev = busyAt.get(stackId);
  if (prev == null || at > prev) busyAt.set(stackId, at);
}

export function clearCriticalBusy(stackId: number): void {
  busyAt.delete(stackId);
}

export function getBusyAt(stackId: number): number | null {
  return busyAt.get(stackId) ?? null;
}

/** Latest activity across a set of stack IDs — used by the watchdog to score Opportunistic yields. */
export function getLatestBusyAtAcross(stackIds: Iterable<number>): number | null {
  let latest: number | null = null;
  for (const id of stackIds) {
    const t = busyAt.get(id);
    if (t != null && (latest == null || t > latest)) latest = t;
  }
  return latest;
}

/** Snapshot for the dashboard / GET /activity endpoint. */
export function snapshotActivity(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [k, v] of busyAt) out[k] = v;
  return out;
}

/** Test-only clear — not exported through the barrel. */
export function __resetForTests(): void {
  busyAt.clear();
}
