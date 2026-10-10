import { db } from '../db';
import { dockerService } from './docker.service';
import { stackService } from './stack.service';
import { selfProjectService } from './selfProject.service';
import { stackVolumesService } from './stackVolumes.service';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/withTimeout';
import { isOblihubHiddenContainer, labelsOf } from '../utils/oblihubContainers';
import type { SleepMode, SleepState, Container } from '@oblihub/shared';
import { suggestProxyPort } from '@oblihub/shared';
import net from 'net';

/**
 * Sleep service — manages on-demand sleep/wake for containers.
 *
 * Why: AI workloads pin GPU VRAM constantly. Stopping idle containers frees it.
 * Only `stop` actually frees VRAM (process exit → driver releases). `pause` just freezes
 * the cgroup but keeps the process mapped — useless for the GPU use case but cheap for non-GPU.
 *
 * State machine: awake → sleeping → waking → awake (or → wake_failed on timeout/error)
 *
 * Wake idempotency: a single in-flight wake per container shared across concurrent callers.
 * Without this, 10 simultaneous browser tabs hitting the waking page would issue 10 `docker start`s.
 */

const WAKE_TIMEOUT_MS = 180_000; // 3 min — generous for AI model reload
const WAKE_HEALTH_POLL_MS = 1_000;
const SELF_INSPECT_TIMEOUT_MS = 5_000;
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/**
 * A containers row whose engine_id is NULL lost its engine (engine rows are deleted with ON DELETE
 * SET NULL; migration 023 backfilled every legacy row to the Local engine). dockerService maps a
 * null engine to the local socket, so any sleep/wake Docker call on such a row would act on
 * whatever the hub's own daemon has under that id or name. Refused before any state change.
 */
export const ORPHAN_ENGINE_MESSAGE = "This container's engine no longer exists";

type NetworkEndpoints = Record<string, { IPAddress?: string; NetworkID?: string } | undefined>;

// In-flight wake promises, keyed by container ID. Lets concurrent wake requests share a single op.
const wakingInFlight = new Map<number, Promise<{ ok: boolean; message?: string }>>();

async function setState(containerId: number, sleepState: SleepState, extra: Record<string, unknown> = {}): Promise<void> {
  await db('containers').where({ id: containerId }).update({
    sleep_state: sleepState,
    updated_at: new Date(),
    ...extra,
  });
}

async function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; try { sock.destroy(); } catch { /* ignore */ } resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
    sock.connect(port, host);
  });
}

async function httpProbe(host: string, port: number, path: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://${host}:${port}${path}`, { signal: controller.signal });
    clearTimeout(t);
    return res.status >= 200 && res.status < 500; // accept anything that's not server-down
  } catch {
    return false;
  }
}

/**
 * Networks (names and IDs) of Oblihub's own container on the local daemon, or null when a direct
 * probe of a container IP cannot be trusted to connect: remote engine, not running in Docker, or
 * the own inspect failed. Docker isolates bridge networks from each other, so an IP is only reachable
 * from here through a network this container is attached to.
 */
async function ownNetworkKeys(engineId: number): Promise<Set<string> | null> {
  // Callers refuse orphans (engine_id NULL) first: isLocalEngine uses the managed-stack meaning of
  // null (local socket), so it must never see a containers-row null.
  try {
    if (!(await stackVolumesService.isLocalEngine(engineId))) return null;
    const selfId = selfProjectService.getSelfContainerId();
    if (!selfId) return null;
    const info = await withTimeout(dockerService.inspectContainer(selfId), SELF_INSPECT_TIMEOUT_MS, 'inspect own container');
    const keys = new Set<string>();
    for (const [name, ep] of Object.entries((info.NetworkSettings?.Networks || {}) as NetworkEndpoints)) {
      keys.add(name);
      if (ep?.NetworkID) keys.add(ep.NetworkID);
    }
    return keys;
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'Cannot read own networks for the wake probe');
    return null;
  }
}

