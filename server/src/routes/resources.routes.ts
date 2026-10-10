import { Router, type Request } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { filterStacksByTeam } from '../middleware/permissions';
import { stackService } from '../services/stack.service';
import { engineService } from '../services/engine.service';
import { engineFactsService } from '../services/engineFacts.service';
import { engineHostService } from '../services/engineHost.service';
import { snapshotActivity } from '../state/criticalActivity.state';
import { getLatestStat } from '../state/containerStats.state';
import { getYieldedStackIds } from '../workers/PriorityWatchdogWorker';
import { logger } from '../utils/logger';
import type {
  DashStackState, EngineHostSnapshot, ResourceLimits, ResourcesDashboard, ResourcesDashboardLegacyHost, ResourcesDashStack, Stack,
  StackPriority,
} from '@oblihub/shared';

const router = Router();
router.use(requireAuth);

// Same default as the watchdog when an Opportunistic stack has no idle timeout.
const DEFAULT_YIELD_IDLE_S = 30;
// "Busy right now" window of a Critical stack nothing yields to.
const DEFAULT_BUSY_WINDOW_MS = 60_000;

function sessionOf(req: Request): { userId: number | null; role: string } {
  const s = req.session as { userId?: number; role?: string };
  return { userId: s.userId ?? null, role: s.role || 'user' };
}

function parseEngineId(raw: unknown): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, 'Invalid engine id');
  return id;
}

/** Body `{ watts: number | null }`; null resets to the default limit. Numeric strings are accepted as
 *  the legacy route did. A missing `watts` is refused rather than read as a reset. */
function parseWatts(body: unknown): number | null {
  if (!body || typeof body !== 'object' || !('watts' in body)) {
    throw new AppError(400, 'watts is required (a positive number, or null to reset to the default)');
  }
  const raw = (body as { watts: unknown }).watts;
  if (raw === null) return null;
  const watts = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(watts) || watts <= 0) {
    throw new AppError(400, 'watts must be a positive number, or null to reset to the default');
  }
  return watts;
}

/**
 * Pre-multi-engine `host` card of the dashboard (ResourcesDashboardLegacyHost), kept for the rollout
 * only. A tab still running the previous bundle keeps polling every 5 s across a server update (or a
 * self-update that recreates only the server container) and reads these fields without a guard; one
 * missing field would blank its whole page.
 *
 * Built from the local engine's snapshot because the old page only knew that host, and the legacy
 * power-limit route it calls targets that engine too. The snapshot is the one this viewer may see
 * (visibility + redaction already applied); when it is not visible, unknown values are 0 / [] rather
 * than null so the old page still renders.
 */
function legacyHost(snapshot: EngineHostSnapshot | null): ResourcesDashboardLegacyHost {
  const ramBytes = snapshot?.facts.ramBytes ?? 0;
  const gpus = snapshot?.gpu.gpus ?? [];
  const currentPowerLimits: Record<string, number> = {};
  for (const g of gpus) currentPowerLimits[g.index] = g.powerLimitCurrentWatts;
  return {
    cpuCount: snapshot?.facts.cpuCount ?? 0,
    ramBytes,
    ramGb: Math.round(ramBytes / 2 ** 30),
    gpus,
    gpuLive: snapshot?.gpu.live ?? [],
    currentPowerLimits,
    // The old route sent the hub process's own values here; they describe no remote host.
    platform: process.platform,
    arch: process.arch,
    cpuModel: snapshot?.live.cpuModel ?? null,
    cpuTemperatureCelsius: snapshot?.live.cpuTemperatureCelsius ?? null,
  };
}

/**
 * GET /api/resources/dashboard — one aggregate call for the live dashboard.
 *
 * Every stack is measured against its OWN engine: conso is divided by that engine's NCPU / MemTotal
 * (engine facts cache or its host snapshot), never by the hub's. Orphaned stacks (engine deleted)
 * keep engineId null and have no share of any engine (conso.*ShareOfEngine null) — they are never
 * mapped to the local engine. Nothing here waits on a remote daemon: facts are read from the
 * cache and each host snapshot is bounded to ~2 s.
 */
