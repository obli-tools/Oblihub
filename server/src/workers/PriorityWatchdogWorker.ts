import * as fs from 'fs';
import * as path from 'path';
import type { Server as SocketIOServer } from 'socket.io';
import type { ResourceLimits, YieldMode } from '@oblihub/shared';
import { config } from '../config';
import { db } from '../db';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/withTimeout';
import { stackService } from '../services/stack.service';
import { appConfigService } from '../services/appConfig.service';
import { composeRunner } from '../services/composeRunner.service';
import { engineFactsService } from '../services/engineFacts.service';
import { selfProjectService } from '../services/selfProject.service';
import {
  stackPower,
  yieldJournal,
  mergeJournalEntries,
  powerKeyOf,
  type PowerContainer,
  type StackRef,
  type YieldJournalEntry,
  type YieldJournalRow,
} from '../services/stackPower.service';
import { stackEvents } from '../state/stackEvents';
import { markCriticalBusy, getLatestBusyAtAcross } from '../state/criticalActivity.state';

// Rebound-through-object so tests can swap these without touching the ESM binding table.
const powerOps = {
  planYield: stackPower.planYield,
  executeYield: stackPower.executeYield,
  resumeEntries: stackPower.resumeEntries,
  legacyResumeAll: stackPower.legacyResumeAll,
};

/**
 * PriorityWatchdogWorker — makes Opportunistic stacks yield to Critical ones.
 *
 * Signal sources: every source stamps `lastCriticalActivityAt` of a Critical stack in
 * criticalActivity.state — this worker's nginx traffic tail (below), GpuUtilPoller (gpu-util) and
 * the busy webhook (`POST /api/stacks/:id/notify-busy`).
 *   1. Tail `<stacksDir>/_proxy/oblihub_traffic.log` (same file TrafficLogWorker aggregates).
 *   2. For each new hit, resolve `proxy_host_id → stack_id` via a 30s-refreshed cache.
 *   3. If that stack is in the `yieldsToStackIds` of any Opportunistic stack, stamp it busy.
 *   4. Every EVAL_INTERVAL_MS the evaluator scans Opportunistic stacks:
 *        - Activity within `yieldIdleTimeoutSeconds` AND not yielded → pause (or stop).
 *        - No activity for > `yieldIdleTimeoutSeconds` AND yielded → resume.
 *
 * Debounce: many hits in one burst only mutate a single timestamp; the evaluator's 5s cadence
 * (plus the idle-timeout window itself) is what prevents flap.
 *
 * Yield / resume: dockerode pause/unpause/stop/start of the stack's EXISTING containers on the
 * stack's own engine (stackPower.service) — never compose, never a container creation. Excluded
 * containers, Oblihub's plumbing and Oblihub itself are never touched; orphaned stacks (engine
 * deleted) are skipped. What was acted on is journalled in `priority_yields`: the intent row is
 * written BEFORE acting and trimmed to what actually acted afterwards, so a resume restores exactly
 * those containers — and only those — even after a crash.
 *
 * Enforcement: every REFRESH_INTERVAL_MS a stack that is still inside its activity window gets its
 * journalled services yielded again, so a container restarted meanwhile (update recreate, manual
 * start) does not keep running next to a busy Critical stack.
 *
 * Cold start: the first boot of this version resumes every Opportunistic stack once through
 * dockerode (the old version's shutdown resume may never have completed); a stack whose engine was
 * disabled or unreachable then is retried alone at later boots, for up to 7 days. Every boot then resumes the
 * journalled rows. Timers start only after that, so a traffic burst cannot race it.
 *
 * Shutdown: `stopPriorityWatchdogWorker()` resumes every journal row and resolves; index.ts bounds
 * the wait. Whatever is not resumed stays journalled for the next cold start.
 */

const LOG_PATH = path.join(config.stacksDir, '_proxy', 'oblihub_traffic.log');
const POLL_INTERVAL_MS = 1_000;
const EVAL_INTERVAL_MS = 5_000;
const REFRESH_INTERVAL_MS = 30_000;
const FAILURE_BACKOFF_MS = 60_000;
const WARN_INTERVAL_MS = 60_000;
const COLD_START_TIMEOUT_MS = 60_000;
const JOURNAL_MARKER_KEY = 'priority_watchdog_journal_v1';
// JSON { since, stackIds }: the stacks the one-time upgrade resume has not reached yet.
const LEGACY_PENDING_KEY = 'priority_watchdog_legacy_pending';
// Past this, a blind resume would start containers the operator stopped since the upgrade.
const LEGACY_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface WatchdogState {
  stackId: number;
  composeProject: string | null;
  engineId: number | null;
  yieldsToStackIds: Set<number>;
  yieldIdleTimeoutMs: number;
  yieldMode: YieldMode;
  isYielded: boolean;                    // true = we've paused/stopped this stack
  /** Neither direction is retried before this epoch ms (a failed yield or resume backs off). */
  failedUntil: number;
  /** Last warning logged for this stack: failures repeat every evaluation, the log once a minute. */
  lastWarnAt: number;
  /**
   * Power keys of services a pause-mode yield skipped as 'restarting' (crash-looping: nothing to
   * freeze during the restart back-off). They are not journalled, and enforceYields only re-yields
   * journalled services, so they would run for the whole busy window once they came back; listed
   * here, the 30 s enforcement pauses them once running. Cleared whenever the stack stops being
   * yielded. Optional: states seeded without it behave as an empty set.
   */
  pendingRestartKeys?: Set<string>;
}

