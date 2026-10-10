import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type Docker from 'dockerode';
import yaml from 'js-yaml';
import type { ManagedStackVolumePlacement } from '@oblihub/shared';
import { config } from '../config';
import { db } from '../db';
import { logger } from '../utils/logger';
import { COMPOSE_YAML_SCHEMA } from '../utils/composeYaml';
import { dockerService } from './docker.service';

/**
 * Named volumes of managed stacks stored under `<stacksDir>/.volumes/<project>/<volume>` instead
 * of Docker's default `/var/lib/docker/volumes` — only for stacks created with
 * `volumes_in_stacks_dir = true` (every stack created after migration 053).
 *
 * Mechanism: an override passed with `-f` redefines each eligible top-level volume as a `local`
 * volume bound to a host folder:
 *
 *   volumes:
 *     db_data:
 *       driver: local
 *       driver_opts: { type: none, o: bind, device: /data/stacks/.volumes/wiki/db_data }
 *
 * Services keep referencing `db_data:` unchanged. Why the data lives OUTSIDE the stack folder:
 * Oblihub treats `<stacksDir>/<project>/` as disposable — ZIP re-upload and git source changes
 * wipe it, stack deletion removes it. `.volumes` can never collide with a project folder (project
 * names never contain a dot) and no wipe path reaches it. The folder is keyed by compose project,
 * like Docker keys named volumes (`<project>_<volume>`): a stack recreated under the same name
 * gets its data back, exactly as it would with regular volumes.
 *
 * Invariants that keep a redeploy / rebuild from ever detaching or losing data:
 *   1. Every compose command goes through composeRunner.execCompose, which passes the override and
 *      `-p <project>`. Compose hashes each volume's config: a runner that forgot the override — or
 *      resolved another project name — would see a different volume.
 *   2. The decision per volume is frozen in `managed_stacks.volume_placements` at the first
 *      deploy that sees it; the override is always generated from that record.
 *   3. A volume that already exists as a regular Docker volume (adopted stack, leftover from a
 *      deleted stack with the same name) is recorded as 'plain' and never converted.
 *   4. The host folder is created only when the volume is first recorded. If it later disappears,
 *      deploys are refused instead of silently starting the service on an empty folder (Postgres
 *      would happily initialise a brand-new database).
 *   5. Before any container-creating command, the stack's Docker volume must point at the
 *      recorded folder and no OTHER volume may point at it — otherwise the deploy is refused.
 *   6. Local engine only: the folder is on the Oblihub host. Remote engines, Oblihub's own stack,
 *      userns-remap daemons and installs where `/data/stacks` is not a host bind mount keep
 *      Docker's default location.
 */

type PlacementRecord =
  | { mode: 'bind'; device: string; rel: string; since: string }
  | { mode: 'plain'; since: string };
type Placements = Record<string, PlacementRecord>;

interface ManagedStackVolumeRow {
  id: number;
  compose_project: string;
  engine_id: number | null;
  compose_path: string | null;
  volumes_in_stacks_dir: boolean;
  volume_placements: unknown;
}

export interface PreparedComposeFiles {
  args: string[];
  /** Deletes the per-invocation override — call once the compose command has exited. */
  cleanup: () => void;
}

const VOLUMES_DIRNAME = '.volumes';
// Inside .volumes; dot-prefixed so it can never be a project folder.
const TRASH_DIRNAME = '.trash';
const OVERRIDE_REL_PATH = path.join('.oblihub', 'docker-compose.volumes.yml');
// Compose volume keys allow [a-zA-Z0-9._-]; a leading dot is refused so a key can never be `.`/`..`.
const VOLUME_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const REL_RE = /^[a-z0-9_-]+\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
// Verbs that can create containers — and therefore volumes. Only these reconcile placements.
const CREATING_VERBS = new Set(['up', 'create', 'run']);
const NO_FILES: PreparedComposeFiles = { args: [], cleanup: () => {} };

