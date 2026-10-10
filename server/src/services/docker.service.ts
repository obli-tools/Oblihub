import Docker from 'dockerode';
import { Readable, Duplex } from 'stream';
import { normalizeDockerPorts, type ContainerPort } from '@oblihub/shared';
import { config } from '../config';
import { logger } from '../utils/logger';
import { isOblihubHiddenContainer } from '../utils/oblihubContainers';

let dockerInstance: Docker | null = null;

function getDocker(): Docker {
  if (!dockerInstance) {
    dockerInstance = new Docker({ socketPath: config.dockerSocket });
  }
  return dockerInstance;
}

/**
 * Get a dockerode client for a specific engine.
 * Workers/services are meant to use this instead of the local-only `getDocker()`.
 * For now most code paths still call getDocker() — they implicitly target the Local engine.
 */
async function getDockerForEngine(engineId: number | null): Promise<Docker> {
  if (engineId == null) return getDocker();
  const { engineService } = await import('./engine.service');
  return engineService.getClient(engineId);
}

/**
 * The HealthConfig fields a container sets differently from its image, or undefined when none do.
 * The daemon fills each field compose left unset (Test, Interval, Retries...) from the image one
 * by one, so comparing whole objects would treat an `interval:`-only compose override as a full
 * healthcheck and pin the old image's Test. Fields dropped here come from the new image at create.
 */
function healthcheckOverrides(containerHc: unknown, imageHc: unknown): Docker.HealthConfig | undefined {
  if (!containerHc || typeof containerHc !== 'object') return undefined;
  const image = (imageHc && typeof imageHc === 'object' ? imageHc : {}) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(containerHc as Record<string, unknown>)) {
    if (value == null) continue;
    if (JSON.stringify(value) !== JSON.stringify(image[key])) kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? (kept as Docker.HealthConfig) : undefined;
}

export interface DiscoveredContainer {
  dockerId: string;
  containerName: string;
  image: string;
  imageTag: string;
  composeProject: string | null;
  composeService: string | null;
  state: string;
  labels: Record<string, string>;
  ports: ContainerPort[];
  networkMode: string | null;
}

