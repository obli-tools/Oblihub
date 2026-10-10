import { db } from '../db';
import { parseStackMaintenance } from './maintenance.service';
import type { Stack, Container, ContainerStatus, SleepMode, SleepState, ResourceLimits, ContainerPort, RawPortBinding, EngineHostSnapshot, StackMaintenance } from '@oblihub/shared';
import { normalizeDockerPorts } from '@oblihub/shared';
import { dockerService, type DiscoveredContainer } from './docker.service';
import { logger } from '../utils/logger';
import { withTimeout, TimeoutError } from '../utils/withTimeout';

interface StackRow {
  id: number;
  name: string;
  compose_project: string | null;
  engine_id: number | null;
  check_interval: number;
  auto_update: boolean;
  enabled: boolean;
  url: string | null;
  notify_update_available: boolean | null;
  notify_update_applied: boolean | null;
  notify_delay: number | null;
  last_checked_at: Date | null;
  last_updated_at: Date | null;
  resource_limits: unknown;
  maintenance_window?: unknown;
  team_id?: number | null;
  created_at: Date;
  updated_at: Date;
}

interface ContainerRow {
  id: number;
  stack_id: number | null;
  engine_id: number | null;
  docker_id: string;
  container_name: string;
  image: string;
  image_tag: string;
  current_digest: string | null;
  latest_digest: string | null;
  status: string;
  error_message: string | null;
  excluded: boolean;
  container_config: unknown;
  ports: unknown;
  last_checked_at: Date | null;
  last_updated_at: Date | null;
  sleep_enabled: boolean;
  sleep_after_seconds: number;
  sleep_mode: string;
  last_active_at: Date | null;
  sleep_state: string;
  wake_started_at: Date | null;
  wake_health_path: string | null;
  wake_durations_ms: number[] | string | null;
  created_at: Date;
  updated_at: Date;
}

/** A jsonb column that holds an object (pg returns it parsed; older writes may be a JSON string). */
function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parsePortsColumn(raw: unknown): ContainerPort[] {
  if (!raw) return [];
  try {
    const ports = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(ports) ? ports as ContainerPort[] : [];
  } catch { return []; }
}

export type PortsUpdateDecision = 'write-discovered' | 'keep-stored' | 'seed';

/**
 * What discovery does with a container's stored ports. A stopped container reports no Ports in
 * /containers/json; overwriting the column with that empty list broke sleep wake probes, the proxy
 * port picker and port-conflict checks for every stopped (or sleeping) container.
 */
export function portsUpdateDecision(input: {
  running: boolean;
  discovered: readonly ContainerPort[];
  stored: readonly ContainerPort[];
  portsSeeded: boolean;
}): PortsUpdateDecision {
  if (input.running || input.discovered.length > 0) return 'write-discovered';
  if (input.stored.length > 0) return 'keep-stored';
  return input.portsSeeded ? 'keep-stored' : 'seed';
}

interface InspectPortsShape {
  Config?: { ExposedPorts?: Record<string, unknown> | null } | null;
  HostConfig?: { PortBindings?: Record<string, Array<{ HostIp?: string | null; HostPort?: string | null }> | null> | null } | null;
}

/**
 * Port bindings of a container that may be stopped, rebuilt from its configuration: a stopped
 * container has no NetworkSettings.Ports, but its exposed ports and requested bindings survive.
 */
export function bindingsFromInspect(info: InspectPortsShape): RawPortBinding[] {
  const parseKey = (key: string): { port: number; type: string } | null => {
    const [portText, proto] = key.split('/');
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { port, type: (proto || 'tcp').toLowerCase() };
  };
  const out: RawPortBinding[] = [];
  for (const key of Object.keys(info.Config?.ExposedPorts ?? {})) {
    const parsed = parseKey(key);
    if (parsed) out.push({ privatePort: parsed.port, type: parsed.type });
  }
  for (const [key, bindings] of Object.entries(info.HostConfig?.PortBindings ?? {})) {
    const parsed = parseKey(key);
    if (!parsed || !Array.isArray(bindings)) continue;
    for (const b of bindings) {
      // An empty HostPort is an ephemeral port: the actual number only exists while the container runs.
      if (!b?.HostPort) continue;
      out.push({ privatePort: parsed.port, publicPort: Number(b.HostPort), type: parsed.type, ip: b.HostIp ?? null });
    }
  }
  return out;
}

/** Seeding inspects per discovery pass, and how long each may take. */
const PORT_SEED_BUDGET = 20;
const PORT_SEED_TIMEOUT_MS = 5_000;
/** Timeouts after which a pass stops seeding: a slow engine must not stall discovery of every engine. */
const PORT_SEED_MAX_TIMEOUTS = 2;

