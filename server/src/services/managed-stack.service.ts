import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { encryptSecret, decryptSecret } from '../utils/crypto';
import { stackVolumesService } from './stackVolumes.service';
import { engineService } from './engine.service';
import { engineFactsService } from './engineFacts.service';
import { teamService } from './team.service';
import { toComposeProject, isValidComposeProject, isSafeStackFolder } from '../utils/composeProject';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/withTimeout';
import type { ManagedStack, ManagedStackStatus, ManagedStackSourceType, RegistryCredential } from '@oblihub/shared';

/** What stackService.carryResourceLimits reports (type only: stack.service is imported lazily below). */
type LimitsCarry = Awaited<ReturnType<(typeof import('./stack.service'))['stackService']['carryResourceLimits']>>;
type LimitsCarryAdjustments = import('./stack.service').LimitsCarryAdjustments;

function toCamelCase(row: Record<string, unknown>): ManagedStack {
  return {
    id: row.id as number,
    name: row.name as string,
    composeContent: row.compose_content as string,
    // env_content_enc (new, AES-GCM) takes priority when present; env_content (legacy plaintext)
    // stays as a fallback so pre-migration rows keep working until the operator re-saves them.
    envContent: row.env_content_enc
      ? ((): string | null => { try { return decryptSecret(row.env_content_enc as string); } catch { return null; } })()
      : ((row.env_content as string) || null),
    status: row.status as ManagedStackStatus,
    composeProject: row.compose_project as string,
    engineId: (row.engine_id as number) ?? null,
    errorMessage: (row.error_message as string) || null,
    sourceType: ((row.source_type as string) || 'compose-only') as ManagedStackSourceType,
    gitUrl: (row.git_url as string) || null,
    gitBranch: (row.git_branch as string) || null,
    gitRef: (row.git_ref as string) || null,
    lastSourceSyncAt: row.last_source_sync_at ? (row.last_source_sync_at as Date).toISOString() : null,
    gitUsername: (row.git_username as string) || null,
    hasGitToken: !!row.git_token_enc,
    composePath: (row.compose_path as string) || null,
    buildEnabled: !!row.build_enabled,
    pollGitIntervalS: (row.poll_git_interval_s as number) ?? 0,
    lastGitPollAt: row.last_git_poll_at ? (row.last_git_poll_at as Date).toISOString() : null,
    // Never leak passwords through the API — only the presence flag. The raw ciphertext stays
    // in DB and is decrypted on-demand by compose.service when building DOCKER_CONFIG.
    registryCredentials: ((): RegistryCredential[] => {
      const raw = row.registry_credentials;
      let arr: Array<{ registry?: string; username?: string; password_enc?: string }> = [];
      if (Array.isArray(raw)) arr = raw as typeof arr;
      else if (typeof raw === 'string' && raw) { try { arr = JSON.parse(raw); } catch { arr = []; } }
      return arr
        .filter(e => e && e.registry && e.username)
        .map(e => ({ registry: e.registry as string, username: e.username as string, hasPassword: !!e.password_enc }));
    })(),
    volumesInStacksDir: !!row.volumes_in_stacks_dir,
    volumePlacements: stackVolumesService.toPublicPlacements(row.volume_placements),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/**
 * A stack may only be placed on an engine that exists and is enabled. engineService.delete
 * disables the engine before it checks for managed stacks, so refusing disabled engines here keeps
 * a stack from landing on an engine that is being deleted. null is the legacy local socket.
 */
async function assertEngineUsable(engineId: number | null): Promise<void> {
  if (engineId == null) return;
  const engine = await engineService.getById(engineId);
  if (!engine) throw new AppError(400, 'Engine not found');
  if (!engine.enabled) throw new AppError(409, `Engine "${engine.name}" is disabled`);
}

/**
 * Two managed stacks driving one compose project on one daemon run compose against each other's
 * live project: resolveTarget picks the lowest id, so deploy/stop/down/delete of either acts on the
 * shared one. Uniqueness is therefore on (compose_project, daemon), not (name, engine_id):
 * toComposeProject is lossy ("App"/"app") and a NULL row and a 'local'-type row are one daemon.
 * Check-then-write, so it can race: a concurrent create or move can still slip in between the check
 * and the write, and no DB constraint can express daemon equivalence. `excludeId` is the stack
 * being edited or moved (its own row never conflicts).
 */
export async function assertNoProjectConflict(project: string, engineId: number | null, excludeId?: number): Promise<void> {
  const rows = await db('managed_stacks')
    .where({ compose_project: project })
    .whereNot('id', excludeId ?? -1)
    .select('engine_id') as Array<{ engine_id: number | null }>;
  if (rows.length === 0) return;
  const daemon = await engineFactsService.managedDaemonKey(engineId);
  for (const row of rows) {
    if (await engineFactsService.managedDaemonKey(row.engine_id ?? null) === daemon) {
      throw new AppError(409, `A managed stack using compose project "${project}" already exists on this engine`);
    }
  }
}

/** Who asks for a change, as the session tells it: the service sees no request of its own. */
export interface ManagedStackCaller { userId?: number; role?: string }

export interface ManagedStackUpdate {
  name?: string;
  composeContent?: string;
  envContent?: string | null;
  engineId?: number | null;
  registryCredentials?: Array<{ registry: string; username: string; password?: string }>;
  gitUsername?: string | null;
  gitToken?: string | null;    // undefined = keep existing, '' = clear, non-empty = replace
  composePath?: string | null;
  buildEnabled?: boolean;
  pollGitIntervalS?: number;
}

export interface ManagedStackUpdateOptions {
  /** The session of an HTTP request; omitted by internal callers. */
  caller?: ManagedStackCaller;
  /** The operator accepts that a move to another daemon drops GPU ids / VRAM caps of the source host. */
  gpuPolicy?: 'revoke';
}

/** Start of the refusal when the GPU settings do not fit the target engine. The client matches it
 *  (managedStacksApi.isGpuCarryRefusal) to offer a retry with `gpuPolicy: 'revoke'`: keep it as is. */
export const GPU_CARRY_REFUSAL_PREFIX = 'GPU restriction refers to GPUs of the source engine';

/**
 * Refuses (409) a move of `project` to another daemon whose limits carry would drop GPU ids or MPS
 * VRAM caps naming cards of the source host (a restriction that loses every id becomes "no GPU"),
 * unless the operator accepted it with gpuPolicy 'revoke'. Meant to run before anything is written
 * or stopped, so a refusal changes nothing. Same daemon: the ids stay valid, nothing to check.
 */
export async function assertLimitsCarryAccepted(
  project: string,
  fromEngineId: number | null,
  toEngineId: number | null,
  gpuPolicy?: 'revoke',
): Promise<void> {
  if (gpuPolicy === 'revoke') return;
  if (await engineFactsService.managedDaemonKey(fromEngineId) === await engineFactsService.managedDaemonKey(toEngineId)) return;
  // Resolved as carryResourceLimitsToNewKey resolves it: no concrete target, nothing is carried.
  const targetEngineId = toEngineId ?? await engineFactsService.resolveLocalEngineId();
  if (targetEngineId == null) return;
  // Lazy like the carry: stack.service is not a static dependency of this module.
  const { stackService, limitsCarryAdjusted } = await import('./stack.service');
  const plan = await stackService.planResourceLimitsCarry(project, await engineFactsService.daemonEngineIds(fromEngineId), targetEngineId);
  if (plan && limitsCarryAdjusted(plan.adjusted)) {
    const dropped = [...new Set([...plan.adjusted.gpuIdsDropped, ...plan.adjusted.vramCapsDropped])];
    const unknown = plan.adjusted.targetCatalogUnknown ? ' The GPU list of the target engine could not be read.' : '';
    throw new AppError(409, `${GPU_CARRY_REFUSAL_PREFIX} (${dropped.join(', ')}); clear it or re-pick GPUs after the move.${unknown}`);
  }
}

/**
 * A non-admin may change a managed stack only when the non-admin list shows it to them: a team with
 * every resource, or a team link to a stacks row of its project. Without it any signed-in user could
 * rewrite, rename or move another team's stack. Admins pass.
 */
export async function assertCallerMayManage(caller: ManagedStackCaller, project: string): Promise<void> {
  if (caller.role === 'admin') return;
  if (caller.userId != null) {
    const teams = await teamService.getTeamsForUser(caller.userId);
    if (teams.some(t => t.allResources)) return;
    const stackIds = teams.flatMap(t => t.resources.filter(r => r.resourceType === 'stack' && !r.excluded).map(r => r.resourceId));
    if (stackIds.length > 0 && await db('stacks').whereIn('id', stackIds).where({ compose_project: project }).first()) return;
  }
  throw new AppError(403, 'Access denied: you are not a member of a team with access to this stack');
}

/** A managed stack as the per-id checks key it: its compose project on its managed engine. */
export interface ManagedStackKey { composeProject: string; engineId: number | null }

/**
 * The `stacks` rows team access is granted on for a compose project on a managed engine's daemon.
 * managed_stacks has no team of its own: list() and create() tie a managed stack to teams through
 * these rows, so every per-id check must use the same mapping. Every engine row of that daemon,
 * plus NULL-engine rows only when no local engine row exists (the stack's own row is then keyed on
 * NULL). Otherwise a NULL row is an orphan and says nothing about who owns the stack that runs
 * on the daemon now. `managedEngineId` is the managed engine (null = legacy local socket).
 */
export async function managedStackTeamRowIds(project: string, managedEngineId: number | null): Promise<number[]> {
  const daemonIds = await engineFactsService.daemonEngineIds(managedEngineId);
  const includeNullRows = (managedEngineId ?? await engineFactsService.resolveLocalEngineId()) == null;
  const rows = await db('stacks')
    .where({ compose_project: project })
    .andWhere((q) => {
      q.whereIn('engine_id', daemonIds);
      if (includeNullRows) q.orWhereNull('engine_id');
    })
    .select('id') as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

/**
 * Whether a non-admin may act on the managed stack of this (project, engine). Every row must be
 * accessible, as in create(): a project name is shared by all rows of that daemon, and one compose
 * command acts on all of their containers. No row yet (a draft an admin created, or a stack whose
 * empty row discovery dropped after a Down): only a team with allResources, which list() already
 * shows every managed stack to, gets in.
 */
export async function canAccessManagedStackKey(userId: number, stack: ManagedStackKey): Promise<boolean> {
  const rowIds = await managedStackTeamRowIds(stack.composeProject, stack.engineId);
  if (rowIds.length === 0) {
    const teams = await teamService.getTeamsForUser(userId);
    return teams.some((t) => t.allResources);
  }
  for (const rowId of rowIds) {
    if (!(await teamService.userHasAccess(userId, 'stack', rowId))) return false;
  }
  return true;
}

/**
 * Managed stacks whose files live in `<stacksDir>/<project>`. The folder is per compose project,
 * whatever the engine (buildManagedTarget, writeStackFiles): same-named stacks on different engines
 * read and write one compose file, one .env and one zip/git source tree.
 */
async function managedStacksSharingFolder(project: string): Promise<Array<{ id: number; engine_id: number | null }>> {
  return db('managed_stacks').where({ compose_project: project }).select('id', 'engine_id') as Promise<Array<{ id: number; engine_id: number | null }>>;
}

/**
 * The per-id guard for a non-admin: access to the stack itself on its daemon, AND to every other
 * managed stack sharing its folder on any engine. Access to one of them is access to the files of
 * all (effective-config interpolates the shared .env, a deploy rewrites the shared compose file, a
 * zip/git source wipes the shared tree), so a same-named pair owned by two teams is locked for both
 * until an admin renames one. That lockout is intended: it also closes pairs created before the
 * create/rename/move guard checked other engines. Per-engine stack folders would remove the cause
 * (out of scope).
 */
export async function canAccessManagedStack(userId: number, stack: ManagedStackKey & { id: number }): Promise<boolean> {
  if (!(await canAccessManagedStackKey(userId, stack))) return false;
  for (const other of await managedStacksSharingFolder(stack.composeProject)) {
    if (other.id === stack.id) continue;
    if (!(await canAccessManagedStackKey(userId, { composeProject: stack.composeProject, engineId: other.engine_id ?? null }))) return false;
  }
  return true;
}

/**
 * The folder half of the take-project guard: a non-admin may point a managed stack at `project`
 * only when its folder `<stacksDir>/<project>` is theirs to share. Checked per project, not per
 * daemon, because the folder is per project: a same-named stack of another team on another engine,
 * or a hand-deployed folder, would otherwise hand the caller its compose file and .env (secrets
 * included) and let their deploys overwrite them.
 * - Oblihub's own project is reserved on EVERY engine: its folder is on the hub whatever the target.
 *   isSelfProject keeps its local-only meaning (runner, watchdog and limits rely on it), so the
 *   daemon key is 'local' here on purpose.
 * - Every other managed stack of that project, on any engine, must pass the per-id check
 *   (canAccessManagedStackKey on its own daemon).
 * - A folder that exists with no managed stack behind it (a hand-deployed stack, a leftover) is
 *   refused: nothing says whose it is.
 * `managedStackId` is the stack being renamed or moved: its own row and its own folder never count
 * against it. Admins pass.
 */
export async function assertCallerMayShareStackFolder(caller: ManagedStackCaller, project: string, managedStackId?: number): Promise<void> {
  if (caller.role === 'admin') return;
  if (caller.userId == null) throw new AppError(403, 'Access denied');
  // Lazy: selfProject.service pulls docker.service, which this module only loads on demand.
  const { selfProjectService } = await import('./selfProject.service');
  if (await selfProjectService.isSelfProject(project, 'local')) {
    throw new AppError(403, 'This name is reserved for Oblihub\'s own stack');
  }
  const sharers = await managedStacksSharingFolder(project);
  for (const other of sharers) {
    if (other.id === managedStackId) continue;
    if (!(await canAccessManagedStackKey(caller.userId, { composeProject: project, engineId: other.engine_id ?? null }))) {
      throw new AppError(409, `A managed stack using compose project "${project}" already exists on another engine, and stacks of one project share one stack folder`);
    }
  }
  // Only a folder no managed stack claims: a sharer's folder was just checked through its stack.
  if (sharers.length === 0 && isSafeStackFolder(project) && fs.existsSync(path.join(config.stacksDir, project))) {
    throw new AppError(409, `A folder named "${project}" already exists in the stacks directory`);
  }
}

/**
 * The create-time name guard, for every way a managed stack comes to drive `project` on the daemon
 * of `engineId` (create, rename, engine move). A non-admin must not take a stack folder that is not
 * theirs (assertCallerMayShareStackFolder: Oblihub's own project on any engine, another team's
 * same-named stack on any engine, an unclaimed folder), nor a project whose stacks row on that
 * daemon their team cannot access: the limits carry and the row retire would overwrite that row's
 * limits and move the team link onto it, and team access to a row opens every container of it
 * (inspect shows the env, secrets included); a later deploy would also run over that project.
 * Admins pass. `engineId` is the managed engine (null = legacy local socket). `managedStackId` is
 * the stack being renamed or moved, omitted on create.
 */
export async function assertCallerMayTakeProject(caller: ManagedStackCaller, project: string, engineId: number | null, managedStackId?: number): Promise<void> {
  if (caller.role === 'admin') return;
  if (caller.userId == null) throw new AppError(403, 'Access denied');
  await assertCallerMayShareStackFolder(caller, project, managedStackId);
  // Resolved as create resolves it: the stack and its stacks row land on this engine.
  const targetEngine = engineId ?? await engineFactsService.resolveLocalEngineId();
  for (const rowId of await managedStackTeamRowIds(project, targetEngine)) {
    if (!(await teamService.userHasAccess(caller.userId, 'stack', rowId))) {
      throw new AppError(409, 'A stack with this name already runs on this engine');
    }
  }
}

/**
 * Links a non-admin's new managed stack to their team, so the per-id guard (canAccessManagedStack)
 * and the list let that team reach it: managed_stacks has no team of its own. Call it right after
 * create, once assertCallerMayTakeProject passed.
 * Scoped by (compose_project, engine_id): a project name is unique only within an engine, and
 * syncWithDocker joins on the same pair. A row without engine_id became an orphan that later failed
 * the discovery INSERT with "duplicate key" once the container came up on a specific engine; a NULL
 * engine_id also reads as "engine deleted". So the row records the engine the stack will run
 * on. It stays empty until the first deploy: discovery's empty-row cleanup keeps it while a managed
 * stack drives this project on that daemon, or the team would lose the stack before it ever runs.
 * Only an unassigned row is claimed: a team set by an admin is never overwritten.
 */
export async function claimStackRowForTeam(
  stack: { name: string; composeProject: string; engineId: number | null },
  teamId: number,
): Promise<void> {
  const engineIdForRow = stack.engineId ?? await engineFactsService.resolveLocalEngineId();
  let row = await db('stacks').where({ compose_project: stack.composeProject, engine_id: engineIdForRow }).first() as { id: number; team_id: number | null } | undefined;
  if (!row) {
    const [inserted] = await db('stacks')
      .insert({ name: stack.name, compose_project: stack.composeProject, engine_id: engineIdForRow, team_id: teamId })
      .returning('*') as Array<{ id: number; team_id: number | null }>;
    row = inserted;
  } else if (row.team_id == null) {
    await db('stacks').where({ id: row.id }).update({ team_id: teamId });
  }
  await teamService.addResource(teamId, 'stack', row.id);
}

/**
 * Translate the public RegistryCredential[] coming from the client into the encrypted
 * DB-shape. `password` undefined / empty on an existing entry means "keep existing" (preserves
 * the encrypted value already stored). Drops malformed entries silently.
 */
async function mergeRegistryCredentials(
  stackId: number | null,
  input: Array<{ registry: string; username: string; password?: string }>,
): Promise<Array<{ registry: string; username: string; password_enc: string | null }>> {
  let existing: Array<{ registry?: string; username?: string; password_enc?: string }> = [];
  if (stackId != null) {
    const row = await db('managed_stacks').where({ id: stackId }).select('registry_credentials').first();
    const raw = row?.registry_credentials;
    if (Array.isArray(raw)) existing = raw as typeof existing;
    else if (typeof raw === 'string' && raw) { try { existing = JSON.parse(raw); } catch { existing = []; } }
  }
  // Match existing entries by (registry, username) so renaming on the same row doesn't lose the secret.
  const byKey = new Map<string, { password_enc?: string }>();
  for (const e of existing) {
    if (e.registry && e.username) byKey.set(`${e.registry} ${e.username}`, e);
  }
  const out: Array<{ registry: string; username: string; password_enc: string | null }> = [];
  for (const c of input || []) {
    if (!c.registry?.trim() || !c.username?.trim()) continue;
    const key = `${c.registry.trim()} ${c.username.trim()}`;
    if (c.password) {
      out.push({ registry: c.registry.trim(), username: c.username.trim(), password_enc: encryptSecret(c.password) });
    } else {
      // Preserve the previously-stored ciphertext when the client didn't send a new password.
      const prev = byKey.get(key);
      out.push({ registry: c.registry.trim(), username: c.username.trim(), password_enc: prev?.password_enc ?? null });
    }
  }
  return out;
}

/**
 * Whether a compose project has containers (any state) on the engine of the given stacks row (the
 * old row of a moved stack, or an existing row of its new project). Asks the engine itself: container rows lag up to one discovery pass behind a `down`, and
 * Down → pick another engine → Save is precisely how a stopped stack gets moved. An engine that
 * cannot answer falls back to those rows, so a doubt keeps the source limits rather than dropping
 * them. A row without engine_id is orphaned and is never mapped to the local daemon.
 */
async function projectHasContainers(project: string, stackId: number, engineId: number | null): Promise<boolean> {
  if (engineId != null) {
    try {
      const { dockerService } = await import('./docker.service');
      const live = await withTimeout(dockerService.listProjectContainers(project, engineId), 5_000, `containers of ${project} on engine ${engineId}`);
      return live.length > 0;
    } catch (err) {
      logger.warn({ project, engineId, err: err instanceof Error ? err.message : String(err) }, 'Engine did not list the project containers: using the stored container rows');
    }
  }
  const count = await db('containers').where({ stack_id: stackId }).count('* as cnt').first();
  return Number(count?.cnt) > 0;
}

type StackRowRef = { id: number; name: string; engine_id: number | null; team_id: number | null };

/** Teams tied to these stacks rows: their owner team_id and every team_resources link to them. */
async function teamsOfRows(rows: StackRowRef[]): Promise<Set<number>> {
  const out = new Set<number>();
  for (const r of rows) if (r.team_id != null) out.add(Number(r.team_id));
  if (rows.length > 0) {
    const linked = await db('team_resources').where({ resource_type: 'stack' }).whereIn('resource_id', rows.map(r => r.id)).pluck('team_id');
    for (const t of linked) out.add(Number(t));
  }
  return out;
}

/**
 * Why the existing (new project, target engine) row must not take over this managed stack's rows,
 * or null when it may. Taking over overwrites the row's limits and moves the team links, proxy hosts
 * and yield links onto it, and team access to a row opens every container of it. A row tied to a
 * team the source rows are not tied to belongs to that team; an unassigned row with containers is a
 * running project nobody gave this stack's teams (hand-deployed, Oblihub's own). A row whose teams
 * are all the source's (a leftover of an earlier carry, the team's own project) grants nothing new.
 * Admin renames and moves reach this too: the caller check only covers non-admins.
 */
async function foreignTargetReason(target: StackRowRef, sourceRows: StackRowRef[], toProject: string, targetEngineId: number): Promise<string | null> {
  const sourceTeams = await teamsOfRows(sourceRows);
  const targetTeams = await teamsOfRows([target]);
  if ([...targetTeams].some(t => !sourceTeams.has(t))) return 'it is assigned to another team';
  if (targetTeams.size === 0 && await projectHasContainers(toProject, target.id, targetEngineId)) return 'it runs containers that were never assigned to this stack\'s team';
  return null;
}

/**
 * A stack without limits has nothing to carry, yet its empty stacks row can still hold its team link
 * (the non-admin create pre-creates the row on the concrete engine) and its proxy hosts. Once the
 * managed stack points at another project or daemon, discovery deletes that row, and the first
 * deploy creates a teamless one: the team would lose the stack. So those references move to the
 * (new project, target engine) row, created empty with the same owner team when missing; discovery
 * keeps it while the managed stack drives that project there, and the first deploy adopts it. Rows whose project
 * still has containers keep their references (a renamed running stack, a just-save of a running one).
 * Returns the rows handed over from and to, or null when nothing moved.
 */
async function handOverEmptySourceRows(
  fromProject: string,
  sourceRows: StackRowRef[],
  toProject: string,
  targetEngineId: number,
  existingTarget: StackRowRef | undefined,
): Promise<{ fromStackId: number; toStackId: number } | null> {
  let target = existingTarget;
  let handedOver: { fromStackId: number; toStackId: number } | null = null;
  const { stackService } = await import('./stack.service');
  for (const src of sourceRows) {
    if (src.id === target?.id) continue;
    const holdsReferences = src.team_id != null
      || !!(await db('team_resources').where({ resource_type: 'stack', resource_id: src.id }).first())
      || !!(await db('proxy_hosts').where({ stack_id: src.id }).first());
    // Nothing to hand over (an admin-only stack): no empty row is created for it, its first deploy does.
    if (!holdsReferences) continue;
    if (await projectHasContainers(fromProject, src.id, src.engine_id)) continue;
    if (!target) {
      const inserted = await db('stacks')
        .insert({ name: toProject === fromProject ? src.name : toProject, compose_project: toProject, engine_id: targetEngineId, team_id: src.team_id ?? null })
        .onConflict(['compose_project', 'engine_id'])
        .ignore()
        .returning('id');
      target = await db('stacks').where({ compose_project: toProject, engine_id: targetEngineId })
        .select('id', 'name', 'engine_id', 'team_id').first() as StackRowRef | undefined;
      if (!target) return handedOver;
      // A discovery pass inserted the row between the ownership check and this insert: check it too.
      if (inserted.length === 0) {
        const reason = await foreignTargetReason(target, sourceRows, toProject, targetEngineId);
        if (reason) {
          logger.warn({ fromProject, toProject, targetEngineId, toStackId: target.id, reason }, 'Stack row of the new project/engine appeared meanwhile and is not this stack\'s: team links and proxy hosts not handed over');
          return handedOver;
        }
      }
    } else if (target.team_id == null && src.team_id != null) {
      // Only an unassigned row is claimed: an owner team already set is never overwritten.
      await db('stacks').where({ id: target.id }).whereNull('team_id').update({ team_id: src.team_id });
      target = { ...target, team_id: src.team_id };
    }
    await stackService.retireStackRow(src.id, target.id);
    handedOver ??= { fromStackId: src.id, toStackId: target.id };
  }
  return handedOver;
}

export const managedStackService = {
  async getAll(): Promise<ManagedStack[]> {
    const rows = await db('managed_stacks').orderBy('name');
    return rows.map(toCamelCase);
  },

  async getById(id: number): Promise<ManagedStack | null> {
    const row = await db('managed_stacks').where({ id }).first();
    return row ? toCamelCase(row) : null;
  },

  async create(data: {
    name: string;
    composeContent: string;
    envContent?: string | null;
    engineId?: number | null;
    registryCredentials?: Array<{ registry: string; username: string; password?: string }>;
    gitUsername?: string | null;
    gitToken?: string | null;
    composePath?: string | null;
    buildEnabled?: boolean;
    pollGitIntervalS?: number;
  }): Promise<ManagedStack> {
    const projectName = toComposeProject(data.name);
    if (!isValidComposeProject(projectName)) {
      throw new AppError(400, 'Stack name must start with a letter or a digit.');
    }
    // A NULL engine_id reads as "engine deleted" wherever rows join on engines, so a stack
    // created without an engine pick (non-admin form, templates) records the local engine it runs on.
    const engineId = data.engineId ?? await engineFactsService.resolveLocalEngineId();
    await assertEngineUsable(engineId);
    // Pre-check to surface a clean 409 rather than a raw constraint violation (a 500). Keyed on the
    // compose project, not the name: "App" and "app" map to one project, and a legacy NULL row and
    // every local-type engine share Oblihub's own socket. The DB (engine_id, name) unique index
    // stays as the backstop for the race this check leaves open.
    await assertNoProjectConflict(projectName, engineId);
    const initialCreds = await mergeRegistryCredentials(null, data.registryCredentials || []);
    const [row] = await db('managed_stacks').insert({
      name: data.name,
      compose_content: data.composeContent,
      // New rows always land in the encrypted column; env_content stays NULL. Legacy plaintext
      // rows remain readable but are opportunistically upgraded when re-saved via update().
      env_content_enc: data.envContent ? encryptSecret(data.envContent) : null,
      status: 'draft',
      compose_project: projectName,
      engine_id: engineId,
      registry_credentials: JSON.stringify(initialCreds),
      git_username: data.gitUsername ?? null,
      git_token_enc: data.gitToken ? encryptSecret(data.gitToken) : null,
      compose_path: data.composePath ?? null,
      build_enabled: !!data.buildEnabled,
      poll_git_interval_s: data.pollGitIntervalS ?? 0,
      // New stacks keep their named volumes under <stacksDir>/.volumes/<project>/ (see
      // stackVolumes.service.ts). Volumes that already exist in Docker are left where they are.
      volumes_in_stacks_dir: true,
    }).returning('*');
    return toCamelCase(row);
  },

  /** updateWithLimitsCarry without the carry report, for callers that only need the stack. */
  async update(id: number, data: ManagedStackUpdate, opts: ManagedStackUpdateOptions = {}): Promise<ManagedStack | null> {
    return (await managedStackService.updateWithLimitsCarry(id, data, opts))?.stack ?? null;
  },

  /**
   * Saves the stack. A rename or an engine move to another daemon also carries its resource limits
   * and team references to the (new project, new engine) stacks row, and `limitsAdjusted` reports
   * the GPU ids / VRAM caps that carry dropped (null when nothing was dropped). HTTP handlers pass
   * `caller`: a non-admin then needs access to the stack and may not take a project another team
   * holds on the target daemon, nor a stack folder another team's stack uses on any engine.
   * Without `caller` (internal callers) neither check runs.
   */
  async updateWithLimitsCarry(id: number, data: ManagedStackUpdate, opts: ManagedStackUpdateOptions = {}): Promise<{ stack: ManagedStack; limitsAdjusted: LimitsCarryAdjustments | null } | null> {
    const updates: Record<string, unknown> = { updated_at: new Date() };
    const restricted = opts.caller != null && opts.caller.role !== 'admin';
    // Read once, before any write: the checks below and the limits carry after the write compare
    // against the stored project and engine.
    const current = data.name !== undefined || data.engineId !== undefined || restricted
      ? await db('managed_stacks').where({ id }).first()
      : undefined;
    if (restricted) {
      if (!current) return null;
      await assertCallerMayManage(opts.caller!, current.compose_project as string);
      // assertCallerMayManage matches the project on any engine; the per-id rule is stricter (its
      // own daemon, plus every stack sharing its folder), and it is the one a save must honour.
      const key = { id, composeProject: current.compose_project as string, engineId: (current.engine_id as number | null) ?? null };
      if (!(await canAccessManagedStack(opts.caller!.userId!, key))) {
        throw new AppError(403, 'Access denied: you are not a member of a team with access to this stack');
      }
    }
    if (data.name !== undefined) {
      updates.name = data.name;
      const project = toComposeProject(data.name);
      updates.compose_project = project;
      // A NEW project name must be one Compose accepts — which also rules out '' (the stack folder
      // would be the stacks dir itself) and reserved folders like `_proxy`. Legacy names that
      // don't change stay editable.
      if (project !== current?.compose_project && !isValidComposeProject(project)) {
        throw new AppError(400, 'Stack name must start with a letter or a digit.');
      }
    }
    if (data.composeContent !== undefined) updates.compose_content = data.composeContent;
    if (data.envContent !== undefined) {
      // Any env update rides the encrypted column going forward; blank the legacy plaintext
      // to avoid two-source-of-truth drift.
      updates.env_content_enc = data.envContent ? encryptSecret(data.envContent) : null;
      updates.env_content = null;
    }
    if (data.engineId !== undefined) updates.engine_id = data.engineId;
    if (data.registryCredentials !== undefined) {
      const merged = await mergeRegistryCredentials(id, data.registryCredentials);
      updates.registry_credentials = JSON.stringify(merged);
    }
    if (data.gitUsername !== undefined) updates.git_username = data.gitUsername;
    // Token semantics: undefined = don't touch, '' = clear ciphertext, non-empty = re-encrypt.
    // Mirrors the same pattern used for engine SSH keys + registry credentials to give the
    // operator a way to rename the deploy user without losing the token.
    if (data.gitToken !== undefined) {
      updates.git_token_enc = data.gitToken ? encryptSecret(data.gitToken) : null;
    }
    if (data.composePath !== undefined) updates.compose_path = data.composePath;
    if (data.buildEnabled !== undefined) updates.build_enabled = data.buildEnabled;
    if (data.pollGitIntervalS !== undefined) updates.poll_git_interval_s = data.pollGitIntervalS;
    // Same uniqueness check on update — only when name or engine actually changed.
    if (data.name !== undefined || data.engineId !== undefined) {
      // Only a move is checked: a stack already sitting on a disabled engine stays editable.
      if (current && data.engineId != null && data.engineId !== ((current.engine_id as number | null) ?? null)) {
        await assertEngineUsable(data.engineId);
      }
      // Volume data under <stacksDir>/.volumes is bound to the compose project name (volume
      // `<project>_<key>`) and to the local engine. Renaming or re-targeting would start the
      // stack on fresh volumes while the data stays behind — refuse instead.
      if (current && stackVolumesService.hasBindPlacements(current.volume_placements)) {
        if (updates.compose_project !== undefined && updates.compose_project !== current.compose_project) {
          throw new AppError(409, `This stack stores its volume data in ${stackVolumesService.bindHostPaths(current.volume_placements).join(', ')}. Renaming it would change the compose project and detach that data — keep the current name.`);
        }
        const newEngineId = data.engineId ?? null;
        const oldEngineId = (current.engine_id as number | null) ?? null;
        // null ↔ a 'local'-type engine row is the same daemon — the data stays attached.
        if (data.engineId !== undefined && newEngineId !== oldEngineId
          && !(await stackVolumesService.isLocalEngine(oldEngineId) && await stackVolumesService.isLocalEngine(newEngineId))) {
          throw new AppError(409, 'This stack stores its volume data on this server (.volumes). It cannot be moved to another engine.');
        }
      }
      if (current) {
        const newName = data.name ?? current.name;
        const newEngine: number | null = data.engineId !== undefined ? data.engineId : ((current.engine_id as number | null) ?? null);
        // Exact (name, engine_id) match: the unique index would reject it anyway, as a raw 500.
        const conflict = await db('managed_stacks')
          .where({ name: newName, engine_id: newEngine })
          .whereNot({ id })
          .first();
        if (conflict) {
          throw new AppError(409, `A managed stack named "${newName}" already exists on this engine.`);
        }
        // Only a change of project or daemon is checked: two legacy rows that already share a
        // project on one daemon must stay editable (a save that moves neither adds no conflict).
        const newProject = (updates.compose_project as string | undefined) ?? (current.compose_project as string);
        const currentEngine = (current.engine_id as number | null) ?? null;
        if (newProject !== current.compose_project
          || await engineFactsService.managedDaemonKey(newEngine) !== await engineFactsService.managedDaemonKey(currentEngine)) {
          await assertNoProjectConflict(newProject, newEngine, id);
          // The create-time guard: the carry below would otherwise hand the caller's team link to
          // the new project's existing row (another team's stack, a hand-deployed one, Oblihub's own),
          // and a new project would hand the caller the folder another engine's stack of it uses.
          if (opts.caller) await assertCallerMayTakeProject(opts.caller, newProject, newEngine, id);
          // Like migrateEngine, and before the write: the carry after it never refuses, so a plain
          // save to another daemon would otherwise drop the GPU ids silently. Keyed by the current
          // project, as the carry keys its source.
          await assertLimitsCarryAccepted(current.compose_project as string, currentEngine, newEngine, opts.gpuPolicy);
        }
      }
    }
    const [row] = await db('managed_stacks').where({ id }).update(updates).returning('*');
    if (!row) return null;
    let limitsAdjusted: LimitsCarryAdjustments | null = null;
    if (current && (data.name !== undefined || data.engineId !== undefined)) {
      // A rename or a move to another daemon through a plain save (any status but 'deployed' in
      // the editor, or a pre-save of the name before migrateEngine) must take the limits along,
      // exactly like migrateEngine does. The carry goes through stack.service on its own
      // connection, so it cannot share a transaction with the write above; a failure there leaves
      // a saved stack whose next deploy runs uncapped, which the log has to say.
      let sourceRetired = false;
      try {
        const carry = await managedStackService.carryResourceLimitsToNewKey(
          { project: current.compose_project as string, engineId: (current.engine_id as number | null) ?? null },
          { project: row.compose_project as string, engineId: (row.engine_id as number | null) ?? null },
          { retireSource: 'if-empty' },
        );
        sourceRetired = carry?.retired ?? false;
        const { limitsCarryAdjusted } = await import('./stack.service');
        if (carry?.adjusted && limitsCarryAdjusted(carry.adjusted)) limitsAdjusted = carry.adjusted;
      } catch (err) {
        logger.warn({ managedStackId: id, fromProject: current.compose_project, toProject: row.compose_project, fromEngineId: current.engine_id, toEngineId: row.engine_id, err }, 'Managed stack saved, but its resource limits could not be carried to its new project/engine');
      }
      // The carry only hands team links over when it retires the old row (no container left there):
      // a renamed or moved stack whose old containers still run would otherwise have no team link
      // on its new row, and non-admin members would get a 403 on it.
      if (!sourceRetired) {
        try {
          await managedStackService.shareTeamLinksWithNewKey(
            { project: current.compose_project as string, engineId: (current.engine_id as number | null) ?? null },
            { project: row.compose_project as string, engineId: (row.engine_id as number | null) ?? null },
          );
        } catch (err) {
          logger.warn({ managedStackId: id, fromProject: current.compose_project, toProject: row.compose_project, fromEngineId: current.engine_id, toEngineId: row.engine_id, err }, 'Managed stack saved, but its team access could not be given to its new project/engine');
        }
      }
    }
    return { stack: toCamelCase(row), limitsAdjusted };
  },

  /**
   * Team access to a managed stack is looked up on the stacks rows of its CURRENT (project, daemon)
   * (the routes' per-id guard, assertCallerMayManage, list()). After a rename or a move to another
   * daemon those rows are new, and the limits carry only hands team links over when it retires an
   * old row (limits carried, or an old project with no container left). A running just-save, a
   * rename of a running stack or a migration of a stack without limits would leave the new row
   * without them: its team would lose the stack (403) and its first deploy would adopt a teamless row.
   *
   * COPIES the old rows' team links (and the owner team_id when the new row has none) to the
   * (new project, new concrete engine) row, created empty when missing (discovery keeps it while
   * the managed stack sits on that daemon, and adopts it on deploy). Copy, not move: the old rows
   * keep their links while their containers still run there, and a migration that fails and goes
   * back to the source loses nothing; retireStackRow later moves what is left. Excluded links are
   * copied as excluded, so a team with every resource does not gain a stack an admin excluded from
   * it. A new row that is not this stack's (foreignTargetReason) gets nothing. Existing links of
   * the new row are never changed.
   *
   * Returns the new row and the old rows it copied from, or null when nothing was copied (no team
   * tied to the old rows, same project and daemon, no concrete target engine, foreign target).
   */
  async shareTeamLinksWithNewKey(
    from: { project: string; engineId: number | null },
    to: { project: string; engineId: number | null },
  ): Promise<{ toStackId: number; fromStackIds: number[] } | null> {
    const renamed = from.project !== to.project;
    const crossDaemon = (await engineFactsService.managedDaemonKey(from.engineId))
      !== (await engineFactsService.managedDaemonKey(to.engineId));
    if (!renamed && !crossDaemon) return null;
    // stacks rows always name a concrete engine: a legacy NULL managed engine is the local one.
    const targetEngineId = to.engineId ?? await engineFactsService.resolveLocalEngineId();
    if (targetEngineId == null) return null;
    const fromEngineIds = await engineFactsService.daemonEngineIds(from.engineId);
    const sourceRows = fromEngineIds.length === 0 ? [] : await db('stacks')
      .where({ compose_project: from.project })
      .whereIn('engine_id', fromEngineIds)
      .select('id', 'name', 'engine_id', 'team_id') as StackRowRef[];
    if (sourceRows.length === 0) return null;
    const links = await db('team_resources')
      .where({ resource_type: 'stack' })
      .whereIn('resource_id', sourceRows.map(r => r.id))
      .select('team_id', 'excluded') as Array<{ team_id: number; excluded: boolean }>;
    // Excluded on any old row wins: the team had no access to the stack through that row, and the
    // routes' guard requires every row of the daemon to be accessible.
    const excludedByTeam = new Map<number, boolean>();
    for (const l of links) excludedByTeam.set(Number(l.team_id), (excludedByTeam.get(Number(l.team_id)) ?? false) || !!l.excluded);
    const ownerTeam = sourceRows.find(r => r.team_id != null)?.team_id ?? null;
    if (excludedByTeam.size === 0 && ownerTeam == null) return null;

    const selectTarget = () => db('stacks').where({ compose_project: to.project, engine_id: targetEngineId })
      .select('id', 'name', 'engine_id', 'team_id').first() as Promise<StackRowRef | undefined>;
    let target = await selectTarget();
    let checkOwner = target != null;
    if (!target) {
      const inserted = await db('stacks')
        .insert({ name: renamed ? to.project : sourceRows[0].name, compose_project: to.project, engine_id: targetEngineId, team_id: ownerTeam })
        .onConflict(['compose_project', 'engine_id'])
        .ignore()
        .returning('id');
      target = await selectTarget();
      if (!target) return null;
      // A discovery pass inserted the row in between: it is not ours to trust blindly.
      checkOwner = inserted.length === 0;
    }
    if (sourceRows.some(r => r.id === target!.id)) return null;
    if (checkOwner) {
      const reason = await foreignTargetReason(target, sourceRows, to.project, targetEngineId);
      if (reason) {
        logger.warn({ from, to, targetEngineId, toStackId: target.id, reason }, 'Stack row of the new project/engine is not this stack\'s: team links not copied');
        return null;
      }
    }
    if (target.team_id == null && ownerTeam != null) {
      // Only an unassigned row is claimed: an owner team already set is never overwritten.
      await db('stacks').where({ id: target.id }).whereNull('team_id').update({ team_id: ownerTeam });
    }
    for (const [teamId, excluded] of excludedByTeam) {
      await db('team_resources')
        .insert({ team_id: teamId, resource_type: 'stack', resource_id: target.id, excluded })
        .onConflict(['team_id', 'resource_type', 'resource_id'])
        .ignore();
    }
    logger.info({ from, to, toStackId: target.id, teams: [...excludedByTeam.keys()], ownerTeam }, 'Team access copied to the stack row of the new project/engine');
    return { toStackId: target.id, fromStackIds: sourceRows.map(r => r.id) };
  },

  /**
   * Resource limits live on the discovery `stacks` row of (compose_project, engine), and the
   * compose runner looks them up by (project, daemon-equivalent engine). A managed stack that
   * changes project (rename) or daemon has nothing linking it to its old row: the next deploy would
   * run without caps or GPU restriction, and the old row, which discovery keeps because it carries
   * limits, would linger as a ghost that a later stack of the old name on that daemon inherits.
   *
   * Copies the limits to the (new project, new concrete engine) row, creating it when missing. With
   * `retireSource: 'if-empty'` the old row is then retired (references handed over, limits dropped,
   * so discovery removes it) once the old project has no container left on the old engine;
   * containers still there (a renamed running stack, a partly-up failed deploy, a just-save of a
   * running stack) keep their limits, so the copy stays a copy. 'never' leaves the retire to the
   * caller, e.g. migrateEngine after a successful deploy on the target. A stack without limits
   * still hands its team link and proxy hosts over under 'if-empty' (handOverEmptySourceRows).
   *
   * An existing target row that belongs to someone else (foreignTargetReason) receives nothing:
   * no limits, no retire, logged; the result then says carried: false with no row ids.
   *
   * `created` / `previousLimits` describe what the LIMITS carry did to the target row (see
   * stackService.carryResourceLimits), so a failed migration can take exactly that back. A row the
   * team hand-over creates for a stack without limits is not reported there.
   *
   * null when neither the project nor the daemon changes (the runner already resolves the limits
   * by daemon equivalence) or when no concrete target engine is known.
   */
  async carryResourceLimitsToNewKey(
    from: { project: string; engineId: number | null },
    to: { project: string; engineId: number | null },
    opts: { retireSource: 'if-empty' | 'never' },
  ): Promise<(LimitsCarry & { retired: boolean }) | null> {
    const renamed = from.project !== to.project;
    const crossDaemon = (await engineFactsService.managedDaemonKey(from.engineId))
      !== (await engineFactsService.managedDaemonKey(to.engineId));
    if (!renamed && !crossDaemon) return null;
    // stacks rows always name a concrete engine: a legacy NULL managed engine is the local one.
    const targetEngineId = to.engineId ?? await engineFactsService.resolveLocalEngineId();
    if (targetEngineId == null) {
      logger.warn({ from, to }, 'No local engine row: resource limits not carried to the new project/engine');
      return null;
    }
    const fromEngineIds = await engineFactsService.daemonEngineIds(from.engineId);
    // The source daemon's rows, in fromEngineIds order (the order planCarry picks its source in).
    const sourceRows = (fromEngineIds.length === 0 ? [] : await db('stacks')
      .where({ compose_project: from.project })
      .whereIn('engine_id', fromEngineIds)
      .select('id', 'name', 'engine_id', 'team_id') as StackRowRef[])
      .sort((a, b) => fromEngineIds.indexOf(Number(a.engine_id)) - fromEngineIds.indexOf(Number(b.engine_id)));
    const target = await db('stacks').where({ compose_project: to.project, engine_id: targetEngineId })
      .select('id', 'name', 'engine_id', 'team_id').first() as StackRowRef | undefined;
    if (target && !sourceRows.some(r => r.id === target.id)) {
      const reason = await foreignTargetReason(target, sourceRows, to.project, targetEngineId);
      if (reason) {
        // Skipped, not refused: the managed stack is saved or moved already, or about to be (a
        // refusal belongs to the caller check, before the write). Its limits stay on its old row.
        logger.warn({ from, to, targetEngineId, toStackId: target.id, reason }, 'Stack row of the new project/engine is not this stack\'s: resource limits, team links and proxy hosts not handed over');
        return { fromStackId: null, toStackId: null, carried: false, adjusted: null, created: false, previousLimits: null, retired: false };
      }
    }
    const { stackService } = await import('./stack.service');
    const carry = await stackService.carryResourceLimits(from.project, fromEngineIds, targetEngineId, { toProject: to.project });
    if (opts.retireSource !== 'if-empty') return { ...carry, retired: false };
    if (!carry.carried) {
      const handedOver = await handOverEmptySourceRows(from.project, sourceRows, to.project, targetEngineId, target);
      return handedOver ? { ...carry, ...handedOver, retired: true } : { ...carry, retired: false };
    }
    let retired = false;
    if (carry.fromStackId != null && carry.toStackId != null && carry.fromStackId !== carry.toStackId) {
      const src = await db('stacks').where({ id: carry.fromStackId }).select('engine_id').first() as { engine_id: number | null } | undefined;
      if (!(await projectHasContainers(from.project, carry.fromStackId, src?.engine_id ?? null))) {
        await stackService.retireStackRow(carry.fromStackId, carry.toStackId);
        retired = true;
      }
    }
    return { ...carry, retired };
  },

  async setStatus(id: number, status: ManagedStackStatus, errorMessage: string | null = null): Promise<void> {
    await db('managed_stacks').where({ id }).update({
      status,
      error_message: errorMessage,
      updated_at: new Date(),
    });
  },

  async delete(id: number): Promise<boolean> {
    const count = await db('managed_stacks').where({ id }).delete();
    return count > 0;
  },

  /**
   * Decrypt and return the git deploy token for a stack. Server-side only — never called from
   * a controller handler; the token is consumed by sourceManager at clone/pull time and by
   * the git-poller worker.
   */
  async getGitToken(id: number): Promise<string | null> {
    const row = await db('managed_stacks').where({ id }).select('git_token_enc').first();
    if (!row?.git_token_enc) return null;
    try { return decryptSecret(row.git_token_enc as string); } catch { return null; }
  },

  /** Record a successful (or failed) deploy in the rollback timeline. Best-effort — never throws. */
  async recordDeployHistory(entry: {
    managedStackId: number;
    sourceType: ManagedStackSourceType;
    gitUrl?: string | null;
    gitBranch?: string | null;
    gitRef?: string | null;
    composePath?: string | null;
    buildEnabled?: boolean;
    success?: boolean;
    notes?: string | null;
    deployedByUserId?: number | null;
  }): Promise<void> {
    try {
      await db('managed_stack_deploy_history').insert({
        managed_stack_id: entry.managedStackId,
        source_type: entry.sourceType,
        git_url: entry.gitUrl ?? null,
        git_branch: entry.gitBranch ?? null,
        git_ref: entry.gitRef ?? null,
        compose_path: entry.composePath ?? null,
        build_enabled: !!entry.buildEnabled,
        success: entry.success !== false,
        notes: entry.notes ?? null,
        deployed_by_user_id: entry.deployedByUserId ?? null,
      });
    } catch { /* history is best-effort; never break the actual deploy flow */ }
  },

  async listDeployHistory(managedStackId: number, limit = 50): Promise<Array<Record<string, unknown>>> {
    const rows = await db('managed_stack_deploy_history')
      .where({ managed_stack_id: managedStackId })
      .orderBy('deployed_at', 'desc')
      .limit(limit);
    return rows.map(r => ({
      id: r.id,
      managedStackId: r.managed_stack_id,
      sourceType: r.source_type,
      gitUrl: r.git_url,
      gitBranch: r.git_branch,
      gitRef: r.git_ref,
      composePath: r.compose_path,
      buildEnabled: !!r.build_enabled,
      success: !!r.success,
      notes: r.notes,
      deployedAt: (r.deployed_at as Date).toISOString(),
      deployedByUserId: r.deployed_by_user_id,
    }));
  },
};
