import type Docker from 'dockerode';
import { db } from '../db';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/withTimeout';
import { containerNameOf, isOblihubHiddenContainer, labelsOf, oblihubInfraReason } from '../utils/oblihubContainers';
import { dockerService } from './docker.service';
import { engineFactsService } from './engineFacts.service';
import { selfProjectService } from './selfProject.service';

/**
 * Pause / stop / resume the EXISTING containers of one discovered stack on its own engine, for the
 * priority watchdog.
 *
 * Why not compose: the old CLI resume fell back to creating the services when `start` failed, from the
 * hub's stack folder and on the LOCAL daemon — a remote stack yielded by the watchdog could come back
 * as a duplicate on the hub. Dockerode on the stack's engine can only act on containers that
 * exist there: this module never runs compose and never creates a container.
 *
 * Never touched (reported as skipped): containers flagged `excluded` (a security control for
 * stateful services), Oblihub's own plumbing (host agent, one-shots, Azure sidecars, socket proxy)
 * and Oblihub itself on the local daemon. Callers skip orphaned stacks (engine deleted) before
 * reaching this module, so the engine id is always concrete.
 */

export interface StackRef { id: number; composeProject: string | null; engineId: number; }
export interface YieldJournalEntry { dockerId: string; name: string; service: string | null; }
export interface YieldJournalRow {
  stackId: number;
  engineId: number | null;
  mode: 'pause' | 'stop';
  containers: YieldJournalEntry[];
  reason: string | null;
  yieldedAt: string;
}
export interface PowerContainer {
  dockerId: string;
  fullId: string;
  name: string;
  service: string | null;
  state: string;
  dependsOn: string[];
  protectedReason: string | null;
  sleeping: boolean;
  /** A `docker compose run` container (`com.docker.compose.oneoff=True`). */
  oneoff: boolean;
}

export type PowerMode = 'pause' | 'stop';

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const COMPOSE_DEPENDS_ON_LABEL = 'com.docker.compose.depends_on';
const COMPOSE_ONEOFF_LABEL = 'com.docker.compose.oneoff';

const LIST_TIMEOUT_MS = 30_000;
const PAUSE_TIMEOUT_MS = 30_000;
// No `t` is sent with stop, so the container's own stop_grace_period applies (a miner may need a while
// to flush). The bound only protects the watchdog loop from a daemon that never answers.
const STOP_TIMEOUT_MS = 5 * 60_000;
const START_TIMEOUT_MS = 2 * 60_000;
const JOURNAL_REASON_MAX = 64;

// ── Pure helpers (exported for the check script) ─────────────────────────────

