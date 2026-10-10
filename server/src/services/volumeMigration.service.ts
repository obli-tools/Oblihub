import { dockerService } from './docker.service';
import { logger } from '../utils/logger';
import { composeRunner } from './composeRunner.service';
import { engineFactsService } from './engineFacts.service';
import { SOCKET_EVENTS } from '@oblihub/shared';
import { Duplex, PassThrough } from 'stream';

/**
 * Volume migration between Docker engines.
 *
 * Strategy: for each named volume the stack uses, we spawn an `alpine` helper container on the
 * source engine that runs `tar cf - -C /data .` against the volume read-only, then attach to its
 * stdout stream. Simultaneously we spawn an `alpine` helper on the destination engine running
 * `tar xf - -C /data` against a freshly-created volume of the same name, attached to its stdin.
 * We pipe source.stdout → dest.stdin through the Oblihub server process — bytes flow through
 * our Node runtime, which means:
 *
 *   - No SSH/rsync prerequisites on either Docker host
 *   - Works for any engine type dockerode can reach (SSH/TLS/API/local)
 *   - The transfer rate is bounded by min(source SSH/TCP bandwidth, dest SSH/TCP bandwidth) and
 *     by our Node memory pressure — but we pipe streams, no full buffering
 *   - Cancellable: aborting the AbortSignal kills both helpers + closes pipes
 *
 * Out of scope (today):
 *   - Bind mounts: those map to host paths Oblihub can't read across engines without filesystem
 *     access. We surface them as "skipped" and let the operator copy manually if needed.
 *   - tmpfs / external volumes: not migrated (tmpfs is ephemeral; external is assumed managed
 *     out-of-band).
 *
 * Per-volume progress is reported via the existing `compose:log` socket channel so the client
 * panel renders it without extra plumbing. It goes to the stack's compose room on the SOURCE
 * daemon: the managed stack still points there while its volumes are copied, so that is the room
 * its editor page is subscribed to.
 */

const HELPER_IMAGE = 'alpine:3';

/** Where one migration's progress lines go: a compose room (null key = nowhere). */
interface ProgressSink { projectName: string; daemonKey: string | null }

async function progressSink(projectName: string, managedEngineId: number | null): Promise<ProgressSink> {
  try {
    return { projectName, daemonKey: await engineFactsService.managedDaemonKey(managedEngineId) };
  } catch (err) {
    logger.debug({ projectName, managedEngineId, err }, 'Volume migration progress: daemon key unresolved, live lines dropped');
    return { projectName, daemonKey: null };
  }
}

function emit(sink: ProgressSink, chunk: string): void {
  // Room only, like every COMPOSE_* event: without a daemon key there is no room whose members were
  // checked for access to the stack, so the line is dropped rather than broadcast.
  if (!sink.daemonKey) return;
  composeRunner.emitComposeEvent(sink.daemonKey, sink.projectName, SOCKET_EVENTS.COMPOSE_LOG, {
    projectName: sink.projectName, stream: 'stdout', chunk,
  });
}

async function ensureHelperImage(engineId: number | null): Promise<void> {
  // Pull alpine if missing on the target engine. Idempotent; uses authconfig from env if set.
  try {
    const docker = await dockerService.forEngine(engineId);
    const images = await docker.listImages({ filters: { reference: [HELPER_IMAGE] } });
    if (images.length > 0) return;
  } catch { /* fall through to pull */ }
  await dockerService.pullImage('alpine', '3', engineId);
}

interface MigratedVolume {
  name: string;
  ok: boolean;
  bytesIn?: number;
  error?: string;
}