/**
 * Docker id (12 chars) of the container that now holds a stop-mode sleeper's name, once the row's
 * own container is gone (recreated outside Oblihub since the last discovery pass). Accepted only
 * where discovery would re-associate the row itself (stack.service syncWithDocker): the exact name,
 * the same compose project as the row's stack (none for Standalone), and no other row tracking it.
 * Wake is reachable by any visitor of a proxied domain, so a bare name lookup would let a stale row
 * start another stack's container that took the name, an excluded or deliberately stopped one
 * included. Throws otherwise: the wake ends in wake_failed and discovery re-associates the row.
 */
async function recreatedByName(container: Container, engineId: number): Promise<string> {
  const name = container.containerName;
  const refusal = (reason: string) =>
    new Error(`Container ${container.dockerId} no longer exists and "${name}" ${reason}; the next discovery pass re-associates the row`);
  const info = await dockerService.inspectContainer(name, engineId);
  // Docker also resolves an id prefix: a name that looks like one could answer with an unrelated container.
  if (info.Name !== `/${name}`) throw refusal('matches no container by exact name');
  // Discovery never lists Oblihub's own host agent and one-shots, so it never tracks them.
  if (isOblihubHiddenContainer(info)) throw refusal('names an Oblihub internal container');
  const stack = container.stackId != null
    ? await db('stacks').where({ id: container.stackId }).select('compose_project').first() as { compose_project: string | null } | undefined
    : undefined;
  if (!stack) throw refusal('cannot be checked: the row has no stack');
  // `|| null`: discovery groups an empty project label with Standalone too.
  const project = labelsOf(info)[COMPOSE_PROJECT_LABEL] || null;
  if (project !== (stack.compose_project ?? null)) throw refusal('names a container of another compose project');
  const dockerId = info.Id.slice(0, 12);
  const owner = await db('containers')
    .where({ engine_id: engineId })
    .whereIn('docker_id', [dockerId, info.Id])
    .whereNot({ id: container.id })
    .first('id');
  if (owner) throw refusal('names a container tracked by another container row');
  return dockerId;
}

/** The target's IP on a network it shares with Oblihub; null when none is shared. */
function sharedNetworkIp(networks: NetworkEndpoints, own: Set<string>): string | null {
  for (const [name, ep] of Object.entries(networks)) {
    if (!ep?.IPAddress) continue;
    if ((ep.NetworkID && own.has(ep.NetworkID)) || own.has(name)) return ep.IPAddress;
  }
  return null;
}