/** The stack is no longer yielded: forget what a yield left pending. */
function clearYielded(state: WatchdogState): void {
  state.isYielded = false;
  state.pendingRestartKeys?.clear();
}

// Config we read once per REFRESH_INTERVAL_MS:
let opportunisticStates = new Map<number, WatchdogState>();       // stackId → state
let proxyHostToStackId = new Map<number, number>();               // proxy_host_id → stack_id
// Reverse index built with each config refresh so the log-line hot path is O(1):
// critical_stack_id → set of opportunistic stack IDs that yield to it.
let criticalToOpportunistic = new Map<number, Set<number>>();

let ioRef: SocketIOServer | null = null;
let watching = false;
let startGeneration = 0;
let lastSize = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let evalTimer: ReturnType<typeof setInterval> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let evalQueued = false;
let refreshQueued = false;

const warnedOrphanStacks = new Set<number>();
const journalWarnAt = new Map<number, number>();
// Stacks a yield is being planned or executed for. isYielded only flips after the Docker calls, so
// without this a background resources apply could recreate the containers mid-yield; readers of
// getYieldedStackIds() treat these as yielded already.
const yieldingStackIds = new Set<number>();

// Every Docker/journal action runs one at a time: evaluate, enforcement, cold start and shutdown
// read-modify-write the same journal rows and state objects, so interleaving them could resume a
// stack while it is being yielded or lose an isYielded update.
let opTail: Promise<void> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = opTail.then(fn);
  opTail = run.then(() => undefined, () => undefined);
  return run;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function coalesceIdleTimeoutMs(limits: ResourceLimits): number {
  const raw = limits.yieldIdleTimeoutSeconds;
  const val = raw == null || raw <= 0 ? 30 : raw;
  return val * 1000;
}

function coalesceYieldMode(limits: ResourceLimits): YieldMode {
  return limits.yieldMode === 'pause' ? 'pause' : 'stop';
}

function refOf(state: WatchdogState): StackRef | null {
  return state.engineId == null ? null : { id: state.stackId, composeProject: state.composeProject, engineId: state.engineId };
}

function withinWindow(state: WatchdogState, now: number): boolean {
  const last = getLatestBusyAtAcross(state.yieldsToStackIds);
  return last != null && (now - last) <= state.yieldIdleTimeoutMs;
}

function warnState(state: WatchdogState, obj: Record<string, unknown>, msg: string): void {
  const now = Date.now();
  if (now - (state.lastWarnAt || 0) >= WARN_INTERVAL_MS) {
    state.lastWarnAt = now;
    logger.warn({ stackId: state.stackId, ...obj }, msg);
  } else {
    logger.debug({ stackId: state.stackId, ...obj }, msg);
  }
}

function warnJournal(stackId: number, obj: Record<string, unknown>, msg: string): void {
  const now = Date.now();
  if (now - (journalWarnAt.get(stackId) ?? 0) >= WARN_INTERVAL_MS) {
    journalWarnAt.set(stackId, now);
    logger.warn({ stackId, ...obj }, msg);
  } else {
    logger.debug({ stackId, ...obj }, msg);
  }
}

/**
 * A stack pause/stop cannot touch at the moment: Oblihub's own project, or a compose run that
 * creates or starts its containers.
 */
async function skipReason(ref: StackRef): Promise<'self' | 'busy' | null> {
  if (!ref.composeProject) return null;
  const daemonKey = await engineFactsService.daemonKey(ref.engineId);
  if (await selfProjectService.isSelfProject(ref.composeProject, daemonKey)) return 'self';
  // Only an `up`/`create`/`run`/`start`/`restart` (a deploy, a redeploy's `up`, a background
  // resources apply) postpones the yield: acting now would pause or stop containers compose is about
  // to replace. A `pull`, `config` or `ps`, or a git-poll hold still fetching, recreates nothing —
  // waiting on those let an Opportunistic stack keep the GPU through a multi-minute image pull.
  // Whatever a later `up` starts is yielded again by the 30 s enforcement.
  if (await composeRunner.isRecreatingFor(ref.engineId, ref.composeProject)) return 'busy';
  return null;
}

// Last info-level postponement log per stack. A compose run spans many 5 s evaluations: logging each
// one would flood, and debug-only logging left an operator no way to see why a stack kept running
// next to a busy Critical one.
const composeWaitLogAt = new Map<number, number>();

function logPostponed(stackId: number, what: string): void {
  const msg = `${what} postponed: a compose command is creating or starting this stack's containers — retried once it finishes`;
  const now = Date.now();
  if (now - (composeWaitLogAt.get(stackId) ?? 0) >= WARN_INTERVAL_MS) {
    composeWaitLogAt.set(stackId, now);
    logger.info({ stackId }, msg);
  } else {
    logger.debug({ stackId }, msg);
  }
}

/** 'stop' wins: a stop-mode resume also unpauses, so entries yielded under either mode come back. */
function combineModes(prev: 'pause' | 'stop' | null, next: 'pause' | 'stop'): 'pause' | 'stop' {
  return prev === 'stop' || next === 'stop' ? 'stop' : 'pause';
}

function toJournalEntry(c: PowerContainer): YieldJournalEntry {
  return { dockerId: c.dockerId, name: c.name, service: c.service };
}