function parsePlacements(raw: unknown): Placements {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return {}; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Placements = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const r = value as { mode?: unknown; device?: unknown; rel?: unknown; since?: unknown } | null;
    if (!r || typeof r !== 'object') continue;
    const since = typeof r.since === 'string' ? r.since : '';
    if (r.mode === 'bind' && typeof r.device === 'string' && typeof r.rel === 'string' && REL_RE.test(r.rel)) {
      out[key] = { mode: 'bind', device: r.device, rel: r.rel, since };
    } else if (r.mode === 'plain') {
      out[key] = { mode: 'plain', since };
    }
  }
  return out;
}

function hasBind(placements: Placements): boolean {
  return Object.values(placements).some((p) => p.mode === 'bind');
}

/**
 * Top-level volume keys we may relocate. Conservative on purpose: anything beyond a bare
 * declaration (optionally with labels / `driver: local`) is left to Docker — external volumes,
 * explicit `name:` (shared across projects), custom drivers or driver_opts.
 */
function eligibleVolumeKeys(compose: unknown): string[] {
  const volumes = (compose as { volumes?: unknown } | null)?.volumes;
  if (!volumes || typeof volumes !== 'object' || Array.isArray(volumes)) return [];
  const keys: string[] = [];
  for (const [key, def] of Object.entries(volumes as Record<string, unknown>)) {
    if (!VOLUME_KEY_RE.test(key)) continue;
    if (def == null) { keys.push(key); continue; }
    if (typeof def !== 'object' || Array.isArray(def)) continue;
    const props = Object.keys(def);
    if (!props.every((p) => p === 'labels' || p === 'driver')) continue;
    const driver = (def as { driver?: unknown }).driver;
    if (driver !== undefined && driver !== 'local') continue;
    keys.push(key);
  }
  return keys.sort();
}

