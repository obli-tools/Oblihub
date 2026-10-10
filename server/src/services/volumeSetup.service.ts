import { randomBytes } from 'crypto';
import type Docker from 'dockerode';
import {
  buildVolumeCreate, maskVolumeOptions, DEFAULT_RCLONE_ALIAS, RCLONE_INSTALL_HINT,
  type VolumeSpec, type VolumeTestResult, type ImageIdentity,
} from '@oblihub/shared';
import { dockerService } from './docker.service';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { withTimeout, TimeoutError } from '../utils/withTimeout';
import { OBLIHUB_INTERNAL_LABEL, OBLIHUB_ROLE_LABEL, ONESHOT_NAME_PREFIX } from '../utils/oblihubContainers';

/**
 * "Add volume": builds the driver options from the structured form (shared `buildVolumeCreate`),
 * tests a mount before anything is kept, and tells which uid/gid a service image runs as so a CIFS
 * or S3 mount can be owned by it.
 *
 * The test and the uid probe run throw-away containers named `oblihub-oneshot-*` with the internal
 * labels (hidden from discovery, swept as one-shot leftovers): no network, no capabilities.
 */

const DOCKER_CALL_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 5 * 60_000;
const WRITE_OK = 'OBLIHUB_WRITE_OK';

function errMessage(err: unknown): string {
  const e = err as { json?: { message?: string }; message?: string };
  return (e?.json?.message || e?.message || String(err)).trim();
}

function short(s: string, max = 600): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function parseSpec(raw: unknown): VolumeSpec {
  if (!raw || typeof raw !== 'object') throw new AppError(400, 'Volume spec required');
  return raw as VolumeSpec;
}

function build(spec: VolumeSpec) {
  try {
    return buildVolumeCreate(spec);
  } catch (err) {
    throw new AppError(400, errMessage(err));
  }
}

/** Splits `repo/name:tag` at the last ':' after the last '/' (a registry port is not a tag). */
function splitImage(image: string): { name: string; tag: string } {
  const at = image.lastIndexOf(':');
  if (at > image.lastIndexOf('/')) return { name: image.slice(0, at), tag: image.slice(at + 1) };
  return { name: image, tag: 'latest' };
}

async function ensureHelperImage(docker: Docker, engineId: number | null): Promise<string> {
  const image = config.hostAgentImage;
  try {
    await withTimeout(docker.getImage(image).inspect(), DOCKER_CALL_TIMEOUT_MS, 'inspect helper image');
    return image;
  } catch { /* pull below */ }
  const { name, tag } = splitImage(image);
  try {
    await withTimeout(dockerService.pullImage(name, tag, engineId), PULL_TIMEOUT_MS, `pull ${image}`);
  } catch (err) {
    throw new AppError(502, `Cannot pull the helper image ${image} on this engine: ${short(errMessage(err), 200)}. Pre-pull it on the host or set OBLIHUB_AGENT_IMAGE.`);
  }
  return image;
}

/** Likely cause of a failed mount or write, from the daemon / helper output. */
export function volumeFailureHint(kind: VolumeSpec['kind'], text: string): string | undefined {
  const t = text.toLowerCase();
  if (kind === 's3' && /plugin .*not found|no such plugin|error looking up volume plugin/.test(t)) {
    return `The rclone volume plugin is not installed on this engine. On the host: ${RCLONE_INSTALL_HINT}`;
  }
  if (/no route to host|network is unreachable|connection timed out|host is unreachable/.test(t)) {
    return kind === 'cifs'
      ? 'The server is unreachable on port 445 from the Docker host: check the host name, outbound port 445 (often blocked), and for a Hetzner Storage Box enable "SMB support" and "External reachability" on the (sub)account.'
      : 'The server is unreachable from the Docker host: check the host name / IP, firewall and port.';
  }
  if (/could not resolve|name or service not known|cannot resolve|no such host/.test(t)) {
    return 'The daemon cannot resolve the server name: fill "Server IP" with its address.';
  }
  if (/permission denied|mount error\(13\)|access denied|nt_status_logon_failure/.test(t) && /mount|cifs|nfs/.test(t)) {
    return 'The server refused the credentials (or the share access): check username, password and domain.';
  }
  if (/mount error\(2\)|no such file or directory/.test(t) && /mount/.test(t)) {
    return 'The share or export path does not exist on the server: check the part after the host name.';
  }
  if (/host is down|mount error\(112\)|operation not supported|mount error\(95\)/.test(t)) {
    return 'Protocol mismatch: try another SMB version (3.1.1, 3.0, 2.1) or NFS version.';
  }
  if (/invalid argument|mount error\(22\)/.test(t) && /mount/.test(t)) {
    return 'The server rejected a mount option: check the SMB/NFS version and the extra options.';
  }
  if (/read-only file system/.test(t)) return 'The share is mounted read-only (server side or "ro" option).';
  if (/eacces|permission denied|cannot create|can't create/.test(t)) {
    return kind === 'cifs' || kind === 's3'
      ? 'Mounted, but this uid/gid cannot write: set uid/gid to the user the service runs as ("Detect" next to the fields).'
      : 'Mounted, but this user cannot write: fix ownership/permissions on the server side.';
  }
  return undefined;
}