/** Intent row, act, trim — shared by the first yield and the 30 s enforcement. */
async function journalAndExecute(
  ref: StackRef,
  mode: 'pause' | 'stop',
  candidates: PowerContainer[],
  reason: string,
): Promise<{ acted: YieldJournalEntry[]; errors: string[] }> {
  const prev = await yieldJournal.get(ref.id);
  const prevEntries = prev?.containers ?? [];
  const journalMode = combineModes(prev?.mode ?? null, mode);
  const intent = mergeJournalEntries(prevEntries, candidates.map(toJournalEntry));
  if (intent.length === 0) return { acted: [], errors: [] };

  // INTENT FIRST: a crash between the stop and the journal write used to leave containers
  // stopped with nothing to resume them. Journalling a container that is then not acted on is
  // harmless: resuming an entry whose container is already running is a no-op. If this write fails,
  // nothing is touched.
  await yieldJournal.put({ stackId: ref.id, engineId: ref.engineId, mode: journalMode, containers: intent, reason });

  const exec = await powerOps.executeYield(ref, mode, candidates);

  // TRIM to what is actually yielded; a failed trim leaves the (superset) intent row, which is safe.
  const kept = mergeJournalEntries(prevEntries, exec.acted);
  try {
    if (kept.length === 0) await yieldJournal.remove(ref.id);
    else if (kept.length !== intent.length) {
      await yieldJournal.put({ stackId: ref.id, engineId: ref.engineId, mode: journalMode, containers: kept, reason });
    }
  } catch (err) {
    logger.warn({ stackId: ref.id, err: errMessage(err) }, 'Watchdog journal trim failed — the intent row is kept');
  }
  return exec;
}

async function refreshConfig(): Promise<void> {
  return serialized(refreshConfigUnlocked);
}

/**
 * The ids among `ids` whose stored priority is Critical right now. A Save only stores Critical
 * targets (allowedYieldTargets), but links stored before that check, or to a stack demoted since,
 * would otherwise keep pausing an Opportunistic stack in step with an ordinary stack's traffic.
 */
async function currentCriticalIds(ids: number[]): Promise<Set<number>> {
  const unique = [...new Set(ids.map(Number).filter(Number.isFinite))];
  const out = new Set<number>();
  if (unique.length === 0) return out;
  const rows = await db('stacks').whereIn('id', unique).select('id', 'resource_limits') as Array<{ id: number; resource_limits: unknown }>;
  for (const r of rows) {
    let limits: unknown = r.resource_limits;
    if (typeof limits === 'string') {
      try { limits = JSON.parse(limits); } catch { continue; }
    }
    if (limits && typeof limits === 'object' && (limits as ResourceLimits).priority === 'critical') out.add(Number(r.id));
  }
  return out;
}

async function refreshConfigUnlocked(): Promise<void> {
  const opportunistic = await stackService.getOpportunisticStacksWithYields();
  let journal: YieldJournalRow[] | null = null;
  try {
    journal = await yieldJournal.all();
  } catch (err) {
    logger.warn({ err: errMessage(err) }, 'PriorityWatchdog could not read its journal — enforcement skipped this round');
  }
  const journalByStack = new Map((journal ?? []).map((r) => [r.stackId, r] as const));

  const nextStates = new Map<number, WatchdogState>();
  const nextCritToOpp = new Map<number, Set<number>>();
  // One query per refresh. A stack left with no Critical target keeps its state (empty set, never
  // within the window), so a yielded one is still resumed.
  const criticalTargets = await currentCriticalIds(opportunistic.flatMap((s) => s.resourceLimits.yieldsToStackIds ?? []));

  const allYieldTargets = new Set<number>();
  for (const s of opportunistic) {
    if (s.engineId == null) {
      // The engine was deleted. Never map it to the local daemon: a same-named project there is
      // somebody else's.
      if (!warnedOrphanStacks.has(s.id)) {
        warnedOrphanStacks.add(s.id);
        logger.warn({ stackId: s.id, composeProject: s.composeProject }, 'Opportunistic stack has no engine (engine deleted) — watchdog skips it');
      }
      continue;
    }
    const yieldsTo = new Set<number>((s.resourceLimits.yieldsToStackIds ?? []).map(Number).filter((id) => criticalTargets.has(id)));
    for (const t of yieldsTo) allYieldTargets.add(t);
    // Preserve runtime bits (isYielded, back-off) across refreshes so we don't oscillate just
    // because the config was re-read. A journal row means containers are still yielded (a resume
    // that failed at cold start, for instance): marking it yielded makes evaluate() retry the resume.
    const prev = opportunisticStates.get(s.id);
    nextStates.set(s.id, {
      stackId: s.id,
      composeProject: s.composeProject,
      engineId: s.engineId,
      yieldsToStackIds: yieldsTo,
      yieldIdleTimeoutMs: coalesceIdleTimeoutMs(s.resourceLimits),
      yieldMode: coalesceYieldMode(s.resourceLimits),
      isYielded: (prev?.isYielded ?? false) || journalByStack.has(s.id),
      failedUntil: prev?.failedUntil ?? 0,
      lastWarnAt: prev?.lastWarnAt ?? 0,
      pendingRestartKeys: prev?.pendingRestartKeys ?? new Set<string>(),
    });
    for (const critId of yieldsTo) {
      if (!nextCritToOpp.has(critId)) nextCritToOpp.set(critId, new Set());
      nextCritToOpp.get(critId)!.add(s.id);
    }
  }

  // Refresh proxy_host → stack_id ONLY for the stack IDs opportunistic stacks yield to. We don't
  // need to know about proxy_hosts for unrelated stacks — the hot path only cares whether a hit
  // belongs to a "watched" critical stack.
  const nextProxyMap = new Map<number, number>();
  if (allYieldTargets.size > 0) {
    // We reverse the query: fetch all proxy_hosts for the watched stacks and invert.
    const rows: Array<{ id: number; stack_id: number }> = await db('proxy_hosts')
      .whereIn('stack_id', Array.from(allYieldTargets))
      .where({ enabled: true })
      .select('id', 'stack_id');
    for (const r of rows) nextProxyMap.set(r.id, r.stack_id);
  }

  // A stack that was yielded with nothing journalled (every container already stopped, say) and no
  // longer yields just disappears from the states: without an event, listeners such as
  // resourceLimits' deferred apply would only notice at their next backstop sweep. Stacks with a
  // journal row get their event from resumeJournalRowsWithoutStack. An unreadable journal says
  // nothing about which stacks still have containers yielded, so no event is guessed then.
  const droppedYielded: number[] = [];
  if (journal != null) {
    for (const [id, s] of opportunisticStates) {
      if (s.isYielded && !nextStates.has(id) && !journalByStack.has(id)) droppedYielded.push(id);
    }
  }

  opportunisticStates = nextStates;
  proxyHostToStackId = nextProxyMap;
  criticalToOpportunistic = nextCritToOpp;

  for (const stackId of droppedYielded) {
    stackEvents.emit('watchdog:resumed', { stackId, reason: 'no-longer-yielding' });
    ioRef?.emit('stack:resumed-by-watchdog', { stackId, reason: 'no-longer-yielding' });
  }

  if (journal == null) return;
  await enforceYields(journalByStack);
  await resumeJournalRowsWithoutStack(journal);
}