export const dockerService = {
  /**
   * Get a dockerode client for an engine. `null` or omitted = the local engine.
   * Multi-engine workers iterate engines and call `dockerService.forEngine(id)` to retrieve the right client.
   */
  async forEngine(engineId: number | null = null): Promise<Docker> {
    return getDockerForEngine(engineId);
  },

  /** List all running containers, extracting compose project info */
  async listContainers(engineId: number | null = null): Promise<DiscoveredContainer[]> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const containers = await docker.listContainers({ all: true });
    // The host agent and one-shot helpers must never become Standalone rows, get update checks or
    // make stacks flap as they come and go. The label alone is not trusted (a tenant can set it on
    // its own compose to hide a service from priorities and caps); the reserved name is required too.
    return containers.filter((c) => !isOblihubHiddenContainer(c)).map((c) => {
      const labels = c.Labels || {};
      // Parse image:tag — handle registry/namespace/repo:tag
      const fullImage = c.Image || '';
      let image = fullImage;
      let imageTag = 'latest';
      const lastColon = fullImage.lastIndexOf(':');
      // Check if the colon is part of a tag (not a port in registry URL)
      if (lastColon > 0 && !fullImage.substring(lastColon).includes('/')) {
        image = fullImage.substring(0, lastColon);
        imageTag = fullImage.substring(lastColon + 1);
      }

      // Compacted: Docker lists IPv4 + IPv6 duplicates and one entry per port of a published range
      // (a 10000-port UDP range used to become ten thousand JSON entries per discovery pass).
      const ports = normalizeDockerPorts((c.Ports || []).map((p) => ({
        privatePort: p.PrivatePort,
        publicPort: p.PublicPort ?? null,
        type: p.Type,
        ip: p.IP,
      })));

      return {
        dockerId: c.Id.substring(0, 12),
        containerName: (c.Names?.[0] || '').replace(/^\//, ''),
        image,
        imageTag,
        composeProject: labels['com.docker.compose.project'] || null,
        composeService: labels['com.docker.compose.service'] || null,
        state: c.State || 'unknown',
        labels,
        ports,
        networkMode: c.HostConfig?.NetworkMode ?? null,
      };
    });
  },

  /**
   * Live resource update (`docker update`) of one container on its own engine. Used where compose
   * cannot apply limits (Standalone containers, https-apikey engines).
   */
  async updateContainerResources(
    dockerId: string,
    engineId: number,
    update: { NanoCpus?: number; Memory?: number; MemorySwap?: number; CpuShares?: number },
  ): Promise<void> {
    const docker = await getDockerForEngine(engineId);
    logger.info({ dockerId, engineId, update }, 'Updating container resources...');
    await docker.getContainer(dockerId).update(update);
    logger.info({ dockerId, engineId }, 'Container resources updated');
  },

  /** Every container (all states) of one compose project on one engine, Oblihub's hidden helpers removed. */
  async listProjectContainers(projectName: string, engineId: number): Promise<Docker.ContainerInfo[]> {
    const docker = await getDockerForEngine(engineId);
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${projectName}`] },
    });
    return containers.filter((c) => !isOblihubHiddenContainer(c));
  },

  /**
   * Get ALL local digests associated with the image (full RepoDigests list).
   * Docker may accumulate multiple sha256 digests over time when a registry
   * re-manifests a tag (same image content, new manifest wrapping) — all of
   * them represent valid locally-known states of the image.
   */
  async getLocalDigests(imageName: string, engineId: number | null = null): Promise<string[]> {
    try {
      const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
      const imageInfo = await docker.getImage(imageName).inspect();
      const digests = imageInfo.RepoDigests || [];
      const out: string[] = [];
      for (const d of digests) {
        const atIdx = d.indexOf('@');
        if (atIdx >= 0) out.push(d.substring(atIdx + 1));
      }
      return out;
    } catch (err) {
      logger.warn({ imageName, err }, 'Failed to get local digests');
      return [];
    }
  },

  /** Get the first local image digest (for display/storage). Returns null if none. */
  async getLocalDigest(imageName: string, engineId: number | null = null): Promise<string | null> {
    const all = await this.getLocalDigests(imageName, engineId);
    return all[0] ?? null;
  },

  /** Pull a new image */
  async pullImage(
    imageName: string,
    tag: string = 'latest',
    engineId: number | null = null,
    onProgress?: (event: { status?: string; id?: string; progress?: string; progressDetail?: { current?: number; total?: number } }) => void,
  ): Promise<void> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const fullRef = `${imageName}:${tag}`;
    logger.info({ fullRef }, 'Pulling image...');

    // Attach Docker Hub auth only for Docker Hub images. The image ref has no registry prefix
    // (e.g. "nginx", "myorg/foo") OR explicitly references docker.io. Passing these creds to a
    // different registry (ghcr.io, lscr.io, …) would be rejected, so we scope it carefully.
    const pullOpts: { authconfig?: { username: string; password: string; serveraddress: string } } = {};
    const firstSegment = imageName.split('/')[0];
    const isDockerHub = !firstSegment.includes('.') && !firstSegment.includes(':') || firstSegment === 'docker.io' || firstSegment === 'registry-1.docker.io';
    if (isDockerHub && config.dockerHubUsername && config.dockerHubToken) {
      pullOpts.authconfig = {
        username: config.dockerHubUsername,
        password: config.dockerHubToken,
        serveraddress: 'https://index.docker.io/v1/',
      };
    }

    return new Promise((resolve, reject) => {
      docker.pull(fullRef, pullOpts, (err: Error | null, stream?: NodeJS.ReadableStream) => {
        if (err || !stream) return reject(err || new Error('No stream'));
        // Follow the pull progress stream to completion. Third arg `onProgress` is called for
        // every JSON event in the stream — pull layer status, download bars, "Pull complete",
        // etc. We forward each to the optional caller-supplied callback so the UI can render
        // a live tail without us having to buffer/parse anything.
        docker.modem.followProgress(
          stream,
          (err2: Error | null) => {
            if (err2) return reject(err2);
            logger.info({ fullRef }, 'Image pulled successfully');
            resolve();
          },
          onProgress
            ? (event: { status?: string; id?: string; progress?: string; progressDetail?: { current?: number; total?: number } }) => {
                try { onProgress(event); } catch { /* never let UI emission break the pull */ }
              }
            : undefined,
        );
      });
    });
  },

  /** Inspect a container to capture its full config for recreation */
  async inspectContainer(dockerId: string, engineId: number | null = null): Promise<Docker.ContainerInspectInfo> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const container = docker.getContainer(dockerId);
    return container.inspect();
  },

  /**
   * Recreate a container with a new image, preserving all config.
   * Steps: inspect → stop → remove → create (same config, new image) → start
   * Returns the new container ID.
   *
   * `preserveState`: the new container ends in the old one's state (running → started, paused →
   * started then paused, stopped → left created) instead of always being started.
   */
  async recreateContainer(
    dockerId: string,
    newImage: string,
    newTag: string,
    engineId: number | null = null,
    opts: { preserveState?: boolean } = {},
  ): Promise<string> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const container = docker.getContainer(dockerId);

    // 1. Capture full config
    const info = await container.inspect();
    const oldName = info.Name.replace(/^\//, '');
    // Read before the stop below changes it.
    const wasPaused = info.State?.Paused === true;
    const wasRunning = info.State?.Running === true && !wasPaused;

    // The daemon folds the image's HEALTHCHECK and STOPSIGNAL into the container Config at create
    // time, so the old image's Config is needed to tell compose/`docker run` settings apart from
    // image defaults (step 4). Read here, before the stop, so it adds no downtime. The old image is
    // still present: the container references it by ID and the pull only moved the tag.
    let oldImageConfig: { Healthcheck?: unknown; StopSignal?: string } | null = null;
    try {
      const oldImage = await docker.getImage(info.Image).inspect();
      oldImageConfig = (oldImage.Config ?? {}) as { Healthcheck?: unknown; StopSignal?: string };
    } catch (err) {
      logger.warn({ dockerId, image: info.Image, err: err instanceof Error ? err.message : String(err) },
        'Old image not inspectable; healthcheck and stop signal will come from the new image');
    }

    logger.info({ dockerId, oldName, newImage: `${newImage}:${newTag}` }, 'Recreating container...');

    // 2. Stop
    try {
      await container.stop({ t: 10 });
    } catch (err: unknown) {
      // An exited/created container makes the daemon answer 304, which dockerode surfaces as
      // "(HTTP code 304) container already stopped". Rethrowing it failed every update of a
      // sleeping or watchdog-stopped container, so the preserveState "left stopped" path in step 8
      // could never run. The status code is checked first because the message text varies across
      // daemon versions.
      const code = (err as { statusCode?: number } | null)?.statusCode;
      if (code !== 304 && !(err instanceof Error && /not running|already stopped/i.test(err.message))) throw err;
    }

    // 3. Remove
    await container.remove({ force: true });

    // 4. Build create options from inspect data
    const createOpts: Docker.ContainerCreateOptions = {
      name: oldName,
      Image: `${newImage}:${newTag}`,
      Cmd: info.Config.Cmd || undefined,
      Entrypoint: info.Config.Entrypoint || undefined,
      Env: info.Config.Env || [],
      Labels: info.Config.Labels || {},
      ExposedPorts: info.Config.ExposedPorts || {},
      WorkingDir: info.Config.WorkingDir || undefined,
      User: info.Config.User || undefined,
      Hostname: info.Config.Hostname || undefined,
      Domainname: info.Config.Domainname || undefined,
      Tty: info.Config.Tty || false,
      OpenStdin: info.Config.OpenStdin || false,
      StdinOnce: info.Config.StdinOnce || false,
      HostConfig: info.HostConfig as Docker.HostConfig,
      NetworkingConfig: undefined as unknown as Record<string, unknown>,
    };
    // Compose healthchecks (and stop settings) were lost on every Oblihub update, so dependants
    // waiting on `service_healthy` and graceful-shutdown timeouts silently changed behaviour.
    // Only values that differ from the old image's were set explicitly: copying an image default
    // would pin the OLD image's HEALTHCHECK/STOPSIGNAL over whatever the new image declares.
    // Without the old image's Config nothing is copied, so the new image's defaults apply.
    const oldConfig = info.Config as typeof info.Config & { StopSignal?: string; StopTimeout?: number };
    if (oldImageConfig) {
      const healthcheck = healthcheckOverrides(oldConfig.Healthcheck, oldImageConfig.Healthcheck);
      if (healthcheck) createOpts.Healthcheck = healthcheck;
      if (oldConfig.StopSignal && oldConfig.StopSignal !== oldImageConfig.StopSignal) {
        createOpts.StopSignal = oldConfig.StopSignal;
      }
    }
    // No Dockerfile instruction sets a stop timeout, so any value here came from compose/`docker run`.
    if (oldConfig.StopTimeout != null) createOpts.StopTimeout = oldConfig.StopTimeout;

    // 5. Rebuild network config from inspect data
    const networks = info.NetworkSettings?.Networks;
    let additionalNetworks: Array<{ name: string; config: NonNullable<typeof networks>[string] }> = [];
    if (networks && Object.keys(networks).length > 0) {
      const endpointsConfig: Record<string, Docker.EndpointSettings> = {};
      // Only attach to the first network at creation time.
      // Additional networks must be connected after creation.
      const networkNames = Object.keys(networks);
      const primaryNet = networkNames[0];
      const primaryConfig = networks[primaryNet];
      endpointsConfig[primaryNet] = {
        Aliases: primaryConfig.Aliases || [],
        IPAMConfig: primaryConfig.IPAMConfig || undefined,
      } as Docker.EndpointSettings;

      createOpts.NetworkingConfig = { EndpointsConfig: endpointsConfig };

      // Store additional networks for post-creation connection
      additionalNetworks = networkNames.slice(1).map(name => ({
        name,
        config: networks[name],
      }));
    }

    // 6. Create container
    const newContainer = await docker.createContainer(createOpts);
    const newId = newContainer.id.substring(0, 12);

    // 7. Connect additional networks before starting
    for (const net of additionalNetworks) {
      try {
        const network = docker.getNetwork(net.name);
        await network.connect({
          Container: newContainer.id,
          EndpointConfig: {
            Aliases: net.config.Aliases || [],
            IPAMConfig: net.config.IPAMConfig || undefined,
          } as Docker.EndpointSettings,
        });
      } catch (err) {
        logger.warn({ network: net.name, newId }, 'Failed to connect additional network');
      }
    }

    // 8. Start, or restore the previous state. Without preserveState every recreate starts the
    // container, as it always has.
    if (!opts.preserveState || wasRunning) {
      await newContainer.start();
    } else if (wasPaused) {
      await newContainer.start();
      await newContainer.pause();
      logger.info({ newId, name: oldName }, 'Recreated container paused again (it was paused before the update)');
    } else {
      logger.info({ newId, name: oldName }, 'Recreated container left stopped (it was not running before the update)');
    }
    logger.info({ oldId: dockerId, newId, name: oldName }, 'Container recreated successfully');
    return newId;
  },

  /** Restart a container (stop + start) */
  async restartContainer(dockerId: string, engineId: number | null = null): Promise<void> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const container = docker.getContainer(dockerId);
    logger.info({ dockerId, engineId }, 'Restarting container...');
    await container.restart();
    logger.info({ dockerId }, 'Container restarted');
  },

  /** Remove a container (stop + remove, optionally remove volumes) */
  async removeContainer(dockerId: string, removeVolumes = false, engineId: number | null = null): Promise<void> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const container = docker.getContainer(dockerId);
    logger.info({ dockerId, removeVolumes, engineId }, 'Removing container...');
    try {
      await container.stop({ t: 5 });
    } catch { /* already stopped */ }
    await container.remove({ force: true, v: removeVolumes });
    logger.info({ dockerId }, 'Container removed');
  },

  /** Stop a container */
  async stopContainer(dockerId: string, engineId: number | null = null): Promise<void> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const container = docker.getContainer(dockerId);
    logger.info({ dockerId, engineId }, 'Stopping container...');
    await container.stop({ t: 10 });
    logger.info({ dockerId }, 'Container stopped');
  },

  /** Start a stopped container */
  async startContainer(dockerId: string, engineId: number | null = null): Promise<void> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const container = docker.getContainer(dockerId);
    logger.info({ dockerId, engineId }, 'Starting container...');
    await container.start();
    logger.info({ dockerId }, 'Container started');
  },

  /** Pause a running container (cgroup freezer — does NOT free GPU VRAM). */
  async pauseContainer(dockerId: string, engineId: number | null = null): Promise<void> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const container = docker.getContainer(dockerId);
    logger.info({ dockerId, engineId }, 'Pausing container...');
    await container.pause();
    logger.info({ dockerId }, 'Container paused');
  },

  /** Unpause a paused container. */
  async unpauseContainer(dockerId: string, engineId: number | null = null): Promise<void> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const container = docker.getContainer(dockerId);
    logger.info({ dockerId, engineId }, 'Unpausing container...');
    await container.unpause();
    logger.info({ dockerId }, 'Container unpaused');
  },

  /** Stream container logs. Returns the stream so the caller can destroy it. */
  async getContainerLogs(dockerId: string, tail: number = 100, engineId: number | null = null): Promise<Readable> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const container = docker.getContainer(dockerId);
    const stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    });
    return stream as unknown as Readable;
  },

  /** Create an exec instance for interactive shell */
  async execContainer(dockerId: string, cols: number = 80, rows: number = 24, engineId: number | null = null): Promise<{ exec: Docker.Exec; stream: Duplex; engineId: number | null }> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const container = docker.getContainer(dockerId);
    const exec = await container.exec({
      Cmd: ['/bin/sh'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: [`COLUMNS=${cols}`, `LINES=${rows}`, 'TERM=xterm-256color'],
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true } as Docker.ExecStartOptions);
    // We return engineId so callers (the socket handler) can use the same daemon for follow-up
    // exec/resize calls without having to re-resolve the engine.
    return { exec, stream: stream as unknown as Duplex, engineId };
  },

  /** Resize an exec TTY on the specified engine (defaults to the local daemon). */
  async execResize(execId: string, cols: number, rows: number, engineId: number | null = null): Promise<void> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    // dockerode doesn't have a direct execResize, use modem
    await new Promise<void>((resolve, reject) => {
      docker.modem.dial({
        path: `/exec/${execId}/resize?h=${rows}&w=${cols}`,
        method: 'POST',
        statusCodes: { 200: true, 201: true },
      }, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  },

  /**
   * Clean up old renamed containers left over from a self-update.
   * Called on startup. Finds containers whose name contains "-old-" and removes them.
   */
  async cleanupOldSelfContainers(): Promise<void> {
    try {
      const docker = getDocker();
      const containers = await docker.listContainers({ all: true });
      for (const c of containers) {
        const name = (c.Names?.[0] || '').replace(/^\//, '');
        if (name.match(/-old-\d+$/)) {
          logger.info({ name, id: c.Id.substring(0, 12), state: c.State }, 'Cleaning up old self-update container');
          const container = docker.getContainer(c.Id);
          try {
            if (c.State === 'running') await container.stop({ t: 5 });
          } catch { /* already stopped */ }
          await container.remove({ force: true });
          logger.info({ name }, 'Old container removed');
        }
      }
    } catch (err) {
      logger.warn(err, 'Failed to clean up old self-update containers');
    }
  },

  /** Check if Docker socket is accessible */
  async ping(): Promise<boolean> {
    try {
      const docker = getDocker();
      await docker.ping();
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Get our own container ID by reading /proc/self/cgroup or HOSTNAME env.
   * Returns null if not running in Docker.
   */
  getSelfContainerId(): string | null {
    // Docker sets HOSTNAME to the container ID (first 12 chars)
    const hostname = process.env.HOSTNAME;
    if (hostname && /^[a-f0-9]{12,}$/.test(hostname)) {
      return hostname.substring(0, 12);
    }
    try {
      const fs = require('fs');
      // cgroups v1: /proc/self/cgroup contains docker/containerId
      try {
        const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8') as string;
        const match = cgroup.match(/docker[/-]([a-f0-9]{12,64})/);
        if (match) return match[1].substring(0, 12);
      } catch { /* ignore */ }
      // cgroups v2 / modern Docker: /proc/self/mountinfo contains /docker/containers/<id>
      try {
        const mountinfo = fs.readFileSync('/proc/self/mountinfo', 'utf8') as string;
        const match = mountinfo.match(/\/docker\/containers\/([a-f0-9]{12,64})/);
        if (match) return match[1].substring(0, 12);
      } catch { /* ignore */ }
      // Fallback: hostname file
      try {
        const hostnameFile = fs.readFileSync('/etc/hostname', 'utf8').trim() as string;
        if (/^[a-f0-9]{12,}$/.test(hostnameFile)) {
          return hostnameFile.substring(0, 12);
        }
      } catch { /* ignore */ }
    } catch { /* not in Docker */ }
    return null;
  },

  /**
   * Self-update: pull new image, then use a helper container with docker CLI
   * to run `docker compose up -d` on the host. This preserves compose networking.
   *
   * Strategy: spawn a short-lived `docker/cli` container that mounts the Docker
   * socket and the compose project dir, then runs `docker compose up -d --no-deps <service>`.
   * This container outlives us (our container gets recreated by compose).
   */
  async selfUpdate(newImage: string, newTag: string): Promise<void> {
    const selfId = this.getSelfContainerId();
    if (!selfId) throw new Error('Cannot determine own container ID — not running in Docker?');

    const docker = getDocker();
    const self = docker.getContainer(selfId);
    const info = await self.inspect();
    const labels = info.Config.Labels || {};
    const composeProject = labels['com.docker.compose.project'] || null;
    const composeWorkdir = labels['com.docker.compose.project.working_dir'] || null;
    const composeService = labels['com.docker.compose.service'] || 'server';

    logger.info({ selfId, composeProject, composeService, newImage: `${newImage}:${newTag}` }, 'Self-update: starting...');

    // 1. Pull the new image (while we're still running)
    await this.pullImage(newImage, newTag);
    logger.info('Self-update: image pulled');

    if (!composeProject || !composeWorkdir) {
      throw new Error('Self-update requires a Docker Compose project. Update manually with: docker compose pull && docker compose up -d');
    }

    // 2. Spawn a helper container that runs docker compose up -d
    // The helper mounts the Docker socket and the compose project dir,
    // runs the compose command, then exits. Because it's a separate container,
    // it survives the recreation of our own container.
    const helperImage = 'docker:cli';

    // Ensure the helper image is available
    try {
      await docker.getImage(helperImage).inspect();
    } catch {
      logger.info('Self-update: pulling docker:cli helper image...');
      await this.pullImage('docker', 'cli');
    }

    const helperContainer = await docker.createContainer({
      Image: helperImage,
      Cmd: ['sh', '-c', `sleep 2 && docker compose -p ${composeProject} up -d --no-deps ${composeService}`],
      HostConfig: {
        Binds: [
          '/var/run/docker.sock:/var/run/docker.sock',
          `${composeWorkdir}:${composeWorkdir}`,
        ],
        AutoRemove: true,
      } as Docker.HostConfig,
      WorkingDir: composeWorkdir,
    });

    await helperContainer.start();
    logger.info('Self-update: helper container started, will recreate us via compose. Exiting...');

    // 3. Exit — the helper container will docker compose up -d us with proper networking
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  },

  // ── Docker resource management ──

  /** List all images */
  async listImages(engineId: number | null = null): Promise<Docker.ImageInfo[]> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    return docker.listImages({ all: false });
  },

  /** Remove an image */
  async removeImage(imageId: string, force = false, engineId: number | null = null): Promise<void> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const image = docker.getImage(imageId);
    await image.remove({ force });
    logger.info({ imageId, engineId }, 'Image removed');
  },

  /** List all networks */
  async listNetworks(engineId: number | null = null): Promise<Docker.NetworkInspectInfo[]> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    return docker.listNetworks();
  },

  /** Inspect a network */
  async inspectNetwork(networkId: string, engineId: number | null = null): Promise<Docker.NetworkInspectInfo> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const network = docker.getNetwork(networkId);
    return network.inspect();
  },

  /** Create a network */
  async createNetwork(opts: { name: string; driver?: string; internal?: boolean; attachable?: boolean; labels?: Record<string, string>; subnet?: string; gateway?: string }, engineId: number | null = null): Promise<string> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const createOpts: Docker.NetworkCreateOptions = {
      Name: opts.name,
      Driver: opts.driver || 'bridge',
      Internal: opts.internal || false,
      Attachable: opts.attachable !== false,
      Labels: opts.labels || {},
      IPAM: undefined,
    };
    if (opts.subnet) {
      createOpts.IPAM = {
        Driver: 'default',
        Config: [{ Subnet: opts.subnet, Gateway: opts.gateway || undefined }],
      };
    }
    const network = await docker.createNetwork(createOpts);
    logger.info({ name: opts.name, id: network.id, engineId }, 'Network created');
    return network.id;
  },

  /** Remove a network */
  async removeNetwork(networkId: string, engineId: number | null = null): Promise<void> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const network = docker.getNetwork(networkId);
    await network.remove();
    logger.info({ networkId, engineId }, 'Network removed');
  },

  /** Connect a container to a network */
  async connectNetwork(networkId: string, containerId: string, aliases?: string[], engineId: number | null = null): Promise<void> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const network = docker.getNetwork(networkId);
    await network.connect({ Container: containerId, EndpointConfig: { Aliases: aliases || [] } as Docker.EndpointSettings });
    logger.info({ networkId, containerId, engineId }, 'Container connected to network');
  },

  /** Disconnect a container from a network */
  async disconnectNetwork(networkId: string, containerId: string, force = false, engineId: number | null = null): Promise<void> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const network = docker.getNetwork(networkId);
    await network.disconnect({ Container: containerId, Force: force });
    logger.info({ networkId, containerId, engineId }, 'Container disconnected from network');
  },

  /** List all volumes */
  async listVolumes(engineId: number | null = null): Promise<{ Volumes: Docker.VolumeInspectInfo[]; Warnings: string[] }> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    return docker.listVolumes();
  },

  /** Create a volume */
  async createVolume(opts: { name: string; driver?: string; labels?: Record<string, string>; driverOpts?: Record<string, string> }, engineId: number | null = null): Promise<Docker.VolumeCreateResponse> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const volume = await docker.createVolume({
      Name: opts.name,
      Driver: opts.driver || 'local',
      Labels: opts.labels || {},
      DriverOpts: opts.driverOpts || {},
    });
    logger.info({ name: opts.name, engineId }, 'Volume created');
    return volume;
  },

  /** Remove a volume */
  async removeVolume(name: string, force = false, engineId: number | null = null): Promise<void> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const volume = docker.getVolume(name);
    await volume.remove({ force });
    logger.info({ name, engineId }, 'Volume removed');
  },

  // ── Prune operations ──

  /** Prune unused images */
  async pruneImages(engineId: number | null = null): Promise<{ deleted: string[]; spaceReclaimed: number }> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const result = await docker.pruneImages({ filters: { dangling: { 'false': true } } });
    const deleted = (result.ImagesDeleted || []).map((i: { Deleted?: string; Untagged?: string }) => i.Deleted || i.Untagged || '').filter(Boolean);
    logger.info({ count: deleted.length, space: result.SpaceReclaimed, engineId }, 'Images pruned');
    return { deleted, spaceReclaimed: result.SpaceReclaimed || 0 };
  },

  /** Prune unused networks */
  async pruneNetworks(engineId: number | null = null): Promise<{ deleted: string[] }> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const result = await docker.pruneNetworks();
    const deleted = result.NetworksDeleted || [];
    logger.info({ count: deleted.length, engineId }, 'Networks pruned');
    return { deleted };
  },

  /** Prune unused volumes */
  async pruneVolumes(engineId: number | null = null): Promise<{ deleted: string[]; spaceReclaimed: number }> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const result = await docker.pruneVolumes();
    const deleted = result.VolumesDeleted || [];
    logger.info({ count: deleted.length, space: result.SpaceReclaimed, engineId }, 'Volumes pruned');
    return { deleted, spaceReclaimed: result.SpaceReclaimed || 0 };
  },

  /** Get Docker engine version info */
  async getVersion(): Promise<{ version: string; apiVersion: string } | null> {
    try {
      const docker = getDocker();
      const info = await docker.version();
      return { version: info.Version, apiVersion: info.ApiVersion };
    } catch {
      return null;
    }
  },

  /**
   * Name of the shared reverse-proxy network. Configurable via the `proxy_network_name` app
   * setting; defaults to `proxy`. Needs to be configurable because docker-compose prefixes
   * network names with the project name unless the compose file declares `name:` explicitly —
   * an install brought up with `COMPOSE_PROJECT_NAME=oblihub` and a plain `proxy:` network
   * ends up with `oblihub_proxy`, and hardcoding "proxy" leaves the auto-created auth sidecar
   * unable to reach the actual nginx container. Cached briefly to avoid a db hit on every
   * docker-facing call.
   */
  async getProxyNetworkName(): Promise<string> {
    const { appConfigService } = await import('./appConfig.service');
    const v = await appConfigService.get('proxy_network_name');
    const trimmed = v?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : 'proxy';
  },

  /**
   * Ensure the shared proxy bridge network exists on the given engine. Idempotent. Returns
   * the network id on success, null when the engine is unreachable (so we don't crash startup).
   *
   * Every managed stack Oblihub deploys gets its containers auto-attached to this network so
   * the integrated nginx proxy can resolve `forward_host: <compose-service-name>` via Docker
   * DNS without needing published host ports.
   */
  async ensureProxyNetwork(engineId: number | null = null): Promise<string | null> {
    try {
      const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
      const name = await this.getProxyNetworkName();
      try {
        const net = await docker.getNetwork(name).inspect();
        return net.Id;
      } catch {
        // not found — create it
      }
      const created = await docker.createNetwork({
        Name: name,
        Driver: 'bridge',
        CheckDuplicate: true,
        Labels: { 'oblihub.shared': 'true' },
      });
      logger.info({ engineId, name }, 'Created shared proxy network');
      return created.id;
    } catch (err) {
      logger.warn({ engineId, err: err instanceof Error ? err.message : String(err) }, 'ensureProxyNetwork failed');
      return null;
    }
  },

  /**
   * Attach a container to the shared proxy network. Idempotent — "already on this network"
   * errors are swallowed. Throws on unrecoverable issues so the caller can decide whether to
   * fail the deploy or just log.
   */
  async connectToProxyNetwork(containerId: string, engineId: number | null = null): Promise<void> {
    const docker = engineId == null ? getDocker() : await getDockerForEngine(engineId);
    const name = await this.getProxyNetworkName();
    try {
      await docker.getNetwork(name).connect({ Container: containerId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // dockerode surfaces "already exists" / "endpoint already exists" — fine, idempotent.
      if (/already (exists|connected)/i.test(msg)) return;
      throw err;
    }
  },
};
