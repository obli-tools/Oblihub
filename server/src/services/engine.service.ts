import Docker from 'dockerode';
import { db } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { encryptSecret, decryptSecret } from '../utils/crypto';
import { withTimeout } from '../utils/withTimeout';
import { AppError } from '../middleware/errorHandler';
import { clearEngine } from '../state/containerStats.state';
import type { DockerEngine, DockerEngineType, EngineSummary, HostAgentMode } from '@oblihub/shared';

/**
 * Docker engine management.
 *
 * Supports four transports:
 *  - local          → unix socket on the Oblihub host (default seeded engine)
 *  - ssh            → ssh://user@host:port using a stored private key
 *  - https-apikey   → HTTP(S) Docker API behind a socket-proxy with a shared header
 *  - tls            → raw Docker TCP + mTLS (ca/cert/key)
 *
 * `dockerService.forEngine(engineId)` returns a cached dockerode client. Cache is invalidated
 * when an engine is updated or deleted. A failed test re-uses the same builder so the user can
 * iterate on config without restart. Only getClient() fills the cache, and only for an enabled
 * engine: the callers of forEngine() rely on it to refuse a disabled one.
 */

interface EngineRow {
  id: number;
  name: string;
  type: string;
  host: string | null;
  port: number | null;
  ssh_user: string | null;
  ssh_private_key_enc: string | null;
  ssh_known_host: string | null;
  api_key_enc: string | null;
  api_key_header: string | null;
  tls_ca: string | null;
  tls_cert: string | null;
  tls_key_enc: string | null;
  is_default: boolean;
  enabled: boolean;
  tailscale_hostname: string | null;
  tailscale_advertised_routes: string | null;
  host_agent_mode: string;
  last_ping_at: Date | null;
  last_ping_status: string | null;
  last_ping_message: string | null;
  created_at: Date;
  updated_at: Date;
}

function toHostAgentMode(value: string | null | undefined): HostAgentMode {
  return value === 'auto' || value === 'always' || value === 'off' ? value : 'auto';
}