/**
 * Re-yield journalled services of stacks still inside their activity window. WHY: an Oblihub update
 * recreate (the new container starts) or a manual start while the Critical stack is busy used to keep
 * running until the next idle→busy transition; now it is yielded again within 30 s. Only services
 * in the journal are enforced: containers the operator had stopped before the yield were never
 * ours to manage.
 */
async function enforceYields(journalByStack: Map<number, YieldJournalRow>): Promise<void> {
  for (const state of opportunisticStates.values()) {
    const now = Date.now();
    if (!state.isYielded || state.failedUntil > now || !withinWindow(state, now)) continue;
    const row = journalByStack.get(state.stackId);
    const ref = refOf(state);
    const pending = state.pendingRestartKeys ?? new Set<string>();
    if (!ref || ((!row || row.containers.length === 0) && pending.size === 0)) continue;
    // The journalled services, plus those a pause-mode yield skipped while they crash-looped.
    const services = new Set([...(row?.containers ?? []).map((e) => powerKeyOf(ref.composeProject, e)), ...pending]);
    yieldingStackIds.add(state.stackId);
    try {
      const skip = await skipReason(ref);
      if (skip === 'self') { warnState(state, {}, 'Oblihub\'s own stack is never yielded by the priority watchdog'); continue; }
      if (skip === 'busy') { logPostponed(state.stackId, 'Watchdog enforcement'); continue; }
      const plan = await powerOps.planYield(ref, state.yieldMode, { services });
      if (plan.candidates.length === 0) continue;
      const exec = await journalAndExecute(ref, state.yieldMode, plan.candidates, row?.reason ?? 'critical-activity');
      // Journalled now: enforced through the journal from here on.
      for (const e of exec.acted) pending.delete(powerKeyOf(ref.composeProject, e));
      if (exec.acted.length > 0) {
        logger.info({ stackId: state.stackId, mode: state.yieldMode, containers: exec.acted.map((e) => e.name) },
          'Watchdog re-yielded containers that restarted while the Critical stack is busy');
      }
      if (exec.errors.length > 0) {
        if (exec.acted.length === 0) state.failedUntil = Date.now() + FAILURE_BACKOFF_MS;
        warnState(state, { errors: exec.errors }, 'Watchdog enforcement failed for some containers');
      }
    } catch (err) {
      state.failedUntil = Date.now() + FAILURE_BACKOFF_MS;
      warnState(state, { err: errMessage(err) }, 'Watchdog enforcement failed — retrying in 60 s');
    } finally {
      yieldingStackIds.delete(state.stackId);
    }
  }
}

/** Journal rows whose stack no longer yields (priority changed, limits cleared, engine deleted). */
async function resumeJournalRowsWithoutStack(journal: YieldJournalRow[]): Promise<void> {
  for (const row of journal) {
    if (opportunisticStates.has(row.stackId)) continue;
    try {
      await resumeJournalRow(row, 'no-longer-yielding', true);
    } catch (err) {
      warnJournal(row.stackId, { err: errMessage(err) }, 'Watchdog could not resume a journalled stack');
    }
  }
}

/**
 * Resume one journal row against its stacks row. A missing stack or an orphaned one (engine deleted)
 * only drops the row (never map it to the local daemon). Returns true when the row is gone.
 */