/** `com.docker.compose.depends_on` = 'db:service_healthy:false,redis:service_started:true' → ['db', 'redis']. */
export function parseDependsOnLabel(label?: string | null): string[] {
  if (!label) return [];
  const out: string[] = [];
  for (const part of label.split(',')) {
    const name = part.split(':')[0]?.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

interface Orderable { name: string; service: string | null; dependsOn: string[]; }

/** a depends on b (by compose service; replicas of one service never depend on each other). */
function dependsOn(a: Orderable, b: Orderable): boolean {
  return b.service != null && a.service !== b.service && a.dependsOn.includes(b.service);
}

/**
 * Stable topological order: repeatedly takes the first not-yet-placed item (input order) whose
 * required predecessors are all placed. A dependency cycle falls back to input order instead of
 * dropping containers.
 */
function orderWith<T extends Orderable>(list: readonly T[], mustPrecede: (a: T, b: T) => boolean): T[] {
  const placed = new Array<boolean>(list.length).fill(false);
  const out: T[] = [];
  while (out.length < list.length) {
    let pick = -1;
    for (let i = 0; i < list.length && pick === -1; i++) {
      if (placed[i]) continue;
      let ready = true;
      for (let j = 0; j < list.length; j++) {
        if (j !== i && !placed[j] && mustPrecede(list[j], list[i])) { ready = false; break; }
      }
      if (ready) pick = i;
    }
    if (pick === -1) pick = placed.indexOf(false);
    placed[pick] = true;
    out.push(list[pick]);
  }
  return out;
}

/** Dependents first: a container is stopped before the services it depends on. */
export function stopOrder<T extends Orderable>(list: readonly T[]): T[] {
  return orderWith(list, (a, b) => dependsOn(a, b));
}

/** Dependencies first (the reverse of stopOrder). */
export function startOrder<T extends Orderable>(list: readonly T[]): T[] {
  return orderWith(list, (a, b) => dependsOn(b, a));
}

/** Union deduplicated by dockerId; an entry of `b` replaces the entry of `a` with the same id. */
export function mergeJournalEntries(a: readonly YieldJournalEntry[], b: readonly YieldJournalEntry[]): YieldJournalEntry[] {
  const byId = new Map<string, YieldJournalEntry>();
  for (const e of a) byId.set(e.dockerId, e);
  for (const e of b) byId.set(e.dockerId, e);
  return [...byId.values()];
}

/** How the watchdog addresses a container across recreates: its compose service, or its name for
 *  Standalone containers (which have no service). */
export function powerKeyOf(composeProject: string | null, c: { name: string; service: string | null }): string {
  return composeProject ? (c.service ?? c.name) : c.name;
}

function toEntry(c: PowerContainer): YieldJournalEntry {
  return { dockerId: c.dockerId, name: c.name, service: c.service };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusCodeOf(err: unknown): number | null {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === 'number' ? code : null;
}

// ── Listing ───────────────────────────────────────────────────────────────────

interface ContainerDbRow {
  docker_id: string;
  container_name: string;
  stack_id: number | null;
  excluded: boolean;
  status: string | null;
  sleep_enabled: boolean | null;
  sleep_state: string | null;
}

async function listStackContainers(stack: StackRef): Promise<PowerContainer[]> {
  const rows = await db('containers')
    .where({ engine_id: stack.engineId })
    .select('docker_id', 'container_name', 'stack_id', 'excluded', 'status', 'sleep_enabled', 'sleep_state') as ContainerDbRow[];

  let infos: Docker.ContainerInfo[];
  if (stack.composeProject) {
    infos = await withTimeout(
      dockerService.listProjectContainers(stack.composeProject, stack.engineId),
      LIST_TIMEOUT_MS,
      `list containers of ${stack.composeProject}`,
    );
  } else {
    // Standalone groups every container without a compose project: only the ones discovery attached
    // to THIS stack row are addressed, never "everything on the engine".
    const ids = rows.filter((r) => r.stack_id === stack.id && r.docker_id).map((r) => r.docker_id);
    if (ids.length === 0) return [];
    const docker = await dockerService.forEngine(stack.engineId);
    const listed = await withTimeout(
      docker.listContainers({ all: true, filters: { id: ids } }),
      LIST_TIMEOUT_MS,
      `list Standalone containers of stack ${stack.id}`,
    );
    // Docker's id filter matches any part of the id: keep exact prefix matches only.
    infos = listed.filter((c) => !isOblihubHiddenContainer(c) && ids.some((id) => c.Id.startsWith(id)));
  }

  const byId = new Map<string, ContainerDbRow>();
  const byName = new Map<string, ContainerDbRow[]>();
  for (const r of rows) {
    if (r.docker_id) byId.set(r.docker_id.substring(0, 12), r);
    const list = byName.get(r.container_name);
    if (list) list.push(r); else byName.set(r.container_name, [r]);
  }

  // Oblihub itself only runs on the local daemon: a same-named project on a remote engine is a tenant's.
  let selfId: string | null = null;
  let selfProjects = new Set<string>();
  if ((await engineFactsService.daemonKey(stack.engineId)) === 'local') {
    selfId = selfProjectService.getSelfContainerId();
    selfProjects = await selfProjectService.getSelfProjects();
  }

  const out: PowerContainer[] = infos.map((c) => {
    const labels = labelsOf(c);
    const name = containerNameOf(c);
    const dockerId = c.Id.substring(0, 12);
    const byIdRow = byId.get(dockerId);
    // A recreated container has a new id until the next discovery pass: its row is found by name.
    // When several rows share the name, any of them being excluded protects it (errs on the safe side).
    const matched = byIdRow ? [byIdRow] : (byName.get(name) ?? []);
    const excluded = matched.some((r) => r.excluded === true || r.status === 'excluded');
    const sleeping = matched.some((r) => r.sleep_enabled === true && r.sleep_state === 'sleeping');

    let protectedReason: string | null = null;
    if (excluded) protectedReason = 'excluded';
    else if (oblihubInfraReason(c)) protectedReason = 'Oblihub infrastructure';
    else if ((selfId && c.Id.startsWith(selfId)) || (labels[COMPOSE_PROJECT_LABEL] && selfProjects.has(labels[COMPOSE_PROJECT_LABEL]))) {
      protectedReason = 'Oblihub itself';
    }

    return {
      dockerId,
      fullId: c.Id,
      name,
      service: labels[COMPOSE_SERVICE_LABEL] ?? null,
      state: c.State || 'unknown',
      dependsOn: parseDependsOnLabel(labels[COMPOSE_DEPENDS_ON_LABEL]),
      protectedReason,
      sleeping,
      oneoff: (labels[COMPOSE_ONEOFF_LABEL] ?? '').toLowerCase() === 'true',
    };
  });
  // Docker lists newest first; a stable name order keeps the start/stop order deterministic.
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function planYield(
  stack: StackRef,
  mode: PowerMode,
  opts: { services?: Set<string> | null } = {},
): Promise<{ candidates: PowerContainer[]; skipped: Array<{ name: string; reason: string; service?: string | null }> }> {
  const services = opts.services ?? null;
  const candidates: PowerContainer[] = [];
  // `service` on 'restarting' entries: the watchdog keys the ones it must pause later by service.
  const skipped: Array<{ name: string; reason: string; service?: string | null }> = [];
  for (const c of await listStackContainers(stack)) {
    if (services && !services.has(powerKeyOf(stack.composeProject, c))) continue;
    if (c.protectedReason) { skipped.push({ name: c.name, reason: c.protectedReason }); continue; }
    // 'restarting' = crash-looping, waiting out its restart back-off (a miner whose VRAM cap is below
    // its working set). Docker counts it as running, so a stop acts on it and cancels the pending
    // restart, as the `docker compose stop` this module replaced did. Left out, it would come back on
    // the shared GPU and, never journalled, never be enforced. Pause mode cannot freeze it (no process
    // between two attempts: the daemon answers 409), so it is reported instead of silently dropped.
    let eligible: boolean;
    if (mode === 'pause') {
      eligible = c.state === 'running';
      if (c.state === 'restarting') skipped.push({ name: c.name, reason: 'restarting', service: c.service });
    } else {
      eligible = c.state === 'running' || c.state === 'paused' || c.state === 'restarting';
    }
    if (eligible) candidates.push(c);
  }
  return { candidates, skipped };
}

async function executeYield(
  stack: StackRef,
  mode: PowerMode,
  candidates: PowerContainer[],
): Promise<{ acted: YieldJournalEntry[]; errors: string[] }> {
  const acted: YieldJournalEntry[] = [];
  const errors: string[] = [];
  if (candidates.length === 0) return { acted, errors };
  let docker: Docker;
  try {
    docker = await dockerService.forEngine(stack.engineId);
  } catch (err) {
    return { acted, errors: [`engine ${stack.engineId}: ${errMessage(err)}`] };
  }

  for (const c of mode === 'stop' ? stopOrder(candidates) : candidates) {
    const container = docker.getContainer(c.fullId);
    try {
      if (mode === 'pause') {
        await withTimeout(container.pause(), PAUSE_TIMEOUT_MS, `pause ${c.name}`);
      } else {
        if (c.state === 'paused') {
          // A paused process cannot handle SIGTERM: unpause first so the stop is a clean shutdown.
          try {
            await withTimeout(container.unpause(), PAUSE_TIMEOUT_MS, `unpause ${c.name}`);
          } catch (err) {
            if (statusCodeOf(err) !== 409) throw err;   // 409: no longer paused — stop it anyway
          }
        }
        await withTimeout(container.stop(), STOP_TIMEOUT_MS, `stop ${c.name}`);
      }
      acted.push(toEntry(c));
      logger.debug({ stackId: stack.id, engineId: stack.engineId, container: c.name, mode }, 'Watchdog yielded container');
    } catch (err) {
      const code = statusCodeOf(err);
      // 304 already stopped, 404 removed meanwhile, 409 on pause = already paused / not running:
      // the container changed state under us, which is not a failure of the yield.
      if (code === 304 || code === 404 || (mode === 'pause' && code === 409)) {
        logger.debug({ stackId: stack.id, container: c.name, statusCode: code }, 'Watchdog yield: container changed state meanwhile');
        continue;
      }
      errors.push(`${c.name}: ${errMessage(err)}`);
    }
  }
  return { acted, errors };
}

export interface ResumeResult {
  resumed: string[];
  gone: string[];
  skipped: Array<{ name: string; reason: string }>;
  errors: string[];
  /** Entries that failed to resume (the caller keeps them journalled and retries). */
  failedEntries: YieldJournalEntry[];
}

/**
 * Resume exactly what the journal lists. Never throws: a listing failure resolves with every entry
 * in `failedEntries`, so the journal row is kept for the next attempt.
 */
async function resumeEntries(stack: StackRef, mode: PowerMode, entries: YieldJournalEntry[]): Promise<ResumeResult> {
  const out: ResumeResult = { resumed: [], gone: [], skipped: [], errors: [], failedEntries: [] };
  if (entries.length === 0) return out;
  let list: PowerContainer[];
  let docker: Docker;
  try {
    list = await listStackContainers(stack);
    docker = await dockerService.forEngine(stack.engineId);
  } catch (err) {
    out.errors.push(errMessage(err));
    out.failedEntries.push(...entries);
    return out;
  }

  // Match by docker id first. A container recreated since the yield (update, resources apply) has a
  // new id: compose keeps its name, so the name is tried next; then any unclaimed container of the
  // same service (compose) — Standalone containers have only their name.
  const claimed = new Set<string>();
  const matches: Array<PowerContainer & { entry: YieldJournalEntry }> = [];
  const pending: YieldJournalEntry[] = [];
  for (const e of entries) {
    const c = list.find((x) => x.dockerId === e.dockerId.substring(0, 12));
    if (c && !claimed.has(c.fullId)) { claimed.add(c.fullId); matches.push({ ...c, entry: e }); } else pending.push(e);
  }
  for (const e of pending) {
    let c = list.find((x) => x.name === e.name);
    if (c && claimed.has(c.fullId)) {
      // Its replacement is already handled through another (newer) entry.
      out.gone.push(e.name);
      continue;
    }
    if (!c && stack.composeProject && e.service) {
      c = list.find((x) => x.service === e.service && !claimed.has(x.fullId));
    }
    if (!c) { out.gone.push(e.name); continue; }
    claimed.add(c.fullId);
    matches.push({ ...c, entry: e });
  }

  for (const c of startOrder(matches)) {
    // An entry that became excluded (or turned out to be Oblihub's own) is left alone.
    if (c.protectedReason) { out.skipped.push({ name: c.name, reason: c.protectedReason }); continue; }
    const container = docker.getContainer(c.fullId);
    try {
      if (c.state === 'paused') {
        await withTimeout(container.unpause(), PAUSE_TIMEOUT_MS, `unpause ${c.name}`);
        out.resumed.push(c.name);
      } else if (c.state === 'exited' || c.state === 'created') {
        if (mode === 'stop' && c.sleeping) {
          // A stop-mode yield also stops a pause-mode sleeper (a paused process still holds its VRAM).
          // Starting it here would leave it running, holding that VRAM, while its row says sleeping.
          // It stays stopped instead, and its wake path starts it on demand, as legacyResumeAll does.
          // It is reported as skipped, not failed, so the journal row is still cleared.
          out.skipped.push({ name: c.name, reason: 'sleeping' });
        } else if (mode === 'stop') {
          await withTimeout(container.start(), START_TIMEOUT_MS, `start ${c.name}`);
          out.resumed.push(c.name);
        } else {
          // Pause mode never stops anything: someone else stopped it, so it stays stopped.
          out.skipped.push({ name: c.name, reason: 'exited since the yield' });
        }
      } else if (c.state !== 'running') {
        out.skipped.push({ name: c.name, reason: `state ${c.state}` });
      }
    } catch (err) {
      const code = statusCodeOf(err);
      if (code === 404) { out.gone.push(c.name); continue; }
      // 304 already started / 409 not paused any more: it is running, which is the goal.
      if (code === 304 || code === 409) continue;
      out.errors.push(`${c.name}: ${errMessage(err)}`);
      out.failedEntries.push(c.entry);
    }
  }
  return out;
}

/**
 * The previous version's boot behaviour, once (first boot of this version): it resumed every
 * Opportunistic stack blindly because it had no journal. `mode` is the stack's coalesced yieldMode,
 * because that boot ran `compose unpause` for a pause-mode stack (unpause only: a container someone
 * stopped by hand stayed stopped) and `compose start` for a stop-mode one. Skips `compose run`
 * one-offs as both commands did, and excluded, infra/self and sleeping containers. Throws when
 * the containers cannot be listed (engine unreachable), so the caller can tell "not done" from
 * "done with per-container errors".
 */
async function legacyResumeAll(stack: StackRef, mode: PowerMode): Promise<{ resumed: string[]; skipped: Array<{ name: string; reason: string }>; errors: string[] }> {
  const resumed: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const errors: string[] = [];
  const list = await listStackContainers(stack);
  const docker = await dockerService.forEngine(stack.engineId);
  for (const c of startOrder(list)) {
    // Left over by `compose run` without --rm (a benchmark, a migration): starting it would re-run
    // its command. The `compose start` / `compose unpause` of the old boot never touched them.
    if (c.oneoff) continue;
    if (c.protectedReason) { skipped.push({ name: c.name, reason: c.protectedReason }); continue; }
    // The sleep feature stopped it on purpose; its wake path starts it on demand.
    if (c.sleeping) { skipped.push({ name: c.name, reason: 'sleeping' }); continue; }
    const container = docker.getContainer(c.fullId);
    try {
      if (c.state === 'paused') {
        await withTimeout(container.unpause(), PAUSE_TIMEOUT_MS, `unpause ${c.name}`);
        resumed.push(c.name);
      } else if (c.state === 'exited' || c.state === 'created') {
        if (mode === 'stop') {
          await withTimeout(container.start(), START_TIMEOUT_MS, `start ${c.name}`);
          resumed.push(c.name);
        } else {
          // The old pause-mode yield never stopped anything, so this one was stopped by someone else
          // (e.g. `docker stop` to free a GPU before the upgrade): it stays stopped.
          skipped.push({ name: c.name, reason: `${c.state} (pause mode never started containers)` });
        }
      }
    } catch (err) {
      const code = statusCodeOf(err);
      if (code === 304 || code === 404 || code === 409) continue;
      errors.push(`${c.name}: ${errMessage(err)}`);
    }
  }
  return { resumed, skipped, errors };
}

export const stackPower = {
  listStackContainers,
  planYield,
  executeYield,
  resumeEntries,
  legacyResumeAll,
};

// ── Journal (priority_yields) ────────────────────────────────────────────────

interface YieldRowDb {
  stack_id: number;
  engine_id: number | null;
  mode: string;
  containers: unknown;
  reason: string | null;
  yielded_at: Date | string | null;
}

function parseEntries(raw: unknown): YieldJournalEntry[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const out: YieldJournalEntry[] = [];
  for (const item of value) {
    const e = item as { dockerId?: unknown; name?: unknown; service?: unknown } | null;
    if (!e || typeof e.dockerId !== 'string' || !e.dockerId || typeof e.name !== 'string') continue;
    out.push({ dockerId: e.dockerId, name: e.name, service: typeof e.service === 'string' ? e.service : null });
  }
  return out;
}

function rowFromDb(r: YieldRowDb): YieldJournalRow {
  const at = r.yielded_at instanceof Date ? r.yielded_at : (r.yielded_at ? new Date(r.yielded_at) : null);
  return {
    stackId: Number(r.stack_id),
    engineId: r.engine_id == null ? null : Number(r.engine_id),
    // An unknown mode resumes as 'stop', which also unpauses: nothing journalled is left behind.
    mode: r.mode === 'pause' ? 'pause' : 'stop',
    containers: parseEntries(r.containers),
    reason: r.reason ?? null,
    yieldedAt: at && !Number.isNaN(at.getTime()) ? at.toISOString() : new Date(0).toISOString(),
  };
}

export const yieldJournal = {
  async get(stackId: number): Promise<YieldJournalRow | null> {
    const row = await db('priority_yields').where({ stack_id: stackId }).first() as YieldRowDb | undefined;
    return row ? rowFromDb(row) : null;
  },

  /** Replaces the stack's row (upsert on stack_id) and refreshes yielded_at. */
  async put(row: Omit<YieldJournalRow, 'yieldedAt'>): Promise<void> {
    const reason = row.reason == null ? null : row.reason.substring(0, JOURNAL_REASON_MAX);
    await db('priority_yields')
      .insert({
        stack_id: row.stackId,
        engine_id: row.engineId,
        mode: row.mode,
        // pg would send a JS array as a Postgres array, not JSON.
        containers: JSON.stringify(row.containers),
        reason,
        yielded_at: new Date(),
      })
      .onConflict('stack_id')
      .merge(['engine_id', 'mode', 'containers', 'reason', 'yielded_at']);
  },

  async remove(stackId: number): Promise<void> {
    await db('priority_yields').where({ stack_id: stackId }).delete();
  },

  async all(): Promise<YieldJournalRow[]> {
    const rows = await db('priority_yields').select('*').orderBy('stack_id') as YieldRowDb[];
    return rows.map(rowFromDb);
  },
};