async function removeQuietly(fn: () => Promise<unknown>, what: string): Promise<void> {
  try { await withTimeout(fn(), DOCKER_CALL_TIMEOUT_MS, what); } catch (err) {
    logger.warn({ err: errMessage(err) }, `Volume setup cleanup failed: ${what}`);
  }
}

async function runHelper(docker: Docker, opts: {
  image: string; purpose: string; entrypoint: string[]; cmd: string[]; user?: string;
  mounts?: Array<{ Type: 'volume'; Source: string; Target: string }>;
}): Promise<{ exitCode: number | null; output: string }> {
  const container = await withTimeout(docker.createContainer({
    name: `${ONESHOT_NAME_PREFIX}${opts.purpose}-${randomBytes(3).toString('hex')}`,
    Image: opts.image,
    Entrypoint: opts.entrypoint,
    Cmd: opts.cmd,
    User: opts.user,
    Tty: true,
    Labels: { [OBLIHUB_INTERNAL_LABEL]: 'true', [OBLIHUB_ROLE_LABEL]: 'oneshot', 'oblihub.oneshot.purpose': opts.purpose },
    HostConfig: {
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: 64 * 1024 * 1024,
      PidsLimit: 64,
      Mounts: opts.mounts ?? [],
      AutoRemove: false,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
    },
  }), DOCKER_CALL_TIMEOUT_MS, 'create helper container');
  try {
    // The daemon mounts the volume here: a CIFS/NFS/S3 failure surfaces as a start error.
    await withTimeout(container.start(), TEST_TIMEOUT_MS, 'start helper container');
    let exitCode: number | null = null;
    try {
      const res = await withTimeout(container.wait() as Promise<{ StatusCode?: unknown }>, TEST_TIMEOUT_MS, 'helper container');
      exitCode = typeof res?.StatusCode === 'number' ? res.StatusCode : null;
    } catch (err) {
      if (!(err instanceof TimeoutError)) throw err;
      await container.kill().catch(() => { /* removed below */ });
      throw new Error(`The test did not finish within ${TEST_TIMEOUT_MS / 1000} s (mount hanging?)`);
    }
    const logs = await withTimeout(container.logs({ stdout: true, stderr: true }), DOCKER_CALL_TIMEOUT_MS, 'helper logs');
    return { exitCode, output: (Buffer.isBuffer(logs) ? logs.toString('utf8') : String(logs)).replace(/\r/g, '').trim() };
  } finally {
    await removeQuietly(() => container.remove({ force: true, v: false }), 'remove helper container');
  }
}

async function volumeExists(docker: Docker, name: string): Promise<boolean> {
  try {
    await withTimeout(docker.getVolume(name).inspect(), DOCKER_CALL_TIMEOUT_MS, 'inspect volume');
    return true;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return false;
    throw err;
  }
}

async function assertPluginInstalled(docker: Docker, alias: string): Promise<void> {
  let plugins: Array<{ Name?: string; Enabled?: boolean }> = [];
  try {
    plugins = await withTimeout(docker.listPlugins() as Promise<Array<{ Name?: string; Enabled?: boolean }>>, DOCKER_CALL_TIMEOUT_MS, 'list plugins');
  } catch { return; /* the volume create will report it */ }
  const base = (n: string) => n.replace(/:latest$/, '');
  const found = plugins.find((p) => p.Name && base(p.Name) === base(alias));
  if (!found) throw new AppError(400, `The "${alias}" volume plugin is not installed on this engine. On the host: ${RCLONE_INSTALL_HINT}`);
  if (!found.Enabled) throw new AppError(400, `The "${alias}" volume plugin is installed but disabled: docker plugin enable ${alias}`);
}