async function resumeJournalRow(row: YieldJournalRow, reason: string, emitEvents: boolean): Promise<boolean> {
  const stackRow = await db('stacks').where({ id: row.stackId }).first('id', 'compose_project', 'engine_id') as
    { id: number; compose_project: string | null; engine_id: number | null } | undefined;
  const names = row.containers.map((e) => e.name);
  if (!stackRow || stackRow.engine_id == null || (row.engineId != null && row.engineId !== stackRow.engine_id)) {
    await yieldJournal.remove(row.stackId);
    logger.warn({ stackId: row.stackId, engineId: row.engineId, containers: names },
      'Watchdog journal row dropped: its stack or engine no longer exists — those containers were not resumed');
    return true;
  }
  const state = opportunisticStates.get(row.stackId);
  if (row.containers.length === 0) {
    await yieldJournal.remove(row.stackId);
    if (state) clearYielded(state);
    return true;
  }
  const ref: StackRef = { id: stackRow.id, composeProject: stackRow.compose_project, engineId: stackRow.engine_id };
  const res = await powerOps.resumeEntries(ref, row.mode, row.containers);
  if (res.errors.length === 0) {
    await yieldJournal.remove(row.stackId);
    if (state) clearYielded(state);
    logger.info({ stackId: row.stackId, reason, resumed: res.resumed, gone: res.gone, skipped: res.skipped }, 'Watchdog resumed journalled stack');
    if (emitEvents) {
      ioRef?.emit('stack:resumed-by-watchdog', { stackId: row.stackId, reason });
      stackEvents.emit('watchdog:resumed', { stackId: row.stackId, reason });
    }
    return true;
  }
  const failed = (res as { failedEntries?: YieldJournalEntry[] }).failedEntries ?? row.containers;
  await yieldJournal.put({
    stackId: row.stackId,
    engineId: row.engineId ?? ref.engineId,
    mode: row.mode,
    containers: failed.length > 0 ? failed : row.containers,
    reason: row.reason,
  });
  warnJournal(row.stackId, { reason, errors: res.errors }, 'Watchdog resume incomplete — the rest stays journalled');
  return false;
}

function processLine(line: string): void {
  if (!line || line[0] === '#') return;
  const parts = line.split('|');
  if (parts.length < 1) return;
  const proxyHostId = parseInt(parts[0], 10);
  if (!Number.isFinite(proxyHostId) || proxyHostId <= 0) return;
  const stackId = proxyHostToStackId.get(proxyHostId);
  if (stackId == null) return;
  // Only stamp if this Critical stack is actually watched by an Opportunistic — cheap early-out
  // for hits against Critical stacks nobody yields to.
  if (!criticalToOpportunistic.has(stackId)) return;
  markCriticalBusy(stackId);
}

async function pollFile(): Promise<void> {
  if (!fs.existsSync(LOG_PATH)) return;
  let stat: fs.Stats;
  try { stat = fs.statSync(LOG_PATH); } catch { return; }
  if (stat.size === lastSize) return;
  if (stat.size < lastSize) { lastSize = 0; }
  const fd = fs.openSync(LOG_PATH, 'r');
  try {
    const toRead = stat.size - lastSize;
    if (toRead > 0) {
      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, lastSize);
      lastSize = stat.size;
      const text = buf.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim()) processLine(line);
      }
    }
  } finally { fs.closeSync(fd); }
}

async function yieldStack(state: WatchdogState, reason: string): Promise<boolean> {
  const now = Date.now();
  if (state.failedUntil > now) return false;
  const ref = refOf(state);
  if (!ref) return false;
  const mode = state.yieldMode;
  yieldingStackIds.add(state.stackId);
  try {
    const skip = await skipReason(ref);
    if (skip === 'self') {
      warnState(state, {}, 'Oblihub\'s own stack is never yielded by the priority watchdog');
      return false;
    }
    if (skip === 'busy') {
      logPostponed(state.stackId, 'Watchdog yield');
      return false;
    }
    const plan = await powerOps.planYield(ref, mode);
    const exec = await journalAndExecute(ref, mode, plan.candidates, reason);
    if (plan.candidates.length > 0 && exec.acted.length === 0 && exec.errors.length === 0) {
      // Every candidate vanished between plan and execute (compose recreated them): nothing is
      // yielded, and marking the stack so would leave the new containers running until the next
      // idle-to-busy transition. No back-off either: the next evaluation re-plans against them.
      logger.debug({ stackId: state.stackId }, 'Watchdog yield found no container left to act on — re-planning next evaluation');
      return false;
    }
    if (exec.acted.length === 0 && exec.errors.length === 0 && plan.skipped.some((s) => s.reason === 'restarting')) {
      // Pause mode cannot freeze a crash-looping container during its restart back-off (no process
      // to freeze). Marking the stack yielded with an empty journal would let it run for the whole
      // busy window: enforceYields only re-yields journalled services. Not yielded and no back-off,
      // so the next 5 s evaluation re-plans and pauses it once it is running.
      logger.debug({ stackId: state.stackId }, 'Watchdog yield: only crash-looping containers to act on — re-planning next evaluation');
      return false;
    }
    if (exec.acted.length > 0 || exec.errors.length === 0) {
      state.isYielded = true;
      // Partial pause: the other services are paused and journalled, a crash-looping one is not.
      // enforceYields pauses it once it runs again (see WatchdogState.pendingRestartKeys).
      state.pendingRestartKeys = new Set(plan.skipped
        .filter((s) => s.reason === 'restarting')
        .map((s) => powerKeyOf(ref.composeProject, { name: s.name, service: s.service ?? null })));
      logger.info({ stackId: state.stackId, mode, reason, containers: exec.acted.map((e) => e.name), skipped: plan.skipped, errors: exec.errors },
        'Watchdog yielded stack');
      ioRef?.emit('stack:paused-by-watchdog', { stackId: state.stackId, reason });
      stackEvents.emit('watchdog:yielded', { stackId: state.stackId, mode, reason });
      return true;
    }
    state.failedUntil = now + FAILURE_BACKOFF_MS;
    warnState(state, { mode, errors: exec.errors }, 'Watchdog yield failed — retrying in 60 s');
    return false;
  } catch (err) {
    state.failedUntil = now + FAILURE_BACKOFF_MS;
    warnState(state, { mode, err: errMessage(err) }, 'Watchdog yield failed — retrying in 60 s');
    return false;
  } finally {
    yieldingStackIds.delete(state.stackId);
  }
}

