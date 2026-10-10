import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { stackService } from '../services/stack.service';
import { updateService } from '../services/update.service';
import { schedulerService } from '../services/scheduler.service';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { ContainerInspectResult, StackMaintenance } from '@oblihub/shared';
import { validateStackMaintenance } from '@oblihub/shared';
import { maintenanceService } from '../services/maintenance.service';
import { proxyUpstreamService, parsePortQuery, ORPHAN_MSG } from '../services/proxyUpstream.service';
import { resourceLimitsService } from '../services/resourceLimits.service';
import { appConfigService } from '../services/appConfig.service';
import { markCriticalBusy, clearCriticalBusy, snapshotActivity } from '../state/criticalActivity.state';
import crypto from 'node:crypto';

const WEBHOOK_SECRET_KEY = 'priority_webhook_secret';

async function getOrCreateWebhookSecret(): Promise<string> {
  const existing = await appConfigService.get(WEBHOOK_SECRET_KEY);
  if (existing && existing.length >= 32) return existing;
  const generated = crypto.randomBytes(32).toString('hex');
  await appConfigService.set(WEBHOOK_SECRET_KEY, generated);
  return generated;
}

const WATCHDOG_HELD_MSG =
  'The priority watchdog has paused or stopped this stack\'s containers while a Critical stack it yields to is busy, ' +
  'and resuming them failed (see the server log). Removing it from Oblihub now would leave them paused or stopped ' +
  'with nothing left to resume them. Retry, or set the stack\'s priority to Normal first (they are resumed within about 30 s).';

/**
 * Whether the priority watchdog holds this stack's containers paused/stopped, or is yielding it right
 * now. WHY: priority_yields cascades from stacks, so deleting the row drops the only record of what
 * to resume, and discovery then re-creates a bare row nothing ever resumes. The journal is read as
 * well because a row whose resume failed (cold start, stack no longer Opportunistic) is not in
 * getYieldedStackIds() until the watchdog retries it. An orphaned stack (engine deleted) is never
 * resumed anyway (its journal row is only dropped), so it does not block its own removal.
 */
async function isHeldByWatchdog(stackId: number, engineId: number | null): Promise<boolean> {
  if (engineId == null) return false;
  const { getYieldedStackIds } = await import('../workers/PriorityWatchdogWorker');
  if (getYieldedStackIds().has(stackId)) return true;
  const { yieldJournal } = await import('../services/stackPower.service');
  const row = await yieldJournal.get(stackId);
  return row != null && row.containers.length > 0;
}

