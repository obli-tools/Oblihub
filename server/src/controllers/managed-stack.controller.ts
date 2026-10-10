import type { Request, Response, NextFunction } from 'express';
import {
  managedStackService,
  assertNoProjectConflict,
  assertCallerMayManage,
  assertCallerMayTakeProject,
  assertLimitsCarryAccepted,
  claimStackRowForTeam,
} from '../services/managed-stack.service';
import { composeService } from '../services/compose.service';
import { dockerService } from '../services/docker.service';
import { sourceManagerService } from '../services/sourceManager.service';
import { volumeMigrationService } from '../services/volumeMigration.service';
import { stackVolumesService } from '../services/stackVolumes.service';
import { composeRunner, type ComposeRunResult, type ComposeTarget } from '../services/composeRunner.service';
import { engineFactsService } from '../services/engineFacts.service';
import { engineService } from '../services/engine.service';
import { stackService, limitsCarryAdjusted, type LimitsCarryAdjustments } from '../services/stack.service';
import { RESOURCES_OVERRIDE_FILE } from '../services/composeResources.service';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { toComposeProject } from '../utils/composeProject';
import { withTimeout } from '../utils/withTimeout';
import { isEngineMigrationRunning, beginEngineMigration, endEngineMigration } from '../state/engineMigrations';
import { revalidateSocketAccess, composeSubscriberIds } from '../socket';
import { hostPortRange, portCount, rangesOverlap } from '@oblihub/shared';
import type { ContainerPort, GeneratedComposeFile, ManagedStack, PortConflictResult, PortSpecInput } from '@oblihub/shared';

const BACKGROUND_COMPOSE_MESSAGE = 'Oblihub is applying resource limits to this stack in the background — retry in a few seconds.';
const PROJECT_HELD_MESSAGE = 'Another compose command or source update is running on this stack — retry when it has finished.';
/** Start of the delete refusal after a failed down. The client matches it to offer `?force=true`. */
const DOWN_FAILED_PREFIX = 'docker compose down failed';
const MIGRATING_MESSAGE = 'An engine migration is running on this stack — retry when it has finished.';
const DEPLOYING_MESSAGE = 'A deploy is running on the stack\'s current engine, or was interrupted: wait for it to finish, or Cancel it, then move or rename the stack.';
const MOVED_MEANWHILE_MESSAGE = 'The stack was moved or renamed meanwhile — reload it and retry.';
/** Bound on the delete's "is anything of the project left on the engine" listing. */
const ENGINE_LIST_TIMEOUT_MS = 10_000;

/** See state/engineMigrations.ts: a hold never refuses UI stream runs, this does. */
function assertNotMigrating(managedStackId: number): void {
  if (isEngineMigrationRunning(managedStackId)) throw new AppError(409, MIGRATING_MESSAGE);
}

/**
 * A background resources apply (quiet compose run) holds the stack's lock. The runner would
 * refuse the stream run anyway, but only asynchronously (a failed deploy in the log) — checking
 * here first gives the operator a clean HTTP 409 before any status change. An engine migration is
 * refused the same way (see state/engineMigrations.ts).
 */
async function assertNoBackgroundCompose(stack: ManagedStack): Promise<void> {
  assertNotMigrating(stack.id);
  const target = await composeRunner.resolveTarget({ managedStackId: stack.id });
  if (target && composeRunner.isQuietBusy(target.daemonKey, target.projectName)) {
    throw new AppError(409, BACKGROUND_COMPOSE_MESSAGE);
  }
}

/** The quiet run can still grab the lock between the pre-check and the command (tiny window):
 *  the runner then refuses without running anything, which is a 409, not a failure of the stack. */
function throwIfRefused(result: Pick<ComposeRunResult, 'refused'>): void {
  if (result.refused) throw new AppError(409, BACKGROUND_COMPOSE_MESSAGE);
}

/**
 * Runs a rewrite of the stack's tree outside any compose command (git fetch + reset/checkout, zip
 * wipe + extract, clone) under the runner's daemonKey:project hold, as GitPollWorker does. A quiet
 * resources apply (a Save or a deferred apply on watchdog resume) refuses as busy while the hold
 * exists, so it never runs compose on a half-rewritten tree — assertNoBackgroundCompose only covers
 * the instant before the rewrite. Stream runs started inside `fn` (the redeploy) still run. 409 when
 * any run already holds the lock. No target (no managed row, unsafe folder): no compose run can lock
 * the project either, so `fn` runs as before.
 */
async function withProjectHold<T>(managedStackId: number, fn: () => Promise<T>): Promise<T> {
  assertNotMigrating(managedStackId);
  const target = await composeRunner.resolveTarget({ managedStackId });
  if (!target) return fn();
  return holdOrRefuse(target, fn);
}

/** composeRunner.holdProject, with a refused hold (fn not called) turned into an HTTP 409. */
async function holdOrRefuse<T>(target: ComposeTarget, fn: () => Promise<T>): Promise<T> {
  const outcome = await composeRunner.holdProject(target, () => fn());
  if (!outcome.held) {
    throw new AppError(409, composeRunner.isQuietBusy(target.daemonKey, target.projectName)
      ? BACKGROUND_COMPOSE_MESSAGE
      : PROJECT_HELD_MESSAGE);
  }
  return outcome.value;
}

/**
 * The end of a compose stderr, for an error message. Compose prints its progress first (pulls,
 * creates) and the error last, so the start of a long stderr says nothing about why it failed.
 */
function stderrTail(stderr: string, max = 1500): string {
  const s = stderr.trim();
  return s.length > max ? `…${s.slice(-max)}` : s;
}

/**
 * Re-reads the stack under the source lock before it is moved to another daemon or project. A deploy
 * resolves its daemon and project once, when its `up` starts: an engine_id or name change landing
 * during the `up` (image pulls included) would leave the containers on the old daemon or project
 * while the record, then marked 'deployed', names the new one. 'deploying' also covers the instants
 * before the deploy takes its hold, and a deploy interrupted by a restart (Cancel resets it).
 */
async function assertStillMovable(id: number, expected: { composeProject: string; engineId: number | null }): Promise<ManagedStack> {
  const current = await managedStackService.getById(id);
  if (!current) throw new AppError(404, 'Stack not found');
  if ((current.engineId ?? null) !== (expected.engineId ?? null) || current.composeProject !== expected.composeProject) {
    throw new AppError(409, MOVED_MEANWHILE_MESSAGE);
  }
  if (current.status === 'deploying') throw new AppError(409, DEPLOYING_MESSAGE);
  return current;
}

/**
 * Runs a move of the stack to another daemon or project that runs no compose command itself (a
 * just-save, a PUT that renames or re-targets it). Claimed as a migration, so deploy, redeploy, pull
 * and the git poll refuse meanwhile (a hold never refuses UI stream runs), and under the source
 * daemonKey:project hold, which refuses while any run (a deploy's `up` included) or hold owns the
 * project. `fn` gets the row re-read under both (assertStillMovable).
 */
async function underMoveGuard<T>(
  id: number,
  expected: { composeProject: string; engineId: number | null },
  fn: (current: ManagedStack) => Promise<T>,
): Promise<T> {
  if (!beginEngineMigration(id)) throw new AppError(409, MIGRATING_MESSAGE);
  try {
    const sourceLock = await composeRunner.resolveTarget({ managedStackId: id });
    const run = async (): Promise<T> => fn(await assertStillMovable(id, expected));
    return await (sourceLock ? holdOrRefuse(sourceLock, run) : run());
  } finally {
    endEngineMigration(id);
  }
}

/**
 * A move or rename that slipped in between a deploy's checks and its `up` (the tiny window
 * underMoveGuard cannot close: the deploy passed assertNotMigrating before the move claimed the
 * stack) leaves the containers on a daemon or project the record no longer names. 'deployed' would
 * then claim containers nothing tracks; the returned message makes the stack 'error' instead.
 */
async function movedDuringDeploy(stack: ManagedStack): Promise<string | null> {
  try {
    const current = await managedStackService.getById(stack.id);
    if (!current) return null;
    const sameDaemon = (await engineFactsService.managedDaemonKey(current.engineId ?? null))
      === (await engineFactsService.managedDaemonKey(stack.engineId ?? null));
    if (sameDaemon && current.composeProject === stack.composeProject) return null;
    return `The stack was moved to another engine or renamed while this deploy ran: its containers came up as "${stack.composeProject}" on the previous engine, which this stack no longer tracks. Take them down there by hand, then deploy again.`;
  } catch (err) {
    // Only a safety net for a rare race: a failed read must not turn a successful deploy into 'error'.
    logger.warn({ projectName: stack.composeProject, err }, 'Could not check whether the stack moved during its deploy');
    return null;
  }
}

/**
 * The target engine's stacks row as it was just before migrateEngine carried the limits to it,
 * as the carry itself reports it: a separate snapshot could read another state than the one the
 * carry overwrote.
 */
interface TargetCarry {
  toStackId: number;
  /** Concrete engine id of that row (a NULL target engine is the local one). */
  engineId: number;
  /** No (project, target engine) row existed: the carry inserted it. */
  created: boolean;
  /** The row's resource_limits before the carry (null when it had none); unused when `created`. */
  previousLimits: unknown;
}

/**
 * Takes back what a failed migration's carry wrote on the target. Discovery keeps an empty row
 * that carries limits for good and the managed DELETE only clears the stack's own daemon, so a row
 * left there would be a ghost on the target engine, and a later same-named project there would
 * silently inherit its priority, yield links and GPU restriction. A row the carry created is deleted:
 * after a successful target `down` (`targetDowned`) its container rows, if discovery saw the failed
 * `up`, describe containers that are gone; otherwise nothing ran there and only an empty row goes.
 * A row that already existed gets its own limits back. Best-effort: logged, never thrown.
 */
async function undoTargetCarry(projectName: string, carry: TargetCarry, targetDowned: boolean): Promise<void> {
  try {
    if (carry.created) {
      await stackService.deleteRowsForProject(projectName, [carry.engineId], { onlyEmpty: !targetDowned });
    } else {
      const { db } = await import('../db');
      await db('stacks').where({ id: carry.toStackId }).update({
        resource_limits: carry.previousLimits == null ? null : JSON.stringify(carry.previousLimits),
        updated_at: new Date(),
      });
    }
  } catch (err) {
    logger.warn({ projectName, carry, err }, 'Failed migration: the limits carried to the target engine could not be taken back, its stack row may linger there');
  }
}