function markResumed(state: WatchdogState, reason: string, details: Record<string, unknown> = {}): void {
  clearYielded(state);
  logger.info({ stackId: state.stackId, mode: state.yieldMode, reason, ...details }, 'Watchdog resumed stack');
  ioRef?.emit('stack:resumed-by-watchdog', { stackId: state.stackId, reason });
  stackEvents.emit('watchdog:resumed', { stackId: state.stackId, reason });
}

async function resumeStackState(state: WatchdogState, reason: string): Promise<boolean> {
  const now = Date.now();
  if (state.failedUntil > now) return false;
  const ref = refOf(state);
  if (!ref) { markResumed(state, reason); return true; }
  try {
    const row = await yieldJournal.get(state.stackId);
    if (!row || row.containers.length === 0) {
      // Nothing was acted on (everything was already stopped, or protected): no Docker call needed.
      if (row) await yieldJournal.remove(state.stackId);
      markResumed(state, reason);
      return true;
    }
    const res = await powerOps.resumeEntries(ref, row.mode, row.containers);
    if (res.errors.length === 0) {
      await yieldJournal.remove(state.stackId);
      markResumed(state, reason, { resumed: res.resumed, gone: res.gone, skipped: res.skipped });
      return true;
    }
    // Keep the stack yielded so evaluate() retries after the back-off; only what did not resume stays journalled.
    state.isYielded = true;
    const failed = (res as { failedEntries?: YieldJournalEntry[] }).failedEntries ?? row.containers;
    await yieldJournal.put({
      stackId: state.stackId,
      engineId: row.engineId ?? ref.engineId,
      mode: row.mode,
      containers: failed.length > 0 ? failed : row.containers,
      reason: row.reason,
    });
    state.failedUntil = now + FAILURE_BACKOFF_MS;
    warnState(state, { errors: res.errors, resumed: res.resumed }, 'Watchdog resume failed — retrying in 60 s');
    return false;
  } catch (err) {
    state.failedUntil = now + FAILURE_BACKOFF_MS;
    warnState(state, { err: errMessage(err) }, 'Watchdog resume failed — retrying in 60 s');
    return false;
  }
}

async function evaluate(): Promise<void> {
  return serialized(evaluateUnlocked);
}

async function evaluateUnlocked(): Promise<void> {
  const now = Date.now();
  for (const state of opportunisticStates.values()) {
    if (state.failedUntil > now) continue;
    // Latest activity across ALL Critical stacks this one yields to. Any source (nginx tail,
    // GPU poller, webhook) that stamped one of those Critical IDs counts.
    const inWindow = withinWindow(state, now);
    if (inWindow && !state.isYielded) {
      await yieldStack(state, 'critical-activity');
    } else if (!inWindow && state.isYielded) {
      await resumeStackState(state, 'idle-timeout');
    }
  }
}

interface LegacyPending {
  since: string;
  stackIds: number[];
}

function parseLegacyPending(raw: string): LegacyPending | null {
  try {
    const v = JSON.parse(raw) as { since?: unknown; stackIds?: unknown } | null;
    if (!v || typeof v.since !== 'string' || !Array.isArray(v.stackIds)) return null;
    return { since: v.since, stackIds: v.stackIds.filter((id): id is number => Number.isInteger(id)) };
  } catch {
    return null;
  }
}

async function saveLegacyPending(since: string, remaining: Set<number>): Promise<void> {
  await appConfigService.set(LEGACY_PENDING_KEY, JSON.stringify({ since, stackIds: [...remaining] }));
}

/**
 * One-time pass for stacks the old version left yielded (its shutdown resume never completed): the
 * old boot behaviour — resume every Opportunistic stack — once, through dockerode, never `up -d`,
 * following each stack's yieldMode (pause mode only unpauses, as `compose unpause` did; stop mode
 * also starts, as `compose start` did). Excluded, sleeping, infra/self containers are skipped,
 * orphaned stacks too.
 *
 * Completion is tracked per stack, as a snapshot of the stacks still PENDING taken at the first boot
 * of this version. WHY: an all-or-nothing marker let one stack on a disabled or unreachable engine
 * re-run the blind resume on every stack at every boot, starting containers an operator had stopped
 * by hand since. A stack that failed is retried at later boots (and only it); stacks resumed once, and
 * stacks created after the upgrade, are never blind-resumed. After LEGACY_PENDING_MAX_AGE_MS the
 * leftovers are dropped: their containers need a manual start.
 */