export const stackController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { filterStacksByTeam } = await import('../middleware/permissions');
      const session = req.session as { userId?: number; role?: string };
      const stacks = await stackService.getAll();
      const filtered = await filterStacksByTeam(session.userId!, session.role || 'user', stacks);
      res.json({ success: true, data: filtered });
    } catch (err) { next(err); }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const stack = await stackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const removeContainers = req.query.containers === 'true';
      const removeVolumes = req.query.volumes === 'true';
      const stack = await stackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      // "Remove from Oblihub only" of a managed stack's row cannot do what it says: the row
      // carries the managed stack's resource_limits, team_id/team_resources and proxy_hosts.stack_id,
      // and the next discovery pass recreates a bare row for the running containers — the limits,
      // team access and proxy links would be gone and nothing removed. Refused, not turned into a
      // silent no-op, before anything (the watchdog resume, the scheduler) is touched. Daemon-aware:
      // a same-named managed stack on another daemon does not block it. Removing the containers
      // ("delete"/"purge") is left as it is.
      if (!removeContainers && stack.engineId != null && stack.composeProject
        && await stackService.isManagedOnDaemon(stack.composeProject, stack.engineId)) {
        throw new AppError(409, 'A managed stack drives this project on this engine; its limits and team access live on this row. Delete it from Managed Stacks, or choose delete/purge.');
      }
      // Checked before anything is touched. "Remove from Oblihub only" promises the containers keep
      // running, which a yielded stack's containers are not: they are resumed first, and the row is
      // deleted in the watchdog's own slot so no new yield lands in between. Removing the containers
      // too is fine: removeContainer force-removes paused/stopped ones, so nothing is left to resume.
      const heldByWatchdog = await isHeldByWatchdog(id, stack.engineId);
      if (heldByWatchdog && !removeContainers) {
        schedulerService.reschedule(id, 0, false);
        const { resumeStackForRemoval } = await import('../workers/PriorityWatchdogWorker');
        if (!(await resumeStackForRemoval(id, () => stackService.delete(id)))) {
          schedulerService.reschedule(stack.id, stack.checkInterval, stack.enabled);
          throw new AppError(409, WATCHDOG_HELD_MSG);
        }
        res.json({ success: true });
        return;
      }
      schedulerService.reschedule(id, 0, false);
      // Optionally remove Docker containers
      let removeFailures = 0;
      if (removeContainers) {
        const { dockerService } = await import('../services/docker.service');
        for (const c of stack.containers) {
          if (c.engineId == null) {
            // Orphaned row: the docker id may name an unrelated container on another daemon.
            logger.warn({ containerName: c.containerName, dockerId: c.dockerId }, 'Skipping Docker removal of orphaned container (engine deleted)');
            continue;
          }
          try {
            await dockerService.removeContainer(c.dockerId, removeVolumes, c.engineId);
            logger.info({ containerName: c.containerName }, 'Container removed with stack');
          } catch (err) {
            removeFailures++;
            logger.warn({ containerName: c.containerName, err }, 'Failed to remove container');
          }
        }
      }
      if (heldByWatchdog && removeFailures > 0) {
        // A container that survived may be one the watchdog paused or stopped: keeping the row keeps
        // its journal, so the watchdog still resumes it. The removed ones resume as "gone" (no-op).
        schedulerService.reschedule(stack.id, stack.checkInterval, stack.enabled);
        throw new AppError(409, `${removeFailures} container(s) could not be removed and the priority watchdog may be holding them paused or stopped, so the stack was kept in Oblihub. Retry the delete.`);
      }
      await stackService.delete(id);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const data = req.body as { name?: string; checkInterval?: number; autoUpdate?: boolean; enabled?: boolean; url?: string | null; notifyUpdateAvailable?: boolean | null; notifyUpdateApplied?: boolean | null; notifyDelay?: number | null; maintenanceWindow?: unknown };
      let maintenanceWindow: StackMaintenance | undefined;
      if (data.maintenanceWindow !== undefined) {
        try { maintenanceWindow = validateStackMaintenance(data.maintenanceWindow); } catch (err) {
          throw new AppError(400, err instanceof Error ? err.message : 'Invalid maintenance window');
        }
      }
      const stack = await stackService.update(id, { ...data, maintenanceWindow });
      if (!stack) throw new AppError(404, 'Stack not found');

      // Reschedule if interval or enabled changed
      if (data.checkInterval !== undefined || data.enabled !== undefined) {
        schedulerService.reschedule(stack.id, stack.checkInterval, stack.enabled);
      }

      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },


  /** Maintenance rule in force for the stack (its own or the global one), open now, next opening. */
  async maintenanceStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const stack = await stackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      res.json({ success: true, data: await maintenanceService.statusFor(stack.maintenanceWindow) });
    } catch (err) { next(err); }
  },

  async check(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      // Run check in background, return immediately
      updateService.checkStack(id, 'manual').catch(() => {});
      res.json({ success: true, message: 'Check started' });
    } catch (err) { next(err); }
  },

  async restart(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const stack = await stackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      // Run restart in background — containers can take 10+ seconds each
      const { dockerService } = await import('../services/docker.service');
      (async () => {
        for (const c of stack.containers) {
          if (c.engineId == null) {
            logger.warn({ containerName: c.containerName, dockerId: c.dockerId }, 'Skipping restart of orphaned container (engine deleted)');
            continue;
          }
          try {
            await dockerService.restartContainer(c.dockerId, c.engineId);
            logger.info({ containerName: c.containerName, dockerId: c.dockerId }, 'Container restarted');
          } catch (err) {
            logger.error({ containerName: c.containerName, dockerId: c.dockerId, err }, 'Failed to restart container');
          }
        }
      })().catch(() => {});
      res.json({ success: true, message: 'Restart started' });
    } catch (err) { next(err); }
  },

  async triggerUpdate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      // Run update in background. updateService internally dedupes per-container in-flight runs
      // so a second click while a 16 GB pull is already going just joins the existing op.
      updateService.updateStack(id, 'manual').catch(() => {});
      res.json({ success: true, message: 'Update started' });
    } catch (err) { next(err); }
  },

  /** Cancel an in-flight update for a single container. */
  async cancelContainerUpdate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const cancelled = updateService.cancelUpdate(id);
      res.json({ success: true, data: { cancelled } });
    } catch (err) { next(err); }
  },

  async getHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const limit = parseInt(req.query.limit as string || '50', 10);
      const offset = parseInt(req.query.offset as string || '0', 10);
      const history = await updateService.getHistory(id, limit, offset);
      res.json({ success: true, data: history });
    } catch (err) { next(err); }
  },

  async setContainerExcluded(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const { excluded } = req.body as { excluded: boolean };
      await stackService.setExcluded(id, excluded);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async checkContainer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const container = await stackService.getContainerById(id);
      if (!container) throw new AppError(404, 'Container not found');
      // Would need to implement single-container check
      res.json({ success: true, message: 'Check started' });
    } catch (err) { next(err); }
  },

  async inspectContainer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const container = await stackService.getContainerById(id);
      if (!container) throw new AppError(404, 'Container not found');
      if (container.engineId == null) throw new AppError(409, ORPHAN_MSG);
      const { dockerService } = await import('../services/docker.service');
      const info = await dockerService.inspectContainer(container.dockerId, container.engineId);

      // Ports: filter out null bindings
      const rawPorts = info.HostConfig?.PortBindings || {};
      const ports: Record<string, { HostIp: string; HostPort: string }[]> = {};
      for (const [port, bindings] of Object.entries(rawPorts)) {
        if (Array.isArray(bindings) && bindings.length > 0) {
          ports[port] = bindings.map((b: { HostIp?: string; HostPort?: string } | null) => ({
            HostIp: b?.HostIp || '0.0.0.0',
            HostPort: b?.HostPort || '',
          }));
        }
      }

      // What is actually bound right now; unlike PortBindings this includes the host ports
      // Docker picked for ephemeral publishes.
      const publishedPorts: Record<string, { HostIp: string; HostPort: string }[]> = {};
      const livePorts = (info.NetworkSettings?.Ports || {}) as Record<string, { HostIp?: string; HostPort?: string }[] | null>;
      for (const [port, bindings] of Object.entries(livePorts)) {
        if (!Array.isArray(bindings)) continue;
        const mapped = bindings
          .filter((b): b is { HostIp?: string; HostPort?: string } => b != null)
          .map((b) => ({ HostIp: b.HostIp || '0.0.0.0', HostPort: b.HostPort || '' }));
        if (mapped.length > 0) publishedPorts[port] = mapped;
      }
      const exposedPorts = Object.keys(info.Config?.ExposedPorts || {}).sort();

      // Mounts
      const mounts = (info.Mounts || []).map((m: { Type?: string; Source?: string; Destination?: string; Mode?: string }) => ({
        Type: m.Type || '',
        Source: m.Source || '',
        Destination: m.Destination || '',
        Mode: m.Mode || '',
      }));

      // Networks
      const networks: Record<string, { IPAddress: string; Gateway: string; NetworkID: string }> = {};
      const rawNetworks = info.NetworkSettings?.Networks;
      if (rawNetworks && typeof rawNetworks === 'object') {
        for (const [name, net] of Object.entries(rawNetworks)) {
          if (!net) continue;
          const n = net as { IPAddress?: string; Gateway?: string; NetworkID?: string };
          networks[name] = {
            IPAddress: n.IPAddress || '',
            Gateway: n.Gateway || '',
            NetworkID: (n.NetworkID || '').substring(0, 12),
          };
        }
      }

      const data: ContainerInspectResult = {
        env: info.Config?.Env || [],
        ports,
        publishedPorts,
        exposedPorts,
        networkMode: info.HostConfig?.NetworkMode ?? null,
        mounts,
        networks,
      };
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async removeContainer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const removeVolumes = req.query.volumes === 'true';
      const container = await stackService.getContainerById(id);
      if (!container) throw new AppError(404, 'Container not found');
      if (container.engineId == null) {
        // Nothing safe to call on Docker; dropping the stale row is all the operator can want.
        logger.warn({ containerId: id, containerName: container.containerName }, 'Orphaned container (engine deleted): removing DB row only');
      } else {
        const { dockerService } = await import('../services/docker.service');
        await dockerService.removeContainer(container.dockerId, removeVolumes, container.engineId);
      }
      // Remove from DB
      await db('update_history').where({ container_id: id }).delete();
      await db('containers').where({ id }).delete();
      logger.info({ containerId: id, containerName: container.containerName, removeVolumes }, 'Container removed');
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async restartContainer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const container = await stackService.getContainerById(id);
      if (!container) throw new AppError(404, 'Container not found');
      if (container.engineId == null) throw new AppError(409, ORPHAN_MSG);
      const { dockerService } = await import('../services/docker.service');
      dockerService.restartContainer(container.dockerId, container.engineId).catch((err) => {
        logger.error({ containerId: id, err }, 'Failed to restart container');
      });
      res.json({ success: true, message: 'Restart started' });
    } catch (err) { next(err); }
  },

  async stopContainer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const container = await stackService.getContainerById(id);
      if (!container) throw new AppError(404, 'Container not found');
      if (container.engineId == null) throw new AppError(409, ORPHAN_MSG);
      const { dockerService } = await import('../services/docker.service');
      dockerService.stopContainer(container.dockerId, container.engineId).catch((err) => {
        logger.error({ containerId: id, err }, 'Failed to stop container');
      });
      res.json({ success: true, message: 'Stop started' });
    } catch (err) { next(err); }
  },

  async startContainer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const container = await stackService.getContainerById(id);
      if (!container) throw new AppError(404, 'Container not found');
      if (container.engineId == null) throw new AppError(409, ORPHAN_MSG);
      const { dockerService } = await import('../services/docker.service');
      dockerService.startContainer(container.dockerId, container.engineId).catch((err) => {
        logger.error({ containerId: id, err }, 'Failed to start container');
      });
      res.json({ success: true, message: 'Start started' });
    } catch (err) { next(err); }
  },

  /** GET /containers/:id/upstream — where nginx on the hub should send traffic for this container. */
  async containerUpstream(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) throw new AppError(400, 'Invalid container id');
      const port = parsePortQuery(req.query.port);
      if (port === undefined) throw new AppError(400, 'port must be an integer between 1 and 65535');
      const rawProtocol = req.query.protocol;
      const protocol = rawProtocol === undefined || rawProtocol === '' ? 'tcp' : String(rawProtocol).toLowerCase();
      if (protocol !== 'tcp' && protocol !== 'udp') throw new AppError(400, 'protocol must be tcp or udp');
      const r = await proxyUpstreamService.resolve(id, { port, protocol });
      if (!r.ok) {
        res.status(r.status).json({ success: false, error: r.error });
        return;
      }
      res.json({ success: true, data: r.data });
    } catch (err) { next(err); }
  },

  async refreshDiscovery(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Through the worker's pass: a per-engine listContainers + syncWithDocker loop here bypassed its
      // in-flight guard and 20 s per-engine timeout, and raced the 30 s pass on orphan-row adoption and
      // row re-association. A click during a running pass now waits for that pass. Never rejects.
      const { runDiscoveryOnce } = await import('../workers/DiscoveryWorker');
      await runDiscoveryOnce();
      // Same team filter as GET /stacks: this route is only behind requireAuth, so an unfiltered
      // getAll() handed every team's stacks, containers and resource limits to any logged-in user.
      const { filterStacksByTeam } = await import('../middleware/permissions');
      const session = req.session as { userId?: number; role?: string };
      const stacks = await stackService.getAll();
      const filtered = await filterStacksByTeam(session.userId!, session.role || 'user', stacks);
      res.json({ success: true, data: filtered });
    } catch (err) { next(err); }
  },

  async systemInfo(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { dockerService } = await import('../services/docker.service');
      const [dockerOk, dockerVersion, stacks] = await Promise.all([
        dockerService.ping(),
        dockerService.getVersion(),
        stackService.getAll(),
      ]);
      const totalContainers = stacks.reduce((sum, s) => sum + s.containers.length, 0);

      // Server version — read from the bundled package.json. This is the source of truth for
      // "what version of the server code is running right now" since the image is built from it.
      let serverVersion: string | null = null;
      try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        // Walk up from __dirname looking for a package.json that has our server name. Handles
        // both compiled (`dist/src/controllers`) and tsx-dev (`src/controllers`) layouts.
        let dir = __dirname;
        for (let i = 0; i < 5; i++) {
          const candidate = path.join(dir, 'package.json');
          if (fs.existsSync(candidate)) {
            const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
            if (pkg.name === '@oblihub/server') {
              serverVersion = pkg.version ?? null;
              break;
            }
          }
          dir = path.dirname(dir);
        }
      } catch { /* leave null */ }

      // Proxy image tag — best-effort. We find the proxy container (label oblihub.proxy=true on
      // the local engine), report its image. The "version" of nginx:alpine is the tag itself;
      // for end-users that's the most useful identifier.
      let proxyImage: string | null = null;
      try {
        const local = await dockerService.forEngine(null);
        const containers = await local.listContainers({ all: true, filters: { label: ['oblihub.proxy=true'] } });
        if (containers[0]) {
          proxyImage = containers[0].Image || null;
        }
      } catch { /* leave null */ }

      // Find our own server container — used to surface the image tag we're actually running
      // (in case the package.json read above doesn't match what was deployed).
      let serverImage: string | null = null;
      let clientImage: string | null = null;
      try {
        const selfId = dockerService.getSelfContainerId();
        if (selfId) {
          const selfInfo = await dockerService.inspectContainer(selfId);
          serverImage = selfInfo.Config?.Image || null;
          const composeProject = selfInfo.Config?.Labels?.['com.docker.compose.project'];
          if (composeProject) {
            const local = await dockerService.forEngine(null);
            const siblings = await local.listContainers({
              all: true,
              filters: { label: [`com.docker.compose.project=${composeProject}`] },
            });
            const clientSibling = siblings.find((c) => {
              const svc = c.Labels?.['com.docker.compose.service'];
              return svc === 'client';
            });
            if (clientSibling) clientImage = clientSibling.Image || null;
          }
        }
      } catch { /* leave nulls */ }

      const mem = process.memoryUsage();
      res.json({
        success: true,
        data: {
          dockerConnected: dockerOk,
          dockerVersion,
          stackCount: stacks.length,
          containerCount: totalContainers,
          allowConsole: config.allowConsole,
          allowStack: config.allowStack,
          allowNginx: config.allowNginx,
          versions: {
            server: serverVersion,
            serverImage,
            clientImage,
            proxyImage,
            node: process.version,
          },
          instance: {
            uptimeSeconds: Math.round(process.uptime()),
            platform: process.platform,
            arch: process.arch,
          },
          memory: {
            processRssMb: Math.round(mem.rss / 1024 / 1024),
            processHeapMb: Math.round(mem.heapUsed / 1024 / 1024),
          },
        },
      });
    } catch (err) { next(err); }
  },

  /** GET /:id/resources — StackResourcesInfo of the stack's own engine (capacity, GPUs, what this viewer may edit). */
  async getResources(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const session = req.session as { userId?: number; role?: string };
      const data = await resourceLimitsService.getInfo(id, { userId: session.userId!, role: session.role || 'user' });
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  /** PUT /:id/resources — 200 even when `apply.ok` is false: the limits are stored either way. */
  async setResources(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const session = req.session as { userId?: number; role?: string };
      const role = session.role || 'user';
      const limits = resourceLimitsService.normalize(req.body, { stackId: id, role });
      const { stack, apply } = await resourceLimitsService.apply(id, limits, { role, userId: session.userId ?? null });
      res.json({ success: true, data: stack, apply });
    } catch (err) { next(err); }
  },

  /**
   * POST /:id/notify-busy — Critical apps that can't be watched via nginx or GPU (e.g. a
   * background LLM inference burst behind a non-proxied port) call this to stamp themselves
   * busy so Opportunistic stacks yielding to them get paused. Header: X-Oblihub-Priority-Token.
   */
  async notifyBusy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const provided = String(req.header('x-oblihub-priority-token') || '');
      const secret = await getOrCreateWebhookSecret();
      // Constant-time compare — token length is fixed so timingSafeEqual is safe.
      const ok = provided.length === secret.length
        && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
      if (!ok) { res.status(401).json({ success: false, error: 'Invalid priority token' }); return; }
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) throw new AppError(400, 'Invalid stack id');
      markCriticalBusy(id);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async notifyIdle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const provided = String(req.header('x-oblihub-priority-token') || '');
      const secret = await getOrCreateWebhookSecret();
      const ok = provided.length === secret.length
        && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
      if (!ok) { res.status(401).json({ success: false, error: 'Invalid priority token' }); return; }
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) throw new AppError(400, 'Invalid stack id');
      clearCriticalBusy(id);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /**
   * GET /activity — snapshot of critical-stack busy timestamps for the dashboard. Non-admins only
   * see the stacks their teams can see: a busy timestamp tells when another team's service is in use.
   */
  async getActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const activity = snapshotActivity();
      const session = req.session as { userId?: number; role?: string };
      if (session.role === 'admin') {
        res.json({ success: true, data: activity });
        return;
      }
      const { filterStacksByTeam } = await import('../middleware/permissions');
      // filterStacksByTeam only reads `id`, so the activity keys are enough.
      const visible = await filterStacksByTeam(session.userId!, session.role || 'user', Object.keys(activity).map((k) => ({ id: Number(k) }))) as Array<{ id: number }>;
      const out: Record<number, number> = {};
      for (const { id } of visible) out[id] = activity[id];
      res.json({ success: true, data: out });
    } catch (err) { next(err); }
  },

  /** GET /webhook-secret — admin-only, so the operator can copy it into a Critical app config. */
  async getWebhookSecret(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const secret = await getOrCreateWebhookSecret();
      res.json({ success: true, data: { secret } });
    } catch (err) { next(err); }
  },

  /** POST /webhook-secret/rotate — admin-only, generates a fresh secret. */
  async rotateWebhookSecret(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const generated = crypto.randomBytes(32).toString('hex');
      await appConfigService.set(WEBHOOK_SECRET_KEY, generated);
      res.json({ success: true, data: { secret: generated } });
    } catch (err) { next(err); }
  },

  async clearResources(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const session = req.session as { userId?: number; role?: string };
      const apply = await resourceLimitsService.clear(id, { role: session.role || 'user', userId: session.userId ?? null });
      res.json({ success: true, apply });
    } catch (err) { next(err); }
  },

  async systemFeatures(_req: Request, res: Response): Promise<void> {
    // Detect our own compose project
    let selfProject: string | null = null;
    try {
      const { dockerService } = await import('../services/docker.service');
      const selfId = dockerService.getSelfContainerId();
      logger.info({ selfId, hostname: process.env.HOSTNAME }, 'Self container detection');
      if (selfId) {
        const info = await dockerService.inspectContainer(selfId);
        selfProject = info.Config?.Labels?.['com.docker.compose.project'] || null;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to detect self container');
    }

    logger.info({ allowConsole: config.allowConsole, allowStack: config.allowStack, selfProject }, 'Features requested');
    res.json({
      success: true,
      data: {
        allowConsole: config.allowConsole,
        allowStack: config.allowStack,
        allowNginx: config.allowNginx,
        selfProject,
      },
    });
  },
};