function rowToEngine(row: EngineRow): DockerEngine {
  return {
    id: row.id,
    name: row.name,
    type: row.type as DockerEngineType,
    host: row.host,
    port: row.port,
    sshUser: row.ssh_user,
    hasSshPrivateKey: !!row.ssh_private_key_enc,
    sshKnownHost: row.ssh_known_host,
    hasApiKey: !!row.api_key_enc,
    apiKeyHeader: row.api_key_header,
    tlsCa: row.tls_ca,
    tlsCert: row.tls_cert,
    hasTlsKey: !!row.tls_key_enc,
    isDefault: row.is_default,
    enabled: row.enabled,
    tailscaleHostname: row.tailscale_hostname,
    tailscaleAdvertisedRoutes: row.tailscale_advertised_routes,
    hostAgentMode: toHostAgentMode(row.host_agent_mode),
    lastPingAt: row.last_ping_at?.toISOString() ?? null,
    lastPingStatus: (row.last_ping_status as 'ok' | 'error' | null) ?? null,
    lastPingMessage: row.last_ping_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

interface EngineCacheEntry {
  client: Docker;
  builtAt: number;
}

const clientCache = new Map<number, EngineCacheEntry>();

// Bumped by every invalidation. getClient() only caches what it built when no invalidation happened
// while it was reading the row, so a PATCH, disable or delete that lands mid-build is not undone by a
// client built from the old row.
let cacheEpoch = 0;

function dropCachedClient(id?: number): void {
  cacheEpoch++;
  if (id == null) clientCache.clear();
  else clientCache.delete(id);
}

// No global dockerode `timeout` / `connectionTimeout` on purpose: it would also abort hijacked
// console exec sessions and the host agent's log-follow stream. Callers bound individual calls with
// `withTimeout` (utils/withTimeout.ts) instead.
function buildDockerClient(row: EngineRow): Docker {
  if (row.type === 'local') {
    return new Docker({ socketPath: config.dockerSocket });
  }

  if (row.type === 'ssh') {
    if (!row.host || !row.ssh_user || !row.ssh_private_key_enc) {
      throw new Error(`Engine ${row.id} (ssh): host, ssh_user and ssh_private_key are required`);
    }
    const privateKey = decryptSecret(row.ssh_private_key_enc);
    // dockerode delegates SSH transport to ssh2 — we pass ssh2 options under `sshOptions`.
    return new Docker({
      protocol: 'ssh',
      host: row.host,
      port: row.port ?? 22,
      username: row.ssh_user,
      sshOptions: {
        privateKey,
      },
    } as unknown as Docker.DockerOptions);
  }

  if (row.type === 'https-apikey') {
    if (!row.host || !row.api_key_enc) {
      throw new Error(`Engine ${row.id} (https-apikey): host and api_key are required`);
    }
    const apiKey = decryptSecret(row.api_key_enc);
    const headerName = row.api_key_header || 'X-API-Key';
    // dockerode v3+ accepts `headers` in DockerOptions — added to every request.
    return new Docker({
      protocol: 'http',
      host: row.host,
      port: row.port ?? 2375,
      headers: { [headerName]: apiKey },
    } as unknown as Docker.DockerOptions);
  }

  if (row.type === 'tls') {
    if (!row.host || !row.tls_ca || !row.tls_cert || !row.tls_key_enc) {
      throw new Error(`Engine ${row.id} (tls): host, tls_ca, tls_cert and tls_key are required`);
    }
    const tlsKey = decryptSecret(row.tls_key_enc);
    return new Docker({
      protocol: 'https',
      host: row.host,
      port: row.port ?? 2376,
      ca: row.tls_ca,
      cert: row.tls_cert,
      key: tlsKey,
    });
  }

  throw new Error(`Unsupported engine type: ${row.type}`);
}

interface EngineCreateInput {
  name: string;
  type: DockerEngineType;
  host?: string;
  port?: number;
  sshUser?: string;
  sshPrivateKey?: string;
  sshKnownHost?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  tlsCa?: string;
  tlsCert?: string;
  tlsKey?: string;
  enabled?: boolean;
  tailscaleHostname?: string | null;
  tailscaleAdvertisedRoutes?: string | null;
  hostAgentMode?: HostAgentMode;
}

export interface EngineDeleteResult {
  removedStacks: number;
  removedContainers: number;
  agentRemoved: boolean;
  warnings: string[];
}

const TEARDOWN_TIMEOUT_MS = 30_000;
const DISCOVERY_DRAIN_TIMEOUT_MS = 30_000;
// Shorter than the teardown bound: it runs before the teardown, and both sit inside one HTTP request.
const WATCHDOG_RELEASE_TIMEOUT_MS = 20_000;
const WATCHDOG_RELEASE_ROUNDS = 3;

function cleanupWarning(reason: string): string {
  return `Could not clean up Oblihub containers on this engine (${reason}) — remove "oblihub-host-agent" and any "oblihub-oneshot-*" container there by hand.`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** This engine's stacks with a priority-watchdog journal row: containers it holds paused or stopped there. */
async function journalledStackIds(engineId: number): Promise<number[]> {
  const rows = await db('priority_yields as py')
    .join('stacks as s', 's.id', 'py.stack_id')
    .where('s.engine_id', engineId)
    .orderBy('py.stack_id')
    .select<{ stack_id: number }[]>('py.stack_id');
  return rows.map((r) => Number(r.stack_id));
}

/**
 * Resumes what the priority watchdog holds paused or stopped on this engine, then disables the engine.
 * WHY: priority_yields cascades from stacks, so the stacks cleanup in delete() drops the only record of
 * what to resume, and a disabled engine cannot be resumed anyway (forEngine() refuses it). The watchdog promises
 * that journalled containers come back, as "Remove from Oblihub" of a single stack already does.
 * Each stack is resumed in the watchdog's own serialized slot (resumeStackForRemoval). The disable runs
 * inside the slot of the last one, after the journal is read again: a stack yielded in between is
 * resumed in another round, and no yield can start once the engine is disabled. A resume that fails
 * (engine unreachable) does not block the delete, because an unreachable engine has to stay deletable:
 * the journal rows that cascade away are reported by lostYieldsWarning instead.
 */
async function releaseWatchdogAndDisable(id: number): Promise<void> {
  let disabled = false;
  const disable = async (): Promise<void> => {
    await db('docker_engines').where({ id }).update({ enabled: false, updated_at: new Date() });
    dropCachedClient(id);
    disabled = true;
  };
  try {
    const engineStackIds = new Set((await db('stacks').where({ engine_id: id }).pluck('id')).map(Number));
    if (engineStackIds.size > 0) {
      const { getYieldedStackIds, resumeStackForRemoval } = await import('../workers/PriorityWatchdogWorker');
      const { stackService } = await import('./stack.service');
      // A yield still in flight has no journal row yet, so the watchdog's own view counts as well.
      let held = [...new Set([
        ...(await journalledStackIds(id)),
        ...[...getYieldedStackIds()].filter((s) => engineStackIds.has(s)),
      ])];
      // Stacks the watchdog could yield here: when none is held, one of them hosts the disable, so a yield
      // about to start there cannot land after the check. None at all: nothing to wait for.
      const yieldable = (await stackService.getOpportunisticStacksWithYields()).filter((s) => s.engineId === id).map((s) => s.id);
      const failed = new Set<number>();
      const deadline = Date.now() + WATCHDOG_RELEASE_TIMEOUT_MS;
      for (let round = 0; round < WATCHDOG_RELEASE_ROUNDS && !disabled; round++) {
        const host = [...held, ...yieldable].find((s) => !failed.has(s));
        const order = held.length > 0 ? held : host != null ? [host] : [];
        if (order.length === 0) break;
        held = [];
        for (const [i, stackId] of order.entries()) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error(`timed out after ${WATCHDOG_RELEASE_TIMEOUT_MS} ms`);
          const last = i === order.length - 1;
          const released = await withTimeout(resumeStackForRemoval(stackId, async () => {
            if (!last) return;
            // Stacks whose resume already failed stay journalled; retrying them here would only loop.
            const late = (await journalledStackIds(id)).filter((s) => !failed.has(s));
            if (late.length > 0) held = late;
            else await disable();
          }), remaining, 'priority watchdog resume');
          if (!released) failed.add(stackId);
        }
      }
    }
  } catch (err) {
    logger.warn({ engineId: id, err: errText(err) }, 'Engine delete: resuming what the priority watchdog holds on this engine failed; continuing');
  }
  // Also reached after a timeout. A resume still queued in the watchdog then either fails against the
  // disabled engine and keeps its journal row, which is reported when it cascades, or finishes late.
  if (!disabled) await disable();
}

/**
 * The containers listed in journal rows about to cascade away with their stacks. Nothing resumes them
 * after that, so the admin is told which ones to unpause or start by hand.
 */
function lostYieldsWarning(rows: Array<{ mode: string; containers: unknown }>): string | null {
  const paused: string[] = [];
  const stopped: string[] = [];
  for (const r of rows) {
    let entries: unknown = r.containers;
    if (typeof entries === 'string') {
      try { entries = JSON.parse(entries); } catch { entries = null; }
    }
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      const name = (e as { name?: unknown } | null)?.name;
      // Same reading as the journal's: any mode other than 'pause' resumes as a stop.
      if (typeof name === 'string' && name) (r.mode === 'pause' ? paused : stopped).push(name);
    }
  }
  if (paused.length === 0 && stopped.length === 0) return null;
  const parts: string[] = [];
  if (paused.length > 0) parts.push(`paused: ${paused.join(', ')}`);
  if (stopped.length > 0) parts.push(`stopped: ${stopped.join(', ')}`);
  // "Had not": a resume that timed out may still complete after the rows are gone.
  return `The priority watchdog had not resumed the containers it held on this engine when it was removed (${parts.join('; ')}). Nothing tracks them any more: check them on that host and unpause or start them by hand.`;
}

async function fetchRow(id: number): Promise<EngineRow | null> {
  const row = await db<EngineRow>('docker_engines').where({ id }).first();
  return row ?? null;
}

export const engineService = {
  async getAll(): Promise<DockerEngine[]> {
    const rows = await db<EngineRow>('docker_engines').orderBy('id');
    return rows.map(rowToEngine);
  },

  /** Identity without host or secrets: safe for every authenticated user (engine badges, tabs). */
  toSummary(e: DockerEngine): EngineSummary {
    return { id: e.id, name: e.name, type: e.type, isDefault: e.isDefault, enabled: e.enabled, isLocal: e.type === 'local' };
  },

  async getSummaries(): Promise<EngineSummary[]> {
    const engines = await engineService.getAll();
    return engines.map((e) => engineService.toSummary(e));
  },

  async getById(id: number): Promise<DockerEngine | null> {
    const row = await fetchRow(id);
    return row ? rowToEngine(row) : null;
  },

  async getDefault(): Promise<DockerEngine | null> {
    const row = await db<EngineRow>('docker_engines').where({ is_default: true, enabled: true }).first();
    return row ? rowToEngine(row) : null;
  },

  async create(data: EngineCreateInput): Promise<DockerEngine> {
    const insert: Record<string, unknown> = {
      name: data.name,
      type: data.type,
      host: data.host || null,
      port: data.port || null,
      ssh_user: data.sshUser || null,
      ssh_private_key_enc: data.sshPrivateKey ? encryptSecret(data.sshPrivateKey) : null,
      ssh_known_host: data.sshKnownHost || null,
      api_key_enc: data.apiKey ? encryptSecret(data.apiKey) : null,
      api_key_header: data.apiKeyHeader || (data.type === 'https-apikey' ? 'X-API-Key' : null),
      tls_ca: data.tlsCa || null,
      tls_cert: data.tlsCert || null,
      tls_key_enc: data.tlsKey ? encryptSecret(data.tlsKey) : null,
      is_default: false,
      enabled: data.enabled !== false,
      tailscale_hostname: data.tailscaleHostname || null,
      tailscale_advertised_routes: data.tailscaleAdvertisedRoutes || null,
      // https-apikey is plain HTTP to a socket proxy that most likely ignores the API key, so
      // Oblihub must not start creating containers there unless an admin opts in.
      host_agent_mode: data.hostAgentMode ?? (data.type === 'https-apikey' ? 'off' : 'auto'),
    };
    const [row] = await db<EngineRow>('docker_engines').insert(insert).returning('*');
    return rowToEngine(row);
  },

  async update(id: number, data: Partial<{
    name: string;
    host: string | null;
    port: number | null;
    sshUser: string | null;
    sshPrivateKey: string;
    sshKnownHost: string | null;
    apiKey: string;
    apiKeyHeader: string | null;
    tlsCa: string | null;
    tlsCert: string | null;
    tlsKey: string;
    enabled: boolean;
    tailscaleHostname: string | null;
    tailscaleAdvertisedRoutes: string | null;
    hostAgentMode: HostAgentMode;
  }>): Promise<DockerEngine | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.host !== undefined) update.host = data.host;
    if (data.port !== undefined) update.port = data.port;
    if (data.sshUser !== undefined) update.ssh_user = data.sshUser;
    if (data.sshPrivateKey !== undefined && data.sshPrivateKey !== '') update.ssh_private_key_enc = encryptSecret(data.sshPrivateKey);
    if (data.sshKnownHost !== undefined) update.ssh_known_host = data.sshKnownHost;
    if (data.apiKey !== undefined && data.apiKey !== '') update.api_key_enc = encryptSecret(data.apiKey);
    if (data.apiKeyHeader !== undefined) update.api_key_header = data.apiKeyHeader;
    if (data.tlsCa !== undefined) update.tls_ca = data.tlsCa;
    if (data.tlsCert !== undefined) update.tls_cert = data.tlsCert;
    if (data.tlsKey !== undefined && data.tlsKey !== '') update.tls_key_enc = encryptSecret(data.tlsKey);
    if (data.enabled !== undefined) update.enabled = data.enabled;
    if (data.tailscaleHostname !== undefined) update.tailscale_hostname = data.tailscaleHostname;
    if (data.tailscaleAdvertisedRoutes !== undefined) update.tailscale_advertised_routes = data.tailscaleAdvertisedRoutes;
    if (data.hostAgentMode !== undefined) update.host_agent_mode = data.hostAgentMode;

    await db('docker_engines').where({ id }).update(update);
    dropCachedClient(id);
    const row = await fetchRow(id);
    return row ? rowToEngine(row) : null;
  },

  /**
   * Deletes an engine and everything Oblihub keeps about it. Oblihub's own helper containers on
   * that engine are removed first, while a client can still be built from the row; the discovery rows
   * go before the engine row, because the FKs would otherwise leave them behind as NULL-engine orphans.
   * Containers the priority watchdog paused or stopped there are resumed before anything else.
   * engineFacts, hostAgent, DiscoveryWorker, scheduler.service, stack.service and the watchdog all
   * import this module (directly or through docker.service), so they are loaded lazily here.
   */
  async delete(id: number): Promise<EngineDeleteResult> {
    const row = await fetchRow(id);
    if (!row) throw new AppError(404, 'Engine not found');
    if (row.is_default) throw new AppError(400, 'Cannot delete the default engine');

    // Every engine_id FK is ON DELETE SET NULL, and a NULL managed_stacks.engine_id means "local
    // socket". Deleting the engine used to silently re-target its managed stacks at the hub, and the
    // next deploy then duplicated them there. The operator has to move or delete them first.
    // A legacy NULL-engine managed stack runs on the local socket through the local-type engine row
    // (runner env, resource limits, team links, discovery). With the last such row gone it would keep
    // deploying on the hub socket uncapped and undiscovered, so it blocks that row's delete too.
    const lastLocal = row.type === 'local'
      && !(await db('docker_engines').where({ type: 'local' }).whereNot({ id }).first('id'));
    const managed = await db('managed_stacks')
      .where((q) => { q.where({ engine_id: id }); if (lastLocal) q.orWhereNull('engine_id'); })
      .orderBy('name').select<{ name: string }[]>('name');
    if (managed.length > 0) {
      throw new AppError(409, `Migrate or delete this engine's managed stacks first: ${managed.map((m) => m.name).join(', ')}`);
    }

    // Disabled first: discovery, stats, agent and facts passes that start from now on skip the
    // engine, and dropping the cached client makes forEngine() refuse it, which narrows the races with
    // work already in flight. What the priority watchdog holds there is resumed just before, while
    // forEngine() still accepts the engine.
    await releaseWatchdogAndDisable(id);

    const warnings: string[] = [];
    let agentRemoved = false;

    const teardown = (async () => {
      // Built from the row explicitly: getClient() refuses a disabled engine.
      const client = buildDockerClient(row);
      const { hostAgentService } = await import('./hostAgent.service');
      return withTimeout(hostAgentService.teardownEngine(id, client), TEARDOWN_TIMEOUT_MS, 'Oblihub container cleanup');
    })();
    // A discovery pass that fetched this engine before it was disabled could write its stacks and
    // containers rows back after we delete them; they would then become NULL-engine orphans. Joining
    // the in-flight pass (or running one that already skips this engine) closes that window. It runs
    // alongside the teardown so it costs no extra time in the usual case.
    const discoveryDrain = (async () => {
      const { runDiscoveryOnce } = await import('../workers/DiscoveryWorker');
      await withTimeout(runDiscoveryOnce(), DISCOVERY_DRAIN_TIMEOUT_MS, 'discovery pass');
    })();
    const [teardownResult, drainResult] = await Promise.allSettled([teardown, discoveryDrain]);

    if (teardownResult.status === 'fulfilled') {
      agentRemoved = teardownResult.value.agentRemoved;
      if (teardownResult.value.errors.length > 0) warnings.push(cleanupWarning(teardownResult.value.errors.join('; ')));
    } else {
      warnings.push(cleanupWarning(errText(teardownResult.reason)));
    }
    if (drainResult.status === 'rejected') {
      logger.warn({ engineId: id, err: errText(drainResult.reason) }, 'Engine delete: waiting for the discovery pass failed; continuing');
    }

    let engineFacts: { invalidate(engineId?: number): void } | null = null;
    try {
      engineFacts = (await import('./engineFacts.service')).engineFactsService;
      engineFacts.invalidate(id);
    } catch (err) {
      logger.warn({ engineId: id, err: errText(err) }, 'Engine delete: engine facts invalidation failed');
    }
    clearEngine(id);

    // The managed-stack check above ran before the teardown, which can take up to 30 s. A managed stack
    // created on or migrated to this engine since then would be re-targeted at the local socket by
    // the FK's SET NULL, which is the orphan bug that check exists to prevent. So check again with the
    // engine row locked. FOR UPDATE conflicts with the key-share lock that an insert or update of
    // managed_stacks.engine_id takes on this row. A write still in flight therefore commits before the
    // re-check reads, or fails its FK check once the row is gone. The discovery-row cleanup runs in
    // the same transaction, so a refusal keeps those rows and their update history. It repeats
    // stackService.delete's statements because that helper cannot join a transaction.
    // Only trx queries run while the lock is held: waiting on another pool connection here could
    // deadlock without Postgres noticing.
    const { schedulerService } = await import('./scheduler.service');
    const { stackIds, removedContainers, lostYields } = await db.transaction(async (trx) => {
      // For a local engine, the other local-type rows are locked too, so "is this the last one" cannot
      // change before commit. ORDER BY runs before the row locks, so two local deletes lock in the same
      // id order: they queue instead of deadlocking, and the later one sees the other row gone.
      const locked = await trx('docker_engines')
        .where((q) => { q.where({ id }); if (row.type === 'local') q.orWhere({ type: 'local' }); })
        .orderBy('id').forUpdate().select<{ id: number }[]>('id');
      if (!locked.some((r) => r.id === id)) throw new AppError(404, 'Engine not found');
      const lateLastLocal = row.type === 'local' && !locked.some((r) => r.id !== id);
      const lateManaged = await trx('managed_stacks')
        .where((q) => { q.where({ engine_id: id }); if (lateLastLocal) q.orWhereNull('engine_id'); })
        .orderBy('name').select<{ name: string }[]>('name');
      if (lateManaged.length > 0) {
        throw new AppError(409, `Migrate or delete this engine's managed stacks first: ${lateManaged.map((m) => m.name).join(', ')} (the engine was left disabled)`);
      }

      // Discovery rows only: they are rebuilt if the engine is added again.
      const ids = (await trx('stacks').where({ engine_id: id }).select<{ id: number }[]>('id')).map((r) => r.id);
      const [counted] = await trx('containers')
        .where({ engine_id: id })
        .orWhereIn('stack_id', ids)
        .count({ count: '*' });
      let lostWarning: string | null = null;
      if (ids.length > 0) {
        // priority_yields cascades from stacks. Read first: a row still here is one the resume before
        // the disable could not clear (engine unreachable, timeout), and it must not vanish silently.
        const journal = await trx('priority_yields').whereIn('stack_id', ids).select<Array<{ mode: string; containers: unknown }>>('mode', 'containers');
        lostWarning = lostYieldsWarning(journal);
        await trx('update_history').whereIn('stack_id', ids).delete();
        await trx('containers').whereIn('stack_id', ids).delete();
        await trx('notification_bindings').where({ scope: 'stack' }).whereIn('scope_id', ids).delete();
        await trx('stacks').whereIn('id', ids).delete();
      }
      await trx('containers').where({ engine_id: id }).delete();

      // gpu_power_limits cascades.
      await trx('docker_engines').where({ id }).delete();
      return { stackIds: ids, removedContainers: Number(counted?.count ?? 0), lostYields: lostWarning };
    });
    if (lostYields) {
      logger.warn({ engineId: id, engineName: row.name }, lostYields);
      // First: paused or stopped workloads matter more than a leftover helper container.
      warnings.unshift(lostYields);
    }
    for (const stackId of stackIds) schedulerService.reschedule(stackId, 0, false);
    dropCachedClient(id);
    // Again, now that the row is gone: a stats collect or a facts lookup that was already running
    // may have republished this engine (or cached it as the local one) since the first call.
    clearEngine(id);
    engineFacts?.invalidate(id);

    const result: EngineDeleteResult = { removedStacks: stackIds.length, removedContainers, agentRemoved, warnings };
    logger.info({ engineId: id, engineName: row.name, ...result }, 'Engine deleted');
    return result;
  },

  async setDefault(id: number): Promise<void> {
    await db.transaction(async (trx) => {
      await trx('docker_engines').update({ is_default: false });
      await trx('docker_engines').where({ id }).update({ is_default: true });
    });
  },

  /**
   * Get a dockerode client for an engine, using cache. Throws if the engine doesn't exist, is disabled
   * or is misconfigured. A cache hit skips the enabled check: every write of `enabled` drops the entry.
   */
  async getClient(id: number): Promise<Docker> {
    const cached = clientCache.get(id);
    if (cached) return cached.client;
    const epoch = cacheEpoch;
    const row = await fetchRow(id);
    if (!row) throw new Error(`Engine ${id} not found`);
    if (!row.enabled) throw new Error(`Engine ${id} is disabled`);
    const client = buildDockerClient(row);
    if (epoch === cacheEpoch) clientCache.set(id, { client, builtAt: Date.now() });
    return client;
  },

  /** Build a client from a row without touching the cache, so it also works for a disabled engine. */
  async _buildEphemeralClient(row: EngineRow): Promise<Docker> {
    return buildDockerClient(row);
  },

  /**
   * Try a no-op call (ping) and update last_ping_*. Returns { ok, message }. Works for a disabled
   * engine too (the Test button is a diagnostic), which is why the client it builds is never cached:
   * a cached client would let forEngine() act on the disabled engine, and a PATCH landing during
   * version() would be undone by a client built from the old row.
   */
  async testConnection(id: number): Promise<{ ok: boolean; message?: string; serverVersion?: string }> {
    const row = await fetchRow(id);
    if (!row) return { ok: false, message: 'Engine not found' };
    try {
      const client = buildDockerClient(row);
      const info = await client.version();
      await db('docker_engines').where({ id }).update({
        last_ping_at: new Date(),
        last_ping_status: 'ok',
        last_ping_message: `Docker ${info.Version} (API ${info.ApiVersion})`,
      });
      return { ok: true, serverVersion: info.Version };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ engineId: id, err }, 'Engine test connection failed');
      await db('docker_engines').where({ id }).update({
        last_ping_at: new Date(),
        last_ping_status: 'error',
        last_ping_message: message.slice(0, 1000),
      });
      clientCache.delete(id);
      return { ok: false, message };
    }
  },

  /** Test a transient config that hasn't been persisted yet — for the "Test connection" button in the form. */
  async testConfig(data: EngineCreateInput): Promise<{ ok: boolean; message?: string; serverVersion?: string }> {
    const fakeRow: EngineRow = {
      id: 0,
      name: data.name,
      type: data.type,
      host: data.host || null,
      port: data.port || null,
      ssh_user: data.sshUser || null,
      ssh_private_key_enc: data.sshPrivateKey ? encryptSecret(data.sshPrivateKey) : null,
      ssh_known_host: data.sshKnownHost || null,
      api_key_enc: data.apiKey ? encryptSecret(data.apiKey) : null,
      api_key_header: data.apiKeyHeader || null,
      tls_ca: data.tlsCa || null,
      tls_cert: data.tlsCert || null,
      tls_key_enc: data.tlsKey ? encryptSecret(data.tlsKey) : null,
      is_default: false,
      enabled: true,
      tailscale_hostname: data.tailscaleHostname || null,
      tailscale_advertised_routes: data.tailscaleAdvertisedRoutes || null,
      // Irrelevant here: the transient client only calls version().
      host_agent_mode: 'auto',
      last_ping_at: null,
      last_ping_status: null,
      last_ping_message: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    try {
      const client = buildDockerClient(fakeRow);
      const info = await client.version();
      return { ok: true, serverVersion: info.Version };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },

  /** Invalidate cached clients — called when secrets are rotated externally. */
  invalidateCache(id?: number): void {
    dropCachedClient(id);
  },
};