async function legacyResumePass(): Promise<void> {
  const opportunistic = await stackService.getOpportunisticStacksWithYields();
  const raw = await appConfigService.get(LEGACY_PENDING_KEY);
  let pending: LegacyPending;
  if (raw == null) {
    pending = { since: new Date().toISOString(), stackIds: opportunistic.filter((s) => s.engineId != null).map((s) => s.id) };
    // Persisted before acting: a crash mid-pass must not re-seed with stacks created in the meantime.
    await saveLegacyPending(pending.since, new Set(pending.stackIds));
  } else {
    const parsed = parseLegacyPending(raw);
    if (!parsed) logger.warn({ key: LEGACY_PENDING_KEY }, 'Watchdog upgrade resume state unreadable — the pass is considered done');
    pending = parsed ?? { since: new Date().toISOString(), stackIds: [] };
  }

  const remaining = new Set(pending.stackIds);
  const sinceMs = Date.parse(pending.since);
  const expired = Number.isFinite(sinceMs) && Date.now() - sinceMs > LEGACY_PENDING_MAX_AGE_MS;
  const byId = new Map(opportunistic.map((s) => [s.id, s] as const));
  const engineIds = [...new Set(opportunistic.filter((s) => remaining.has(s.id) && s.engineId != null).map((s) => s.engineId as number))];
  const engineRows = engineIds.length === 0 ? [] : await db('docker_engines').whereIn('id', engineIds).select('id', 'enabled') as Array<{ id: number; enabled: boolean }>;
  const engineEnabled = new Map(engineRows.map((e) => [Number(e.id), Boolean(e.enabled)] as const));

  for (const id of [...remaining]) {
    const s = byId.get(id);
    // Deleted, or no longer an Opportunistic stack with yields: the old boot would not resume it either.
    if (!s) { remaining.delete(id); continue; }
    const enabled = s.engineId == null ? undefined : engineEnabled.get(s.engineId);
    if (s.engineId == null || enabled === undefined) {
      remaining.delete(id);
      logger.warn({ stackId: s.id, composeProject: s.composeProject }, 'Watchdog upgrade resume skipped an orphaned stack (engine deleted)');
      continue;
    }
    if (expired) {
      remaining.delete(id);
      logger.warn({ stackId: s.id, composeProject: s.composeProject, since: pending.since },
        'Watchdog upgrade resume gave up on a stack whose engine stayed unavailable — start its containers by hand if needed');
      continue;
    }
    if (!enabled) {
      // engineService refuses a disabled engine; kept pending so re-enabling it and restarting resumes it.
      logger.warn({ stackId: s.id, engineId: s.engineId }, 'Watchdog upgrade resume postponed: the stack\'s engine is disabled — retried at the next boot');
      continue;
    }
    const ref: StackRef = { id: s.id, composeProject: s.composeProject, engineId: s.engineId };
    let res: Awaited<ReturnType<typeof powerOps.legacyResumeAll>>;
    try {
      // The stack's own yieldMode, as the old boot chose `compose unpause` (pause) or `compose start` (stop).
      res = await powerOps.legacyResumeAll(ref, coalesceYieldMode(s.resourceLimits));
    } catch (err) {
      logger.warn({ stackId: s.id, err: errMessage(err) }, 'Watchdog upgrade resume could not reach the stack — retried at the next boot');
      continue;
    }
    logger.info({ stackId: s.id, resumed: res.resumed, skipped: res.skipped, errors: res.errors }, 'Watchdog upgrade resume');
    remaining.delete(id);
    // Saved per stack: a crash later in the pass must not blind-resume this one again. Outside the
    // try: a failed write stops the pass rather than resuming more stacks it could not record.
    await saveLegacyPending(pending.since, remaining);
  }

  if (remaining.size > 0) {
    await saveLegacyPending(pending.since, remaining);
    return;
  }
  // Marker first: a crash between the two writes must not leave both keys unset (that would re-seed).
  await appConfigService.set(JOURNAL_MARKER_KEY, new Date().toISOString());
  await db('app_config').where({ key: LEGACY_PENDING_KEY }).del();
}

async function coldStart(): Promise<void> {
  if (!(await appConfigService.get(JOURNAL_MARKER_KEY))) {
    // A failed upgrade pass stays pending for the next boot; it must not keep the journal from resuming.
    try {
      await legacyResumePass();
    } catch (err) {
      logger.warn({ err: errMessage(err) }, 'Watchdog upgrade resume failed — retried at the next boot');
    }
  }
  const rows = await yieldJournal.all();
  for (const row of rows) {
    try {
      await resumeJournalRow(row, 'cold-start', true);
    } catch (err) {
      warnJournal(row.stackId, { err: errMessage(err) }, 'Watchdog cold-start resume failed');
    }
  }
}

/**
 * Snapshot of stacks currently paused/stopped by the watchdog. Consumed by the Resources
 * Dashboard so it can render a "paused-by-watchdog" badge without having to infer from the
 * container's raw Docker state (which would conflate operator-initiated stops with our yields).
 * A yield still in flight counts: resourceLimits' apply, update.service and the GPU poller must hold
 * off on it exactly as on a finished one.
 */
export function getYieldedStackIds(): Set<number> {
  const out = new Set<number>(yieldingStackIds);
  for (const [id, s] of opportunisticStates) if (s.isYielded) out.add(id);
  return out;
}