function rowToContainer(row: ContainerRow): Container {
  const ports = parsePortsColumn(row.ports);
  const containerConfig = parseJsonObject(row.container_config);
  return {
    id: row.id,
    stackId: row.stack_id,
    engineId: row.engine_id,
    dockerId: row.docker_id,
    containerName: row.container_name,
    image: row.image,
    imageTag: row.image_tag,
    currentDigest: row.current_digest,
    latestDigest: row.latest_digest,
    status: row.status as ContainerStatus,
    errorMessage: row.error_message,
    excluded: row.excluded,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    lastUpdatedAt: row.last_updated_at?.toISOString() ?? null,
    ports,
    networkMode: typeof containerConfig?.networkMode === 'string' ? containerConfig.networkMode : null,
    sleepEnabled: row.sleep_enabled,
    sleepAfterSeconds: row.sleep_after_seconds,
    sleepMode: row.sleep_mode as SleepMode,
    sleepState: row.sleep_state as SleepState,
    lastActiveAt: row.last_active_at?.toISOString() ?? null,
    wakeStartedAt: row.wake_started_at?.toISOString() ?? null,
    wakeHealthPath: row.wake_health_path,
    wakeDurationsMs: ((): number[] => {
      const raw = row.wake_durations_ms;
      if (Array.isArray(raw)) return raw as number[];
      if (typeof raw === 'string' && raw) { try { return JSON.parse(raw) as number[]; } catch { return []; } }
      return [];
    })(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function parseResourceLimits(raw: unknown): ResourceLimits | null {
  const limits = parseJsonObject(raw) as ResourceLimits | null;
  if (!limits) return null;
  // Rows saved before MPS support have no `mps` key; readers compare it against null.
  return 'mps' in limits ? limits : { ...limits, mps: null };
}

function rowToStack(row: StackRow, containers: Container[] = []): Stack {
  return {
    id: row.id,
    name: row.name,
    composeProject: row.compose_project,
    engineId: row.engine_id,
    checkInterval: row.check_interval,
    autoUpdate: row.auto_update,
    enabled: row.enabled,
    url: row.url || null,
    notifyUpdateAvailable: row.notify_update_available ?? null,
    notifyUpdateApplied: row.notify_update_applied ?? null,
    notifyDelay: row.notify_delay ?? null,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    lastUpdatedAt: row.last_updated_at?.toISOString() ?? null,
    containers,
    resourceLimits: parseResourceLimits(row.resource_limits),
    maintenanceWindow: parseStackMaintenance(row.maintenance_window),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Compose projects with a managed stack on this engine's daemon, whatever its status. Their stacks
 * row carries the team link that non-admin access to the managed stack goes through (the routes'
 * per-id guard, list()): the non-admin create pre-creates it for a draft, an engine move or rename
 * copies it there, and after a Down the row has no container. Dropping it would lock the team out
 * (403) and hand the next deploy a fresh row without a team.
 */
async function managedProjectsOnDaemon(engineId: number): Promise<Set<string>> {
  const rows = await db('managed_stacks')
    .select('compose_project', 'engine_id') as Array<{ compose_project: string; engine_id: number | null }>;
  const out = new Set<string>();
  if (rows.length === 0) return out;
  // Dynamic like the scheduler import below; a NULL engine_id is the local daemon (managedDaemonKey).
  const { engineFactsService } = await import('./engineFacts.service');
  const engineKey = await engineFactsService.daemonKey(engineId);
  for (const r of rows) {
    if (await engineFactsService.managedDaemonKey(r.engine_id ?? null) === engineKey) out.add(r.compose_project);
  }
  return out;
}

/**
 * Whether an engine of this engine's daemon (every local-type engine shares the local socket)
 * already has a row of the project. Migration 054 skips such a project, and so does discovery: an
 * orphan left by 054 stays orphaned, and deleteRowsForProject clears it with the managed stack.
 */
async function projectHasRowOnDaemon(project: string, engineId: number): Promise<boolean> {
  const { engineFactsService } = await import('./engineFacts.service');
  const ids = await engineFactsService.daemonEngineIds(engineId);
  if (ids.length === 0) return false;
  return (await db('stacks').where({ compose_project: project }).whereIn('engine_id', ids).first('id')) != null;
}

// ── Cross-daemon carry of engine-specific GPU settings ──────────────────────

/** What a carry to another daemon removed from the GPU settings, so the UI can ask for a re-pick. */
export interface LimitsCarryAdjustments {
  /** visibleGpuIds entries that do not name a card of the target host. */
  gpuIdsDropped: string[];
  /** mps.pinnedMemLimitGb keys (GPU UUIDs) that do not name a card of the target host. */
  vramCapsDropped: string[];
  /** A non-empty GPU restriction lost every id and was stored as [] (no GPU), not null (every GPU). */
  gpuRevoked: boolean;
  /** The target's GPU catalog could not be read (agent starting, engine slow or unreachable), so
   *  nothing could be matched and every GPU id / VRAM cap was dropped. */
  targetCatalogUnknown: boolean;
}

export function limitsCarryAdjusted(a: LimitsCarryAdjustments | null | undefined): boolean {
  return a != null && (a.gpuIdsDropped.length > 0 || a.vramCapsDropped.length > 0);
}

const GPU_UUID_PREFIX_RE = /^GPU-/i;

/**
 * The limits to store for the same project on ANOTHER daemon. visibleGpuIds and the MPS VRAM caps
 * name cards of the source host: an index is a slot number there and would select whatever card
 * holds that slot on the target (the PUT path refuses such ids via assertGpusExist, a migration
 * would otherwise bypass it), so indexes are always dropped. A UUID is kept only when the target's
 * known catalog lists it (same physical card, e.g. two engine rows of one host). A restriction that
 * loses every id fails closed as [] — null would grant every GPU of the target. The other MPS
 * settings are kept: the renderer only emits them while a live daemon answers on the target.
 */
export function limitsForOtherDaemon(
  limits: Record<string, unknown>,
  targetSnap: EngineHostSnapshot | null,
): { limits: Record<string, unknown>; adjusted: LimitsCarryAdjustments } {
  const status = targetSnap?.gpu.status;
  // 'no-gpu' is a known, empty catalog: nothing matches, but the drop is not due to a blind spot.
  const catalogKnown = status === 'ok' || status === 'no-gpu';
  const targetUuids = new Set<string>();
  if (status === 'ok') {
    for (const g of targetSnap?.gpu.gpus ?? []) if (g.uuid) targetUuids.add(g.uuid.toLowerCase());
  }
  const onTarget = (id: string): boolean => GPU_UUID_PREFIX_RE.test(id) && targetUuids.has(id.toLowerCase());

  const out: Record<string, unknown> = { ...limits };
  const adjusted: LimitsCarryAdjustments = { gpuIdsDropped: [], vramCapsDropped: [], gpuRevoked: false, targetCatalogUnknown: false };

  // null (no restriction) and [] (revoked) are portable as they are.
  const ids = limits.visibleGpuIds;
  if (Array.isArray(ids) && ids.length > 0) {
    const kept: string[] = [];
    for (const raw of ids) {
      const id = String(raw);
      if (onTarget(id)) kept.push(id);
      else adjusted.gpuIdsDropped.push(id);
    }
    if (adjusted.gpuIdsDropped.length > 0) {
      out.visibleGpuIds = kept;
      adjusted.gpuRevoked = kept.length === 0;
    }
  }

  const mps = parseJsonObject(limits.mps);
  const pinned = mps ? parseJsonObject(mps.pinnedMemLimitGb) : null;
  if (mps && pinned) {
    const keptCaps: Record<string, unknown> = {};
    for (const [uuid, gb] of Object.entries(pinned)) {
      if (onTarget(uuid)) keptCaps[uuid] = gb;
      else adjusted.vramCapsDropped.push(uuid);
    }
    if (adjusted.vramCapsDropped.length > 0) {
      out.mps = { ...mps, pinnedMemLimitGb: Object.keys(keptCaps).length > 0 ? keptCaps : null };
    }
  }

  adjusted.targetCatalogUnknown = !catalogKnown && limitsCarryAdjusted(adjusted);
  return { limits: out, adjusted };
}

/** The target engine's host snapshot within 2 s, or null: an unknown catalog keeps no GPU id. */
async function carryTargetSnapshot(engineId: number): Promise<EngineHostSnapshot | null> {
  try {
    // Dynamic like the other engineHost imports: a static one would pull the host-agent graph into
    // every importer of stack.service.
    const { engineHostService } = await import('./engineHost.service');
    return await withTimeout(engineHostService.getSnapshot(engineId), 2_000, `host snapshot of engine ${engineId}`);
  } catch (err) {
    logger.warn({ engineId, err: err instanceof Error ? err.message : String(err) }, 'Target engine host snapshot unavailable for the limits carry');
    return null;
  }
}

/** Only GPU-specific settings need the target's catalog; skip the snapshot when there are none. */
function hasEngineSpecificGpuSettings(limits: Record<string, unknown>): boolean {
  if (Array.isArray(limits.visibleGpuIds) && limits.visibleGpuIds.length > 0) return true;
  const pinned = parseJsonObject(parseJsonObject(limits.mps)?.pinnedMemLimitGb);
  return pinned != null && Object.keys(pinned).length > 0;
}

interface CarryPlan {
  src: StackRow;
  limits: Record<string, unknown>;
  adjusted: LimitsCarryAdjustments;
}

/** The source row (first of `fromEngineIds` whose row has limits) and the limits to write on `toEngineId`. */
async function planCarry(project: string, fromEngineIds: number[], toEngineId: number): Promise<CarryPlan | null> {
  if (fromEngineIds.length === 0) return null;
  const sources = await db<StackRow>('stacks').where({ compose_project: project }).whereIn('engine_id', fromEngineIds);
  let src: StackRow | undefined;
  for (const id of fromEngineIds) {
    src = sources.find(r => r.engine_id === id && parseJsonObject(r.resource_limits) != null);
    if (src) break;
  }
  const limits = src ? parseJsonObject(src.resource_limits) : null;
  if (!src || !limits) return null;
  // fromEngineIds are the source daemon's rows: a target among them is the same host, where the ids
  // stay valid as they are.
  if (fromEngineIds.includes(toEngineId) || !hasEngineSpecificGpuSettings(limits)) {
    return { src, limits, adjusted: { gpuIdsDropped: [], vramCapsDropped: [], gpuRevoked: false, targetCatalogUnknown: false } };
  }
  return { src, ...limitsForOtherDaemon(limits, await carryTargetSnapshot(toEngineId)) };
}

export const stackService = {
  /**
   * Whether a managed stack drives `project` on the daemon of `engineId` (managedProjectsOnDaemon):
   * compared by daemon key, so a same-named managed stack on another daemon does not count.
   */
  async isManagedOnDaemon(project: string, engineId: number): Promise<boolean> {
    return (await managedProjectsOnDaemon(engineId)).has(project);
  },

  /**
   * Synchronize database with live Docker state for ONE engine.
   * Stacks and containers are scoped by `engineId` — a sync of engine A never touches engine B's rows.
   * Docker IDs are 12-char prefixes and can theoretically collide across engines, so the (engine_id, docker_id)
   * pair is used for lookups.
   */
  async syncWithDocker(discovered: DiscoveredContainer[], engineId: number): Promise<void> {
    // Group by compose project
    const projectGroups = new Map<string | null, DiscoveredContainer[]>();
    for (const c of discovered) {
      const key = c.composeProject;
      if (!projectGroups.has(key)) projectGroups.set(key, []);
      projectGroups.get(key)!.push(c);
    }

    // This engine's container rows, read once instead of one query per discovered container.
    type SyncRow = Pick<ContainerRow, 'id' | 'stack_id' | 'docker_id' | 'container_name' | 'ports' | 'container_config' | 'status' | 'sleep_state' | 'excluded'>;
    const engineRows = await db<ContainerRow>('containers')
      .where({ engine_id: engineId })
      .select('id', 'stack_id', 'docker_id', 'container_name', 'ports', 'container_config', 'status', 'sleep_state', 'excluded') as SyncRow[];
    const liveIds = new Set(discovered.map(c => c.dockerId));
    const byDockerId = new Map<string, SyncRow>();
    // Rows whose container is gone, by name: re-association candidates for a recreated container.
    const byName = new Map<string, SyncRow[]>();
    for (const row of engineRows) {
      byDockerId.set(row.docker_id, row);
      if (liveIds.has(row.docker_id)) continue;
      const list = byName.get(row.container_name);
      if (list) list.push(row); else byName.set(row.container_name, [row]);
    }

    let seedBudget = PORT_SEED_BUDGET;
    let seedTimeouts = 0;
    // Compose projects a managed stack drives on this daemon. Read lazily and at most once per pass:
    // only an orphan adoption or an empty compose row about to be cleaned up needs it.
    let managed: Set<string> | null = null;

    // Ensure stacks exist for each compose project (scoped to this engine)
    for (const [project, containers] of projectGroups) {
      let stackId: number;

      if (project) {
        let stack = await db<StackRow>('stacks').where({ compose_project: project, engine_id: engineId }).first();
        if (!stack) {
          // A `stacks` row of this project with engine_id NULL is adopted only when it is a
          // pre-upgrade draft: the non-admin managed-stack create pre-created it (with the team
          // link) before engine_id propagation was fixed. Such a row has no container rows, no
          // resource limits and no watchdog journal row, a managed stack drives its project on
          // this daemon, and the daemon has no row of the project yet. These are migration 054's
          // guards. Adopting updates the row in place, so team_id and the team resource links stay.
          //
          // Every other NULL-engine row belonged to a deleted engine: the former delete set
          // engine_id NULL and left its team and proxy links, limits and dead container rows.
          // Binding it to whichever engine now shows the same project name would hand all of that
          // to an unrelated stack, so it stays orphaned (listed under "Unknown engine") and a
          // fresh row is created.
          const orphanIds = (await db('stacks').where({ compose_project: project }).whereNull('engine_id').orderBy('id').pluck('id')).map(Number);
          let orphan: StackRow | undefined;
          if (orphanIds.length > 0) {
            managed ??= await managedProjectsOnDaemon(engineId);
            if (managed.has(project) && !(await projectHasRowOnDaemon(project, engineId))) {
              orphan = await db<StackRow>('stacks')
                .whereIn('id', orphanIds)
                .whereNull('engine_id')
                .whereNull('resource_limits')
                .whereRaw('NOT EXISTS (SELECT 1 FROM containers c WHERE c.stack_id = stacks.id)')
                .whereRaw('NOT EXISTS (SELECT 1 FROM priority_yields py WHERE py.stack_id = stacks.id)')
                .orderBy('id')
                .first();
            }
            if (!orphan) {
              logger.info({ project, engineId, orphanStackIds: orphanIds },
                'NULL-engine stack rows of this project are not a pre-upgrade draft of a managed stack on this engine: left orphaned, creating a fresh row');
            }
          }
          if (orphan) {
            await db('stacks').where({ id: orphan.id }).update({ engine_id: engineId });
            stack = { ...orphan, engine_id: engineId };
            logger.info({ project, stackId: stack.id, engineId }, 'Adopted orphan stack row (was engine_id=null)');
          } else {
            const [newStack] = await db<StackRow>('stacks')
              .insert({ name: project, compose_project: project, engine_id: engineId })
              .returning('*');
            stack = newStack;
            logger.info({ project, stackId: stack.id, engineId }, 'New stack discovered');
          }
        }
        stackId = stack.id;
      } else {
        // Per-engine synthetic "Standalone" stack
        let stack = await db<StackRow>('stacks').whereNull('compose_project').where({ engine_id: engineId }).first();
        if (!stack) {
          const [newStack] = await db<StackRow>('stacks')
            .insert({ name: 'Standalone', compose_project: null, engine_id: engineId })
            .returning('*');
          stack = newStack;
        }
        stackId = stack.id;
      }

      // Upsert containers — match on (docker_id, engine_id)
      for (const c of containers) {
        const isStopped = c.state !== 'running';
        let existing = byDockerId.get(c.dockerId);
        let reassociated = false;
        if (!existing) {
          // Compose recreates (deploy, resources apply) change docker ids. Matching on the id alone
          // deleted the row and inserted a new one, losing per-container settings (sleep), the
          // excluded flag and proxy wake links. The same name in the same stack is the same service.
          const candidates = byName.get(c.containerName);
          const index = candidates ? candidates.findIndex(r => r.stack_id === stackId) : -1;
          if (candidates && index >= 0) {
            existing = candidates.splice(index, 1)[0];
            reassociated = true;
          }
        }

        const config = parseJsonObject(existing?.container_config) ?? {};
        const nextConfig: Record<string, unknown> = { ...config, networkMode: c.networkMode };
        // undefined = leave the stored column as it is.
        let portsJson: string | undefined;
        const decision = portsUpdateDecision({
          running: c.state === 'running',
          discovered: c.ports,
          stored: existing ? parsePortsColumn(existing.ports) : [],
          portsSeeded: config.portsSeeded === true,
        });
        if (decision === 'write-discovered') {
          portsJson = JSON.stringify(c.ports);
        } else if (decision === 'seed' && seedBudget > 0 && seedTimeouts < PORT_SEED_MAX_TIMEOUTS) {
          seedBudget--;
          try {
            const info = await withTimeout(dockerService.inspectContainer(c.dockerId, engineId), PORT_SEED_TIMEOUT_MS, 'seed ports');
            portsJson = JSON.stringify(normalizeDockerPorts(bindingsFromInspect(info)));
            nextConfig.portsSeeded = true;
          } catch (err) {
            if (err instanceof TimeoutError) {
              // portsSeeded stays unset so the next pass retries.
              seedTimeouts++;
              logger.warn({ engineId, containerName: c.containerName }, 'Port seeding inspect timed out — retrying on the next discovery pass');
            } else {
              portsJson = '[]';
              nextConfig.portsSeeded = true;
              logger.debug({ engineId, containerName: c.containerName, err: err instanceof Error ? err.message : String(err) }, 'Port seeding inspect failed');
            }
          }
        }
        const configJson = JSON.stringify(nextConfig);

        if (existing) {
          const update: Record<string, unknown> = {
            stack_id: stackId,
            container_name: c.containerName,
            image: c.image,
            image_tag: c.imageTag,
            container_config: configJson,
            updated_at: new Date(),
          };
          if (portsJson !== undefined) update.ports = portsJson;
          if (reassociated) {
            update.docker_id = c.dockerId;
            // Sleep, excluded, wake and digest columns are kept. A new container may run a new image,
            // so its update status is recomputed by the next check.
            if (existing.status === 'excluded') {
              // stays excluded
            } else if (isStopped) {
              if (existing.sleep_state !== 'sleeping') update.status = 'stopped';
            } else {
              update.status = 'unknown';
            }
            logger.info({ containerId: existing.id, containerName: c.containerName, oldDockerId: existing.docker_id, newDockerId: c.dockerId, stackId, engineId },
              'Re-associated container row after recreation');
          } else if (isStopped && existing.status !== 'excluded' && existing.sleep_state !== 'sleeping') {
            // If the container is sleeping (we stopped it on purpose), don't overwrite the sleep state.
            // Discovery sees it as 'stopped' but the sleep_state row tells the real story.
            update.status = 'stopped';
          } else if (!isStopped && existing.status === 'stopped') {
            update.status = 'unknown';
          }
          await db('containers').where({ id: existing.id }).update(update);
        } else {
          await db('containers').insert({
            stack_id: stackId,
            engine_id: engineId,
            docker_id: c.dockerId,
            container_name: c.containerName,
            image: c.image,
            image_tag: c.imageTag,
            status: isStopped ? 'stopped' : 'unknown',
            ports: portsJson ?? '[]',
            container_config: configJson,
          });
          logger.info({ containerName: c.containerName, stackId, engineId }, 'New container discovered');
        }
      }
    }

    // Remove containers that no longer exist on this engine
    const liveDockerIds = discovered.map(c => c.dockerId);
    if (liveDockerIds.length > 0) {
      await db('containers')
        .where({ engine_id: engineId })
        .whereNotIn('docker_id', liveDockerIds)
        .whereNot('status', 'excluded')
        .delete();
    }

    // Clean up empty stacks for this engine. A row that carries resource limits or a watchdog
    // journal row is kept: limits (CPU/RAM caps, GPU restriction, priority, yield links) must survive
    // a Down → Deploy or a watchdog stop. The (compose_project, engine_id) lookup above re-adopts
    // the row when its containers come back.
    // A row of a project that a managed stack drives on this daemon is kept too, whatever the
    // managed stack's status (draft, stopped after a Down, moved here): non-admin team access goes
    // through that row (see managedProjectsOnDaemon). Deleting the managed stack removes it; a
    // managed stack renamed or moved away no longer protects the rows it left.
    // Rows of non-managed projects are still dropped when empty, team link or not: keeping them
    // would leave a ghost for every hand-deployed project removed from the engine.
    const engineStacks = await db<StackRow>('stacks').where({ engine_id: engineId }).select('id', 'compose_project', 'resource_limits', 'maintenance_window');
    const journalled = engineStacks.length === 0
      ? new Set<number>()
      : new Set((await db('priority_yields').whereIn('stack_id', engineStacks.map(s => s.id)).pluck('stack_id')).map(Number));
    for (const s of engineStacks) {
      const count = await db('containers').where({ stack_id: s.id }).count('* as cnt').first();
      if (Number(count?.cnt) === 0) {
        // A maintenance window too: the operator's "updates only at night" must survive a Down → Deploy.
        if (s.resource_limits != null || s.maintenance_window != null || journalled.has(s.id)) {
          logger.debug({ stackId: s.id, project: s.compose_project, engineId }, 'Kept empty stack row: it carries resource limits, a maintenance window or a watchdog journal');
          continue;
        }
        if (s.compose_project != null) {
          managed ??= await managedProjectsOnDaemon(engineId);
          if (managed.has(s.compose_project)) {
            logger.debug({ stackId: s.id, project: s.compose_project, engineId }, 'Kept empty stack row: a managed stack drives this project on this engine');
            continue;
          }
        }
        await db('stacks').where({ id: s.id }).delete();
        logger.info({ stackId: s.id, project: s.compose_project, engineId }, 'Cleaned up empty stack');
      }
    }
  },

  // ── Limit-row helpers for managed-stack flows (delete, engine migration) ──

  /**
   * Deletes the discovery rows of a compose project on the given engines (a managed stack's
   * daemon). Needed because discovery keeps empty rows that carry limits: without this a deleted
   * managed stack would linger as a ghost. Returns the deleted stack ids.
   *
   * `includeLegacyNullRows` (local daemon only): also deletes the project's NULL-engine rows that
   * hold nothing (no containers, no limits, no watchdog journal). The pre-upgrade non-admin create
   * left such rows for local drafts; migration 054 adopts one per project, but not when a local row
   * already existed, and discovery never adopts it then either, so only this delete can clear it.
   */
  async deleteRowsForProject(project: string, engineIds: number[], opts: { onlyEmpty?: boolean; includeLegacyNullRows?: boolean } = {}): Promise<number[]> {
    const rows: Array<Pick<StackRow, 'id'>> = engineIds.length === 0
      ? []
      : await db<StackRow>('stacks').where({ compose_project: project }).whereIn('engine_id', engineIds).select('id');
    if (opts.includeLegacyNullRows) {
      const legacy = await db<StackRow>('stacks')
        .where({ compose_project: project })
        .whereNull('engine_id')
        .whereNull('resource_limits')
        .whereRaw('NOT EXISTS (SELECT 1 FROM containers c WHERE c.stack_id = stacks.id)')
        .whereRaw('NOT EXISTS (SELECT 1 FROM priority_yields py WHERE py.stack_id = stacks.id)')
        .select('id');
      rows.push(...legacy);
    }
    if (rows.length === 0) return [];
    const { schedulerService } = await import('./scheduler.service');
    // Dynamic like the scheduler import above: only this delete path needs the journal.
    const { yieldJournal } = await import('./stackPower.service');
    const deleted: number[] = [];
    for (const row of rows) {
      if (opts.onlyEmpty) {
        const count = await db('containers').where({ stack_id: row.id }).count('* as cnt').first();
        if (Number(count?.cnt) > 0) continue;
      }
      // Deleting is still right in both branches: after a successful down the containers are gone,
      // and with onlyEmpty discovery lists with all:true, so no container rows means no containers.
      // The log keeps a trace of the yield that will never be resumed.
      const journal = await yieldJournal.get(row.id);
      if (journal && journal.containers.length > 0) {
        logger.warn({ stackId: row.id, project, onlyEmpty: !!opts.onlyEmpty, containers: journal.containers.map(e => e.name) },
          'Deleting a stack row the priority watchdog still journals: its containers are gone (compose down succeeded, or no container rows left), so the journal row is dropped with nothing to resume');
      }
      schedulerService.reschedule(row.id, 0, false);
      await this.delete(row.id);
      deleted.push(row.id);
    }
    if (deleted.length > 0) logger.info({ project, engineIds, deleted }, 'Deleted stack rows of project');
    return deleted;
  },

  /**
   * What `carryResourceLimits` would drop from the GPU settings on `toEngineId`, without writing
   * anything: lets a migration check them against the target BEFORE it stops the stack on the
   * source (the carry itself runs after `down`). null when there are no limits to carry.
   */
  async planResourceLimitsCarry(
    project: string,
    fromEngineIds: number[],
    toEngineId: number,
  ): Promise<{ fromStackId: number; adjusted: LimitsCarryAdjustments } | null> {
    const plan = await planCarry(project, fromEngineIds, toEngineId);
    return plan ? { fromStackId: plan.src.id, adjusted: plan.adjusted } : null;
  },

  /**
   * Copies a project's resource limits from its row on one of `fromEngineIds` (first match in that
   * order) to its row on `toEngineId`, creating that row when missing, so the compose runner renders
   * the caps for the very first deploy on the target engine. Across daemons the GPU ids and MPS VRAM
   * caps are checked against the target's catalog (limitsForOtherDaemon) instead of copied verbatim;
   * `adjusted` reports what was dropped so the operator can re-pick GPUs on the target.
   * `opts.toProject` keys the target row by another project (a managed-stack rename); the source
   * stays keyed by `project`.
   *
   * `created` (this carry inserted the target row) and `previousLimits` (the target row's limits
   * before the write, null when it had none or did not exist) come from the same read the write is
   * based on, so a caller that must take the carry back (a failed engine migration) needs no
   * snapshot of its own, which could see another state than the one the carry overwrote.
   */
  async carryResourceLimits(
    project: string,
    fromEngineIds: number[],
    toEngineId: number,
    opts: { toProject?: string } = {},
  ): Promise<{
    fromStackId: number | null;
    toStackId: number | null;
    carried: boolean;
    adjusted: LimitsCarryAdjustments | null;
    created: boolean;
    previousLimits: unknown;
  }> {
    const toProject = opts.toProject ?? project;
    const target = await db<StackRow>('stacks').where({ compose_project: toProject, engine_id: toEngineId }).first();
    const previousLimits: unknown = target?.resource_limits ?? null;
    // Keyed by the source project: its fromEngineIds.includes(toEngineId) same-host shortcut still
    // holds for a rename, where the GPU ids stay valid as they are.
    const plan = await planCarry(project, fromEngineIds, toEngineId);
    if (!plan) return { fromStackId: null, toStackId: target?.id ?? null, carried: false, adjusted: null, created: false, previousLimits };
    const { src, adjusted } = plan;
    if (limitsCarryAdjusted(adjusted)) {
      logger.warn({ project, toProject, fromStackId: src.id, toEngineId, adjusted }, 'GPU settings of the source engine are not on the target engine: dropped from the carried limits');
    }

    const limitsJson = JSON.stringify(plan.limits);
    if (target) {
      if (target.id !== src.id) {
        await db('stacks').where({ id: target.id }).update({ resource_limits: limitsJson, updated_at: new Date() });
      }
      logger.info({ project, toProject, fromStackId: src.id, toStackId: target.id, toEngineId }, 'Carried resource limits to the target engine row');
      return { fromStackId: src.id, toStackId: target.id, carried: true, adjusted, created: false, previousLimits };
    }
    // A discovery pass may insert the same (project, engine) row concurrently: merge instead of failing.
    const [inserted] = await db('stacks')
      .insert({ name: toProject === project ? src.name : toProject, compose_project: toProject, engine_id: toEngineId, team_id: src.team_id ?? null, resource_limits: limitsJson })
      .onConflict(['compose_project', 'engine_id'])
      .merge({ resource_limits: limitsJson, updated_at: new Date() })
      .returning('id');
    const toStackId = Number(typeof inserted === 'object' && inserted !== null ? (inserted as { id: number }).id : inserted);
    logger.info({ project, toProject, fromStackId: src.id, toStackId, toEngineId }, 'Created target engine stack row with carried resource limits');
    // A discovery pass that inserted the row in between (merged above) never sets limits, so null
    // stays the right "before"; `created` then also lets an undo delete that empty row, as it would
    // delete the one this insert made.
    return { fromStackId: src.id, toStackId, carried: true, adjusted, created: true, previousLimits: null };
  },

  /**
   * Hands a stack row's references over to its successor after a cross-engine move or a rename:
   * proxy hosts, team links, yield links of Opportunistic stacks and the watchdog journal. The source
   * row then has no limits and no containers, so the next discovery pass removes it — no ghost stack.
   */
  async retireStackRow(fromStackId: number, toStackId: number): Promise<void> {
    if (fromStackId === toStackId) return;
    await db.transaction(async (trx) => {
      await trx('proxy_hosts').where({ stack_id: fromStackId }).update({ stack_id: toStackId });

      // A non-admin team reaches the stack through its row id: left on the source row, the link
      // would vanish with it and the team would lose the moved stack. A team already linked to the
      // successor keeps that link as it is (unique on team, type, id), so its source link is dropped.
      const linkedToTarget = (await trx('team_resources')
        .where({ resource_type: 'stack', resource_id: toStackId })
        .pluck('team_id')).map(Number);
      if (linkedToTarget.length > 0) {
        await trx('team_resources')
          .where({ resource_type: 'stack', resource_id: fromStackId })
          .whereIn('team_id', linkedToTarget)
          .delete();
      }
      await trx('team_resources').where({ resource_type: 'stack', resource_id: fromStackId }).update({ resource_id: toStackId });

      const limitRows = await trx('stacks').whereNotNull('resource_limits').select('id', 'resource_limits') as Array<{ id: number; resource_limits: unknown }>;
      for (const row of limitRows) {
        const limits = parseJsonObject(row.resource_limits);
        const ids = limits?.yieldsToStackIds;
        if (!limits || !Array.isArray(ids) || !ids.map(Number).includes(fromStackId)) continue;
        // Deduplicated; a stack never yields to itself.
        const next = [...new Set(ids.map(Number).map(id => (id === fromStackId ? toStackId : id)))].filter(id => id !== row.id);
        await trx('stacks').where({ id: row.id }).update({
          resource_limits: JSON.stringify({ ...limits, yieldsToStackIds: next }),
          updated_at: new Date(),
        });
      }

      await trx('priority_yields').where({ stack_id: fromStackId }).delete();
      await trx('stacks').where({ id: fromStackId }).update({ resource_limits: null, updated_at: new Date() });
    });
    logger.info({ fromStackId, toStackId }, 'Retired stack row: references moved to its successor');
  },

  /** Get all stacks with their containers */
  async getAll(): Promise<Stack[]> {
    const stackRows = await db<StackRow>('stacks').orderBy('name');
    const containerRows = await db<ContainerRow>('containers').orderBy('container_name');

    const containersByStack = new Map<number, Container[]>();
    for (const row of containerRows) {
      const c = rowToContainer(row);
      if (c.stackId) {
        if (!containersByStack.has(c.stackId)) containersByStack.set(c.stackId, []);
        containersByStack.get(c.stackId)!.push(c);
      }
    }

    return stackRows.map(row => rowToStack(row, containersByStack.get(row.id) || []));
  },

  /** Get a single stack with containers */
  async getById(id: number): Promise<Stack | null> {
    const row = await db<StackRow>('stacks').where({ id }).first();
    if (!row) return null;
    const containerRows = await db<ContainerRow>('containers').where({ stack_id: id }).orderBy('container_name');
    return rowToStack(row, containerRows.map(rowToContainer));
  },

  /** Update stack config */
  async update(id: number, data: { name?: string; checkInterval?: number; autoUpdate?: boolean; enabled?: boolean; url?: string | null; notifyUpdateAvailable?: boolean | null; notifyUpdateApplied?: boolean | null; notifyDelay?: number | null; maintenanceWindow?: StackMaintenance }): Promise<Stack | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.checkInterval !== undefined) update.check_interval = data.checkInterval;
    if (data.autoUpdate !== undefined) update.auto_update = data.autoUpdate;
    if (data.enabled !== undefined) update.enabled = data.enabled;
    if (data.url !== undefined) update.url = data.url;
    if (data.notifyUpdateAvailable !== undefined) update.notify_update_available = data.notifyUpdateAvailable;
    if (data.notifyUpdateApplied !== undefined) update.notify_update_applied = data.notifyUpdateApplied;
    if (data.notifyDelay !== undefined) update.notify_delay = data.notifyDelay;
    if (data.maintenanceWindow !== undefined) update.maintenance_window = data.maintenanceWindow == null ? null : JSON.stringify(data.maintenanceWindow);
    await db('stacks').where({ id }).update(update);
    return this.getById(id);
  },

  /** Delete a stack, its containers, and its history from the database */
  async delete(id: number): Promise<void> {
    await db('update_history').where({ stack_id: id }).delete();
    await db('containers').where({ stack_id: id }).delete();
    await db('notification_bindings').where({ scope: 'stack', scope_id: id }).delete();
    await db('stacks').where({ id }).delete();
  },

  /** Update container status */
  async updateContainerStatus(containerId: number, status: ContainerStatus, latestDigest?: string | null, currentDigest?: string | null, errorMessage?: string | null): Promise<void> {
    const update: Record<string, unknown> = { status, updated_at: new Date(), last_checked_at: new Date() };
    if (latestDigest !== undefined) update.latest_digest = latestDigest;
    if (currentDigest !== undefined) update.current_digest = currentDigest;
    if (errorMessage !== undefined) update.error_message = errorMessage;
    await db('containers').where({ id: containerId }).update(update);
  },

  /** Toggle container excluded flag */
  async setExcluded(containerId: number, excluded: boolean): Promise<void> {
    await db('containers').where({ id: containerId }).update({
      excluded,
      status: excluded ? 'excluded' : 'unknown',
      updated_at: new Date(),
    });
  },

  /** Get container by ID */
  async getContainerById(id: number): Promise<Container | null> {
    const row = await db<ContainerRow>('containers').where({ id }).first();
    return row ? rowToContainer(row) : null;
  },

  /** Get container by Docker ID */
  async getContainerByDockerId(dockerId: string): Promise<Container | null> {
    const row = await db<ContainerRow>('containers').where({ docker_id: dockerId }).first();
    return row ? rowToContainer(row) : null;
  },

  /** Update stack last_checked_at */
  async markChecked(stackId: number): Promise<void> {
    await db('stacks').where({ id: stackId }).update({ last_checked_at: new Date() });
  },

  /** Update stack last_updated_at */
  async markUpdated(stackId: number): Promise<void> {
    await db('stacks').where({ id: stackId }).update({ last_updated_at: new Date() });
  },

  /** Update container docker_id after recreation */
  async updateContainerDockerId(containerId: number, newDockerId: string): Promise<void> {
    await db('containers').where({ id: containerId }).update({ docker_id: newDockerId, updated_at: new Date() });
  },

  /** Read the resource_limits blob for one stack. */
  async getResourceLimits(stackId: number): Promise<ResourceLimits | null> {
    const row = await db<StackRow>('stacks').where({ id: stackId }).first();
    if (!row) return null;
    return parseResourceLimits(row.resource_limits);
  },

  /**
   * Store a stack's resource limits (null clears them). Storage only: applying them to containers is
   * resourceLimits.service's job, and the compose runner re-renders the override from this column
   * before every compose command of the stack.
   */
  async saveResourceLimits(stackId: number, limits: ResourceLimits | null): Promise<void> {
    await db('stacks').where({ id: stackId }).update({
      resource_limits: limits == null ? null : JSON.stringify(limits),
      updated_at: new Date(),
    });
  },

  /**
   * List every Opportunistic stack that yields to at least one other stack — the input the
   * priority watchdog needs to decide which stacks to pause/resume on Critical traffic. Shape is
   * kept minimal (id / composeProject / engineId / limits) so the watchdog doesn't accidentally
   * become a full stack-hydration hotspot when it re-reads this every 30s.
   */
  async getOpportunisticStacksWithYields(): Promise<Array<{
    id: number;
    composeProject: string | null;
    engineId: number | null;
    resourceLimits: ResourceLimits;
  }>> {
    const rows = await db<StackRow>('stacks').whereNotNull('resource_limits');
    const out: Array<{ id: number; composeProject: string | null; engineId: number | null; resourceLimits: ResourceLimits }> = [];
    for (const row of rows) {
      const limits = parseResourceLimits(row.resource_limits);
      if (!limits) continue;
      if (limits.priority !== 'opportunistic') continue;
      if (!limits.yieldsToStackIds || limits.yieldsToStackIds.length === 0) continue;
      out.push({
        id: row.id,
        composeProject: row.compose_project,
        engineId: row.engine_id,
        resourceLimits: limits,
      });
    }
    return out;
  },

  /**
   * Reverse-lookup for the watchdog: given a batch of proxy_host_ids seen in the traffic log,
   * return a Map[proxy_host_id → stack_id] for every host row that has a stack link. Rows whose
   * `stack_id` is null are omitted — a proxy_host with no owning stack can't trigger yielding.
   */
  async getStackIdsByProxyHostIds(proxyHostIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (proxyHostIds.length === 0) return out;
    const rows = await db('proxy_hosts')
      .whereIn('id', proxyHostIds)
      .whereNotNull('stack_id')
      .select('id', 'stack_id');
    for (const r of rows as Array<{ id: number; stack_id: number }>) out.set(r.id, r.stack_id);
    return out;
  },
};