/**
 * A failed engine migration after the source `down` must not leave the stack stopped on both
 * engines. Whatever the failed `up` started on the target is taken down first (two live copies
 * would both serve, and after migrate-data both would write their own copy of the data), the stack
 * is pointed back at the source engine (the runner only finds a managed stack on its own daemon)
 * and redeployed there. The source volumes were only read by the migration, so they are intact.
 * Best-effort and never throws: returns a sentence for the error message, saying where the stack is,
 * and `restored` (the source deploy exited 0) so the caller records a stack that runs again as
 * running rather than 'error'. The target stacks row the limits were carried to is undone once
 * nothing of the stack runs there (see undoTargetCarry); a target `down` that failed leaves it, so
 * live containers keep their caps. That failure is part of the returned text: once the record
 * points back at the source, nothing in Oblihub would ever take those containers down.
 * `mirrorTo`: the editor sockets the migration's target deploy was mirrored to. They get the target
 * `down` and the source redeploy too, whichever room revalidateSocketAccess has them in by then.
 */
async function restoreOnSource(
  stack: ManagedStack,
  sourceEngineId: number | null,
  targetEngineId: number | null,
  engineSwitched: boolean,
  targetCarry: TargetCarry | null,
  mirrorTo: string[] = [],
): Promise<{ restored: boolean; text: string }> {
  const projectName = stack.composeProject;
  // Why the target `down` failed, when it did (set before anything below can throw).
  let targetDownFailure: string | null = null;
  const leftOnTarget = (): string => (targetDownFailure == null ? '' :
    ` Taking it down on the target engine failed (${targetDownFailure}): containers may still be running there. Remove them by hand.`);
  try {
    if (engineSwitched) {
      let targetClear = false;
      try {
        const targetDown = await composeService.down(projectName, false, targetEngineId, { mirrorTo });
        if (targetDown.exitCode !== 0) {
          targetDownFailure = stderrTail(targetDown.stderr, 500) || `exit code ${targetDown.exitCode}`;
          logger.error({ projectName, targetEngineId, stderr: stderrTail(targetDown.stderr) }, 'Failed migration: down on the target engine failed, containers may be left there');
        } else {
          targetClear = true;
        }
      } catch (err) {
        targetDownFailure = err instanceof Error ? err.message : String(err);
        logger.error({ projectName, targetEngineId, err }, 'Failed migration: down on the target engine failed, containers may be left there');
      }
      if (targetCarry && targetClear) await undoTargetCarry(projectName, targetCarry, true);
      const { db } = await import('../db');
      await db('managed_stacks').where({ id: stack.id }).update({ engine_id: sourceEngineId, updated_at: new Date() });
      // The compose room follows engine_id: subscribers go back to the source room.
      void revalidateSocketAccess();
    } else if (targetCarry) {
      // Failed after the carry but before the switch: nothing was started on the target.
      await undoTargetCarry(projectName, targetCarry, false);
    }
    const result = await composeService.deploy(projectName, stack.composeContent, stack.envContent, sourceEngineId, { mirrorTo });
    if (result.exitCode === 0) {
      logger.info({ projectName, sourceEngineId, targetEngineId }, 'Failed migration: stack redeployed on the source engine');
      return { restored: true, text: `The stack was redeployed on the source engine.${leftOnTarget()}` };
    }
    logger.error({ projectName, sourceEngineId, stderr: stderrTail(result.stderr) }, 'Failed migration: redeploy on the source engine failed too');
    // The stderr rarely ends with a full stop: the appended sentence needs one before it.
    const stderr = stderrTail(result.stderr, 500);
    const tail = leftOnTarget();
    return { restored: false, text: `Redeploying it on the source engine failed too, so it is stopped: ${stderr}${tail && !/[.!?]$/.test(stderr) ? '.' : ''}${tail}` };
  } catch (err) {
    logger.error({ projectName, sourceEngineId, targetEngineId, err }, 'Failed migration: the stack could not be restored on the source engine');
    return { restored: false, text: `It could not be redeployed on the source engine either (${err instanceof Error ? err.message : String(err)}), so it is stopped.${leftOnTarget()}` };
  }
}

/**
 * gitPull's redeploy, run after the HTTP answer but still inside the pull's project hold. Never
 * throws: the request has already been answered.
 */