/**
 * "Remove from Oblihub only" of a stack the watchdog holds: resumes what it paused or stopped, then
 * runs `remove` in the same serialized slot. Deleting the stacks row drops its journal row (cascade),
 * so a yield landing between a separate resume and the delete would leave containers paused or
 * stopped with nothing left to resume them; no yield can run inside this slot. The state is dropped
 * with the row so the evaluator does not yield a stack that no longer exists before the next refresh.
 * false (nothing removed) when the resume did not complete; the rest stays journalled.
 *
 * engineService.delete (releaseWatchdogAndDisable) also relies on it: it calls it for each stack the
 * watchdog holds on the engine with a no-op `remove`, and uses the last call's `remove` to disable the
 * engine inside the slot, including for a stack that is not held at all (it only needs the slot). So
 * with no journal row and no yield in flight this must keep running `remove` in the slot and
 * returning true. (A dedicated resumeStacksForEngineRemoval(engineId, disable) resuming every journal
 * row of the engine and then disabling in ONE slot could replace that multi-round loop.)
 */
export function resumeStackForRemoval(stackId: number, remove: () => Promise<void>): Promise<boolean> {
  return serialized(async () => {
    const row = await yieldJournal.get(stackId);
    let released: boolean;
    if (!row) {
      // Yielded with nothing journalled (every container was already stopped): nothing to resume.
      const s = opportunisticStates.get(stackId);
      if (s) clearYielded(s);
      released = !yieldingStackIds.has(stackId);
    } else {
      released = await resumeJournalRow(row, 'stack-removed', true);
    }
    if (!released) return false;
    await remove();
    opportunisticStates.delete(stackId);
    return true;
  });
}

function startTimers(): void {
  pollTimer = setInterval(() => {
    pollFile().catch(err => logger.warn({ err: errMessage(err) }, 'PriorityWatchdog poll failed'));
  }, POLL_INTERVAL_MS);
  // One queued run at most per kind: a slow Docker call must not pile up a tick every 5 s.
  evalTimer = setInterval(() => {
    if (evalQueued) return;
    evalQueued = true;
    evaluate()
      .catch(err => logger.warn({ err: errMessage(err) }, 'PriorityWatchdog evaluate failed'))
      .finally(() => { evalQueued = false; });
  }, EVAL_INTERVAL_MS);
  refreshTimer = setInterval(() => {
    if (refreshQueued) return;
    refreshQueued = true;
    refreshConfig()
      .catch(err => logger.warn({ err: errMessage(err) }, 'PriorityWatchdog refresh failed'))
      .finally(() => { refreshQueued = false; });
  }, REFRESH_INTERVAL_MS);
}

export function startPriorityWatchdogWorker(io: SocketIOServer): void {
  if (watching) return;
  watching = true;
  ioRef = io;
  const generation = ++startGeneration;
  logger.info({ logPath: LOG_PATH }, 'Starting priority watchdog worker (1s poll, 5s evaluate, 30s refresh)');

  // Seek to EOF so we don't replay historical traffic at boot.
  try { lastSize = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0; } catch { lastSize = 0; }

  // Cold-start resume BEFORE we start evaluating — otherwise a still-active traffic burst could
  // race us into a fresh yield before the previous one is cleared. A cold start that outlives the
  // bound keeps the operation lock, so later evaluations still wait for it.
  withTimeout(serialized(coldStart), COLD_START_TIMEOUT_MS, 'priority watchdog cold start')
    .catch(err => logger.warn({ err: errMessage(err) }, 'Watchdog cold start failed'))
    .finally(() => {
      if (!watching || generation !== startGeneration) return;
      refreshConfig().catch(err => logger.warn({ err: errMessage(err) }, 'PriorityWatchdog initial config refresh failed'));
      startTimers();
    });
}

/** Resolves once every journal row got a resume attempt; never rejects. index.ts bounds the wait. */
export function stopPriorityWatchdogWorker(): Promise<void> {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (evalTimer) { clearInterval(evalTimer); evalTimer = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  watching = false;
  startGeneration++;
  // Resume what we yielded so stacks don't stay stuck when the process exits. Waits for an action in
  // flight first. Rows left behind (timeout, unreachable engine) are resumed at the next cold start.
  return serialized(async () => {
    const rows = await yieldJournal.all();
    for (const row of rows) {
      try {
        // No events: a listener starting compose work now would be killed half-way by the exit.
        await resumeJournalRow(row, 'shutdown', false);
      } catch (err) {
        logger.warn({ stackId: row.stackId, err: errMessage(err) }, 'Shutdown resume failed');
      }
    }
  }).catch(err => logger.warn({ err: errMessage(err) }, 'Shutdown resume failed'));
}

/**
 * Test hook — force an immediate config refresh + evaluate cycle. Not called at runtime; used
 * by unit tests to advance the state machine without waiting for the 5s / 30s timers.
 */
export const __test_only = {
  refreshConfig,
  evaluate,
  processLine,
  getState: (stackId: number) => opportunisticStates.get(stackId),
  seedProxyMap: (m: Map<number, number>) => { proxyHostToStackId = new Map(m); },
  seedCriticalIndex: (m: Map<number, Set<number>>) => { criticalToOpportunistic = new Map(m); },
  seedStates: (m: Map<number, WatchdogState>) => { opportunisticStates = new Map(m); },
  setPowerOps: (ops: Partial<typeof powerOps>) => { Object.assign(powerOps, ops); },
};