export const volumeMigrationService = {
  /**
   * Discover the named volumes attached to a stack on the source engine. Returns the actual
   * Docker volume names (already prefixed by compose, e.g. `myapp_postgres_data`). Bind mounts
   * are returned separately for the UI to warn about.
   */
  async discoverVolumes(composeProject: string, sourceEngineId: number | null): Promise<{ named: string[]; binds: string[] }> {
    const docker = await dockerService.forEngine(sourceEngineId);
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${composeProject}`] },
    });
    const named = new Set<string>();
    const binds = new Set<string>();
    for (const c of containers) {
      const info = await docker.getContainer(c.Id).inspect();
      for (const m of info.Mounts || []) {
        if (m.Type === 'volume' && m.Name) named.add(m.Name);
        else if (m.Type === 'bind' && m.Source) binds.add(m.Source);
      }
    }
    return { named: [...named].sort(), binds: [...binds].sort() };
  },

  /**
   * Migrate every named volume of `composeProject` from one engine to another. Containers must
   * already be stopped on the source — otherwise we'd race against writes and corrupt the copy.
   *
   * Streams progress to the COMPOSE_LOG socket channel; throws on the first volume that fails so
   * the caller can decide whether to fall back. The `signal` lets a Cancel button abort mid-flight.
   */
  async migrateAll(
    composeProject: string,
    sourceEngineId: number | null,
    targetEngineId: number | null,
    signal?: AbortSignal,
  ): Promise<{ migrated: MigratedVolume[]; skippedBinds: string[] }> {
    const { named, binds } = await this.discoverVolumes(composeProject, sourceEngineId);
    const progress = await progressSink(composeProject, sourceEngineId);
    if (binds.length > 0) {
      emit(progress, `⚠ ${binds.length} bind mount(s) skipped — copy host paths manually if needed:`);
      for (const b of binds) emit(progress, `  · ${b}`);
    }
    if (named.length === 0) {
      emit(progress, '(no named volumes to migrate)');
      return { migrated: [], skippedBinds: binds };
    }

    emit(progress, `== Preparing ${HELPER_IMAGE} on both engines ==`);
    await Promise.all([ensureHelperImage(sourceEngineId), ensureHelperImage(targetEngineId)]);

    const results: MigratedVolume[] = [];
    for (const volumeName of named) {
      if (signal?.aborted) throw new Error('Cancelled by user');
      emit(progress, `\n== Migrating volume "${volumeName}" ==`);
      try {
        const bytesIn = await this._migrateOne(progress, volumeName, sourceEngineId, targetEngineId, signal);
        emit(progress, `  ✓ ${volumeName} — ${formatBytes(bytesIn)} transferred`);
        results.push({ name: volumeName, ok: true, bytesIn });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit(progress, `  ✗ ${volumeName} — ${message}`);
        results.push({ name: volumeName, ok: false, error: message });
        throw err; // bail on first failure so the orchestrator can react
      }
    }

    return { migrated: results, skippedBinds: binds };
  },

  /** Move one named volume's content from source to target. Returns bytes transferred. */
  async _migrateOne(
    progress: ProgressSink,
    volumeName: string,
    sourceEngineId: number | null,
    targetEngineId: number | null,
    signal?: AbortSignal,
  ): Promise<number> {
    const srcDocker = await dockerService.forEngine(sourceEngineId);
    const dstDocker = await dockerService.forEngine(targetEngineId);

    // Ensure the destination volume exists (created empty; tar will populate). If it already
    // exists with content, tar will overlay — operator's job to know if that's what they want.
    try {
      await dstDocker.getVolume(volumeName).inspect();
      emit(progress, `  (target volume "${volumeName}" already exists — content will be overwritten)`);
    } catch {
      await dstDocker.createVolume({ Name: volumeName });
    }

    // Tar producer on source: read-only mount of the volume, dump to stdout.
    const srcContainer = await srcDocker.createContainer({
      Image: HELPER_IMAGE,
      Cmd: ['sh', '-c', 'tar cf - -C /data . 2>/dev/null'],
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: false,
      Tty: false,
      HostConfig: {
        AutoRemove: true,
        Binds: [`${volumeName}:/data:ro`],
      },
    });

    // Tar consumer on target: stdin → untar into the (new/empty) volume.
    const dstContainer = await dstDocker.createContainer({
      Image: HELPER_IMAGE,
      Cmd: ['sh', '-c', 'tar xf - -C /data'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: true,
      Tty: false,
      HostConfig: {
        AutoRemove: true,
        Binds: [`${volumeName}:/data`],
      },
    });

    // Attach BEFORE start so we don't lose any output. Both attach() calls hijack the connection
    // and return a Duplex stream.
    const srcStream = await srcContainer.attach({ stream: true, stdout: true, stderr: true }) as unknown as Duplex;
    const dstStream = await dstContainer.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true }) as unknown as Duplex;

    // Docker multiplexes stdout/stderr over the same stream using 8-byte frame headers. The
    // demuxer below extracts stdout (channel 1) and forwards it to the destination stdin.
    // We can't use dockerode's built-in `demuxStream` because we need byte counts + custom routing.
    let bytesIn = 0;
    const stdoutOnly = new PassThrough();
    srcStream.on('data', (buf: Buffer) => {
      let offset = 0;
      while (offset + 8 <= buf.length) {
        const channel = buf[offset]; // 1 = stdout, 2 = stderr
        const size = buf.readUInt32BE(offset + 4);
        if (offset + 8 + size > buf.length) break;
        const payload = buf.subarray(offset + 8, offset + 8 + size);
        if (channel === 1) {
          bytesIn += payload.length;
          stdoutOnly.write(payload);
        } else if (channel === 2) {
          const text = payload.toString('utf8').trim();
          if (text) emit(progress, `  [src stderr] ${text}`);
        }
        offset += 8 + size;
      }
    });
    srcStream.on('end', () => stdoutOnly.end());
    srcStream.on('error', (err: Error) => { stdoutOnly.destroy(err); });

    // Pipe demuxed stdout → destination stdin. Backpressure handled natively by pipe().
    stdoutOnly.pipe(dstStream);

    // Light progress ping every 2s — bytes-so-far is enough signal for the UI.
    const ticker = setInterval(() => {
      if (bytesIn > 0) emit(progress, `  … ${formatBytes(bytesIn)} transferred`);
    }, 2000);

    // Honor cancellation by killing both helpers.
    const onAbort = (): void => {
      logger.warn({ volumeName }, 'Volume migration cancelled — killing helpers');
      srcContainer.kill().catch(() => {});
      dstContainer.kill().catch(() => {});
    };
    if (signal) signal.addEventListener('abort', onAbort);

    try {
      await srcContainer.start();
      await dstContainer.start();
      // Wait for both to exit. wait() resolves with the exit info.
      const [srcExit, dstExit] = await Promise.all([
        srcContainer.wait(),
        dstContainer.wait(),
      ]);
      if (srcExit.StatusCode !== 0) throw new Error(`source tar exited ${srcExit.StatusCode}`);
      if (dstExit.StatusCode !== 0) throw new Error(`destination untar exited ${dstExit.StatusCode}`);
      return bytesIn;
    } finally {
      clearInterval(ticker);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
