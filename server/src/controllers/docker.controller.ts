import type { Request, Response, NextFunction } from 'express';
import { dockerService } from '../services/docker.service';
import { volumeSetupService } from '../services/volumeSetup.service';
import { engineService } from '../services/engine.service';
import { stackVolumesService } from '../services/stackVolumes.service';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import type { DockerImage, DockerNetwork, DockerVolume } from '@oblihub/shared';

/**
 * Resolve the engine id requested via `?engineId=` query string. Values:
 *   undefined / ''       → null (= local default engine, legacy behaviour)
 *   "all"                → returns 'all' so the caller knows to fan out
 *   numeric              → that engine id
 *
 * "all" is used by list endpoints to fetch from every enabled engine in parallel and tag
 * each row with its source engine.
 */
function readEngineId(req: Request): number | null | 'all' {
  const raw = (req.query.engineId as string | undefined);
  if (!raw || raw === 'null') return null;
  if (raw === 'all') return 'all';
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** Map an engine to {id, name} for badging on aggregated responses. */
async function engineLabel(engineId: number | null): Promise<{ id: number | null; name: string }> {
  if (engineId == null) {
    const def = await engineService.getDefault();
    return { id: def?.id ?? null, name: def?.name ?? 'Local' };
  }
  const e = await engineService.getById(engineId);
  return { id: engineId, name: e?.name ?? `Engine ${engineId}` };
}

/** Iterate every enabled engine and run `fn` against each in parallel. */
async function forEachEngine<T>(fn: (engineId: number, name: string) => Promise<T>): Promise<{ engineId: number; engineName: string; ok: boolean; result?: T; error?: string }[]> {
  const engines = await engineService.getAll();
  const enabled = engines.filter(e => e.enabled);
  return Promise.all(enabled.map(async (e) => {
    try {
      const result = await fn(e.id, e.name);
      return { engineId: e.id, engineName: e.name, ok: true, result };
    } catch (err) {
      return { engineId: e.id, engineName: e.name, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }));
}

type ImageWithEngine = DockerImage & { engineId: number | null; engineName: string };
type NetworkWithEngine = DockerNetwork & { engineId: number | null; engineName: string };
type VolumeWithEngine = DockerVolume & { engineId: number | null; engineName: string };

export const dockerController = {
  // ── Images ──

  async listImages(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const target = readEngineId(req);
      const collect = async (engineId: number | null): Promise<ImageWithEngine[]> => {
        const label = await engineLabel(engineId);
        const rawImages = await dockerService.listImages(engineId);
        return rawImages.map(img => ({
          id: img.Id.replace('sha256:', '').substring(0, 12),
          repoTags: img.RepoTags || [],
          repoDigests: img.RepoDigests || [],
          size: img.Size,
          created: img.Created,
          containers: (img as unknown as { Containers: number }).Containers || 0,
          engineId: label.id,
          engineName: label.name,
        }));
      };
      let images: ImageWithEngine[] = [];
      if (target === 'all') {
        const buckets = await forEachEngine((id) => collect(id));
        images = buckets.flatMap(b => b.result || []);
      } else {
        images = await collect(target);
      }
      res.json({ success: true, data: images });
    } catch (err) { next(err); }
  },

  async pullImage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const { image, tag } = req.body as { image: string; tag?: string };
      if (!image) throw new AppError(400, 'Image name required');
      const target = readEngineId(req);
      const engineId = target === 'all' ? null : target;
      dockerService.pullImage(image, tag || 'latest', engineId).catch(() => {});
      res.json({ success: true, message: 'Pull started' });
    } catch (err) { next(err); }
  },

  async removeImage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const target = readEngineId(req);
      const engineId = target === 'all' ? null : target;
      await dockerService.removeImage(req.params.id, req.query.force === 'true', engineId);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Networks ──

  async listNetworks(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const target = readEngineId(req);
      const collect = async (engineId: number | null): Promise<NetworkWithEngine[]> => {
        const label = await engineLabel(engineId);
        const rawNetworks = await dockerService.listNetworks(engineId);
        return Promise.all(rawNetworks.map(async (net) => {
          let containers: DockerNetwork['containers'] = [];
          try {
            const detail = await dockerService.inspectNetwork(net.Id, engineId);
            const netContainers = detail.Containers || {};
            containers = Object.entries(netContainers).map(([id, c]) => ({
              id: id.substring(0, 12),
              name: (c as { Name: string }).Name,
              ipv4: (c as { IPv4Address: string }).IPv4Address || '',
              ipv6: (c as { IPv6Address: string }).IPv6Address || '',
            }));
          } catch { /* ignore */ }

          const labels = net.Labels || {};
          return {
            id: net.Id.substring(0, 12),
            name: net.Name,
            driver: net.Driver || 'bridge',
            scope: net.Scope || 'local',
            internal: net.Internal || false,
            attachable: net.Attachable || false,
            ipam: ((net.IPAM?.Config || []) as { Subnet?: string; Gateway?: string }[]).map(c => ({
              subnet: c.Subnet,
              gateway: c.Gateway,
            })),
            containers,
            labels,
            composeProject: labels['com.docker.compose.project'] || null,
            created: net.Created || '',
            engineId: label.id,
            engineName: label.name,
          };
        }));
      };
      let networks: NetworkWithEngine[] = [];
      if (target === 'all') {
        const buckets = await forEachEngine((id) => collect(id));
        networks = buckets.flatMap(b => b.result || []);
      } else {
        networks = await collect(target);
      }
      res.json({ success: true, data: networks });
    } catch (err) { next(err); }
  },

  async createNetwork(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const { name, driver, internal, attachable, labels, subnet, gateway } = req.body;
      if (!name) throw new AppError(400, 'Network name required');
      const target = readEngineId(req);
      const engineId = target === 'all' ? null : target;
      const id = await dockerService.createNetwork({ name, driver, internal, attachable, labels, subnet, gateway }, engineId);
      res.json({ success: true, data: { id } });
    } catch (err) { next(err); }
  },

  async removeNetwork(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const target = readEngineId(req);
      const engineId = target === 'all' ? null : target;
      await dockerService.removeNetwork(req.params.id, engineId);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async connectNetwork(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const { containerId, aliases } = req.body as { containerId: string; aliases?: string[] };
      if (!containerId) throw new AppError(400, 'Container ID required');
      const target = readEngineId(req);
      const engineId = target === 'all' ? null : target;
      await dockerService.connectNetwork(req.params.id, containerId, aliases, engineId);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async disconnectNetwork(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const { containerId } = req.body as { containerId: string };
      if (!containerId) throw new AppError(400, 'Container ID required');
      const target = readEngineId(req);
      const engineId = target === 'all' ? null : target;
      await dockerService.disconnectNetwork(req.params.id, containerId, true, engineId);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Volumes ──

  async listVolumes(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const target = readEngineId(req);
      const collect = async (engineId: number | null): Promise<VolumeWithEngine[]> => {
        const label = await engineLabel(engineId);
        const result = await dockerService.listVolumes(engineId);
        return (result.Volumes || []).map(v => {
          const labels = v.Labels || {};
          return {
            name: v.Name,
            driver: v.Driver,
            mountpoint: v.Mountpoint,
            scope: v.Scope || 'local',
            labels,
            composeProject: labels['com.docker.compose.project'] || null,
            created: (v as unknown as { CreatedAt?: string }).CreatedAt || '',
            usageSize: (v as unknown as { UsageData?: { Size?: number } }).UsageData?.Size ?? null,
            bindDevice: stackVolumesService.bindDeviceOf(v),
            engineId: label.id,
            engineName: label.name,
          };
        });
      };
      let volumes: VolumeWithEngine[] = [];
      if (target === 'all') {
        const buckets = await forEachEngine((id) => collect(id));
        volumes = buckets.flatMap(b => b.result || []);
      } else {
        volumes = await collect(target);
      }
      res.json({ success: true, data: volumes });
    } catch (err) { next(err); }
  },

  async createVolume(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const target = readEngineId(req);
      const engineId = target === 'all' ? null : target;
      // Structured form ("Add volume"): the server builds the driver options itself.
      if (req.body?.spec) {
        const created = await volumeSetupService.create(req.body.spec, engineId);
        res.json({ success: true, data: created });
        return;
      }
      const { name, driver, labels, driverOpts } = req.body;
      if (!name) throw new AppError(400, 'Volume name required');
      const info = await dockerService.createVolume({ name, driver, labels, driverOpts }, engineId);
      res.json({ success: true, data: info });
    } catch (err) { next(err); }
  },

  /** Mount test of a volume spec, before creating it: throw-away volume + helper, nothing kept. */
  async testVolume(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const target = readEngineId(req);
      const engineId = target === 'all' ? null : target;
      const user = typeof req.body?.user === 'string' ? req.body.user : null;
      const result = await volumeSetupService.test(req.body?.spec, engineId, user);
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  /** uid/gid an image runs as, to own a CIFS/S3 mount. */
  async imageIdentity(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const target = readEngineId(req);
      const engineId = target === 'all' ? null : target;
      const image = typeof req.query.image === 'string' ? req.query.image.trim() : '';
      const result = await volumeSetupService.identity(image, engineId);
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  async removeVolume(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const target = readEngineId(req);
      const engineId = target === 'all' ? null : target;
      await dockerService.removeVolume(req.params.name, req.query.force === 'true', engineId);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Prune ──

  async pruneImages(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const target = readEngineId(req);
      if (target === 'all') {
        const buckets = await forEachEngine((id) => dockerService.pruneImages(id));
        res.json({ success: true, data: { perEngine: buckets } });
        return;
      }
      const result = await dockerService.pruneImages(target);
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  async pruneNetworks(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const target = readEngineId(req);
      if (target === 'all') {
        const buckets = await forEachEngine((id) => dockerService.pruneNetworks(id));
        res.json({ success: true, data: { perEngine: buckets } });
        return;
      }
      const result = await dockerService.pruneNetworks(target);
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  async pruneVolumes(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const target = readEngineId(req);
      if (target === 'all') {
        const buckets = await forEachEngine((id) => dockerService.pruneVolumes(id));
        res.json({ success: true, data: { perEngine: buckets } });
        return;
      }
      const result = await dockerService.pruneVolumes(target);
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },
};