export const sleepService = {
  /**
   * Mark a container as "active" (touched by user traffic). Resets idle timer.
   * Called by ActivityTracker on each filtered request.
   */
  async recordActivity(containerId: number): Promise<void> {
    await db('containers').where({ id: containerId }).update({
      last_active_at: new Date(),
    });
  },

  /**
   * Sleep a container — either `docker stop` (frees VRAM) or `docker pause` (cgroup freeze).
   * Idempotent: already-sleeping container is a no-op.
   */
  async sleep(containerId: number): Promise<{ ok: boolean; message?: string }> {
    const container = await stackService.getContainerById(containerId);
    if (!container) return { ok: false, message: 'Container not found' };
    if (container.sleepState === 'sleeping') return { ok: true, message: 'Already sleeping' };
    if (container.sleepState === 'waking') return { ok: false, message: 'Currently waking — sleep aborted' };
    const engineId = container.engineId;
    if (engineId == null) {
      logger.warn({ containerId, containerName: container.containerName }, 'Sleep refused: container row has no engine (orphaned)');
      return { ok: false, message: ORPHAN_ENGINE_MESSAGE };
    }

    const mode: SleepMode = container.sleepMode || 'stop';
    try {
      if (mode === 'pause') {
        await dockerService.pauseContainer(container.dockerId, engineId);
      } else {
        await dockerService.stopContainer(container.dockerId, engineId);
      }
      await setState(containerId, 'sleeping');
      logger.info({ containerId, containerName: container.containerName, mode, engineId: container.engineId }, 'Container put to sleep');
      return { ok: true };
    } catch (err) {
      logger.error({ containerId, err }, 'Failed to sleep container');
      return { ok: false, message: err instanceof Error ? err.message : 'sleep failed' };
    }
  },

  /**
   * Wake a container — start (or unpause) + poll readiness.
   * Returns when the container is reachable or after WAKE_TIMEOUT_MS.
   *
   * Idempotent across callers via wakingInFlight map.
   */
  async wake(containerId: number): Promise<{ ok: boolean; message?: string }> {
    const existing = wakingInFlight.get(containerId);
    if (existing) return existing;

    const promise = this._wakeInner(containerId).finally(() => {
      wakingInFlight.delete(containerId);
    });
    wakingInFlight.set(containerId, promise);
    return promise;
  },

  async _wakeInner(containerId: number): Promise<{ ok: boolean; message?: string }> {
    const container = await stackService.getContainerById(containerId);
    if (!container) return { ok: false, message: 'Container not found' };
    if (container.sleepState === 'awake') return { ok: true, message: 'Already awake' };
    // Before the 'waking' write: the row keeps its state, and getWakeStatus reports the refusal.
    const engineId = container.engineId;
    if (engineId == null) {
      logger.warn({ containerId, containerName: container.containerName }, 'Wake refused: container row has no engine (orphaned)');
      return { ok: false, message: ORPHAN_ENGINE_MESSAGE };
    }

    const mode = container.sleepMode || 'stop';
    const now = new Date();

    await setState(containerId, 'waking', { wake_started_at: now, last_active_at: now });

    let dockerId = container.dockerId;
    try {
      if (mode === 'pause') {
        try {
          await dockerService.unpauseContainer(dockerId, engineId);
        } catch (err) {
          // A stop-mode watchdog yield stops a pause-mode sleeper (a paused process still holds its
          // VRAM), and the resume leaves it stopped: unpause then answers 409, so it is started
          // instead. A 409 on a running container means someone (a watchdog resume) unpaused it
          // already. Anything else stays a failure.
          if ((err as { statusCode?: number })?.statusCode !== 409) throw err;
          const info = await dockerService.inspectContainer(dockerId, engineId);
          if (info.State?.Running === true && info.State?.Paused !== true) {
            logger.info({ containerId, dockerId }, 'Wake: container was already unpaused');
          } else if (info.State?.Status === 'exited' || info.State?.Status === 'created') {
            await dockerService.startContainer(dockerId, engineId);
            logger.info({ containerId, dockerId }, 'Wake: pause-mode sleeper was stopped (watchdog yield), started it');
          } else {
            throw err;
          }
        }
      } else {
        try {
          await dockerService.startContainer(dockerId, engineId);
        } catch (err) {
          // The row can still name a container recreated outside Oblihub since the last discovery
          // pass (compose up, a manual recreate); its name then points at the live one, when it
          // passes the checks discovery's own re-association implies (recreatedByName).
          if ((err as { statusCode?: number })?.statusCode !== 404) throw err;
          dockerId = await recreatedByName(container, engineId);
          await dockerService.startContainer(dockerId, engineId);
          logger.info({ containerId, containerName: container.containerName, oldDockerId: container.dockerId, dockerId }, 'Woke the recreated container found by name');
          try {
            await stackService.updateContainerDockerId(containerId, dockerId);
          } catch (e) {
            // docker_id is unique: a discovery pass may have re-associated the row first.
            logger.warn({ containerId, dockerId, err: e }, 'Wake: container row not re-associated with its recreated container; the next discovery pass will');
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'start failed';
      logger.error({ containerId, err }, 'Failed to start container during wake');
      await setState(containerId, 'wake_failed');
      return { ok: false, message };
    }

    // Probe readiness — HTTP path if configured, else TCP.
    //
    // Probe target selection — single source of truth: the proxy_host's forwardHost:forwardPort.
    // That's what nginx routes to in production, so it's both reachable from here and exactly
    // what the user has validated. Falls back to the container's IP for containers not (yet)
    // wired to a proxy host (e.g. the operator just enabled sleep on a container they're going
    // to consume some other way), but only on a network Oblihub shares with it; otherwise
    // Docker's running state is trusted, since a probe that can never connect would only end
    // in wake_failed after WAKE_TIMEOUT_MS.
    let probeHost: string | null = null;
    let probePort: number | null = null;
    try {
      const proxyRow = await db('proxy_hosts')
        .where({ wake_container_id: containerId })
        .select('forward_host', 'forward_port')
        .first();
      if (proxyRow?.forward_host && proxyRow?.forward_port) {
        probeHost = proxyRow.forward_host as string;
        probePort = proxyRow.forward_port as number;
      }
    } catch { /* leave nulls — fall through to bridge probe */ }

    // Ports are compacted and published-first now, so the first entry could be a UDP port or the
    // start of an unrelated range. suggestProxyPort only picks tcp (falls back to the first tcp run).
    const containerPort = suggestProxyPort(container.ports);
    // Resolved once per wake: only the fallback probe needs it.
    const ownNetworks = !(probeHost && probePort) && containerPort
      ? await ownNetworkKeys(engineId)
      : null;
    const start = Date.now();

    // Helper invoked when readiness is confirmed — keeps the success branches DRY and ensures
    // every successful wake records a duration sample for the rolling history. We compute
    // duration HERE (not at `start`) so it reflects the actual wait the user experienced.
    const markAwake = async (via: string): Promise<void> => {
      const elapsedMs = Date.now() - start;
      await setState(containerId, 'awake', { last_active_at: new Date() });
      // Append the new duration, FIFO-cap to 10. We re-fetch the latest array from DB rather
      // than trust `container.wakeDurationsMs` because concurrent wakes (different containers)
      // could otherwise produce stale-write races on this column. Per-row updates so it's safe.
      try {
        const current = await db('containers').where({ id: containerId }).select('wake_durations_ms').first();
        let arr: number[] = [];
        const raw = current?.wake_durations_ms;
        if (Array.isArray(raw)) arr = raw as number[];
        else if (typeof raw === 'string' && raw) { try { arr = JSON.parse(raw) as number[]; } catch { arr = []; } }
        arr.push(elapsedMs);
        if (arr.length > 10) arr = arr.slice(-10);
        await db('containers').where({ id: containerId }).update({ wake_durations_ms: JSON.stringify(arr) });
      } catch (err) {
        logger.warn({ containerId, err }, 'Failed to record wake duration sample');
      }
      logger.info({ containerId, via, elapsedMs }, 'Container woken');
    };

    while (Date.now() - start < WAKE_TIMEOUT_MS) {
      try {
        // Primary path: probe the proxy_host's forward target.
        if (probeHost && probePort) {
          const ready = container.wakeHealthPath
            ? await httpProbe(probeHost, probePort, container.wakeHealthPath)
            : await tcpProbe(probeHost, probePort);
          if (ready) {
            await markAwake(`proxy-host:${probeHost}:${probePort}`);
            return { ok: true };
          }
        } else {
          // Fallback: no proxy_host wired to this container — probe its IP on a shared network.
          const info = await dockerService.inspectContainer(dockerId, engineId);
          const ip = ownNetworks
            ? sharedNetworkIp((info.NetworkSettings?.Networks || {}) as NetworkEndpoints, ownNetworks)
            : null;
          if (ip && containerPort) {
            const ready = container.wakeHealthPath
              ? await httpProbe(ip, containerPort, container.wakeHealthPath)
              : await tcpProbe(ip, containerPort);
            if (ready) {
              await markAwake('bridge-ip');
              return { ok: true };
            }
          } else if (info.State?.Running === true && info.State?.Paused !== true) {
            // Last resort: no probe target reachable from here. Trust docker status.
            await new Promise(r => setTimeout(r, WAKE_HEALTH_POLL_MS));
            await markAwake('docker-status-only');
            return { ok: true };
          }
        }
      } catch {
        // inspect may briefly fail during startup, keep polling
      }
      await new Promise(r => setTimeout(r, WAKE_HEALTH_POLL_MS));
    }

    await setState(containerId, 'wake_failed');
    logger.warn({ containerId }, 'Wake timeout');
    return { ok: false, message: 'Wake timed out — container did not become ready' };
  },

  /**
   * Return current wake status for the waking page poller.
   *
   * `estimatedMs` is the rolling average of past wake durations for this container — the
   * waking page uses it to render an honest progress bar. Falls back to null (page shows
   * a spinner without bar) when we have no history yet.
   */
  async getWakeStatus(containerId: number): Promise<{
    state: SleepState;
    elapsedMs: number;
    estimatedMs: number | null;
    sampleCount: number;
    message?: string;
  }> {
    const c = await stackService.getContainerById(containerId);
    if (!c) return { state: 'wake_failed', elapsedMs: 0, estimatedMs: null, sampleCount: 0, message: 'Container not found' };
    const elapsedMs = c.wakeStartedAt ? Date.now() - new Date(c.wakeStartedAt).getTime() : 0;
    const samples = c.wakeDurationsMs || [];
    const estimatedMs = samples.length > 0
      ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
      : null;
    // A refused orphan wake leaves the row in its state (usually 'sleeping'); without this the
    // waking page would poll a state that can never change instead of showing why.
    if (c.engineId == null && c.sleepState !== 'awake') {
      return { state: 'wake_failed', elapsedMs, estimatedMs, sampleCount: samples.length, message: ORPHAN_ENGINE_MESSAGE };
    }
    return { state: c.sleepState, elapsedMs, estimatedMs, sampleCount: samples.length };
  },

  /** Update sleep config for a container. */
  async updateConfig(containerId: number, data: {
    sleepEnabled?: boolean;
    sleepAfterSeconds?: number;
    sleepMode?: SleepMode;
    wakeHealthPath?: string | null;
  }): Promise<Container | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.sleepEnabled !== undefined) update.sleep_enabled = data.sleepEnabled;
    if (data.sleepAfterSeconds !== undefined) update.sleep_after_seconds = Math.max(60, data.sleepAfterSeconds);
    if (data.sleepMode !== undefined) update.sleep_mode = data.sleepMode;
    if (data.wakeHealthPath !== undefined) update.wake_health_path = data.wakeHealthPath;
    await db('containers').where({ id: containerId }).update(update);
    return stackService.getContainerById(containerId);
  },

  /**
   * Reconcile sleep_state against Docker reality. Picks up containers stuck in `wake_failed` or
   * `sleeping` whose Docker state actually says they're running (e.g. someone started them by
   * hand, or a previous wake attempt timed out due to an unrelated bug and the container ended
   * up healthy later). Resets them to `awake` so the proxy waking page stops being shown and
   * the idle-detection clock resets.
   *
   * Returns the IDs that were reconciled, mainly for logging.
   */
  async reconcileStuckStates(): Promise<number[]> {
    const rows = await db('containers')
      .whereIn('sleep_state', ['wake_failed', 'sleeping'])
      .where({ sleep_enabled: true })
      // Orphans: an inspect with a null engine would read the local daemon.
      .whereNotNull('engine_id')
      .select('id', 'docker_id', 'engine_id', 'sleep_state');
    const reconciled: number[] = [];
    for (const r of rows) {
      try {
        const info = await dockerService.inspectContainer(r.docker_id as string, r.engine_id as number);
        const running = info.State?.Running === true && info.State?.Paused !== true;
        if (running) {
          await setState(r.id as number, 'awake', { last_active_at: new Date() });
          reconciled.push(r.id as number);
          logger.info({ containerId: r.id, previousState: r.sleep_state }, 'Sleep state reconciled to awake (container is running)');
        }
      } catch {
        // Container might be gone or engine unreachable — leave state as-is, will retry next tick.
      }
    }
    return reconciled;
  },

  /** List containers that should be put to sleep right now (idle past threshold). */
  async listIdleSleepCandidates(): Promise<Container[]> {
    const rows = await db('containers')
      .where({ sleep_enabled: true, sleep_state: 'awake' })
      .whereNot('excluded', true)
      // Orphans: sleep() refuses them, so listing them would only log a refusal every tick.
      .whereNotNull('engine_id');
    const result: Container[] = [];
    const now = Date.now();
    for (const r of rows) {
      const c = await stackService.getContainerById(r.id);
      if (!c || !c.sleepEnabled) continue;
      // Anti-flapping: require last_active_at to be set and idle longer than threshold.
      // If never seen activity (last_active_at NULL), treat now as activity to give grace period.
      if (!c.lastActiveAt) {
        await sleepService.recordActivity(c.id);
        continue;
      }
      const idleMs = now - new Date(c.lastActiveAt).getTime();
      if (idleMs >= c.sleepAfterSeconds * 1000) {
        result.push(c);
      }
    }
    return result;
  },
};