async function redeployAfterPull(stack: ManagedStack, userId: number | null): Promise<void> {
  const id = stack.id;
  const history = {
    managedStackId: id, sourceType: stack.sourceType, gitUrl: stack.gitUrl, gitBranch: stack.gitBranch,
    gitRef: stack.gitRef, composePath: stack.composePath, buildEnabled: stack.buildEnabled, deployedByUserId: userId,
  };
  try {
    const result = await composeService.redeploy(stack.composeProject, stack.composeContent, stack.envContent, stack.engineId);
    if (result.refused || result.busy) {
      // Not expected under the hold (a quiet run cannot start while it exists); kept for the
      // no-target path. Nothing was recreated, so the stack is not 'error': it keeps its status
      // (read before 'deploying') and no failed history row is written, as in GitPollWorker.
      await managedStackService.setStatus(id, stack.status, `Pulled ${stack.gitRef ?? 'the latest commit'}, but the redeploy was refused: ${result.stderr} Redeploy to apply it.`);
      logger.info({ projectName: stack.composeProject, to: stack.gitRef }, 'Manual pull redeploy refused by a background compose run');
      return;
    }
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    await managedStackService.setStatus(id, result.exitCode === 0 ? 'deployed' : 'error', output || null);
    await managedStackService.recordDeployHistory({ ...history, success: result.exitCode === 0, notes: 'Manual pull + redeploy' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    try {
      await managedStackService.setStatus(id, 'error', msg);
    } catch (statusErr) {
      logger.warn({ projectName: stack.composeProject, err: statusErr }, 'Pull + redeploy failed and its status could not be recorded');
    }
    await managedStackService.recordDeployHistory({ ...history, success: false, notes: `Pull+redeploy failed: ${msg}` });
  }
}

/** One stored discovery row as the port-conflict check needs it. */
export interface PortConflictRow {
  containerId: number;
  containerName: string;
  stackName: string | null;
  composeProject: string | null;
  ports: ContainerPort[];
}

/**
 * Pure: which requested host-port segments collide with ports stored for an engine's containers.
 * Stored entries may be compacted ranges (`count`), so overlap is range-based; a request without a
 * protocol (legacy single ports) conflicts with any protocol. Exported for the check script.
 */
export function computePortConflicts(
  requested: PortSpecInput[],
  rows: PortConflictRow[],
  excludeComposeProject: string | null,
): PortConflictResult[] {
  const out: PortConflictResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    // The stack being edited does not conflict with itself, even though its containers will be
    // recreated by the redeploy.
    if (excludeComposeProject && row.composeProject === excludeComposeProject) continue;
    for (const p of row.ports ?? []) {
      if (!p || typeof p.hostPort !== 'number') continue;
      const hostRange = hostPortRange(p);
      if (!hostRange) continue;
      const protocol = (p.protocol || 'tcp').toLowerCase();
      for (const req of requested) {
        const reqEnd = req.end ?? req.start;
        if (!rangesOverlap(req.start, reqEnd, hostRange[0], hostRange[1])) continue;
        if (req.protocol && req.protocol.toLowerCase() !== protocol) continue;
        const conflict: PortConflictResult = {
          port: Math.max(req.start, hostRange[0]),
          range: portCount(p) > 1 ? hostRange : null,
          protocol,
          stackName: row.stackName ?? null,
          containerName: row.containerName,
          containerId: row.containerId,
        };
        const key = JSON.stringify(conflict);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(conflict);
      }
    }
  }
  return out;
}

/**
 * A conflict as sent to the caller: names and id are null for a container the caller's teams cannot
 * see (the editor then says "port in use by another stack"). Widened here so the controller does not
 * depend on the shared PortConflictResult already allowing null.
 */
export type VisiblePortConflict = Omit<PortConflictResult, 'containerName' | 'containerId'> & {
  containerName: string | null;
  containerId: number | null;
};

/**
 * Pure: keeps port, range and protocol of every conflict (pre-deploy validation still needs them)
 * but drops stack and container names of containers not in `visibleContainerIds`, so a user sees
 * which ports are taken on an engine without learning what other teams run there. Redacted entries
 * that became identical are merged. Exported for the check script.
 */
export function redactPortConflicts(conflicts: PortConflictResult[], visibleContainerIds: ReadonlySet<number>): VisiblePortConflict[] {
  const out: VisiblePortConflict[] = [];
  const seen = new Set<string>();
  for (const c of conflicts) {
    const v: VisiblePortConflict = c.containerId != null && visibleContainerIds.has(c.containerId)
      ? c
      : { ...c, stackName: null, containerName: null, containerId: null };
    const key = JSON.stringify(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

const MAX_PORT_SPECS = 1000;
const PORT_PROTOCOLS = new Set(['tcp', 'udp', 'sctp']);

function isPortNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** Validates the body's `portSpecs` (400 on any invalid entry, unlike legacy `ports`, which are filtered). */
function parsePortSpecs(raw: unknown): PortSpecInput[] {
  if (!Array.isArray(raw)) throw new AppError(400, 'portSpecs must be an array');
  if (raw.length > MAX_PORT_SPECS) throw new AppError(400, `Too many port specs (max ${MAX_PORT_SPECS})`);
  return raw.map((item, i) => {
    const o = (item && typeof item === 'object' ? item : {}) as { start?: unknown; end?: unknown; protocol?: unknown };
    if (!isPortNumber(o.start)) throw new AppError(400, `portSpecs[${i}].start must be an integer between 1 and 65535`);
    const end = o.end ?? o.start;
    if (!isPortNumber(end) || end < o.start) throw new AppError(400, `portSpecs[${i}].end must be an integer between start and 65535`);
    let protocol: PortSpecInput['protocol'];
    if (o.protocol != null) {
      const proto = typeof o.protocol === 'string' ? o.protocol.toLowerCase() : '';
      if (!PORT_PROTOCOLS.has(proto)) throw new AppError(400, `portSpecs[${i}].protocol must be tcp, udp or sctp`);
      protocol = proto as PortSpecInput['protocol'];
    }
    return { start: o.start, end, ...(protocol ? { protocol } : {}) };
  });
}

function parseStoredPorts(raw: unknown): ContainerPort[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v as ContainerPort[] : [];
  } catch { return []; /* malformed row: no ports */ }
}

// Precise check (own container's compose label) on purpose: it decides deploy-via-helper, which
// copies the stack's compose over Oblihub's own compose file. The broad self-project set used for
// refusals could match another stack and must never drive that decision.
async function isSelfStack(stack: { composeProject: string; engineId: number | null }): Promise<boolean> {
  try {
    // The helper always acts on the local socket and the hub's own compose dir: a same-named stack
    // on a remote daemon is an ordinary stack there, and routing it to the helper would overwrite
    // and recreate the hub's own Oblihub instead.
    if (await engineFactsService.managedDaemonKey(stack.engineId ?? null) !== 'local') return false;
    const selfId = dockerService.getSelfContainerId();
    if (!selfId) return false;
    const info = await dockerService.inspectContainer(selfId);
    return (info.Config?.Labels?.['com.docker.compose.project'] || null) === stack.composeProject;
  } catch { return false; }
}

export const managedStackController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const session = req.session as { userId?: number; role?: string };
      const allStacks = await managedStackService.getAll();
      if (session.role === 'admin') {
        res.json({ success: true, data: allStacks });
        return;
      }
      // Filter by team access
      const { teamService } = await import('../services/team.service');
      const teams = await teamService.getTeamsForUser(session.userId!);
      if (teams.length === 0) { res.json({ success: true, data: [] }); return; }
      if (teams.some(t => t.allResources)) { res.json({ success: true, data: allStacks }); return; }
      const accessibleIds = [...new Set(teams.flatMap(t => t.resources
        .filter(r => r.resourceType === 'stack' && !r.excluded)
        .map(r => r.resourceId)))];
      if (accessibleIds.length === 0) { res.json({ success: true, data: [] }); return; }
      const { db } = await import('../db');
      const rows = await db('stacks').whereIn('id', accessibleIds).whereNotNull('compose_project')
        .select('compose_project', 'engine_id') as Array<{ compose_project: string; engine_id: number | null }>;
      // A project name is only unique per daemon: a team's row of "app" on one engine says nothing
      // about a managed "app" on another, and the per-id guard (managed-stacks.routes.ts) would
      // refuse that one anyway. Matched as the guard does: rows of the stack's daemon, NULL-engine
      // rows only when the stack's own row is keyed on NULL (no local engine row exists).
      const localEngineId = await engineFactsService.resolveLocalEngineId();
      const filtered: ManagedStack[] = [];
      for (const s of allStacks) {
        const candidates = rows.filter(r => r.compose_project === s.composeProject);
        if (candidates.length === 0) continue;
        const daemonIds = await engineFactsService.daemonEngineIds(s.engineId);
        const includeNullRows = (s.engineId ?? localEngineId) == null;
        if (candidates.some(r => (r.engine_id == null ? includeNullRows : daemonIds.includes(Number(r.engine_id))))) {
          filtered.push(s);
        }
      }
      res.json({ success: true, data: filtered });
    } catch (err) { next(err); }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');
      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled. Set ALLOW_STACK=true to enable.');
      const session = req.session as { userId?: number; role?: string };
      const { name, composeContent, envContent, teamId, engineId, registryCredentials, gitUsername, gitToken, composePath, buildEnabled, pollGitIntervalS } = req.body;
      if (!name || !composeContent) throw new AppError(400, 'Name and compose content are required');

      // Non-admin must have a team to create a stack
      if (session.role !== 'admin') {
        const { teamService } = await import('../services/team.service');
        const userTeams = await teamService.getTeamsForUser(session.userId!);
        if (userTeams.length === 0) throw new AppError(403, 'You must be in a team to create stacks');

        // Auto-assign to first team if no teamId specified, or validate the teamId
        const targetTeamId = teamId || userTeams[0].id;
        const isInTeam = userTeams.some(t => t.id === targetTeamId);
        if (!isInTeam) throw new AppError(403, 'You are not a member of this team');

        // Everything below is checked BEFORE create, so a refusal leaves no managed stack behind.
        if (engineId != null && !Number.isInteger(engineId)) throw new AppError(400, 'engineId must be an integer or null');
        // Naming a managed stack after Oblihub's own project, or after a project that already runs
        // on this daemon (another team's stack, a hand-deployed one), must not hand its stacks row
        // to the caller's team: team access to that row opens every container of it (inspect shows
        // the env, secrets included). The managed-name check in create() never sees such projects,
        // as they are not managed. Same guard as a rename or an engine move.
        await assertCallerMayTakeProject(session, toComposeProject(name), engineId ?? null);

        const stack = await managedStackService.create({ name, composeContent, envContent, engineId, registryCredentials, gitUsername, gitToken, composePath, buildEnabled, pollGitIntervalS });
        // Ensure the stack exists in the stacks table and assign it to the team (see the helper).
        await claimStackRowForTeam(stack, targetTeamId);

        res.json({ success: true, data: stack });
        return;
      }

      const stack = await managedStackService.create({ name, composeContent, envContent, engineId, registryCredentials, gitUsername, gitToken, composePath, buildEnabled, pollGitIntervalS });
      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const { name, composeContent, envContent, engineId, registryCredentials, gitUsername, gitToken, composePath, buildEnabled, pollGitIntervalS, gpuPolicy } = req.body;
      // Same contract as migrateEngine: 'revoke' accepts that a move to another daemon drops GPU
      // ids / VRAM caps naming cards of the source host; anything else is a client bug.
      if (gpuPolicy !== undefined && gpuPolicy !== 'revoke') throw new AppError(400, 'Invalid gpuPolicy');
      // A save can move the stack to another engine (and carry its limits) under a running
      // migration, which flips engine_id itself and deploys the row it re-reads.
      assertNotMigrating(id);
      const save = () => managedStackService.updateWithLimitsCarry(
        id,
        { name, composeContent, envContent, engineId, registryCredentials, gitUsername, gitToken, composePath, buildEnabled, pollGitIntervalS },
        { caller: req.session as { userId?: number; role?: string }, gpuPolicy },
      );
      // Keyed on a real change of project or daemon, not on the fields being present: the editor
      // sends name and engineId on every save (saveAndMoveEngine's pre-save with the old engine
      // included), and those must keep working during a deploy.
      let moves = false;
      const stored = name !== undefined || engineId !== undefined ? await managedStackService.getById(id) : null;
      if (stored) {
        // A non-string name is left to the service, which rejects it as before.
        const renamed = typeof name === 'string' && toComposeProject(name) !== stored.composeProject;
        const crossDaemon = engineId !== undefined
          && (await engineFactsService.managedDaemonKey(engineId ?? null)) !== (await engineFactsService.managedDaemonKey(stored.engineId ?? null));
        moves = renamed || crossDaemon;
      }
      // Same guard as migrateEngine's just-save: a rename or a move landing during a deploy's `up`
      // would leave its containers on the old project/daemon under a record naming the new one.
      const result = moves && stored
        ? await underMoveGuard(id, { composeProject: stored.composeProject, engineId: stored.engineId ?? null }, () => save())
        : await save();
      if (!result) throw new AppError(404, 'Managed stack not found');
      // A rename or a move re-keys the stack's compose room: subscribers follow it now, and the old
      // (daemon, project) room, whose name another stack may take, is left at once.
      if (name !== undefined || engineId !== undefined) await revalidateSocketAccess();
      // limitsAdjusted at the top level: the editor stores `data` as the stack (setStack), and this
      // is a report of the save, not a field of the stack.
      res.json({ success: true, data: result.stack, limitsAdjusted: result.limitsAdjusted });
    } catch (err) { next(err); }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');
      // A migration flips engine_id mid-way: the down below would reach whichever engine the row
      // named when it was read, and the files and row would be removed under the migration.
      assertNotMigrating(id);
      // `?forEngine=<id|null>` — sent by a discovered stack's page, which finds its managed stack
      // by project name only. Several engines can run a project with the same name, so a delete
      // aimed at another daemon's stack must not down or remove this one (null and 'local'-type
      // rows are the same daemon). Checked before anything runs, whatever `volumes` says.
      if (typeof req.query.forEngine === 'string') {
        let forEngine: number | null = null;
        if (req.query.forEngine !== 'null') {
          const parsed = Number(req.query.forEngine);
          if (!Number.isInteger(parsed)) throw new AppError(400, 'Invalid forEngine');
          forEngine = parsed;
        }
        if (await engineFactsService.managedDaemonKey(forEngine) !== await engineFactsService.managedDaemonKey(stack.engineId ?? null)) {
          throw new AppError(409, 'This managed stack runs on another engine; nothing was changed');
        }
      }
      if (await isSelfStack(stack)) throw new AppError(403, 'Cannot delete Oblihub\'s own stack');
      // `?volumes=true` → also wipe the named volumes (DESTRUCTIVE: deletes all data the stack
      // wrote to its volumes). Defaults to false so an accidental click doesn't nuke a database.
      const removeVolumes = req.query.volumes === 'true';
      const hasVolumeData = stack.volumePlacements.some(p => p.mode === 'bind');
      // Everything from the down to the row delete runs under the project hold, whatever the status:
      // holdProject refuses (409) while any run or hold owns the project, not only a quiet one, so
      // the down never races a redeploy's `pull`, a deploy's `up`, a git poll, a rollback or a pull,
      // nor removes their files and managed row under them. Held, a git poll or a quiet apply cannot
      // start meanwhile either.
      const lock = await composeRunner.resolveTarget({ managedStackId: id });
      const removeStack = async () => {
        // Any status but 'draft' may have containers: 'deploying' (a redeploy's old containers, a
        // deploy interrupted by a restart), 'error' (a cancelled or partly failed `up`), 'stopped'
        // (a `stop` keeps them). A draft was never deployed, so its down would only ever reach a
        // same-named project nobody deployed from here; `?volumes=true` still runs `down -v` to GC
        // volumes left from a previous deploy.
        const mayHaveContainers = stack.status !== 'draft';
        const downResult = mayHaveContainers || removeVolumes
          ? await composeService.down(stack.composeProject, removeVolumes, stack.engineId)
          : null;
        // Deleting the files while a background apply recreates the containers would strand them.
        if (downResult) throwIfRefused(downResult);
        // A failed down (disabled or unreachable engine, compose error) leaves the containers running:
        // deleting the stack now would lose the compose files and the only record that it is managed.
        // The stderr says why (a disabled engine names itself), so the operator can fix it and retry.
        // `?force=true` deletes anyway — the way to empty a dead engine before engineService.delete.
        const containersLeftRunning = mayHaveContainers && downResult != null && downResult.exitCode !== 0;
        if (containersLeftRunning && req.query.force !== 'true') {
          throw new AppError(409, `${DOWN_FAILED_PREFIX} — the stack was NOT deleted and its containers may still be running. ${downResult!.stderr.slice(0, 500)}`);
        }
        // Volume data under <stacksDir>/.volumes survives `down -v` (Docker only drops the volume
        // reference) — delete it ourselves, but only once the containers and volumes are gone.
        const keptVolumeData = removeVolumes ? [] as string[] : stack.volumePlacements.flatMap(p => p.hostPath ? [p.hostPath] : []);
        if (removeVolumes && hasVolumeData) {
          if (!downResult || downResult.exitCode !== 0) {
            throw new AppError(500, `docker compose down -v failed — nothing was deleted and the volume data is intact. ${(downResult?.stderr || '').slice(0, 500)}`);
          }
          // Containers are gone whatever purgeData does next.
          await managedStackService.setStatus(id, 'stopped');
          const purge = await stackVolumesService.purgeData(id);
          if (purge.kept.length > 0) {
            // Deleting the row would drop the only record of those folders — keep the stack.
            throw new AppError(409, `Containers removed, but the stack was NOT deleted: these data folders are still used by another container or volume and were kept: ${purge.kept.join(', ')}. Free them, then delete again.`);
          }
        }
        // Same-name managed stacks on other engines (and legacy names that map to the same project,
        // e.g. "Ollama"/"ollama") share <stacksDir>/<project>: wiping it would take their compose file,
        // .env and zip/git sources with it — a zip-sourced build context exists nowhere else. Keep the
        // folder while another row still uses it.
        const { db } = await import('../db');
        let keptStackFiles = false;
        try {
          const sibling = await db('managed_stacks')
            .where({ compose_project: stack.composeProject })
            .whereNot({ id })
            .first('id');
          keptStackFiles = !!sibling;
        } catch (err) {
          // Unknown ownership: fail safe and keep the files rather than risk another stack's sources.
          keptStackFiles = true;
          logger.warn({ projectName: stack.composeProject, err }, 'Could not check for other stacks sharing the folder; keeping stack files');
        }
        if (keptStackFiles) {
          logger.warn({ projectName: stack.composeProject, id }, 'Stack folder kept: another managed stack uses the same compose project');
        } else {
          composeService.removeStackFiles(stack.composeProject);
        }
        await managedStackService.delete(id);
        // Drops the deleted stack's subscribers from its compose room now: a stack created next
        // with the same name on this daemon reuses the room, and must not reach them.
        await revalidateSocketAccess();
        return { downResult, containersLeftRunning, keptVolumeData, keptStackFiles };
      };
      // No target (unsafe folder name): no compose run can lock the project either.
      const { downResult, containersLeftRunning, keptVolumeData, keptStackFiles } = lock
        ? await holdOrRefuse(lock, removeStack)
        : await removeStack();

      // Discovery keeps empty stacks rows that carry resource limits (so limits survive a
      // down/deploy cycle) — without this the deleted stack would linger as a ghost row. After a
      // successful `down` its container rows describe containers that no longer exist, so every
      // row of the project on this daemon goes; otherwise only the empty ones (live containers,
      // if any, keep being tracked by discovery).
      let removedStackRows = 0;
      try {
        const engineIds = await engineFactsService.daemonEngineIds(stack.engineId);
        const downOk = downResult != null && downResult.exitCode === 0;
        // No down ran (a draft) or it failed (a forced delete): the containers table lags the engine
        // by up to one discovery pass, so stale container rows would skip the row, and discovery
        // would then keep the emptied row for its limits (a ghost row a later same-named project
        // inherits). Ask the engine instead; only a confirmed empty answer drops onlyEmpty,
        // a timeout, an error or an unknown engine keeps it (fail-safe).
        let engineConfirmedEmpty = false;
        if (!downOk) {
          try {
            const listEngineId = stack.engineId ?? await engineFactsService.resolveLocalEngineId();
            if (listEngineId != null) {
              const live = await withTimeout(dockerService.listProjectContainers(stack.composeProject, listEngineId), ENGINE_LIST_TIMEOUT_MS, `list ${stack.composeProject} containers`);
              engineConfirmedEmpty = live.length === 0;
            }
          } catch (err) {
            logger.warn({ projectName: stack.composeProject, engineId: stack.engineId, err }, 'Managed stack delete: could not list the project containers, only empty stack rows are removed');
          }
        }
        // Empty NULL-engine rows are pre-upgrade local drafts (see deleteRowsForProject): only a
        // stack on the local daemon can own them.
        const includeLegacyNullRows = (await engineFactsService.managedDaemonKey(stack.engineId ?? null)) === 'local';
        const removed = await stackService.deleteRowsForProject(stack.composeProject, engineIds, { ...(downOk || engineConfirmedEmpty ? {} : { onlyEmpty: true }), includeLegacyNullRows });
        removedStackRows = removed.length;
      } catch (err) {
        // The managed stack is already gone: report success and let the operator delete the
        // leftover row from the stack page rather than fail a delete that happened.
        logger.warn({ projectName: stack.composeProject, err }, 'Managed stack deleted, but its discovery rows could not be removed');
      }
      // Only a successful `down -v` removed volumes: a forced delete after a failed down (a direct
      // API caller can still send force with volumes=true) must not claim it did.
      const removedVolumes = removeVolumes && downResult != null && downResult.exitCode === 0;
      res.json({ success: true, data: { removedVolumes, keptVolumeData, removedStackRows, containersLeftRunning, keptStackFiles } });
    } catch (err) { next(err); }
  },

  async deploy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');

      // Safety: refuse to deploy empty/placeholder compose
      const content = stack.composeContent.trim();
      if (!content || !content.includes('image:') && !content.includes('build:')) {
        throw new AppError(400, 'Cannot deploy: compose file has no services with an image or build directive. Please define at least one valid service.');
      }

      await assertNoBackgroundCompose(stack);
      await managedStackService.setStatus(id, 'deploying');

      const selfStack = await isSelfStack(stack);
      if (selfStack) {
        // Self-deploy: hand off to helper container, return immediately — we're about to be recreated.
        res.json({ success: true, message: 'Self-stack deploy handed off to helper' });
        try {
          await composeService.deployViaHelper(stack.composeProject, stack.composeContent, stack.envContent, false);
          logger.info({ projectName: stack.composeProject }, 'Self-stack deploy helper launched');
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          await managedStackService.setStatus(id, 'error', `Self-deploy helper failed: ${msg}`);
          logger.error({ projectName: stack.composeProject, err }, 'Self-stack deploy helper error');
        }
        return;
      }

      res.json({ success: true, message: 'Deploy started' });

      // Run in background
      const sessionForDeploy = req.session as { userId?: number };
      (async () => {
        try {
          const result = await composeService.deploy(stack.composeProject, stack.composeContent, stack.envContent, stack.engineId);
          if (result.refused || result.busy) {
            // A quiet run took the lock after assertNoBackgroundCompose (tiny window): nothing ran,
            // so as in redeployAfterPull the stack keeps the status read before 'deploying' and no
            // failed history row is written.
            await managedStackService.setStatus(id, stack.status, `Deploy refused: ${result.stderr} Deploy again to apply it.`);
            logger.info({ projectName: stack.composeProject }, 'Manual deploy refused by a background compose run');
            return;
          }
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
          const moved = result.exitCode === 0 ? await movedDuringDeploy(stack) : null;
          if (result.exitCode !== 0) {
            await managedStackService.setStatus(id, 'error', output || 'Deploy failed');
            logger.error({ projectName: stack.composeProject, stderr: result.stderr }, 'Compose deploy failed');
          } else if (moved) {
            await managedStackService.setStatus(id, 'error', moved);
            logger.error({ projectName: stack.composeProject, engineId: stack.engineId }, 'Stack deployed, but moved or renamed during the deploy: its containers are untracked');
          } else {
            await managedStackService.setStatus(id, 'deployed', output || null);
            logger.info({ projectName: stack.composeProject }, 'Stack deployed');
          }
          await managedStackService.recordDeployHistory({
            managedStackId: id,
            sourceType: stack.sourceType,
            gitUrl: stack.gitUrl,
            gitBranch: stack.gitBranch,
            gitRef: stack.gitRef,
            composePath: stack.composePath,
            buildEnabled: stack.buildEnabled,
            success: result.exitCode === 0,
            notes: 'Manual deploy',
            deployedByUserId: sessionForDeploy.userId ?? null,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          await managedStackService.setStatus(id, 'error', msg);
          logger.error({ projectName: stack.composeProject, err }, 'Compose deploy error');
          await managedStackService.recordDeployHistory({
            managedStackId: id, sourceType: stack.sourceType, gitUrl: stack.gitUrl, gitBranch: stack.gitBranch,
            gitRef: stack.gitRef, composePath: stack.composePath, buildEnabled: stack.buildEnabled,
            success: false, notes: `Failed: ${msg}`, deployedByUserId: sessionForDeploy.userId ?? null,
          });
        }
      })();
    } catch (err) { next(err); }
  },

  async stop(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');
      if (await isSelfStack(stack)) throw new AppError(403, 'Cannot stop Oblihub\'s own stack');

      await assertNoBackgroundCompose(stack);
      const result = await composeService.stop(stack.composeProject, stack.engineId);
      throwIfRefused(result);
      if (result.exitCode !== 0) {
        await managedStackService.setStatus(id, 'error', result.stderr);
        throw new AppError(500, result.stderr || 'Stop failed');
      }
      await managedStackService.setStatus(id, 'stopped');
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async down(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');
      if (await isSelfStack(stack)) throw new AppError(403, 'Cannot down Oblihub\'s own stack');

      const removeVolumes = req.query.volumes === 'true';
      await assertNoBackgroundCompose(stack);
      const result = await composeService.down(stack.composeProject, removeVolumes, stack.engineId);
      throwIfRefused(result);
      if (result.exitCode !== 0) {
        await managedStackService.setStatus(id, 'error', result.stderr);
        throw new AppError(500, result.stderr || 'Down failed');
      }
      await managedStackService.setStatus(id, 'stopped');
      // `down -v` only drops the Docker reference of volumes stored under .volumes — delete
      // their folders too so the next deploy really starts from empty volumes.
      const volumeData = removeVolumes ? await stackVolumesService.purgeData(id) : { removed: [], kept: [] };
      res.json({ success: true, data: { removedVolumeData: volumeData.removed, keptVolumeData: volumeData.kept } });
    } catch (err) { next(err); }
  },

  async pull(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');

      await assertNoBackgroundCompose(stack);
      // The file write happens outside any compose command: held, a quiet resources apply cannot
      // start between it and the pull and run compose on a half-written compose/.env.
      const result = await withProjectHold(id, async () => {
        // Ensure files exist on disk
        await composeService.writeStackFiles(stack.composeProject, stack.composeContent, stack.envContent);
        return composeService.pull(stack.composeProject, stack.engineId);
      });
      throwIfRefused(result);
      res.json({ success: true, data: { exitCode: result.exitCode, output: result.stdout + result.stderr } });
    } catch (err) { next(err); }
  },

  async cancel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');

      // Engine-aware: a project name is only unique per daemon, and only the stream run (the UI
      // deploy) is cancellable — a background resources apply is never killed halfway.
      const wasRunning = composeService.cancel(stack.composeProject, stack.engineId);
      // Always reset status — also unblocks stacks stuck in 'deploying' after a server restart mid-deploy.
      await managedStackService.setStatus(
        id,
        'error',
        wasRunning ? 'Cancelled by user' : 'Deploy status reset (no active process)',
      );

      logger.warn({ projectName: stack.composeProject, wasRunning }, 'Deploy cancelled');
      res.json({ success: true, data: { killed: wasRunning } });
    } catch (err) { next(err); }
  },

  async redeploy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');
      // Recreate = redeploy with `--force-recreate`: every container is recreated even when compose
      // sees nothing changed (same config, same image tag).
      const forceRecreate = (req.body as { forceRecreate?: unknown } | undefined)?.forceRecreate === true;
      const verb = forceRecreate ? 'Recreate' : 'Redeploy';

      const content = stack.composeContent.trim();
      if (!content || !content.includes('image:') && !content.includes('build:')) {
        throw new AppError(400, 'Cannot deploy: compose file has no valid services.');
      }

      const selfStack = await isSelfStack(stack);
      // The self-stack helper only runs a plain `up -d`: refuse rather than silently not force it.
      if (selfStack && forceRecreate) throw new AppError(400, 'Recreate is not available on the Oblihub stack itself: use Redeploy.');

      await assertNoBackgroundCompose(stack);
      await managedStackService.setStatus(id, 'deploying');

      if (selfStack) {
        res.json({ success: true, message: 'Self-stack redeploy handed off to helper' });
        try {
          await composeService.deployViaHelper(stack.composeProject, stack.composeContent, stack.envContent, true);
          logger.info({ projectName: stack.composeProject }, 'Self-stack redeploy helper launched');
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          await managedStackService.setStatus(id, 'error', `Self-redeploy helper failed: ${msg}`);
          logger.error({ projectName: stack.composeProject, err }, 'Self-stack redeploy helper error');
        }
        return;
      }

      res.json({ success: true, message: `${verb} started` });

      const sessionForRedeploy = req.session as { userId?: number };
      (async () => {
        try {
          const result = await composeService.redeploy(stack.composeProject, stack.composeContent, stack.envContent, stack.engineId, { forceRecreate });
          if (result.refused || result.busy) {
            // Same race as deploy(): nothing was recreated, so no 'error' and no failed history row.
            await managedStackService.setStatus(id, stack.status, `${verb} refused: ${result.stderr} ${verb} again to apply it.`);
            logger.info({ projectName: stack.composeProject, forceRecreate }, 'Manual redeploy refused by a background compose run');
            return;
          }
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
          const moved = result.exitCode === 0 ? await movedDuringDeploy(stack) : null;
          if (result.exitCode !== 0) {
            await managedStackService.setStatus(id, 'error', output || `${verb} failed`);
          } else if (moved) {
            await managedStackService.setStatus(id, 'error', moved);
            logger.error({ projectName: stack.composeProject, engineId: stack.engineId }, 'Stack redeployed, but moved or renamed during the redeploy: its containers are untracked');
          } else {
            await managedStackService.setStatus(id, 'deployed', output || null);
          }
          await managedStackService.recordDeployHistory({
            managedStackId: id, sourceType: stack.sourceType, gitUrl: stack.gitUrl, gitBranch: stack.gitBranch,
            gitRef: stack.gitRef, composePath: stack.composePath, buildEnabled: stack.buildEnabled,
            success: result.exitCode === 0, notes: forceRecreate ? 'Manual recreate' : 'Manual redeploy',
            deployedByUserId: sessionForRedeploy.userId ?? null,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          await managedStackService.setStatus(id, 'error', msg);
          await managedStackService.recordDeployHistory({
            managedStackId: id, sourceType: stack.sourceType, gitUrl: stack.gitUrl, gitBranch: stack.gitBranch,
            gitRef: stack.gitRef, composePath: stack.composePath, buildEnabled: stack.buildEnabled,
            success: false, notes: `Failed: ${msg}`, deployedByUserId: sessionForRedeploy.userId ?? null,
          });
        }
      })();
    } catch (err) { next(err); }
  },

  /**
   * Given a list of host ports the user wants to claim on a specific Docker engine, return
   * which ones are already in use by other containers on that engine — along with which
   * stack/container is holding each one. The client uses this for pre-deploy validation in
   * the stack editor so port conflicts surface before `docker compose up` fails.
   *
   * Body: { engineId: number | null, ports?: number[], portSpecs?: PortSpecInput[], excludeComposeProject?: string }
   *  - engineId: which engine to check against (null = the LOCAL engine)
   *  - portSpecs: host port segments (ranges, optional protocol) the user is about to claim;
   *               wins over `ports`. Invalid entries → 400.
   *  - ports: legacy single host ports, any protocol (invalid entries are ignored, as before)
   *  - excludeComposeProject: optional compose_project name to skip — the stack being edited
   *                           must not count as conflicting with itself. We match by compose
   *                           project name because that's the natural link between the
   *                           `managed_stacks` table (the user's definition) and the `stacks`
   *                           table (what DiscoveryWorker actually sees running on Docker) —
   *                           those two tables have unrelated IDs.
   * Stopped containers are included: discovery keeps their ports, and they claim them again on start.
   * Non-admins get stack and container names only for stacks their teams can see; any other
   * conflict keeps its port, range and protocol with null names (see redactPortConflicts).
   */
  async checkPortConflicts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = (req.body ?? {}) as { engineId?: unknown; ports?: unknown; portSpecs?: unknown; excludeComposeProject?: unknown };
      let requested: PortSpecInput[];
      if (body.portSpecs != null) {
        requested = parsePortSpecs(body.portSpecs);
      } else {
        const ports = Array.isArray(body.ports) ? body.ports.filter(isPortNumber) : [];
        requested = ports.map(p => ({ start: p, end: p }));
      }
      if (requested.length === 0) { res.json({ success: true, data: { conflicts: [] } }); return; }

      if (body.engineId != null && !(typeof body.engineId === 'number' && Number.isInteger(body.engineId))) {
        throw new AppError(400, 'engineId must be an integer or null');
      }
      // null used to mean the default engine; it now means the LOCAL engine (a managed stack with
      // no engine runs on the local socket), and the editor always sends a concrete id anyway.
      const engineId = (body.engineId as number | null | undefined) ?? await engineFactsService.resolveLocalEngineId();
      if (engineId == null) { res.json({ success: true, data: { conflicts: [] } }); return; }

      const { db } = await import('../db');
      const rows = await db('containers')
        .leftJoin('stacks', 'containers.stack_id', 'stacks.id')
        .where('containers.engine_id', engineId)
        .select('containers.id as containerId',
                'containers.container_name as containerName',
                'containers.ports as ports',
                'containers.stack_id as stackId',
                'stacks.name as stackName',
                'stacks.compose_project as composeProject') as Array<{
          containerId: number; containerName: string; ports: unknown; stackId: number | null; stackName: string | null; composeProject: string | null;
        }>;
      const excludeProject = typeof body.excludeComposeProject === 'string' && body.excludeComposeProject
        ? body.excludeComposeProject : null;
      const conflicts = computePortConflicts(
        requested,
        rows.map(r => ({
          containerId: r.containerId, containerName: r.containerName, stackName: r.stackName ?? null,
          composeProject: r.composeProject ?? null, ports: parseStoredPorts(r.ports),
        })),
        excludeProject,
      );
      const session = (req.session ?? {}) as { userId?: number; role?: string };
      if (session.role === 'admin' || conflicts.length === 0) {
        res.json({ success: true, data: { conflicts } });
        return;
      }
      // Any user can ask about any engine and a single 1-65535 spec lists every published port, so
      // names are only given for stacks the caller's teams can see (as in the stacks list).
      let visibleStackIds = new Set<number>();
      if (session.userId != null) {
        const conflictContainerIds = new Set(conflicts.map(c => c.containerId));
        const stackIds = [...new Set(rows.flatMap(r => (r.stackId != null && conflictContainerIds.has(r.containerId) ? [r.stackId] : [])))];
        const { filterStacksByTeam } = await import('../middleware/permissions');
        const visible = await filterStacksByTeam(session.userId, session.role || 'user', stackIds.map(stackId => ({ id: stackId }))) as Array<{ id: number }>;
        visibleStackIds = new Set(visible.map(s => s.id));
      }
      const visibleContainerIds = new Set(rows.flatMap(r => (r.stackId != null && visibleStackIds.has(r.stackId) ? [r.containerId] : [])));
      res.json({ success: true, data: { conflicts: redactPortConflicts(conflicts, visibleContainerIds) } });
    } catch (err) { next(err); }
  },

  /**
   * Receive a multipart/form-data zip upload and replace the stack's source files with it.
   * Re-uploads are clean: the project dir is wiped (except .env, docker-compose.yml at root,
   * and .oblihub state) before extraction.
   */
  async uploadZip(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) throw new AppError(400, 'No file uploaded (expected field "file")');
      // The wipe + extract rewrites the tree compose reads.
      await withProjectHold(id, () => sourceManagerService.receiveZip(id, file.buffer));
      const stack = await managedStackService.getById(id);
      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },

  /** Configure / replace the git source for this stack. Body accepts optional deploy-token
   *  auth (`gitUsername` + `gitToken`) and `composePath` (compose file at a subpath in the
   *  repo, e.g. `stack/docker-compose.yml`). `gitToken`: omit to keep the stored token,
   *  send an empty string to clear it, send a non-empty string to replace it. */
  async setGit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const { gitUrl, gitBranch, gitUsername, gitToken, composePath } = req.body as {
        gitUrl?: string; gitBranch?: string; gitUsername?: string | null; gitToken?: string | null; composePath?: string | null;
      };
      if (!gitUrl) throw new AppError(400, 'gitUrl required');
      // The wipe + clone rewrites the tree compose reads.
      await withProjectHold(id, () => sourceManagerService.setGitSource(id, gitUrl, gitBranch || 'main', {
        username: gitUsername,
        token: gitToken,
        composePath,
      }));
      const stack = await managedStackService.getById(id);
      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },

  /** Deploy history for a managed stack — one row per past deploy, for the rollback UI. */
  async getDeployHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const limit = Math.min(parseInt((req.query.limit as string) || '50', 10) || 50, 200);
      const history = await managedStackService.listDeployHistory(id, limit);
      res.json({ success: true, data: history });
    } catch (err) { next(err); }
  },

  /** Rollback: check out a prior git_ref (from a history entry) and redeploy with --build if
   *  the stack has build_enabled. No-op for non-git sources. */
  async rollback(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const { gitRef } = req.body as { gitRef?: string };
      if (!gitRef) throw new AppError(400, 'gitRef required');
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      if (stack.sourceType !== 'git' || !stack.gitUrl) throw new AppError(400, 'Stack is not git-sourced — rollback only supports git stacks');

      // Before the checkout: refusing afterwards would leave the files at the old ref undeployed.
      await assertNoBackgroundCompose(stack);
      // The hold spans the checkout AND the redeploy: a quiet resources apply starting in between
      // would run compose on a half-checked-out tree, then get the redeploy refused.
      const { refreshed, result } = await withProjectHold(id, async () => {
        await sourceManagerService.checkoutGitRef(id, gitRef);
        const current = await managedStackService.getById(id);
        if (!current) throw new AppError(404, 'Stack disappeared during rollback');
        const run = await composeService.redeploy(current.composeProject, current.composeContent, current.envContent, current.engineId);
        throwIfRefused(run);
        return { refreshed: current, result: run };
      });
      const session = req.session as { userId?: number };
      await managedStackService.recordDeployHistory({
        managedStackId: id,
        sourceType: refreshed.sourceType,
        gitUrl: refreshed.gitUrl,
        gitBranch: refreshed.gitBranch,
        gitRef: refreshed.gitRef,
        composePath: refreshed.composePath,
        buildEnabled: refreshed.buildEnabled,
        success: result.exitCode === 0,
        notes: `Rollback to ${gitRef}`,
        deployedByUserId: session.userId ?? null,
      });
      res.json({ success: true, data: { stack: await managedStackService.getById(id), result } });
    } catch (err) { next(err); }
  },

  /**
   * Pull latest commits on the configured branch, then trigger a redeploy in the background so
   * the operator's mental model matches Portainer/NPM ("update code → apply") without a second
   * click. Only redeploys when the stack has actually been deployed at least once (status !=
   * 'draft'); a fresh clone still needs an explicit Deploy so the operator can review env vars
   * and settings first. The redeploy runs async — same pattern as the /deploy handler — and
   * records a deploy history entry.
   */
  async gitPull(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const before = await managedStackService.getById(id);
      if (!before) throw new AppError(404, 'Stack not found');
      // Only a pull that will redeploy competes for the compose lock; check before pulling so a
      // 409 leaves the source untouched.
      if (before.status !== 'draft') await assertNoBackgroundCompose(before);
      const userId = (req.session as { userId?: number }).userId ?? null;

      // As in GitPollWorker, one hold spans the `git reset --hard` AND the redeploy that follows,
      // which outlives this request: a quiet resources apply starting in between would run compose
      // on a half-rewritten tree, then get the redeploy refused. The answer goes out once the pull is
      // done; a failed pull or a refused hold rejects `run` first and becomes the HTTP error.
      let reportPulled: (stack: ManagedStack) => void = () => { /* replaced below */ };
      const pulled = new Promise<ManagedStack>((resolve) => { reportPulled = resolve; });
      const run = withProjectHold(id, async () => {
        await sourceManagerService.gitPull(id);
        const current = await managedStackService.getById(id);
        if (!current) throw new AppError(404, 'Stack not found');
        const redeploy = current.status !== 'draft';
        if (redeploy) await managedStackService.setStatus(id, 'deploying', null);
        reportPulled(current);
        // Never throws: the request has been answered by then.
        if (redeploy) await redeployAfterPull(current, userId);
      });
      const stack = await Promise.race([pulled, run.then(() => pulled)]);
      const shouldRedeploy = stack.status !== 'draft';
      const refreshed = await managedStackService.getById(id);
      res.json({ success: true, data: refreshed, redeployStarted: shouldRedeploy });
    } catch (err) { next(err); }
  },

  /** List the files currently present in the stack's source dir (excluding .git/.oblihub). */
  async listSourceFiles(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const files = await sourceManagerService.listFiles(id);
      res.json({ success: true, data: files });
    } catch (err) { next(err); }
  },

  /**
   * Files Oblihub generates or honours next to the operator's compose, in the order compose
   * receives them: `docker-compose.override.yml` (proxy networks, or the operator's own file under
   * that name), the operator's own override under another compose default name, the resources
   * override (freshly rendered) and the volumes override. Read-only: nothing is written, and the
   * resources preview takes engine capacity from the facts cache only, so this polled GET never
   * waits on a remote Docker daemon. Exists so the operator can see WHY a service is (or isn't) on
   * the proxy network, capped, or where its volumes live, without SSH-ing into the server.
   */
  async getGeneratedFiles(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      const fs = await import('fs');
      const pathMod = await import('path');
      const PROXY_FILE = 'docker-compose.override.yml';

      const target = await composeRunner.resolveTarget({ managedStackId: id });
      const stackRoot = target?.stackRoot ?? pathMod.join(config.stacksDir, stack.composeProject);
      const composeDir = target?.composeDir
        ?? (stack.composePath ? pathMod.join(stackRoot, pathMod.dirname(stack.composePath)) : stackRoot);
      const rel = (full: string) => pathMod.relative(stackRoot, full).replace(/\\/g, '/');

      const generated: GeneratedComposeFile[] = [];
      if (!target) {
        for (const [kind, name] of [['proxy', PROXY_FILE], ['resources', RESOURCES_OVERRIDE_FILE]] as const) {
          generated.push({
            name, path: rel(pathMod.join(composeDir, name)), content: null, exists: false,
            kind, owner: 'oblihub', passedToCompose: false, note: 'Stack folder not found',
          });
        }
      } else {
        const d = composeRunner.describeOverrideFile(target);
        const owner = d.owner ?? 'oblihub';
        let proxyNote: string;
        if (!d.exists) {
          proxyNote = 'Not generated: no proxy host targets a service of this stack, or your compose declares the proxy network itself.';
        } else if (owner === 'operator') {
          proxyNote = d.passed
            ? 'Your own override: passed to every compose command; Oblihub never overwrites it.'
            : `Your file, but not passed: compose loads only one default override and ${d.operator?.name ?? 'another override file'} comes first.`;
        } else {
          proxyNote = d.passed
            ? 'Passed to every compose command (non-standard compose file name).'
            : 'Reference copy: for standard compose file names Oblihub attaches these networks after each deploy (compose does not load this file because Oblihub passes -f explicitly).';
        }
        generated.push({
          name: PROXY_FILE, path: rel(pathMod.join(composeDir, PROXY_FILE)), content: d.content, exists: d.exists,
          kind: 'proxy', owner, passedToCompose: d.passed, note: proxyNote,
        });

        if (d.operator && d.operator.name !== PROXY_FILE) {
          generated.push({
            name: d.operator.name, path: rel(pathMod.join(composeDir, d.operator.name)), content: d.operator.content, exists: true,
            kind: 'operator', owner: 'operator', passedToCompose: true,
            note: 'Your own override (the one docker compose up would load here): passed to every compose command; Oblihub never writes it.',
          });
        }

        // No verb: a read-only render with cached engine capacity (a cold cache adds a warning).
        const resourcesPath = rel(pathMod.join(composeDir, RESOURCES_OVERRIDE_FILE));
        try {
          const p = await composeRunner.previewResources(target);
          const rendered = p.yaml != null;
          generated.push({
            name: RESOURCES_OVERRIDE_FILE, path: resourcesPath, content: p.yaml, exists: rendered,
            kind: 'resources', owner: 'oblihub', passedToCompose: rendered,
            note: p.warnings.length > 0 ? p.warnings.join(' · ') : (p.limits == null ? 'No resource limits on this stack.' : null),
          });
        } catch (err) {
          logger.warn({ projectName: stack.composeProject, err }, 'Resources override preview failed');
          generated.push({
            name: RESOURCES_OVERRIDE_FILE, path: resourcesPath, content: null, exists: false,
            kind: 'resources', owner: 'oblihub', passedToCompose: false,
            note: `Preview failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      const volumesFull = pathMod.join(stackRoot, stackVolumesService.overrideRelativePath());
      const volumesExists = fs.existsSync(volumesFull);
      let volumesContent: string | null = null;
      if (volumesExists) {
        try { volumesContent = fs.readFileSync(volumesFull, 'utf8'); } catch { volumesContent = null; }
      }
      generated.push({
        // Name kept as before: older clients find this entry by name.
        name: 'docker-compose.volumes.yml', path: rel(volumesFull), content: volumesContent, exists: volumesExists,
        kind: 'volumes', owner: 'oblihub', passedToCompose: volumesExists, note: null,
      });
      res.json({ success: true, data: generated });
    } catch (err) { next(err); }
  },

  /**
   * Show the compose config as Docker Compose sees it AFTER merging the operator's compose
   * with Oblihub's override + any .env resolution. This is exactly what runs on `up`. Great
   * to debug "why isn't my service on the proxy network" — the merged output shows the final
   * `networks:` block.
   */
  async getEffectiveConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      // `docker compose config` merges compose + override + resolves env. We piggyback on the
      // existing runCompose so engine + credentials are handled uniformly. `emit: false`: the output
      // is the .env interpolated into the compose file, so it goes to this HTTP caller only, not to
      // the stack's socket room. Still a stream run, not quiet: a quiet run is refused as busy while
      // any other compose command holds the project (a deploy, a git-poll hold), and while it runs it
      // makes the operator's own deploy refuse as a background apply.
      const result = await composeService.runCompose(stack.composeProject, ['config'], 30_000, stack.engineId, { emit: false });
      if (result.exitCode !== 0) {
        res.json({ success: true, data: { config: null, error: result.stderr || 'compose config failed', exitCode: result.exitCode } });
        return;
      }
      res.json({ success: true, data: { config: result.stdout, error: null, exitCode: 0 } });
    } catch (err) { next(err); }
  },

  /**
   * Preview what volumes / bind mounts the stack uses on its current engine. Called by the
   * client BEFORE showing the engine-migration modal so the user sees what they're about to
   * move (or skip, in the case of bind mounts).
   */
  async previewMigration(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      const vols = await volumeMigrationService.discoverVolumes(stack.composeProject, stack.engineId);
      res.json({ success: true, data: vols });
    } catch (err) { next(err); }
  },

  /**
   * Re-target a deployed stack to a different engine.
   *
   *   strategy = 'just-save'        — flip engine_id in DB only. Orphans the old containers.
   *                                    Use when the operator will clean up the old engine
   *                                    by hand or just doesn't care. Across daemons, refused
   *                                    while a deploy runs or holds the stack (underMoveGuard).
   *   strategy = 'stop-and-deploy'  — `docker compose down` on old, flip DB, `up -d` on new.
   *                                    Data is NOT migrated — new volumes will be empty.
   *   strategy = 'migrate-data'     — `down` on old → tar-stream every named volume from old
   *                                    to new → flip DB → `up -d` on new. Bind mounts are
   *                                    surfaced as skipped. The longest path; live progress
   *                                    streams via compose:log.
   *
   * Runs synchronously so the HTTP response only returns when the migration is fully done.
   * For long transfers (multi-GB DB volumes) the client gets progress via the socket and can
   * cancel via /cancel-update on the stack.
   */
  async migrateEngine(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      // `gpuPolicy: 'revoke'`: the operator accepts that GPU ids / VRAM caps naming cards of the
      // source host are dropped on the target (a restriction that loses every id becomes "no GPU").
      const body = req.body as { targetEngineId: number | null; strategy: 'just-save' | 'stop-and-deploy' | 'migrate-data'; gpuPolicy?: 'revoke' };
      if (!('targetEngineId' in body)) throw new AppError(400, 'targetEngineId required');
      if (!['just-save', 'stop-and-deploy', 'migrate-data'].includes(body.strategy)) {
        throw new AppError(400, 'Invalid strategy');
      }
      if (body.gpuPolicy !== undefined && body.gpuPolicy !== 'revoke') throw new AppError(400, 'Invalid gpuPolicy');
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      // The routes' per-id guard already checked this; repeated here so the handler stays safe
      // whatever router mounts it (same rule as a PUT through updateWithLimitsCarry).
      const session = req.session as { userId?: number; role?: string };
      await assertCallerMayManage(session, stack.composeProject);
      // Every strategy flips engine_id, just-save included: never under a running migration.
      assertNotMigrating(id);
      const sourceEngineId = stack.engineId;
      const targetEngineId = body.targetEngineId;
      if (sourceEngineId === targetEngineId) {
        res.json({ success: true, data: { changed: false, message: 'Already on this engine', limitsCarried: false } });
        return;
      }
      // engineService.delete disables the engine before anything else, so refusing a disabled
      // target here, before any strategy (just-save included) runs, closes the window in which a
      // stack could move onto an engine being deleted. delete's FOR UPDATE re-check stays the backstop.
      if (targetEngineId != null) {
        const target = await engineService.getById(targetEngineId);
        if (!target) throw new AppError(400, 'Engine not found');
        if (!target.enabled) throw new AppError(409, `Engine "${target.name}" is disabled`);
      }

      const crossDaemon = (await engineFactsService.managedDaemonKey(sourceEngineId))
        !== (await engineFactsService.managedDaemonKey(targetEngineId));
      // Another managed stack of this project on the target daemon would then share it with this
      // one (deploy, stop, down and delete of either act on both). Refused here, before any strategy
      // (just-save included) and any side effect: the (engine_id, name) index would only fire at the
      // engine flip, after the source `down`, the volume overlay and the limits copy, and misses
      // lossy names ("App"/"app") and NULL vs 'local'-type rows anyway. A same-daemon move changes
      // neither project nor daemon, so it is not refused.
      if (crossDaemon) await assertNoProjectConflict(stack.composeProject, targetEngineId, id);
      // The create-time name guard, before any strategy (just-save included): the carry and the
      // team hand-over below would otherwise give the caller's team another team's row there.
      if (crossDaemon) await assertCallerMayTakeProject(session, stack.composeProject, targetEngineId, id);

      const { db } = await import('../db');

      if (stack.volumePlacements.some(p => p.mode === 'bind')) {
        // The data lives in host folders on this server. Between the implicit local engine and a
        // 'local'-type engine row (same daemon) only the DB reference changes; anything else would
        // leave the data behind — neither the tar-stream migration nor a re-target carries it.
        if (await stackVolumesService.isLocalEngine(sourceEngineId) && await stackVolumesService.isLocalEngine(targetEngineId)) {
          await db('managed_stacks').where({ id }).update({ engine_id: targetEngineId, updated_at: new Date() });
          // Same daemon, so the room should not change; re-checked anyway, as after every engine_id flip.
          void revalidateSocketAccess();
          const updated = await managedStackService.getById(id);
          // engineOnly: nothing was stopped, migrated or redeployed, whatever the strategy asked.
          // Same daemon: the runner finds the limits by daemon equivalence, nothing to carry.
          res.json({ success: true, data: { stack: updated, migrated: [], skippedBinds: [], engineOnly: true, limitsCarried: false } });
          return;
        }
        throw new AppError(409, 'This stack stores its volume data on this server (.volumes). Engine migration is not supported for it.');
      }
      const { setComposeServiceIO } = await import('../services/compose.service');
      void setComposeServiceIO;

      // Limits live on the discovery `stacks` row of (project, engine). Across daemons the
      // target has no such row yet, so the first deploy there would run uncapped (and with every
      // GPU) unless the limits are copied first. Between engine rows of the same daemon the runner
      // already resolves them by daemon equivalence (carryResourceLimitsToNewKey returns null then,
      // and when no local engine row exists for a NULL target).
      type Carry = {
        fromStackId: number | null;
        toStackId: number | null;
        carried: boolean;
        adjusted: LimitsCarryAdjustments | null;
        created: boolean;
        previousLimits: unknown;
        /** The source row was retired: its team links were moved to the target already. */
        retired: boolean;
      };
      const carryLimits = (retireSource: 'if-empty' | 'never'): Promise<Carry | null> =>
        managedStackService.carryResourceLimitsToNewKey(
          { project: stack.composeProject, engineId: sourceEngineId },
          { project: stack.composeProject, engineId: targetEngineId },
          { retireSource },
        );
      const limitsAdjusted = (carry: Carry | null): LimitsCarryAdjustments | null =>
        carry?.adjusted && limitsCarryAdjusted(carry.adjusted) ? carry.adjusted : null;
      // Team access follows the stack to the target daemon (shareTeamLinksWithNewKey): without it
      // the non-admin guards, which look at the rows of the stack's current daemon, would refuse its
      // own team after the move. Called after the engine flip, so the new row it may create is kept
      // by discovery from the start. Best-effort: the move itself is done or under way, and a
      // failure only costs non-admin members access that an admin can restore from the team page.
      const shareTeamLinks = async (): Promise<{ toStackId: number; fromStackIds: number[] } | null> => {
        try {
          return await managedStackService.shareTeamLinksWithNewKey(
            { project: stack.composeProject, engineId: sourceEngineId },
            { project: stack.composeProject, engineId: targetEngineId },
          );
        } catch (err) {
          logger.warn({ projectName: stack.composeProject, sourceEngineId, targetEngineId, err }, 'Engine move: team access could not be copied to the target engine row');
          return null;
        }
      };

      // GPU ids and MPS VRAM caps name cards of the source host; the carry drops those the target
      // does not have, and a restriction that loses every id becomes "no GPU". Checked here, before
      // anything is stopped, so a refusal leaves the stack running on the source: the carry itself
      // runs after `down`, when the operator could no longer back out. Same check and message as a
      // PUT that changes daemon (the client matches GPU_CARRY_REFUSAL_PREFIX on both).
      await assertLimitsCarryAccepted(stack.composeProject, sourceEngineId, targetEngineId, body.gpuPolicy);

      // ── Strategy: just-save ──
      if (body.strategy === 'just-save') {
        const justSave = async (): Promise<Record<string, unknown>> => {
          // Copy only: the source containers keep running on the old engine with their row. A
          // stopped stack leaves nothing there, so its source row is retired rather than left as a ghost.
          const carry = await carryLimits('if-empty');
          await db('managed_stacks').where({ id }).update({ engine_id: targetEngineId, updated_at: new Date() });
          // A running source keeps its row and links (its containers stay there); the target gets
          // copies. A retired source (stopped stack) already handed its links over.
          if (!carry?.retired) await shareTeamLinks();
          // The compose room follows the daemon: move the subscribers now, and out of the source
          // room, whose (daemon, project) name another stack may take. After the team links are
          // shared: checked before, a team member would lose the subscription on the target.
          void revalidateSocketAccess();
          const updated = await managedStackService.getById(id);
          return { stack: updated, migrated: [], skippedBinds: [], limitsCarried: carry?.carried ?? false, limitsAdjusted: limitsAdjusted(carry) };
        };
        // Across daemons, a deploy still running on the source (its `up` resolved the daemon when it
        // started) would come up there under a record naming the target, and the 'if-empty' carry,
        // seeing no container yet, would retire the source row: its containers would then run with
        // no limits, team access or managed record. Same daemon: the containers land where the record
        // points whatever the timing, so nothing to guard.
        const data = crossDaemon
          ? await underMoveGuard(id, { composeProject: stack.composeProject, engineId: sourceEngineId }, () => justSave())
          : await justSave();
        res.json({ success: true, data });
        return;
      }

      // ── Strategy: stop-and-deploy + migrate-data both start with `down` on the old engine ──
      await assertNoBackgroundCompose(stack);
      // The whole down → copy → carry → switch → deploy (and restoreOnSource on failure) holds the
      // runner's lock on the source daemon AND on the target daemon. GitPollWorker resolves the
      // stack's daemon from engine_id (the source until the switch), so without it a commit pushed
      // mid-copy would bring the stack up on the source while its volumes are tarred, then leave it
      // live on both engines; after the switch it would race the target `up`. Held, a git poll
      // defers its commit, and quiet resources applies and withProjectHold callers are refused. The
      // migration's own `down`/`up` pass: a hold does not refuse stream runs, which is also why UI
      // stream runs are refused through state/engineMigrations.ts instead. Only daemonKey, projectName and the
      // engine ids of a target matter to the lock; one daemon (null vs a 'local'-type row) is one lock.
      const sourceLock = await composeRunner.resolveTarget({ managedStackId: id });
      const targetLock: ComposeTarget | null = sourceLock && {
        ...sourceLock,
        managedEngineId: targetEngineId,
        engineId: targetEngineId ?? await engineFactsService.resolveLocalEngineId(),
        daemonKey: await engineFactsService.managedDaemonKey(targetEngineId),
      };

      // COMPOSE_* events go to the room of the daemon a run targets, and the open editor is still in
      // the source room when the target deploy starts (revalidateSocketAccess moves it after the
      // switch, asynchronously; the client resubscribes once this request answers): the target's
      // pull/up output would reach nobody. So the runs from the switch on are mirrored to the sockets
      // subscribed to this stack in the source room, snapshotted just before the switch. A mirror
      // lasts one run: unlike a room join, nothing is left to undo, and a socket that unsubscribes or
      // loses access meanwhile keeps no membership that revalidateSocketAccess could not see.
      const sourceRoom = sourceLock ? composeRunner.composeRoom(sourceLock.daemonKey, sourceLock.projectName) : null;

      const stopAndMove = async (): Promise<Record<string, unknown>> => {
        // Re-read under the locks: a save or another migration that moved or renamed the stack since
        // the checks above would send the source `down` to the wrong daemon or project, and a deploy
        // about to take its hold would race the `down` with its `up` on the source.
        const current = await assertStillMovable(id, { composeProject: stack.composeProject, engineId: sourceEngineId });
        await managedStackService.setStatus(id, 'deploying', null);
        // Between a successful source `down` and a successful target `up` the stack runs nowhere.
        let stoppedOnSource = false;
        let engineSwitched = false;
        let targetCarry: TargetCarry | null = null;
        let mirrorTo: string[] = [];
        try {
          const downResult = await composeService.down(stack.composeProject, false, sourceEngineId);
          throwIfRefused(downResult);
          if (downResult.exitCode !== 0) {
            throw new AppError(500, `Failed to stop on source engine: ${stderrTail(downResult.stderr)}`);
          }
          stoppedOnSource = true;

          let migration: Awaited<ReturnType<typeof volumeMigrationService.migrateAll>> = { migrated: [], skippedBinds: [] };
          if (body.strategy === 'migrate-data') {
            migration = await volumeMigrationService.migrateAll(stack.composeProject, sourceEngineId, targetEngineId);
          }

          // Before the engine switch and the deploy, so the very first `up` on the target renders the
          // caps and the GPU restriction. The source row is retired below, once the target runs. The
          // carry reports what it overwrote (created / previousLimits, read by the carry itself), so
          // a failed deploy can take exactly that back (undoTargetCarry).
          const targetConcrete = crossDaemon ? targetEngineId ?? await engineFactsService.resolveLocalEngineId() : null;
          const carry = await carryLimits('never');
          if (carry?.carried && carry.toStackId != null && targetConcrete != null) {
            targetCarry = { toStackId: carry.toStackId, engineId: targetConcrete, created: carry.created, previousLimits: carry.previousLimits };
          }

          // Taken right before the switch, while the subscribers are all still in the source room.
          // Same daemon: the room does not change, nothing to mirror.
          mirrorTo = sourceRoom && crossDaemon ? composeSubscriberIds(id, sourceRoom) : [];
          await db('managed_stacks').where({ id }).update({ engine_id: targetEngineId, updated_at: new Date() });
          engineSwitched = true;
          // Before the deploy, not after: once engine_id points at the target, discovery no longer
          // keeps an empty source row without limits, and a long `up` (image pulls on a new engine)
          // would let it drop the row and its team links. If the deploy fails, the source keeps its
          // links (copies) and discovery drops the empty target row once the stack is back there.
          const teamShare = await shareTeamLinks();
          // Subscribers follow the stack to the target room, and leave the source one, whose
          // (daemon, project) name another stack may now take. After the team links are shared:
          // checked before, a team member would lose the subscription on the target.
          void revalidateSocketAccess();
          const stackForDeploy = await managedStackService.getById(id);
          if (!stackForDeploy) throw new AppError(500, 'Stack disappeared mid-migration');

          const upResult = await composeService.deploy(
            stackForDeploy.composeProject,
            stackForDeploy.composeContent,
            stackForDeploy.envContent,
            targetEngineId,
            { mirrorTo },
          );
          if (upResult.exitCode !== 0) {
            throw new AppError(500, `Deploy on target engine failed: ${stderrTail(upResult.stderr)}`);
          }
          stoppedOnSource = false;
          await managedStackService.setStatus(id, 'deployed', null);
          if (carry?.carried && carry.fromStackId != null && carry.toStackId != null) {
            // The stack now lives on the target: hand proxy-host links and yield references to the
            // new row and drop the source row's limits, so discovery removes the empty source row
            // instead of keeping a ghost.
            try {
              await stackService.retireStackRow(carry.fromStackId, carry.toStackId);
            } catch (err) {
              // The migration itself succeeded; a failed hand-over only leaves the old row behind.
              logger.warn({ projectName: stack.composeProject, carry, err }, 'Migration done, but the source stack row could not be retired');
            }
          }
          if (teamShare) {
            // The other source rows (every row of a stack without limits) still hold the links
            // copied above and their proxy hosts: hand those over too, so the empty rows discovery
            // drops take nothing with them. The source is down, so nothing there needs them.
            for (const fromStackId of teamShare.fromStackIds) {
              if (fromStackId === carry?.fromStackId) continue;
              try {
                await stackService.retireStackRow(fromStackId, teamShare.toStackId);
              } catch (err) {
                logger.warn({ projectName: stack.composeProject, fromStackId, toStackId: teamShare.toStackId, err }, 'Migration done, but a source stack row could not be retired');
              }
            }
          }
          const updated = await managedStackService.getById(id);
          return { stack: updated, ...migration, limitsCarried: carry?.carried ?? false, limitsAdjusted: limitsAdjusted(carry) };
        } catch (err) {
          let message = err instanceof Error ? err.message : String(err);
          let restored = false;
          if (stoppedOnSource) {
            // Error texts end with raw compose stderr, rarely with a full stop.
            const base = message.trimEnd();
            const restore = await restoreOnSource(current, sourceEngineId, targetEngineId, engineSwitched, targetCarry, mirrorTo);
            restored = restore.restored;
            message = `${/[.!?]$/.test(base) ? base : `${base}.`} ${restore.text}`;
            // The editor shows a 'deployed' stack's message as green deploy output: say it failed.
            if (restored) message = `Migration failed: ${message}`;
          }
          // A stack restored on its source runs there: 'deployed' keeps Delete's `down`, the proxy
          // network refresh and upstream resolution treating it as live ('error' would make Delete
          // skip the down and orphan the containers). The message still records the failed migration.
          await managedStackService.setStatus(id, restored ? 'deployed' : 'error', message);
          if (!stoppedOnSource) throw err;
          // The client must learn where the stack ended up, which a bare 500 would hide.
          throw new AppError(err instanceof AppError ? err.statusCode : 500, message);
        }
      };

      // Both locks are taken before anything is stopped: a refused one is a 409 with the stack
      // untouched. holdProject never waits (it refuses), so nesting them cannot deadlock.
      const holdTargetToo = (): Promise<Record<string, unknown>> =>
        (sourceLock && targetLock && targetLock.daemonKey !== sourceLock.daemonKey
          ? holdOrRefuse(targetLock, stopAndMove)
          : stopAndMove());
      // Claimed synchronously after the last await above, so two migrations of one stack cannot both pass.
      if (!beginEngineMigration(id)) throw new AppError(409, MIGRATING_MESSAGE);
      let data: Record<string, unknown>;
      try {
        data = await (sourceLock ? holdOrRefuse(sourceLock, holdTargetToo) : stopAndMove());
      } finally {
        endEngineMigration(id);
      }
      // Answered once the locks are released, so a deploy the client sends right after is not refused.
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },
};