export const volumeSetupService = {
  /** Driver + options the spec produces, secrets masked. */
  preview(rawSpec: unknown) {
    return maskVolumeOptions(build(parseSpec(rawSpec)));
  },

  async create(rawSpec: unknown, engineId: number | null): Promise<{ name: string; driver: string }> {
    const spec = parseSpec(rawSpec);
    const opts = build(spec);
    const docker = await dockerService.forEngine(engineId);
    if (await volumeExists(docker, spec.name)) throw new AppError(409, `A volume named "${spec.name}" already exists on this engine`);
    if (spec.kind === 's3') await assertPluginInstalled(docker, opts.driver);
    try {
      await withTimeout(docker.createVolume({
        Name: spec.name,
        Driver: opts.driver,
        DriverOpts: opts.driverOpts,
        Labels: { 'oblihub.volume.kind': spec.kind },
      }), DOCKER_CALL_TIMEOUT_MS, 'create volume');
    } catch (err) {
      const msg = short(errMessage(err));
      const hint = volumeFailureHint(spec.kind, msg);
      throw new AppError(400, hint ? `${msg} — ${hint}` : msg);
    }
    logger.info({ engineId, name: spec.name, ...maskVolumeOptions(opts) }, 'Volume created');
    return { name: spec.name, driver: opts.driver };
  },

  /**
   * Creates the volume under a throw-away name, mounts it in a helper container that writes and
   * deletes a file as `user` (uid[:gid]), then removes both. Nothing is left behind, pass or fail.
   * `local` without a host path is always fine and is not tested.
   */
  async test(rawSpec: unknown, engineId: number | null, user?: string | null): Promise<VolumeTestResult> {
    const spec = parseSpec(rawSpec);
    const opts = build(spec);
    if (user != null && user !== '' && !/^\d{1,10}(:\d{1,10})?$/.test(user)) throw new AppError(400, 'Test user must be uid or uid:gid');
    if (spec.kind === 'local' && !opts.driverOpts.device) {
      return { ok: true, message: 'Docker-managed local volume: nothing to test.' };
    }
    const docker = await dockerService.forEngine(engineId);
    if (spec.kind === 's3') {
      try { await assertPluginInstalled(docker, opts.driver || DEFAULT_RCLONE_ALIAS); } catch (err) {
        return { ok: false, message: 'rclone plugin missing', hint: errMessage(err) };
      }
    }
    const image = await ensureHelperImage(docker, engineId);
    const tmpName = `oblihub-voltest-${randomBytes(4).toString('hex')}`;
    try {
      await withTimeout(docker.createVolume({ Name: tmpName, Driver: opts.driver, DriverOpts: opts.driverOpts, Labels: { [OBLIHUB_INTERNAL_LABEL]: 'true' } }), DOCKER_CALL_TIMEOUT_MS, 'create test volume');
    } catch (err) {
      const detail = short(errMessage(err));
      return { ok: false, message: 'Docker refused the volume options', hint: volumeFailureHint(spec.kind, detail), detail };
    }
    const testUser = user || undefined;
    const script = `f=/t/.oblihub-write-test-$$; if echo ok > "$f" && rm -f "$f"; then echo ${WRITE_OK}; fi; id; df -hP /t | tail -n 1`;
    try {
      const { output } = await runHelper(docker, {
        image, purpose: 'volume-test', entrypoint: ['sh', '-c'], cmd: [script], user: testUser,
        mounts: [{ Type: 'volume', Source: tmpName, Target: '/t' }],
      });
      const who = testUser ? `uid ${testUser}` : 'root';
      if (output.includes(WRITE_OK)) {
        return { ok: true, message: `Mounted and writable as ${who}.`, detail: output.replace(WRITE_OK, '').trim() };
      }
      return { ok: false, message: `Mounted, but ${who} cannot write to it.`, hint: volumeFailureHint(spec.kind, `${output}\npermission denied`), detail: output };
    } catch (err) {
      const detail = short(errMessage(err));
      return { ok: false, message: 'The mount failed', hint: volumeFailureHint(spec.kind, detail), detail };
    } finally {
      await removeQuietly(() => docker.getVolume(tmpName).remove({ force: true }), 'remove test volume');
    }
  },

  /**
   * uid/gid a container of `image` runs as: from the image config when numeric, else by running
   * `id` in it (no network, no capabilities). The image must already be on the engine.
   */
  async identity(image: string, engineId: number | null): Promise<ImageIdentity> {
    if (!image || /\s/.test(image)) throw new AppError(400, 'Image required');
    const docker = await dockerService.forEngine(engineId);
    let user = '';
    try {
      const info = await withTimeout(docker.getImage(image).inspect(), DOCKER_CALL_TIMEOUT_MS, 'inspect image');
      user = (info.Config?.User ?? '').trim();
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return { known: false, uid: null, gid: null, user: null, source: 'unknown', message: 'Image not present on this engine yet (pull or build it first).' };
      }
      throw err;
    }
    if (user === '' || user === 'root' || user === '0' || user === '0:0') {
      return { known: true, uid: 0, gid: 0, user: user || 'root', source: 'default-root' };
    }
    const numeric = /^(\d+):(\d+)$/.exec(user);
    if (numeric) return { known: true, uid: Number(numeric[1]), gid: Number(numeric[2]), user, source: 'config' };
    try {
      const { output } = await runHelper(docker, { image, purpose: 'uid-probe', entrypoint: ['id'], cmd: [] });
      const m = /uid=(\d+)[^\n]*?gid=(\d+)/.exec(output);
      if (m) return { known: true, uid: Number(m[1]), gid: Number(m[2]), user, source: 'probe' };
      return { known: false, uid: null, gid: null, user, source: 'unknown', message: `The image runs as "${user}" but "id" gave no answer: ${short(output, 160)}` };
    } catch (err) {
      return { known: false, uid: null, gid: null, user, source: 'unknown', message: `The image runs as "${user}"; could not resolve its uid: ${short(errMessage(err), 160)}` };
    }
  },
};