/** Eligible keys of the compose file, or the reason it couldn't be read. */
function readEligibleKeys(composeFile: string): { keys: string[] } | { error: string } {
  let content: string;
  try {
    content = fs.readFileSync(composeFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { keys: [] };
    return { error: err instanceof Error ? err.message : String(err) };
  }
  try {
    return { keys: eligibleVolumeKeys(yaml.load(content, { schema: COMPOSE_YAML_SCHEMA })) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function containerPathFor(rel: string): string {
  return path.join(config.stacksDir, VOLUMES_DIRNAME, ...rel.split('/'));
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ── Oblihub's own container: host path of the stacks dir + own compose project ──

interface SelfInfo { hostStacksDir: string | null; selfProject: string | null; reason: string | null }
let selfInfoCache: SelfInfo | null = null;

/** Mounts can't change while the process lives — cached once resolved. Docker API errors propagate. */
async function getSelfInfo(): Promise<SelfInfo> {
  if (selfInfoCache) return selfInfoCache;
  const selfId = dockerService.getSelfContainerId();
  if (!selfId) {
    selfInfoCache = { hostStacksDir: null, selfProject: null, reason: 'Oblihub is not running inside Docker' };
    return selfInfoCache;
  }
  const info = await dockerService.inspectContainer(selfId);
  // Only used to detect userns-remap; a socket proxy may block /info — don't make it a hard dependency.
  let securityOptions: string[] = [];
  let infoOk = true;
  try {
    securityOptions = ((await (await dockerService.forEngine(null)).info()) as { SecurityOptions?: string[] }).SecurityOptions || [];
  } catch (err) {
    infoOk = false;
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'docker info failed — cannot check for userns-remap');
  }
  const selfProject = info.Config?.Labels?.['com.docker.compose.project'] || null;
  const target = path.posix.normalize(config.stacksDir).replace(/\/+$/, '');
  const mount = (info.Mounts || []).find((m) => path.posix.normalize(m.Destination).replace(/\/+$/, '') === target) as
    | { Type?: string; Source: string; RW: boolean } | undefined;
  let hostStacksDir: string | null = null;
  let reason: string | null = null;
  if (!mount) {
    reason = `${config.stacksDir} is not mounted into the Oblihub container`;
  } else if (mount.Type !== 'bind') {
    reason = `${config.stacksDir} is a Docker volume (legacy "stacks_data" layout), not a host folder — mount it with STACKS_HOST_DIR (see docker-compose.yml)`;
  } else if (!mount.RW) {
    reason = `${config.stacksDir} is mounted read-only`;
  } else if (securityOptions.some((o) => String(o).includes('name=userns'))) {
    // Folders created by Oblihub would be owned by the real root, not the remapped one.
    reason = 'the Docker daemon uses userns-remap';
  } else {
    hostStacksDir = mount.Source.replace(/\/+$/, '') || '/';
  }
  const result = { hostStacksDir, selfProject, reason };
  // Not cached when /info failed: the userns-remap check is retried on the next deploy.
  if (infoOk) selfInfoCache = result;
  if (reason) logger.warn({ reason }, 'Managed-stack volumes stay in Docker\'s default location');
  return result;
}

async function isLocalEngine(engineId: number | null): Promise<boolean> {
  if (engineId == null) return true;
  const { engineService } = await import('./engine.service');
  const engine = await engineService.getById(engineId);
  return engine?.type === 'local';
}

/**
 * Whether the local daemon of a local stack (engineId null or a 'local'-type row) may be called.
 * Same rule as compose.service._proxyEngineUsable, repeated here because compose.service reaches
 * this module through the runner: NULL is off only when local-type rows exist and all of them are
 * disabled (no row = pre-engines install). The helpers below call `forEngine(null)`, which checks
 * no engine row. The runner refuses a disabled engine before it builds the file set, so this is a
 * second line for any caller that reaches reconcile or purgeData without going through it.
 */
async function localDaemonUsable(engineId: number | null): Promise<boolean> {
  if (engineId != null) {
    const row = await db('docker_engines').where({ id: engineId }).select('enabled').first() as { enabled: boolean } | undefined;
    return row?.enabled !== false;
  }
  const locals = await db('docker_engines').where({ type: 'local' }).select('enabled') as Array<{ enabled: boolean }>;
  return !(locals.length > 0 && locals.every((e) => e.enabled === false));
}

// Relocated volumes always live on the local daemon (Oblihub's own socket).
async function listLocalVolumes(): Promise<Docker.VolumeInspectInfo[]> {
  const docker = await dockerService.forEngine(null);
  return (await docker.listVolumes()).Volumes || [];
}

async function volumeInUse(name: string): Promise<boolean> {
  const docker = await dockerService.forEngine(null);
  const containers = await docker.listContainers({ all: true, filters: { volume: [name] } });
  return containers.length > 0;
}

async function removeLocalVolume(name: string): Promise<void> {
  const docker = await dockerService.forEngine(null);
  await docker.getVolume(name).remove();
}

function bindDeviceOf(vol: Docker.VolumeInspectInfo): string | null {
  const opts = (vol.Options || {}) as Record<string, string>;
  if (vol.Driver !== 'local' || opts.type !== 'none') return null;
  if (!(opts.o || '').split(',').includes('bind')) return null;
  return typeof opts.device === 'string' && opts.device ? opts.device : null;
}

function otherVolumesOn(volumes: Docker.VolumeInspectInfo[], device: string, exceptName: string): string[] {
  return volumes.filter((v) => v.Name !== exceptName && bindDeviceOf(v) === device).map((v) => v.Name);
}

function overrideYaml(projectName: string, entries: Array<[string, string]>): string {
  const volumes: Record<string, unknown> = {};
  for (const [key, device] of entries) {
    volumes[key] = { driver: 'local', driver_opts: { type: 'none', o: 'bind', device } };
  }
  const header = '# Auto-generated by Oblihub — DO NOT EDIT. Regenerated on every deploy.\n'
    + '# Stores this stack\'s named volumes in the stacks dir (.volumes/) instead of Docker\'s default location.\n'
    + `# Running compose by hand? Always include this file:\n`
    + `#   docker compose -p ${projectName} -f <compose file> -f .oblihub/docker-compose.volumes.yml ...\n`
    + '# and never answer "y" to "Volume ... exists but doesn\'t match configuration ... Recreate (data will be lost)?".\n';
  return header + yaml.dump({ volumes }, { noRefs: true, lineWidth: 200 });
}

let overrideWriteSeq = 0;

/** The visible copy next to the stack (generated-files panel, manual CLI use). Best effort. */
function writeVisibleOverride(stackRoot: string, projectName: string, entries: Array<[string, string]>): void {
  const file = path.join(stackRoot, OVERRIDE_REL_PATH);
  try {
    if (entries.length === 0) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${++overrideWriteSeq}.tmp`;
    fs.writeFileSync(tmp, overrideYaml(projectName, entries), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, 'Failed to write the visible volumes override');
  }
}

/**
 * The copy compose actually reads: one file per invocation, generated from the placements this
 * invocation just read — a concurrent command can never swap it for a stale version.
 */
function writeInvocationOverride(projectName: string, entries: Array<[string, string]>): PreparedComposeFiles {
  if (entries.length === 0) return NO_FILES;
  const file = path.join(os.tmpdir(), `oblihub-volumes-${projectName}-${process.pid}-${++overrideWriteSeq}.yml`);
  // 'wx': the name is predictable and os.tmpdir() may be shared — never write through a file or
  // symlink someone else put there. The name is unique per pid + sequence, and the runner's startup
  // sweep removes leftovers of a crashed process before the first command.
  fs.writeFileSync(file, overrideYaml(projectName, entries), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { args: ['-f', file], cleanup: () => { try { fs.unlinkSync(file); } catch { /* already gone */ } } };
}

async function findRow(projectName: string, engineId: number | null): Promise<ManagedStackVolumeRow | null> {
  const rows = await db('managed_stacks')
    .where({ compose_project: projectName })
    .select('id', 'compose_project', 'engine_id', 'compose_path', 'volumes_in_stacks_dir', 'volume_placements') as ManagedStackVolumeRow[];
  return rows.find((r) => (r.engine_id ?? null) === engineId) ?? null;
}

async function reconcile(
  row: ManagedStackVolumeRow,
  keys: string[],
  placements: Placements,
  log: (line: string) => void,
): Promise<Placements> {
  const projectName = row.compose_project;
  const protectedData = hasBind(placements);
  if (!(await isLocalEngine(row.engine_id ?? null))) {
    if (protectedData) {
      throw new Error(`Stack "${projectName}" keeps its volume data in ${config.stacksDir}/${VOLUMES_DIRNAME} on the Oblihub host, but it targets a remote engine. Deploy refused so the services don't start on empty volumes.`);
    }
    if (keys.length > 0) log('[volumes] Named volumes stay in Docker\'s default location: remote engine');
    return placements;
  }
  if (!(await localDaemonUsable(row.engine_id ?? null))) {
    // Only creating verbs reconcile: refusing here keeps them from starting on a disabled engine.
    throw new Error(`The engine of stack "${projectName}" is disabled — enable it on the Engines page before deploying`);
  }
  let self: SelfInfo;
  try {
    self = await getSelfInfo();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (protectedData) throw new Error(`Cannot inspect the Oblihub container to locate ${config.stacksDir} on the host (${msg}). Deploy refused to protect the volume data.`);
    log(`[volumes] Named volumes stay in Docker's default location: cannot inspect the Oblihub container (${msg})`);
    return placements;
  }
  if (self.selfProject === projectName) return placements;
  if (!self.hostStacksDir) {
    if (protectedData) throw new Error(`Volume data of this stack lives in ${config.stacksDir}/${VOLUMES_DIRNAME}, but ${self.reason}. Deploy refused.`);
    if (keys.length > 0) log(`[volumes] Named volumes stay in Docker's default location: ${self.reason}`);
    return placements;
  }
  if (keys.length === 0) return placements;

  const hostRoot = path.posix.join(self.hostStacksDir, VOLUMES_DIRNAME);
  const allVolumes = await listLocalVolumes();
  const next: Placements = { ...placements };
  let changed = false;
  const now = new Date().toISOString();

  const refuseIfShared = (device: string, volumeName: string) => {
    const others = otherVolumesOn(allVolumes, device, volumeName);
    if (others.length > 0) {
      throw new Error(`Folder ${device} is also used by Docker volume(s) ${others.join(', ')}. Deploy refused: two volumes on one data folder would corrupt it.`);
    }
  };

  for (const key of keys) {
    const volumeName = `${projectName}_${key}`;
    const rec = next[key];
    const vol = allVolumes.find((v) => v.Name === volumeName) ?? null;

    if (rec?.mode === 'bind') {
      const expected = path.posix.join(hostRoot, rec.rel);
      if (!isDirectory(containerPathFor(rec.rel))) {
        const moved = rec.device !== expected ? ` (it was ${rec.device} before ${config.stacksDir} changed host folder)` : '';
        throw new Error(`Volume "${key}": data folder ${expected} is missing${moved}. Deploy refused so the service doesn't start on an empty volume. Restore the folder — or, to start from scratch, create it empty on the host or delete the stack with its volumes.`);
      }
      const device = vol ? bindDeviceOf(vol) : null;
      if (vol && device !== expected) {
        if (device !== null && device === rec.device) {
          // STACKS_HOST_DIR changed and .volumes moved along: the Docker volume still points to
          // the previous host path. Dropping a bind-backed volume only removes the reference —
          // the data stays in the folder — so re-point it, provided nothing still mounts it.
          if (await volumeInUse(volumeName)) {
            throw new Error(`Docker volume "${volumeName}" still points to the previous folder ${rec.device}. Use "Down" on the stack, then deploy again so Oblihub can re-point it to ${expected}.`);
          }
          await removeLocalVolume(volumeName);
          log(`[volumes] ${key}: re-pointing Docker volume from ${rec.device} to ${expected}`);
        } else {
          throw new Error(`Docker volume "${volumeName}" points to ${device ?? 'Docker\'s default location'} instead of ${expected}. Deploy refused to avoid mounting the wrong data. Once the data you need is safe, remove that volume (docker volume rm ${volumeName}) and deploy again.`);
        }
      }
      refuseIfShared(expected, volumeName);
      if (rec.device !== expected) {
        next[key] = { ...rec, device: expected };
        changed = true;
      }
      continue;
    }
    if (rec?.mode === 'plain' && vol) continue;

    // First deploy of this volume — or a pre-existing Docker volume that has since been removed
    // (nothing left to preserve, so it moves to the stacks dir like any new volume).
    if (vol) {
      const device = bindDeviceOf(vol);
      const rel = `${projectName}/${key}`;
      if (device && device.endsWith(`/${VOLUMES_DIRNAME}/${rel}`)) {
        // Left behind by a deleted stack with the same project name — reattach its data.
        const expected = path.posix.join(hostRoot, rel);
        if (!isDirectory(containerPathFor(rel))) {
          throw new Error(`Docker volume "${volumeName}" points to ${device}, but ${expected} does not exist. Restore the folder, or remove that volume (docker volume rm ${volumeName}) to start from an empty one, and deploy again.`);
        }
        if (device !== expected) {
          // Created under a previous STACKS_HOST_DIR; the folder moved along with .volumes.
          if (await volumeInUse(volumeName)) {
            throw new Error(`Docker volume "${volumeName}" still points to the previous folder ${device}. Stop and remove the containers using it, then deploy again so Oblihub can re-point it to ${expected}.`);
          }
          await removeLocalVolume(volumeName);
          log(`[volumes] ${key}: re-pointing Docker volume from ${device} to ${expected}`);
        }
        refuseIfShared(expected, volumeName);
        next[key] = { mode: 'bind', device: expected, rel, since: now };
        log(`[volumes] ${key}: reusing existing data in ${expected}`);
      } else {
        next[key] = { mode: 'plain', since: now };
        log(`[volumes] ${key}: Docker volume "${volumeName}" already exists — kept in its current location`);
      }
      changed = true;
      continue;
    }

    const rel = `${projectName}/${key}`;
    const device = path.posix.join(hostRoot, rel);
    refuseIfShared(device, volumeName);
    const dir = containerPathFor(rel);
    // 0700 on the parents: DB files must not be readable by other host users (same as
    // /var/lib/docker). Containers are unaffected — the daemon bind-mounts the leaf folder.
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    const reused = isDirectory(dir) && fs.readdirSync(dir).length > 0;
    fs.mkdirSync(dir, { recursive: true });
    next[key] = { mode: 'bind', device, rel, since: now };
    changed = true;
    log(reused
      ? `[volumes] ${key}: reusing existing data in ${device} (left by a previous stack named "${projectName}")`
      : `[volumes] ${key}: data stored in ${device}`);
  }

  if (changed) {
    await db('managed_stacks').where({ id: row.id }).update({ volume_placements: JSON.stringify(next) });
  }
  return next;
}

async function prepareForRow(row: ManagedStackVolumeRow, verb: string, log: (line: string) => void): Promise<PreparedComposeFiles> {
  if (!row.volumes_in_stacks_dir) return NO_FILES;
  const stackRoot = path.join(config.stacksDir, row.compose_project);
  const composeFile = path.join(stackRoot, row.compose_path || 'docker-compose.yml');
  let placements = parsePlacements(row.volume_placements);
  const parsed = readEligibleKeys(composeFile);
  const keys = 'keys' in parsed ? parsed.keys : null;
  const creating = CREATING_VERBS.has(verb);

  if (creating) {
    if (keys === null) {
      const error = 'error' in parsed ? parsed.error : '';
      if (hasBind(placements)) {
        throw new Error(`Cannot read ${composeFile} (${error}) to protect the volumes stored in .volumes — deploy refused.`);
      }
      log(`[volumes] ${composeFile} could not be read (${error}) — named volumes stay in Docker's default location for this deploy`);
    } else {
      placements = await reconcile(row, keys, placements, log);
    }
  }

  // Unreadable compose on a non-creating verb (down, stop, config…) → keep every bind record.
  const active = keys ?? Object.keys(placements);
  const entries: Array<[string, string]> = [];
  for (const key of [...active].sort()) {
    const rec = placements[key];
    if (rec?.mode === 'bind') entries.push([key, rec.device]);
  }
  // Only creating verbs refresh the visible copy: their placements are the freshest.
  if (creating) writeVisibleOverride(stackRoot, row.compose_project, entries);
  return writeInvocationOverride(row.compose_project, entries);
}

export const stackVolumesService = {
  /**
   * Extra `-f` args for a compose command on a managed stack (none when the stack doesn't use the
   * feature). Container-creating verbs reconcile placements first. Throws when running the command
   * could detach or hide existing volume data — the caller must abort. Call `cleanup()` once the
   * compose command has exited.
   */
  async prepareComposeFiles(opts: {
    projectName: string;
    engineId: number | null;
    verb: string;
    log?: (line: string) => void;
  }): Promise<PreparedComposeFiles> {
    const row = await findRow(opts.projectName, opts.engineId ?? null);
    if (!row) return NO_FILES;
    return prepareForRow(row, opts.verb, opts.log ?? (() => {}));
  },

  /**
   * Delete the host folders of the stack's relocated volumes. Only call after a SUCCESSFUL
   * `docker compose down -v`. A folder is deleted only when no container and no other volume
   * uses it; bind-backed Docker volumes `down -v` left behind (key no longer in the compose) are
   * dropped first — for them Docker only removes the reference.
   * Each folder is first renamed into `.volumes/.trash` and its record dropped, so an rm failing
   * halfway can never leave a half-deleted folder that the next deploy would accept.
   */
  async purgeData(stackId: number): Promise<{ removed: string[]; kept: string[] }> {
    const row = await db('managed_stacks').where({ id: stackId })
      .select('id', 'compose_project', 'engine_id', 'compose_path', 'volumes_in_stacks_dir', 'volume_placements')
      .first() as ManagedStackVolumeRow | undefined;
    const removed: string[] = [];
    const kept: string[] = [];
    if (!row) return { removed, kept };
    const placements = parsePlacements(row.volume_placements);
    const binds = Object.entries(placements).filter(([, rec]) => rec.mode === 'bind') as Array<[string, Extract<PlacementRecord, { mode: 'bind' }>]>;
    if (binds.length === 0) return { removed, kept };
    if (!(await localDaemonUsable(row.engine_id ?? null))) {
      // Whether a volume is still in use cannot be asked: keep everything, as when the list fails.
      logger.warn({ stackId }, 'Local engine disabled — keeping all volume data');
      return { removed, kept: binds.map(([, rec]) => rec.device) };
    }

    let allVolumes: Docker.VolumeInspectInfo[];
    try {
      allVolumes = await listLocalVolumes();
    } catch (err) {
      logger.warn({ stackId, err: err instanceof Error ? err.message : String(err) }, 'Cannot list Docker volumes — keeping all volume data');
      return { removed, kept: binds.map(([, rec]) => rec.device) };
    }

    const next: Placements = { ...placements };
    const trashed: Array<{ from: string; to: string }> = [];
    const trashRoot = path.join(config.stacksDir, VOLUMES_DIRNAME, TRASH_DIRNAME);
    for (const [key, rec] of binds) {
      const volumeName = `${row.compose_project}_${key}`;
      try {
        if (otherVolumesOn(allVolumes, rec.device, volumeName).length > 0) { kept.push(rec.device); continue; }
        const vol = allVolumes.find((v) => v.Name === volumeName);
        if (vol) {
          if (bindDeviceOf(vol) !== rec.device || await volumeInUse(volumeName)) { kept.push(rec.device); continue; }
          await removeLocalVolume(volumeName);
        }
        const dir = containerPathFor(rec.rel);
        if (fs.existsSync(dir)) {
          fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
          const trash = path.join(trashRoot, `${rec.rel.replace('/', '__')}-${Date.now()}`);
          fs.renameSync(dir, trash);
          trashed.push({ from: dir, to: trash });
          try { fs.rmdirSync(path.dirname(dir)); } catch { /* other volumes left, or already gone */ }
        }
        delete next[key];
        removed.push(rec.device);
      } catch (err) {
        logger.warn({ stackId, volumeName, err: err instanceof Error ? err.message : String(err) }, 'Could not remove volume data — kept');
        kept.push(rec.device);
      }
    }
    if (removed.length > 0) {
      try {
        await db('managed_stacks').where({ id: stackId }).update({ volume_placements: JSON.stringify(next) });
      } catch (err) {
        // Records unchanged → put the folders back so disk and records agree (the next deploy
        // re-creates the Docker volumes on them). Nothing is deleted.
        for (const { from, to } of trashed) {
          try {
            fs.mkdirSync(path.dirname(from), { recursive: true, mode: 0o700 });
            fs.renameSync(to, from);
          } catch (restoreErr) {
            logger.error({ trash: to, dataFolder: from, err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) }, 'Could not restore volume data from trash — move it back by hand');
          }
        }
        throw err;
      }
    }
    for (const { to: trash } of trashed) {
      try {
        fs.rmSync(trash, { recursive: true, force: true });
      } catch (err) {
        logger.warn({ trash, err: err instanceof Error ? err.message : String(err) }, 'Volume data moved to trash but not fully deleted — remove it by hand');
      }
    }
    if (removed.length > 0) logger.info({ stackId, removed }, 'Removed volume data folders');
    return { removed, kept };
  },

  isLocalEngine,

  hasBindPlacements(raw: unknown): boolean {
    return hasBind(parsePlacements(raw));
  },

  /** Host folders holding this stack's data (for UI messages). */
  bindHostPaths(raw: unknown): string[] {
    return Object.values(parsePlacements(raw))
      .flatMap((p) => (p.mode === 'bind' ? [p.device] : []))
      .sort();
  },

  toPublicPlacements(raw: unknown): ManagedStackVolumePlacement[] {
    return Object.entries(parsePlacements(raw))
      .map(([volume, p]) => ({ volume, mode: p.mode, hostPath: p.mode === 'bind' ? p.device : null }))
      .sort((a, b) => a.volume.localeCompare(b.volume));
  },

  /** Path of the visible override, relative to the stack folder (for the "generated files" view). */
  overrideRelativePath(): string {
    return OVERRIDE_REL_PATH.replace(/\\/g, '/');
  },

  /** Host folder of a bind-backed local volume, null otherwise (Volumes page). */
  bindDeviceOf,
};