router.get('/dashboard', async (req, res, next) => {
  try {
    const { userId, role } = sessionOf(req);
    const isAdmin = role === 'admin';
    const [allStacks, allEngines] = await Promise.all([stackService.getAll(), engineService.getSummaries()]);
    const stacks = await filterStacksByTeam(userId as number, role, allStacks) as Stack[];

    const visibleEngineIds = new Set<number>();
    for (const s of stacks) if (s.engineId != null) visibleEngineIds.add(s.engineId);
    // Admins see every enabled engine (even an empty one); anyone else only the engines hosting a
    // stack they can see. A disabled engine is listed only when it hosts a visible stack ("(disabled)"
    // badge in All, no tab, no host card).
    const engines = allEngines.filter((e) => (isAdmin ? e.enabled || visibleEngineIds.has(e.id) : visibleEngineIds.has(e.id)));

    engineHostService.ensureStarted();
    // Non-admins get the redacted error/agent/GPU texts (host paths, SSH errors) and no facts hostname /
    // engine-wide container counts; capacityOf only reads host.facts.cpuCount / ramBytes, which the redaction keeps.
    const hosts = (await engineHostService.getSnapshots(engines.filter((e) => e.enabled).map((e) => e.id)))
      .map((h) => engineHostService.forViewer(h, isAdmin));

    const summaryById = new Map(allEngines.map((e) => [e.id, e]));
    const hostById = new Map<number, EngineHostSnapshot>(hosts.map((h) => [h.engine.id, h]));
    const capacityByEngine = new Map<number, { cpuCount: number | null; memTotal: number | null }>();
    const capacityOf = (engineId: number) => {
      let cap = capacityByEngine.get(engineId);
      if (!cap) {
        // Disabled engines have no host card and no fresh samples; peeking them would only start a
        // docker info that is bound to fail.
        const enabled = summaryById.get(engineId)?.enabled === true;
        const facts = enabled ? engineFactsService.peek(engineId) : null;
        const host = hostById.get(engineId) ?? null;
        cap = {
          cpuCount: facts?.cpuCount ?? host?.facts.cpuCount ?? null,
          memTotal: facts?.memTotalBytes ?? host?.facts.ramBytes ?? null,
        };
        capacityByEngine.set(engineId, cap);
      }
      return cap;
    };

    // Busy window per Critical stack: the longest idle timeout of the Opportunistic stacks yielding
    // to it (that is how long the watchdog keeps them yielded). All stacks, not only visible ones:
    // the answer is a boolean and must match what the watchdog does.
    const busyWindowMs = new Map<number, number>();
    for (const s of allStacks) {
      const l = s.resourceLimits;
      if (!l || l.priority !== 'opportunistic' || s.engineId == null || !l.yieldsToStackIds?.length) continue;
      const windowMs = (l.yieldIdleTimeoutSeconds != null && l.yieldIdleTimeoutSeconds > 0 ? l.yieldIdleTimeoutSeconds : DEFAULT_YIELD_IDLE_S) * 1000;
      for (const raw of l.yieldsToStackIds) {
        const target = Number(raw);
        busyWindowMs.set(target, Math.max(busyWindowMs.get(target) ?? 0, windowMs));
      }
    }

    const activity = snapshotActivity();
    const yieldedIds = getYieldedStackIds();
    const now = Date.now();

    const dashStacks: ResourcesDashStack[] = stacks.map((s) => {
      const limits: ResourceLimits | null = s.resourceLimits;
      const priority: StackPriority = limits?.priority ?? 'normal';
      const engineId = s.engineId;

      let cpuSum = 0;
      let ramSum = 0;
      let newestAt: number | null = null;
      let running = 0;
      let anyRunning = false;
      let anyStopped = false;
      for (const c of s.containers) {
        // Samples are keyed per engine (a 12-char docker id is only unique per daemon); an orphaned
        // container has no engine to read them from.
        const stat = engineId != null && c.engineId === engineId ? getLatestStat(engineId, c.dockerId) : null;
        if (stat) {
          cpuSum += Number(stat.cpuPercent) || 0;
          ramSum += Number(stat.memoryUsage) || 0;
          if (newestAt == null || stat.at > newestAt) newestAt = stat.at;
        }
        // status 'stopped' is stopped; every other status is running-ish.
        if (c.status === 'stopped') anyStopped = true;
        else { anyRunning = true; running++; }
      }

      const cap = engineId != null ? capacityOf(engineId) : null;
      // docker stats reports "% of one core" per container: divided by the engine's cores it becomes
      // a share of that whole host, so the bar caps at 100. null = that engine's capacity is unknown
      // (orphan, disabled engine, remote engine not reached yet): never measured against the hub.
      const cpuShare = cap?.cpuCount ? Math.min(100, cpuSum / cap.cpuCount) : null;
      const ramShare = cap?.memTotal ? Math.min(100, (ramSum / cap.memTotal) * 100) : null;

      const cpuCapPercent = limits?.cpuPercent ?? null;
      const ramCapPercent = limits?.ramPercent ?? null;
      // Stay null when the share is unknown: the previous bundle already guards these with != null.
      const cpuPercentOfCap = cpuShare != null && cpuCapPercent != null && cpuCapPercent > 0
        ? Math.min(100, (cpuShare / cpuCapPercent) * 100)
        : null;
      const ramPercentOfCap = ramShare != null && ramCapPercent != null && ramCapPercent > 0
        ? Math.min(100, (ramShare / ramCapPercent) * 100)
        : null;

      let state: DashStackState;
      if (yieldedIds.has(s.id)) state = 'paused-by-watchdog';
      // A stack kept for its limits while it has no container is not running.
      else if (s.containers.length === 0) state = 'stopped';
      else if (!anyRunning && anyStopped) state = 'stopped';
      else if (anyRunning && anyStopped) state = 'mixed';
      else state = 'running';

      const busyAt = activity[s.id];
      const isBusyNow = priority === 'critical'
        ? typeof busyAt === 'number' && (now - busyAt) < (busyWindowMs.get(s.id) ?? DEFAULT_BUSY_WINDOW_MS)
        : null;

      return {
        id: s.id,
        name: s.name,
        composeProject: s.composeProject,
        engineId,
        engineName: engineId != null ? summaryById.get(engineId)?.name ?? null : null,
        priority,
        state,
        containerCount: s.containers.length,
        runningContainerCount: running,
        cpuCapPercent,
        ramCapPercent,
        cpuShares: limits?.cpuShares ?? null,
        visibleGpuIds: limits?.visibleGpuIds ?? null,
        yieldSignalSource: limits?.yieldSignalSource ?? null,
        yieldsToStackIds: limits?.yieldsToStackIds ?? null,
        yieldIdleTimeoutSeconds: limits?.yieldIdleTimeoutSeconds ?? null,
        yieldMode: limits?.yieldMode ?? null,
        isBusyNow,
        conso: {
          // New clients read these; null = engine capacity unknown, shown as "unknown".
          cpuShareOfEngine: cpuShare,
          ramShareOfEngine: ramShare,
          // Deprecated, kept numeric for the rollout. The previous bundle calls toFixed on them without
          // a guard (and has no error boundary), so one null blanks its whole page; it survives a
          // server-only self-update because the client container keeps serving it. The previous server
          // already listed orphan, disabled-engine and remote-engine stacks and always sent a number
          // here (divided by the hub's own cores/RAM, 0 as fallback), so 0 when unknown matches both it
          // and legacyHost().
          cpuPercentOfHost: cpuShare ?? 0,
          cpuPercentOfCap,
          ramBytes: ramSum,
          ramPercentOfHost: ramShare ?? 0,
          ramPercentOfCap,
          sampledAt: newestAt != null ? new Date(newestAt).toISOString() : null,
        },
      };
    });

    // Only the stacks this viewer can see: a busy timestamp tells when another team's service is in
    // use. isBusyNow above reads the full map, which is fine (it is only sent for visible stacks).
    const visibleActivity: Record<number, number> = {};
    for (const s of stacks) if (typeof activity[s.id] === 'number') visibleActivity[s.id] = activity[s.id];

    // A failed lookup must not fail the dashboard for a compatibility field.
    const localEngineId = await engineFactsService.resolveLocalEngineId().catch(() => null);
    const data: ResourcesDashboard = {
      engines,
      hosts,
      stacks: dashStacks,
      activity: visibleActivity,
      generatedAt: new Date().toISOString(),
      host: legacyHost(localEngineId != null ? hostById.get(localEngineId) ?? null : null),
    };
    res.json({ success: true, data });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'dashboard aggregation failed');
    next(err);
  }
});

/**
 * PUT /api/resources/engines/:engineId/gpus/:gpu/power-limit — body { watts: number | null }.
 *
 * Host-wide GPU power limit of one engine's GPU (`:gpu` = index or uuid). Not tied to any stack:
 * `nvidia-smi -pl` affects every container using that GPU, which is why it lives on the dashboard
 * and is admin-only. Stored and re-applied after host reboots; null resets to the default and
 * forgets the stored value. AppErrors (400/404/409/502) carry the host command to run by hand.
 */
router.put('/engines/:engineId/gpus/:gpu/power-limit', requireRole('admin'), async (req, res, next) => {
  try {
    const engineId = parseEngineId(req.params.engineId);
    const watts = parseWatts(req.body);
    const data = await engineHostService.setPowerLimit(engineId, String(req.params.gpu ?? ''), watts, sessionOf(req).userId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

/**
 * PUT /api/resources/gpus/:index/power-limit — legacy alias targeting the local engine.
 *
 * Security fix: this route used to be callable by ANY authenticated user although it changes a
 * host-wide setting that affects every stack on that GPU. It is admin-only now, like the new route.
 */
router.put('/gpus/:index/power-limit', requireRole('admin'), async (req, res, next) => {
  try {
    const watts = parseWatts(req.body);
    const engineId = await engineFactsService.resolveLocalEngineId();
    if (engineId == null) throw new AppError(404, 'No local engine');
    const data = await engineHostService.setPowerLimit(engineId, String(req.params.index ?? ''), watts, sessionOf(req).userId);
    // `watts` keeps the previous response field for clients built before the per-engine route.
    res.json({ success: true, data: { ...data, watts: data.appliedWatts ?? data.requestedWatts } });
  } catch (err) { next(err); }
});

/** POST /api/resources/engines/:engineId/agent/retry — reconcile that engine's host agent now, dropping every backoff. */
router.post('/engines/:engineId/agent/retry', requireRole('admin'), async (req, res, next) => {
  try {
    const engineId = parseEngineId(req.params.engineId);
    const engine = await engineService.getById(engineId);
    if (!engine) throw new AppError(404, 'Engine not found');
    const data = await engineHostService.retryAgent(engineId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

export default router;
