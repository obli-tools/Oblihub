import { spawn, execFileSync, execSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SOCKET_EVENTS } from '@oblihub/shared';
import type { DockerEngine, DockerEngineType, ResourceLimits } from '@oblihub/shared';
import { config } from '../config';
import { db } from '../db';
import { logger } from '../utils/logger';
import { decryptSecret } from '../utils/crypto';
import { isSafeStackFolder } from '../utils/composeProject';
import { validateEngineHost, validateSshUser } from '../utils/engineValidation';
import { withTimeout } from '../utils/withTimeout';
import { getComposeIo } from '../state/composeIo';
import { dockerService } from './docker.service';
import { engineFactsService } from './engineFacts.service';
import { selfProjectService } from './selfProject.service';
import { stackVolumesService, type PreparedComposeFiles } from './stackVolumes.service';
import {
  RESOURCES_OVERRIDE_FILE, OBLIHUB_HEADER_PREFIX, renderForTarget, type RenderedOverride,
} from './composeResources.service';

/**
 * The single choke point for every stack compose command.
 *
 * `resolveTarget()` maps a managed stack, a (project, engine) pair or a discovery stacks row to a
 * `ComposeTarget`; `execCompose()` builds the file set (base, override files, resources override,
 * volumes override), the environment (DOCKER_HOST always explicit, registry auth) and runs
 * `docker compose` under a per-daemon/project lock. Stream runs (UI actions) emit COMPOSE_* socket
 * events to the project's room (composeRoom), the admins room (COMPOSE_ADMINS_ROOM) and the sockets
 * the run is mirrored to (ExecOptions.mirrorTo) only, and can be cancelled; quiet runs (background
 * work) only log.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ComposeTarget {
  kind: 'managed' | 'adopted-folder';
  managedStackId: number | null;
  /** managed_stacks.engine_id as stored (null = legacy local); for adopted folders: the stacks row engine id. */
  managedEngineId: number | null;
  /** Concrete engine id (managed null → local engine id; null only if no local engine row). */
  engineId: number | null;
  engineType: DockerEngineType;
  daemonKey: string;
  projectName: string;
  stackRoot: string;
  composeDir: string;
  composeFile: string;
  /** Discovery stacks row on the same daemon, if any. */
  linkedStackId: number | null;
  isSelfStack: boolean;
}

export type TargetQuery = { managedStackId: number } | { stackId: number } | { projectName: string; engineId: number | null };

export interface ComposeRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  busy?: boolean;
  refused?: boolean;
}

export interface ExecOptions {
  mode: 'stream' | 'quiet';
  idleTimeoutMs?: number;
  purpose?: string;
  /**
   * Stream runs only. `false` keeps every stream semantic (not refused by a hold, cancellable, never
   * counted as quiet-busy) but sends no COMPOSE_* socket event, so the output reaches the caller
   * only. For output that must stay in one HTTP response: `config` prints the interpolated .env.
   */
  emit?: boolean;
  /**
   * Stream runs only: socket ids that get this run's COMPOSE_* events on top of the project's room
   * (socket.ts composeSubscriberIds). An engine move deploys on the target daemon while the open
   * editor is still subscribed to the source room; a mirror reaches it for this run only, where a
   * room join would outlive the run and escape revalidateSocketAccess.
   */
  mirrorTo?: string[];
}

/** Override files next to the compose file. The first four fields describe
 *  docker-compose.override.yml; `operator` / `args` give file-set step 2. */
export interface OverrideFilesInfo {
  exists: boolean;
  owner: 'oblihub' | 'operator' | null;
  passed: boolean;
  content: string | null;
  operator: { name: string; content: string } | null;
  args: string[];
}

export type ResourcesPreview = RenderedOverride & { limits: ResourceLimits | null };

interface ManagedRow { id: number; compose_project: string; engine_id: number | null; compose_path: string | null }
interface StacksRow { id: number; compose_project: string | null; engine_id: number | null }

interface RunEntry {
  /** 'hold': no compose child, see holdProject. */
  kind: 'stream' | 'quiet' | 'hold';
  projectName: string;
  child: ChildProcess | null;
  cancelled: boolean;
  engineIds: Set<number | null>;
  /** True while this run can create or start containers: the priority watchdog must not pause/stop
   *  under it. Always false for 'hold' (a git-poll hold spends most of its time fetching/pulling; its
   *  redeploy's own `up` registers as a separate stream entry with creating=true). */
  creating: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DCO = 'docker-compose.override.yml';
// compose-go `DefaultOverrideFileNames`, in compose's own lookup order.
const OVERRIDE_NAMES = ['compose.override.yml', 'compose.override.yaml', 'docker-compose.override.yml', 'docker-compose.override.yaml'] as const;
// Base names for which Oblihub's proxy override is NOT passed — today's rule, unchanged on purpose
// (`compose.yaml` / `docker-compose.yaml` bases keep having it passed, exactly as before).
const STANDARD_BASE_NAMES = ['docker-compose.yml', 'compose.yml'];
const MUTATING = new Set(['up', 'create', 'run', 'start', 'restart', 'stop', 'down', 'kill', 'rm', 'pause', 'unpause', 'scale']);
const CREATING = new Set(['up', 'create', 'run']);
// Verbs after which containers may be running: what the watchdog must not yield under. Separate from
// CREATING, which drives the override-refusal logic and leaves out start/restart on purpose.
const STARTING_VERBS = new Set(['up', 'create', 'run', 'start', 'restart']);
const BUSY_EXIT = 75;
const QUIET_REFUSAL = 'Oblihub is applying resource limits to this stack in the background — retry in a few seconds.';
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';
const STREAM_MAX_BUF = 5 * 1024 * 1024;
const QUIET_MAX_BUF = 1024 * 1024;
const QUIET_IDLE_TIMEOUT_MS = 180_000;
const LOCAL_CALL_TIMEOUT_MS = 10_000;
const PROXY_NETWORK_TIMEOUT_MS = 30_000;

// ⚠ SECURITY-CRITICAL — env scrub.
//
// Spreading `process.env` into the subprocess used to leak Oblihub's OWN env (admin creds,
// session secret, DB password, …) into every managed stack we deploy. Docker Compose
// resolves `${VAR}` substitutions from the SHELL ENVIRONMENT first, .env file second.
// So a child stack with `DEFAULT_ADMIN_USERNAME: ${DEFAULT_ADMIN_USERNAME:-admin}` in its
// compose received Oblihub's value instead of the operator's intended value — even when
// the stack's own .env file said something else. All deployed Obli* templates were
// affected because they share Oblihub's env var names.
//
// Fix: ship only the OS basics + Docker routing the CLI actually needs. Everything else
// (secrets, app config) comes from the stack's own .env file at `cwd: stackDir`.
const SAFE_PASSTHROUGH = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'HOSTNAME',
  'TMPDIR', 'TEMP', 'TMP', 'PWD',
  'DOCKER_BUILDKIT', 'COMPOSE_DOCKER_CLI_BUILD',
];

// ── Small helpers ────────────────────────────────────────────────────────────

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function noop(): void { /* nothing to release */ }

function firstNonEmptyLine(text: string): string {
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

function readTextOrNull(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function normalizePosixDir(p: string): string {
  return path.posix.normalize(p).replace(/\/+$/, '') || '/';
}

function localDockerHost(): string {
  return `unix://${config.dockerSocket}`;
}

// ── Compose socket events ────────────────────────────────────────────────────

/**
 * Socket.io room that receives a project's COMPOSE_* events. Compose output carries secrets (deploy
 * logs, errors quoting env values), so events never go to every socket: socket.ts joins a socket
 * here only after checking that its user can access the stack. Keyed like the lock (daemon, not
 * engine id), so the same project on another engine does not share it.
 */
export function composeRoom(daemonKey: string, projectName: string): string {
  return `compose:${lockKey(daemonKey, projectName)}`;
}

/**
 * Every COMPOSE_* event also goes to this room, which socket.ts joins admin sockets to at connect.
 * Self-update recreates only the `server` service, so the client container keeps serving the
 * previous bundle, which never sends COMPOSE_SUBSCRIBE and relied on the old broadcast: without
 * this room its deploy log panel stays empty for every managed-stack action. Admins can already
 * read every stack and its .env, so nothing new leaks. A non-admin on the previous bundle still
 * gets no live log until the client container is updated and the tab reloaded. Cannot collide with
 * composeRoom(), whose name always holds a second ':' (lockKey).
 */
export const COMPOSE_ADMINS_ROOM = 'compose:admins';

/** `mirrorTo`: socket ids that also get the event (ExecOptions.mirrorTo). */
function emitComposeEvent(daemonKey: string, projectName: string, event: string, payload: Record<string, unknown>, mirrorTo: readonly string[] = []): void {
  // One emit to every room: socket.io sends it once to a socket that is in several of them.
  getComposeIo()?.to([composeRoom(daemonKey, projectName), COMPOSE_ADMINS_ROOM, ...mirrorTo]).emit(event, payload);
}

type ComposeEmit = (event: string, payload: Record<string, unknown>) => void;

/** null = send nothing: quiet runs (background work) and stream runs with `emit: false`. */
function composeEmitter(target: ComposeTarget, opts: ExecOptions): ComposeEmit | null {
  if (opts.mode !== 'stream' || opts.emit === false) return null;
  const mirrorTo = opts.mirrorTo ?? [];
  return (event, payload) => emitComposeEvent(target.daemonKey, target.projectName, event, payload, mirrorTo);
}

// ── Pure helpers (exported for the check script) ─────────────────────────────

/**
 * Which override files every compose command passes. With any `-f`, compose skips its default
 * override lookup; without `-f` it loads exactly ONE override, the first existing of OVERRIDE_NAMES.
 * - Oblihub's own `docker-compose.override.yml` (proxy networks, Oblihub header) is passed for
 *   non-standard base names only — today's rule. For standard names it is a reference copy: proxy
 *   membership is enforced at runtime by compose.service's post-up reconcile.
 * - The operator's own override (the file compose would have auto-loaded, unless it is Oblihub's) is
 *   passed whatever the base name, because that is what the operator expects `docker compose up` to
 *   do in that folder.
 */
export function overrideFilePolicy(composeFile: string, files: Partial<Record<string, string | null>>): OverrideFilesInfo {
  const dco = files[DCO] ?? null;
  const owner: OverrideFilesInfo['owner'] = dco == null ? null
    : (firstNonEmptyLine(dco).startsWith(OBLIHUB_HEADER_PREFIX) ? 'oblihub' : 'operator');
  // Only docker-compose.override.yml can be Oblihub's; Oblihub never writes the other three names.
  let operatorName: string | null = null;
  for (const name of OVERRIDE_NAMES) {
    if (files[name] == null) continue;
    if (name === DCO && owner === 'oblihub') continue;
    operatorName = name;
    break;
  }
  const operator = operatorName ? { name: operatorName, content: files[operatorName] as string } : null;
  const passed = dco != null && (!STANDARD_BASE_NAMES.includes(composeFile) || operatorName === DCO);
  const args = [
    ...(passed ? ['-f', DCO] : []),
    ...(operatorName && operatorName !== DCO ? ['-f', operatorName] : []),
  ];
  return { exists: dco != null, owner, passed, content: dco, operator, args };
}

function isPlainKnownHostsEntryFor(line: string, hostPattern: string): boolean {
  if (!line || line.startsWith('#') || line.startsWith('|1|')) return false;
  const first = line.split(/\s+/)[0] ?? '';
  return first.split(',').includes(hostPattern);
}

/** Non-hashed known_hosts lines of a host (trimmed). Hashed `|1|` lines cannot be matched without ssh-keygen. */
export function knownHostsPlainEntriesFor(text: string, hostPattern: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => isPlainKnownHostsEntryFor(l, hostPattern));
}

export function knownHostsHasPlainEntry(text: string, hostPattern: string): boolean {
  return knownHostsPlainEntriesFor(text, hostPattern).length > 0;
}

/** Drops exactly the plain entries of that host; every other line (and the trailing newline) is kept. */
export function stripKnownHostsPlainEntries(text: string, hostPattern: string): string {
  return text.split('\n').filter((raw) => !isPlainKnownHostsEntryFor(raw.trim(), hostPattern)).join('\n');
}

const SSH_BLOCK_BEGIN_RE = /^# oblihub:engine-(\d+) begin$/;

/** Removes the `# oblihub:engine-<id> begin/end` block of that engine, or of every engine when omitted. */
export function stripOblihubSshBlocks(text: string, engineId?: number): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = SSH_BLOCK_BEGIN_RE.exec(lines[i].trim());
    if (m && (engineId === undefined || Number(m[1]) === engineId)) {
      const endMarker = `# oblihub:engine-${m[1]} end`;
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === endMarker) { end = j; break; }
      }
      // Only complete blocks are removed: an unmatched marker is not ours to guess about.
      if (end >= 0) { i = end; continue; }
    }
    out.push(lines[i]);
  }
  const result = out.join('\n');
  return result === text ? text : result.replace(/\n{3,}/g, '\n\n');
}

// ── Target resolution ────────────────────────────────────────────────────────

async function managedRowsFor(project: string): Promise<ManagedRow[]> {
  return db('managed_stacks')
    .where({ compose_project: project })
    .select('id', 'compose_project', 'engine_id', 'compose_path')
    .orderBy('id') as Promise<ManagedRow[]>;
}

/** Exact engine match first, then the managed row on the same daemon. */
async function pickManagedRow(rows: ManagedRow[], engineId: number | null): Promise<ManagedRow | null> {
  const exact = rows.find((r) => (r.engine_id ?? null) === (engineId ?? null));
  if (exact) return exact;
  const want = await engineFactsService.managedDaemonKey(engineId ?? null);
  for (const r of rows) {
    if (await engineFactsService.managedDaemonKey(r.engine_id ?? null) === want) return r;
  }
  return null;
}

/** Discovery stacks row of this project on the same daemon (exact engine first). NULL-engine rows are orphans. */
async function findLinkedStackId(project: string, engineId: number | null, daemonKey: string): Promise<number | null> {
  const rows = await db('stacks')
    .where({ compose_project: project })
    .whereNotNull('engine_id')
    .select('id', 'engine_id')
    .orderBy('id') as Array<{ id: number; engine_id: number }>;
  if (engineId != null) {
    const exact = rows.find((r) => r.engine_id === engineId);
    if (exact) return exact.id;
  }
  for (const r of rows) {
    if (await engineFactsService.daemonKey(r.engine_id) === daemonKey) return r.id;
  }
  return null;
}

async function buildManagedTarget(row: ManagedRow, linkedStackIdHint: number | null): Promise<ComposeTarget | null> {
  const project = row.compose_project;
  if (!isSafeStackFolder(project)) return null;
  const stackRoot = path.join(config.stacksDir, project);
  // compose_path set = the compose file lives at a subpath of the source (e.g. `stack/docker-compose.yml`):
  // cwd is its folder so relative build contexts and `.env` resolve like the operator expects.
  const composePath = row.compose_path || null;
  const composeFile = composePath ? path.basename(composePath) : 'docker-compose.yml';
  const composeDir = composePath ? path.join(stackRoot, path.dirname(composePath)) : stackRoot;
  const managedEngineId = row.engine_id ?? null;
  const engineId = managedEngineId ?? await engineFactsService.resolveLocalEngineId();
  const daemonKey = await engineFactsService.managedDaemonKey(managedEngineId);
  const engineType: DockerEngineType = managedEngineId == null
    ? 'local'
    : (await engineFactsService.engineType(managedEngineId)) ?? 'local';
  const linkedStackId = linkedStackIdHint ?? await findLinkedStackId(project, engineId, daemonKey);
  return {
    kind: 'managed',
    managedStackId: row.id,
    managedEngineId,
    engineId,
    engineType,
    daemonKey,
    projectName: project,
    stackRoot,
    composeDir,
    composeFile,
    linkedStackId,
    isSelfStack: await selfProjectService.isSelfProject(project, daemonKey),
  };
}

/**
 * A stacks-dir folder deployed by hand (no managed_stacks row anywhere): compose-manageable only on
 * the LOCAL daemon, and only when a live container's working_dir label proves compose ran it from
 * exactly that folder.
 */
async function resolveAdoptedFolder(s: StacksRow & { engine_id: number; compose_project: string }): Promise<ComposeTarget | null> {
  const project = s.compose_project;
  if (await engineFactsService.daemonKey(s.engine_id) !== 'local') return null;
  if (!isSafeStackFolder(project)) return null;
  if (await selfProjectService.isSelfProject(project, 'local')) return null;
  const stackRoot = path.join(config.stacksDir, project);
  if (!fs.existsSync(path.join(stackRoot, 'docker-compose.yml'))) return null;

  let containers: Array<{ Labels?: Record<string, string> }>;
  try {
    const docker = await dockerService.forEngine(null);
    containers = await withTimeout(
      docker.listContainers({ all: true, filters: { label: [`${COMPOSE_PROJECT_LABEL}=${project}`] } }),
      LOCAL_CALL_TIMEOUT_MS,
      `list containers of ${project}`,
    );
  } catch (err) {
    logger.debug({ project, err: errMessage(err) }, 'Cannot list project containers — folder not adopted');
    return null;
  }
  const wanted = new Set<string>([normalizePosixDir(path.posix.join(config.stacksDir, project))]);
  const hostStacksDir = await selfProjectService.getHostStacksDir();
  if (hostStacksDir) wanted.add(normalizePosixDir(path.posix.join(hostStacksDir, project)));
  const provenHere = containers.some((c) => {
    const wd = c.Labels?.[WORKING_DIR_LABEL];
    return typeof wd === 'string' && wd !== '' && wanted.has(normalizePosixDir(wd));
  });
  if (!provenHere) return null;
  return {
    kind: 'adopted-folder',
    managedStackId: null,
    managedEngineId: s.engine_id,
    engineId: s.engine_id,
    engineType: (await engineFactsService.engineType(s.engine_id)) ?? 'local',
    daemonKey: 'local',
    projectName: project,
    stackRoot,
    composeDir: stackRoot,
    composeFile: 'docker-compose.yml',
    linkedStackId: s.id,
    isSelfStack: false,
  };
}

async function resolveTarget(q: TargetQuery, opts: { requireComposeFile?: boolean } = {}): Promise<ComposeTarget | null> {
  let target: ComposeTarget | null = null;
  if ('managedStackId' in q) {
    const row = await db('managed_stacks').where({ id: q.managedStackId })
      .select('id', 'compose_project', 'engine_id', 'compose_path').first() as ManagedRow | undefined;
    target = row ? await buildManagedTarget(row, null) : null;
  } else if ('stackId' in q) {
    const s = await db('stacks').where({ id: q.stackId })
      .select('id', 'compose_project', 'engine_id').first() as StacksRow | undefined;
    if (!s) return null;
    // A NULL engine_id means the stack's engine was deleted (orphan) — never map it to the
    // local daemon.
    if (s.engine_id == null) return null;
    // Standalone (no compose project) is never compose-manageable.
    if (!s.compose_project) return null;
    const rows = await managedRowsFor(s.compose_project);
    if (rows.length > 0) {
      const row = await pickManagedRow(rows, s.engine_id);
      // Never adopt a folder that belongs to a managed stack of ANOTHER engine — remote managed
      // stacks keep their files in the hub's stacks dir too, so a local duplicate of the project
      // would be driven by that remote stack's compose file.
      target = row ? await buildManagedTarget(row, s.id) : null;
    } else {
      target = await resolveAdoptedFolder({ ...s, engine_id: s.engine_id, compose_project: s.compose_project });
    }
  } else {
    const rows = await managedRowsFor(q.projectName);
    const row = rows.length > 0 ? await pickManagedRow(rows, q.engineId ?? null) : null;
    target = row ? await buildManagedTarget(row, null) : null;
  }
  if (target && opts.requireComposeFile && !fs.existsSync(path.join(target.composeDir, target.composeFile))) return null;
  return target;
}

// ── Override files, limits and the resources preview ─────────────────────────

function describeOverrideFile(target: ComposeTarget): OverrideFilesInfo {
  const files: Record<string, string | null> = {};
  for (const name of OVERRIDE_NAMES) {
    const content = readTextOrNull(path.join(target.composeDir, name));
    if (content != null) files[name] = content;
  }
  return overrideFilePolicy(target.composeFile, files);
}

function parseLimits(raw: unknown): ResourceLimits | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const limits = obj as ResourceLimits;
  return limits.mps === undefined ? { ...limits, mps: null } : limits;
}

/** Limits are found by (project, daemon-equivalent engine), even before discovery linked a row. */
async function readLinkedLimits(target: ComposeTarget): Promise<ResourceLimits | null> {
  const stackId = target.linkedStackId ?? await findLinkedStackId(target.projectName, target.engineId, target.daemonKey);
  if (stackId == null) return null;
  const row = await db('stacks').where({ id: stackId }).select('resource_limits').first() as { resource_limits: unknown } | undefined;
  return parseLimits(row?.resource_limits);
}

async function previewWith(target: ComposeTarget, overrides: OverrideFilesInfo, verb?: string): Promise<ResourcesPreview> {
  const limits = await readLinkedLimits(target);
  const base = readTextOrNull(path.join(target.composeDir, target.composeFile));
  // The operator's own override can request GPUs too; Oblihub's proxy override only adds networks.
  const rendered = await renderForTarget({
    projectName: target.projectName,
    limits,
    composeTexts: [base, overrides.operator?.content ?? null],
    engineId: target.engineId,
    daemonKey: target.daemonKey,
    verb,
  });
  return { limits, ...rendered };
}

/** Never writes files. Without a verb (generated-files view) capacity comes from the facts cache only. */
async function previewResources(target: ComposeTarget, verb?: string): Promise<ResourcesPreview> {
  return previewWith(target, describeOverrideFile(target), verb);
}

/**
 * Write synchronously through a pid-named temp file: no await between write and rename, so two
 * renders in this process can never interleave on the temp file, and compose never reads a
 * half-written override. The file holds no secret (caps, GPU ids, MPS settings), hence 0644.
 * The folder content comes from the stack's source (a git clone carries symlinks) and the pid is
 * predictable, so the temp name may already exist: rmSync drops it without following a symlink,
 * and `wx` (O_EXCL) refuses anything planted in between instead of writing through it.
 */
function writeResourcesOverride(composeDir: string, text: string): void {
  const finalPath = path.join(composeDir, RESOURCES_OVERRIDE_FILE);
  const tmp = path.join(composeDir, `.${RESOURCES_OVERRIDE_FILE}.${process.pid}.tmp`);
  let renamed = false;
  try {
    try { fs.rmSync(tmp, { force: true }); } catch { /* the wx open below still refuses it */ }
    fs.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    fs.renameSync(tmp, finalPath);
    renamed = true;
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
  }
}

/** Nothing to render: remove the file, but only when Oblihub wrote it (header check). */
function removeResourcesOverride(composeDir: string): void {
  const finalPath = path.join(composeDir, RESOURCES_OVERRIDE_FILE);
  const content = readTextOrNull(finalPath);
  if (content == null || !firstNonEmptyLine(content).startsWith(OBLIHUB_HEADER_PREFIX)) return;
  try { fs.unlinkSync(finalPath); } catch { /* already gone */ }
}

// ── Registry auth ────────────────────────────────────────────────────────────

/**
 * Temp DOCKER_CONFIG with this managed stack's registry credentials (plus the global Docker Hub
 * creds). The `oblihub-` dir prefix is what sweepStale removes after a crash; config.json holds
 * registry passwords, hence 0600 and 'wx' (never follow or reuse an existing file).
 */
async function resolveRegistryAuth(managedStackId: number, projectName: string): Promise<{ dockerConfigDir: string | null; cleanup: () => void }> {
  let tmpDir: string | null = null;
  const cleanup = () => {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  };
  try {
    const row = await db('managed_stacks').where({ id: managedStackId }).select('registry_credentials').first();
    const raw = row?.registry_credentials;
    let creds: Array<{ registry?: string; username?: string; password_enc?: string }> = [];
    if (Array.isArray(raw)) creds = raw as typeof creds;
    else if (typeof raw === 'string' && raw) { try { creds = JSON.parse(raw); } catch { creds = []; } }
    const usable = creds.filter(c => c.registry && c.username && c.password_enc);
    if (usable.length === 0) return { dockerConfigDir: null, cleanup: noop };

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `oblihub-dockercfg-${projectName}-`));
    const auths: Record<string, { auth: string }> = {};
    for (const c of usable) {
      try {
        const pw = decryptSecret(c.password_enc!);
        auths[c.registry!] = { auth: Buffer.from(`${c.username}:${pw}`).toString('base64') };
      } catch (err) {
        logger.warn({ projectName, registry: c.registry, err: errMessage(err) }, 'Skipping registry cred — decrypt failed');
      }
    }
    // Also fold in the global Docker Hub creds (env-based) so a stack with private + Docker Hub
    // images uses both transparently. The stack's per-registry entries take precedence on
    // conflict because they're set last.
    if (config.dockerHubUsername && config.dockerHubToken && !auths['https://index.docker.io/v1/']) {
      auths['https://index.docker.io/v1/'] = {
        auth: Buffer.from(`${config.dockerHubUsername}:${config.dockerHubToken}`).toString('base64'),
      };
    }
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ auths }, null, 2), { mode: 0o600, flag: 'wx' });
    return { dockerConfigDir: tmpDir, cleanup };
  } catch (err) {
    cleanup();
    logger.warn({ projectName, err: errMessage(err) }, 'Failed to build per-stack DOCKER_CONFIG');
    return { dockerConfigDir: null, cleanup: noop };
  }
}

// ── Engine environment (DOCKER_HOST and friends) ─────────────────────────────

interface SshHold { count: number; dir: string }
// Reference-counted per engine: concurrent runs on one engine used to delete each other's key file
// and ~/.ssh/config block when the first of them finished.
const sshHolds = new Map<number, SshHold>();

function sshDirPath(): string {
  // os.homedir() honors /etc/passwd: the docker CLI's ssh resolves ~ the same way, not from $HOME.
  return path.join(os.homedir(), '.ssh');
}

function writeSshConfigWithoutBlock(configFile: string, engineId: number): void {
  const prior = readTextOrNull(configFile);
  if (prior == null) return;
  const next = stripOblihubSshBlocks(prior, engineId);
  if (next !== prior) fs.writeFileSync(configFile, next, { mode: 0o600 });
}

function appendLines(file: string, lines: string[]): void {
  const existing = readTextOrNull(file) ?? '';
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, sep + lines.join('\n') + '\n', { mode: 0o600 });
}

/** known_hosts lines of a host as ssh sees them (hashed entries included when ssh-keygen exists). */
function knownHostEntries(file: string, hostPattern: string): string[] {
  if (!fs.existsSync(file)) return [];
  try {
    const out = execFileSync('ssh-keygen', ['-F', hostPattern, '-f', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null };
    if (e.code !== 'ENOENT' && e.status === 1) return [];
    return knownHostsPlainEntriesFor(readTextOrNull(file) ?? '', hostPattern);
  }
}

function hasKnownHostEntry(file: string, hostPattern: string): boolean {
  if (!fs.existsSync(file)) return false;
  try {
    execFileSync('ssh-keygen', ['-F', hostPattern, '-f', file], { stdio: 'ignore' });
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null };
    if (e.code !== 'ENOENT' && e.status === 1) return false;
    return knownHostsHasPlainEntry(readTextOrNull(file) ?? '', hostPattern);
  }
}

/**
 * With a pinned key the host's known_hosts entries become EXACTLY the pinned lines. Today's code
 * only appended the pinned line, so an earlier TOFU key — possibly a MITM key, of any key type —
 * stayed trusted next to it and pinning never revoked it.
 */
function applyPinnedHostKey(file: string, hostPattern: string, pinnedLines: string[], engineId: number): void {
  const entries = knownHostEntries(file, hostPattern);
  const pinnedSet = new Set(pinnedLines);
  const entrySet = new Set(entries);
  const exact = pinnedLines.every((l) => entrySet.has(l)) && entries.every((e) => pinnedSet.has(e));
  if (!exact) {
    if (entries.length > 0) {
      try {
        // Keeps a known_hosts.old backup.
        execFileSync('ssh-keygen', ['-R', hostPattern, '-f', file], { stdio: 'ignore' });
      } catch (err) {
        const text = readTextOrNull(file) ?? '';
        fs.writeFileSync(file, stripKnownHostsPlainEntries(text, hostPattern), { mode: 0o600 });
        logger.warn({ engineId, host: hostPattern, err: errMessage(err) },
          'ssh-keygen unavailable — removed plain known_hosts entries only; hashed (|1|) entries could not be checked or removed');
      }
      logger.warn({ engineId, host: hostPattern }, 'Replaced SSH host key(s) with the pinned key');
    }
    const present = new Set((readTextOrNull(file) ?? '').split(/\r?\n/).map((l) => l.trim()));
    const missing = pinnedLines.filter((l) => !present.has(l));
    if (missing.length > 0) appendLines(file, missing);
  }
  const matchesHost = pinnedLines.some((l) => l.startsWith('|1|') || (l.split(/\s+/)[0] ?? '').split(',').includes(hostPattern));
  if (!matchesHost) {
    // The command then fails with "Host key verification failed" — the intended loud failure.
    logger.warn({ engineId, host: hostPattern }, 'The pinned SSH host key does not name this host (or its [host]:port form) — ssh will not match it');
  }
}

/** TOFU only for a host without any known_hosts entry. When one exists, NEVER append another key:
 *  appending on every run used to auto-trust a MITM key next to the real one; with
 *  StrictHostKeyChecking yes a changed key now fails loudly instead. */
function trustOnFirstUse(file: string, hostPattern: string, host: string, port: number, engineId: number): void {
  if (hasKnownHostEntry(file, hostPattern)) return;
  try {
    const scan = execFileSync('ssh-keyscan', ['-T', '5', '-p', String(port), host], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = scan.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (lines.length > 0) {
      appendLines(file, lines);
      logger.info({ engineId, host: hostPattern, keys: lines.length }, 'Trusted SSH host key on first use');
    }
  } catch (err) {
    // ssh reports its own, more useful error if the connection really fails.
    logger.warn({ engineId, host, err: errMessage(err) }, 'ssh-keyscan failed — continuing anyway');
  }
}

/**
 * The docker CLI shells out to ssh with a fixed set of options (no hook for extra ones, and HOME
 * overrides are ignored because ssh resolves the home dir via getpwuid), so the per-engine key is
 * wired through the real user's ~/.ssh/config: a marker-delimited Host block pointing at a temp key.
 * Must run synchronously from the hold check to the hold creation (no await): that is what makes the
 * reference count race-free.
 */
function acquireSshIdentity(engine: DockerEngine, privateKey: string): void {
  const engineId = engine.id;
  const host = engine.host as string;
  const port = engine.port ?? 22;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `oblihub-engine-${engineId}-`));
  const sshDir = sshDirPath();
  const configFile = path.join(sshDir, 'config');
  let blockWritten = false;
  try {
    const keyFile = path.join(dir, 'id_engine');
    fs.writeFileSync(keyFile, privateKey, { mode: 0o600, flag: 'wx' });

    if (!fs.existsSync(sshDir)) fs.mkdirSync(sshDir, { mode: 0o700, recursive: true });
    try { fs.chmodSync(sshDir, 0o700); } catch { /* not fatal */ }

    const knownHostsFile = path.join(sshDir, 'known_hosts');
    const hostPattern = port === 22 ? host : `[${host}]:${port}`;
    const pinnedLines = (engine.sshKnownHost || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (pinnedLines.length > 0) applyPinnedHostKey(knownHostsFile, hostPattern, pinnedLines, engineId);
    else trustOnFirstUse(knownHostsFile, hostPattern, host, port, engineId);
    try { fs.chmodSync(knownHostsFile, 0o600); } catch { /* not fatal */ }

    const block = [
      `# oblihub:engine-${engineId} begin`,
      `Host ${host}`,
      `  IdentityFile ${keyFile}`,
      '  IdentitiesOnly yes',
      '  StrictHostKeyChecking yes',
      '  LogLevel ERROR',
      '  ServerAliveInterval 30',
      `# oblihub:engine-${engineId} end`,
      '',
    ].join('\n');
    const prior = stripOblihubSshBlocks(readTextOrNull(configFile) ?? '', engineId);
    const sep = prior.length > 0 && !prior.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(configFile, prior + sep + block, { mode: 0o600 });
    try { fs.chmodSync(configFile, 0o600); } catch { /* not fatal */ }
    blockWritten = true;

    // Surface a missing openssh-client clearly instead of a vague connect failure deep in compose.
    try {
      execSync('which ssh', { stdio: 'ignore' });
    } catch {
      throw new Error('openssh-client (ssh) is not installed in the server image — cannot deploy via SSH engine.');
    }
    sshHolds.set(engineId, { count: 1, dir });
  } catch (err) {
    if (blockWritten) {
      try { writeSshConfigWithoutBlock(configFile, engineId); } catch { /* ignore */ }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function releaseSshIdentity(engineId: number): void {
  const hold = sshHolds.get(engineId);
  if (!hold) return;
  hold.count -= 1;
  if (hold.count > 0) return;
  sshHolds.delete(engineId);
  try { writeSshConfigWithoutBlock(path.join(sshDirPath(), 'config'), engineId); } catch { /* ignore */ }
  try { fs.rmSync(hold.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Env the `docker compose` CLI needs to reach the target daemon, plus a release function for any
 * secret material written to disk.
 * - null / local → DOCKER_HOST=unix://<socket>, always explicit so no ambient docker context can
 *   redirect the CLI to another daemon.
 * - ssh → DOCKER_HOST=ssh://user@host:port, key + ~/.ssh/config block (reference-counted).
 * - tls → DOCKER_HOST=tcp://host:port + DOCKER_TLS_VERIFY + DOCKER_CERT_PATH (per-run temp dir).
 * - https-apikey → refused: the docker CLI cannot inject custom HTTP headers.
 * A disabled engine is refused, including the local daemon reached through a legacy NULL engine_id.
 */
async function resolveEngineEnv(managedEngineId: number | null): Promise<{ env: Record<string, string>; release: () => void }> {
  sweepStale();
  if (managedEngineId == null) {
    // The UI shows a legacy NULL managed stack on the local engine, so disabling that engine must
    // keep compose off the hub for it too. Local-type rows share one socket: only when all of them
    // are disabled is the daemon off. No local row at all = pre-engines install, bare socket.
    const locals = await db('docker_engines')
      .where({ type: 'local' })
      .orderBy([{ column: 'is_default', order: 'desc' }, { column: 'id', order: 'asc' }])
      .select('name', 'enabled') as Array<{ name: string; enabled: boolean }>;
    if (locals.length > 0 && locals.every((e) => e.enabled === false)) {
      throw new Error(`Engine "${locals[0].name}" is disabled — enable it on the Engines page before running compose on it`);
    }
    return { env: { DOCKER_HOST: localDockerHost() }, release: noop };
  }
  const { engineService } = await import('./engine.service');
  const engine = await engineService.getById(managedEngineId);
  if (!engine) throw new Error(`Engine ${managedEngineId} not found`);
  if (engine.enabled === false) {
    throw new Error(`Engine "${engine.name}" is disabled — enable it on the Engines page before running compose on it`);
  }
  if (engine.type === 'local') return { env: { DOCKER_HOST: localDockerHost() }, release: noop };
  if (engine.type === 'https-apikey') {
    throw new Error(
      `Engine "${engine.name}" uses HTTP + API key (socket-proxy). The docker compose CLI does not support custom HTTP headers, so managed stack deployment is not possible on this engine. Use SSH or TLS for engines you intend to deploy stacks on.`
    );
  }
  if (engine.type !== 'ssh' && engine.type !== 'tls') {
    throw new Error(`Unsupported engine type for compose CLI: ${engine.type}`);
  }
  // Host and user are written into ~/.ssh/config and DOCKER_HOST; rows saved before validation
  // existed are checked again here.
  if (validateEngineHost(engine.host) || (engine.type === 'ssh' && validateSshUser(engine.sshUser))) {
    throw new Error(`Engine "${engine.name}" has an invalid host or SSH user — fix it on the Engines page`);
  }

  if (engine.type === 'tls') {
    if (!engine.host || !engine.tlsCa || !engine.tlsCert) throw new Error(`Engine ${managedEngineId} (tls) missing host/ca/cert`);
    const row = await db('docker_engines').where({ id: managedEngineId }).select('tls_key_enc').first() as { tls_key_enc: string | null } | undefined;
    if (!row?.tls_key_enc) throw new Error(`Engine ${managedEngineId} (tls) missing key`);
    const tlsKey = decryptSecret(row.tls_key_enc);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `oblihub-engine-${managedEngineId}-`));
    const release = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } };
    try {
      fs.writeFileSync(path.join(tmp, 'ca.pem'), engine.tlsCa, { mode: 0o600, flag: 'wx' });
      fs.writeFileSync(path.join(tmp, 'cert.pem'), engine.tlsCert, { mode: 0o600, flag: 'wx' });
      fs.writeFileSync(path.join(tmp, 'key.pem'), tlsKey, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      release();
      throw err;
    }
    return {
      env: { DOCKER_HOST: `tcp://${engine.host}:${engine.port ?? 2376}`, DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: tmp },
      release,
    };
  }

  // ssh
  if (!engine.host || !engine.sshUser) throw new Error(`Engine ${managedEngineId} (ssh) missing host/user`);
  const row = await db('docker_engines').where({ id: managedEngineId }).select('ssh_private_key_enc').first() as { ssh_private_key_enc: string | null } | undefined;
  if (!row?.ssh_private_key_enc) throw new Error(`Engine ${managedEngineId} (ssh) missing private key`);
  const privateKey = decryptSecret(row.ssh_private_key_enc);
  // From here to the hold update: synchronous (no await), so concurrent runs share one identity.
  const hold = sshHolds.get(engine.id);
  if (hold) hold.count += 1;
  else acquireSshIdentity(engine, privateKey);
  let released = false;
  return {
    env: { DOCKER_HOST: `ssh://${engine.sshUser}@${engine.host}:${engine.port ?? 22}` },
    release: () => {
      if (released) return;
      released = true;
      releaseSshIdentity(engine.id);
    },
  };
}

// ── Crash cleanup ────────────────────────────────────────────────────────────

let sweptThisProcess = false;

/**
 * A crash or `docker stop` mid-run used to leave private keys, DOCKER_CONFIG dirs (registry
 * passwords) and ~/.ssh/config blocks behind. Runs once per process (index.ts calls it at boot; the
 * first compose call is the fallback). Nothing in this process has written any of these yet when it
 * first runs, and the mtime rule protects files of anything that started after boot. Never throws.
 */
function sweepStale(): void {
  if (sweptThisProcess) return;
  sweptThisProcess = true;
  try {
    const processStartedAt = Date.now() - process.uptime() * 1000;
    const tmpRoot = os.tmpdir();
    let removed = 0;
    // Covers oblihub-engine-* (ssh/tls keys), oblihub-dockercfg-* (registry auth) and
    // stackVolumes' oblihub-volumes-* invocation files.
    for (const name of fs.readdirSync(tmpRoot)) {
      if (!name.startsWith('oblihub-')) continue;
      const full = path.join(tmpRoot, name);
      try {
        if (fs.lstatSync(full).mtimeMs >= processStartedAt) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      } catch { /* best effort */ }
    }
    let sshBlocksRemoved = false;
    const configFile = path.join(sshDirPath(), 'config');
    const text = readTextOrNull(configFile);
    if (text != null) {
      const next = stripOblihubSshBlocks(text);
      if (next !== text) {
        fs.writeFileSync(configFile, next, { mode: 0o600 });
        try { fs.chmodSync(configFile, 0o600); } catch { /* not fatal */ }
        sshBlocksRemoved = true;
      }
    }
    if (removed > 0 || sshBlocksRemoved) {
      logger.info({ removedTempEntries: removed, sshConfigBlocksRemoved: sshBlocksRemoved }, 'Removed compose leftovers of a previous run');
    }
  } catch (err) {
    logger.warn({ err: errMessage(err) }, 'Stale compose leftovers sweep failed');
  }
}

// ── Process registry and locks ──────────────────────────────────────────

const running = new Map<string, RunEntry[]>();

function lockKey(daemonKey: string, project: string): string {
  return `${daemonKey}:${project}`;
}

function matchingEntries(project: string, engineId: number | null | undefined): RunEntry[] {
  const out: RunEntry[] = [];
  for (const entries of running.values()) {
    for (const e of entries) {
      if (e.projectName !== project) continue;
      if (engineId !== undefined && !e.engineIds.has(engineId ?? null)) continue;
      out.push(e);
    }
  }
  return out;
}

function isBusy(daemonKey: string, project: string): boolean {
  return (running.get(lockKey(daemonKey, project))?.length ?? 0) > 0;
}

function isQuietBusy(daemonKey: string, project: string): boolean {
  return (running.get(lockKey(daemonKey, project)) ?? []).some((e) => e.kind === 'quiet');
}

/** A run that can create or start containers holds the project (see RunEntry.creating). */
function isRecreating(daemonKey: string, project: string): boolean {
  return (running.get(lockKey(daemonKey, project)) ?? []).some((e) => e.creating);
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** STREAM runs only: quiet runs are background work (resource applies) the UI never cancels — killing
 *  one halfway would leave the stack partially recreated with nobody watching. */
function cancel(project: string, engineId?: number | null): boolean {
  let signalled = false;
  for (const e of matchingEntries(project, engineId)) {
    if (e.kind !== 'stream') continue;
    const child = e.child;
    if (child && !isAlive(child)) continue;
    e.cancelled = true;
    signalled = true;
    // No child yet (still preparing files/env): execCompose sees `cancelled` before spawning.
    if (!child) continue;
    logger.warn({ projectName: project, pid: child.pid }, 'Cancelling compose command');
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    const force = setTimeout(() => {
      if (isAlive(child)) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    }, 3000);
    force.unref();
  }
  return signalled;
}

function isRunning(project: string, engineId?: number | null): boolean {
  return matchingEntries(project, engineId).length > 0;
}

export interface ProjectHold {
  /** True while a compose run other than this hold shares the lock (a UI stream started meanwhile). */
  othersRunning(): boolean;
}

/**
 * Holds the daemonKey:project lock around work that rewrites the stack's files OUTSIDE a compose
 * command — GitPollWorker's `git reset --hard` followed by redeploy's file writes. A quiet run
 * (background resources apply) refuses as busy while the hold exists, so compose never reads a
 * half-rewritten tree; stream runs are not refused by it (they only refuse on a quiet holder), so the
 * redeploy's own `pull`/`up` still run, and cancel() never targets it. Refused (fn not called) when
 * any run already holds the lock. Reserved synchronously, like execCompose, so no check-then-act window.
 */
async function holdProject<T>(target: ComposeTarget, fn: (hold: ProjectHold) => Promise<T>): Promise<{ held: false } | { held: true; value: T }> {
  const key = lockKey(target.daemonKey, target.projectName);
  const holders = running.get(key) ?? [];
  if (holders.length > 0) return { held: false };
  const entry: RunEntry = {
    kind: 'hold',
    projectName: target.projectName,
    child: null,
    cancelled: false,
    engineIds: new Set<number | null>([target.managedEngineId, target.engineId]),
    creating: false,
  };
  holders.push(entry);
  running.set(key, holders);
  try {
    const value = await fn({ othersRunning: () => (running.get(key) ?? []).some((e) => e !== entry) });
    return { held: true, value };
  } finally {
    const list = running.get(key);
    if (list) {
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) running.delete(key);
    }
  }
}

// ── execCompose ──────────────────────────────────────────────────────────────

async function execCompose(target: ComposeTarget, verbArgs: string[], opts: ExecOptions): Promise<ComposeRunResult> {
  sweepStale();
  const stream = opts.mode === 'stream';
  const projectName = target.projectName;
  const key = lockKey(target.daemonKey, projectName);
  const emit = composeEmitter(target, opts);
  const verbDisplay = `docker compose ${verbArgs.join(' ')}`;

  // Lock reservation happens synchronously, before the first await: a check-then-await-then-register
  // window let two runs start.
  const holders = running.get(key) ?? [];
  if (!stream && holders.length > 0) {
    return { exitCode: BUSY_EXIT, busy: true, stdout: '', stderr: 'Another compose command is running for this stack', durationMs: 0 };
  }
  if (stream && holders.some((h) => h.kind === 'quiet')) {
    emit?.(SOCKET_EVENTS.COMPOSE_STARTED, { projectName, cmd: verbDisplay });
    emit?.(SOCKET_EVENTS.COMPOSE_LOG, { projectName, stream: 'stderr', chunk: `${QUIET_REFUSAL}\n` });
    emit?.(SOCKET_EVENTS.COMPOSE_FINISHED, { projectName, exitCode: BUSY_EXIT, durationMs: 0 });
    return { exitCode: BUSY_EXIT, refused: true, stdout: '', stderr: QUIET_REFUSAL, durationMs: 0 };
  }
  const entry: RunEntry = {
    kind: opts.mode,
    projectName,
    child: null,
    cancelled: false,
    engineIds: new Set<number | null>([target.managedEngineId, target.engineId]),
    // Same verb as runLocked reads (`verbArgs[0]`).
    creating: STARTING_VERBS.has(verbArgs[0] ?? ''),
  };
  holders.push(entry);
  running.set(key, holders);
  try {
    return await runLocked(target, verbArgs, opts, entry);
  } finally {
    const list = running.get(key);
    if (list) {
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) running.delete(key);
    }
  }
}

async function runLocked(target: ComposeTarget, verbArgs: string[], opts: ExecOptions, entry: RunEntry): Promise<ComposeRunResult> {
  const stream = opts.mode === 'stream';
  const projectName = target.projectName;
  const key = lockKey(target.daemonKey, projectName);
  const emit = composeEmitter(target, opts);
  const verb = verbArgs[0] ?? '';
  const purpose = opts.purpose ?? verb;
  const cleanups: Array<() => void> = [];
  const runCleanups = () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      try { fn(); } catch { /* best effort */ }
    }
  };

  /** Refusal before anything was spawned. */
  const fail = (exitCode: number, message: string, cmd = `docker compose ${verbArgs.join(' ')}`): ComposeRunResult => {
    runCleanups();
    if (emit) {
      emit(SOCKET_EVENTS.COMPOSE_STARTED, { projectName, cmd });
      emit(SOCKET_EVENTS.COMPOSE_LOG, { projectName, stream: 'stderr', chunk: `${message}\n` });
      emit(SOCKET_EVENTS.COMPOSE_FINISHED, { projectName, exitCode, durationMs: 0 });
    }
    logger.warn({ projectName, key, purpose, exitCode, err: message }, 'Compose command refused');
    return { exitCode, stdout: '', stderr: message, durationMs: 0 };
  };

  try {
    // Oblihub's own stack is (re)deployed by a helper container: `up`/`down` from inside would
    // stop the very process running the command.
    if (target.isSelfStack && MUTATING.has(verb)) {
      return fail(1, "Oblihub's own stack is deployed through its helper container, not from inside Oblihub");
    }

    // The engine is resolved, and a disabled one refused, before the file set: the resources render
    // queries the engine's facts, and for a legacy NULL engine_id or a local-type row the volumes
    // step lists, creates and can remove Docker volumes and writes volume placements through the
    // local client, which checks no engine row. The rest of the env is assembled further down.
    let engineEnv: { env: Record<string, string>; release: () => void };
    try {
      engineEnv = await resolveEngineEnv(target.managedEngineId);
    } catch (err) {
      logger.warn({ projectName, engineId: target.managedEngineId, err: errMessage(err) }, 'Compose engine env resolution failed');
      return fail(1, errMessage(err));
    }
    cleanups.push(engineEnv.release);

    // ── File set, in order: base, override files, resources override, volumes override ──
    const fileArgs: string[] = ['-f', target.composeFile];
    const display: string[] = ['-f', target.composeFile];
    const overrides = describeOverrideFile(target);
    fileArgs.push(...overrides.args);
    display.push(...overrides.args);

    // Re-rendering before EVERY verb is what keeps deploy / redeploy / rollback / git poll /
    // resources apply from dropping caps or GPU visibility. The render is idempotent, so `config`
    // stays effectively read-only. (Same-name managed stacks on two engines already share
    // `<stacksDir>/<project>` — compose file and .env included — so their renders can overwrite each
    // other; that folder sharing is a known, out-of-scope limitation.)
    const leadLines: string[] = [];
    const creating = CREATING.has(verb);
    const resourcesPath = path.join(target.composeDir, RESOURCES_OVERRIDE_FILE);
    // Running a creating verb without the override would recreate the services uncapped, so a render
    // or write failure refuses those; other verbs (stop, down, ps, config…) fall back to the file on disk.
    const refuseUncapped = (message: string) => fail(1, `${message} — command refused so resource limits are not dropped`);
    let passResources = false;
    let preview: ResourcesPreview | null = null;
    try {
      preview = await previewWith(target, overrides, verb);
    } catch (err) {
      const message = `Could not render the resource override (${errMessage(err)})`;
      if (creating) return refuseUncapped(message);
      logger.warn({ projectName, key }, `${message} — using the file on disk`);
      passResources = fs.existsSync(resourcesPath);
    }
    if (preview) {
      if (preview.yaml != null) {
        try {
          writeResourcesOverride(target.composeDir, preview.yaml);
          passResources = true;
        } catch (err) {
          const message = `Could not write ${RESOURCES_OVERRIDE_FILE} (${errMessage(err)})`;
          if (creating) return refuseUncapped(message);
          logger.warn({ projectName, key }, `${message} — using the file on disk`);
          passResources = fs.existsSync(resourcesPath);
        }
      } else {
        removeResourcesOverride(target.composeDir);
      }
      for (const w of preview.warnings) {
        if (stream) leadLines.push(`[resources] ${w}`);
        else logger.warn({ projectName, key, purpose }, `[resources] ${w}`);
      }
    }
    if (passResources) {
      fileArgs.push('-f', RESOURCES_OVERRIDE_FILE);
      display.push('-f', RESOURCES_OVERRIDE_FILE);
    }

    // Volumes stored under <stacksDir>/.volumes (managed stacks): the override rides along on EVERY
    // command; container-creating verbs are refused when they could detach data. The MANAGED row's
    // engine_id is passed so stackVolumes' exact row lookup matches.
    if (target.kind === 'managed') {
      let volumeFiles: PreparedComposeFiles;
      const volumeLines: string[] = [];
      try {
        volumeFiles = await stackVolumesService.prepareComposeFiles({
          projectName,
          engineId: target.managedEngineId,
          verb,
          log: (line) => volumeLines.push(line),
        });
      } catch (err) {
        const message = errMessage(err);
        logger.error({ projectName, engineId: target.managedEngineId, err: message }, 'Compose command refused by volume placement check');
        return fail(1, message);
      }
      cleanups.push(volumeFiles.cleanup);
      fileArgs.push(...volumeFiles.args);
      // Display the visible copy's name, not the per-invocation temp file.
      for (const a of volumeFiles.args) display.push(a === '-f' ? a : stackVolumesService.overrideRelativePath());
      leadLines.push(...volumeLines);
      if (!stream) for (const line of volumeLines) logger.info({ projectName, key, purpose }, line);
    }

    // ── Environment ──
    const childEnv: Record<string, string> = {};
    for (const k of SAFE_PASSTHROUGH) {
      const v = process.env[k];
      if (v !== undefined) childEnv[k] = v;
    }
    // Explicit overrides (DOCKER_HOST, DOCKER_TLS_VERIFY, ...) come LAST and always win.
    Object.assign(childEnv, engineEnv.env);
    if (target.kind === 'managed' && target.managedStackId != null) {
      const registryAuth = await resolveRegistryAuth(target.managedStackId, projectName);
      cleanups.push(registryAuth.cleanup);
      // The docker CLI then reads `${DOCKER_CONFIG}/config.json` instead of `~/.docker/config.json`.
      if (registryAuth.dockerConfigDir) childEnv.DOCKER_CONFIG = registryAuth.dockerConfigDir;
    }
    if (target.daemonKey !== 'local' && !childEnv.DOCKER_HOST) {
      return fail(1, 'Refusing to run compose for a remote engine without DOCKER_HOST');
    }

    // A pruned or never-created shared proxy network must not fail the command (deploy() made the
    // same call before `up`); ensureProxyNetwork never throws, the bound covers a hung engine. It runs
    // after the engine env so a refused (disabled) engine gets no network either: for a NULL engine_id
    // ensureProxyNetwork uses the local client, which checks no engine row.
    if (creating) {
      try {
        await withTimeout(dockerService.ensureProxyNetwork(target.managedEngineId), PROXY_NETWORK_TIMEOUT_MS, 'ensure proxy network');
      } catch (err) {
        logger.warn({ projectName, key, err: errMessage(err) }, 'Could not ensure the shared proxy network — continuing');
      }
    }
    if (entry.cancelled) {
      return fail(130, 'Cancelled by user');
    }

    // ── Spawn ──
    const cmdString = `docker compose -p "${projectName}" ${display.join(' ')} ${verbArgs.join(' ')}`;
    const idleTimeoutMs = opts.idleTimeoutMs ?? (stream ? 0 : QUIET_IDLE_TIMEOUT_MS);
    const maxBuf = stream ? STREAM_MAX_BUF : QUIET_MAX_BUF;
    if (stream) logger.info({ projectName, engineId: target.managedEngineId, cmd: cmdString, idleTimeoutMs }, 'Running compose command');
    else logger.info({ purpose, key, cmd: cmdString }, 'Running background compose command');

    return await new Promise<ComposeRunResult>((resolve) => {
      const startedAt = Date.now();
      let child: ChildProcess;
      try {
        // stdin = /dev/null: any Compose prompt (e.g. "Volume … exists but doesn't match
        // configuration. Recreate (data will be lost)?") reads EOF and gets the safe default "no"
        // instead of hanging forever on an open pipe. Never pass --yes.
        child = spawn('docker', ['compose', '-p', projectName, ...fileArgs, ...verbArgs], {
          cwd: target.composeDir,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve(fail(1, errMessage(err), cmdString));
        return;
      }
      entry.child = child;
      emit?.(SOCKET_EVENTS.COMPOSE_STARTED, { projectName, cmd: cmdString });
      for (const line of leadLines) {
        emit?.(SOCKET_EVENTS.COMPOSE_LOG, { projectName, stream: 'stdout', chunk: `${line}\n` });
      }

      // [resources] / [volumes] lines lead the output so they also land in the stack's "Deploy Output".
      let stdoutBuf = leadLines.map((line) => `${line}\n`).join('');
      let stderrBuf = '';
      let settled = false;

      let idleTimer: NodeJS.Timeout | null = null;
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (idleTimeoutMs > 0) {
          idleTimer = setTimeout(() => {
            logger.warn({ projectName, key, idleTimeoutMs }, 'Compose command idle timeout — killing process');
            try { child.kill('SIGTERM'); } catch { /* ignore */ }
            const force = setTimeout(() => { if (isAlive(child)) { try { child.kill('SIGKILL'); } catch { /* ignore */ } } }, 3000);
            force.unref();
          }, idleTimeoutMs);
        }
      };
      resetIdle();

      const onChunk = (streamName: 'stdout' | 'stderr') => (data: Buffer) => {
        resetIdle();
        const chunk = data.toString();
        if (streamName === 'stdout') stdoutBuf = (stdoutBuf + chunk).slice(-maxBuf);
        else stderrBuf = (stderrBuf + chunk).slice(-maxBuf);
        emit?.(SOCKET_EVENTS.COMPOSE_LOG, { projectName, stream: streamName, chunk });
      };
      child.stdout?.on('data', onChunk('stdout'));
      child.stderr?.on('data', onChunk('stderr'));

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        runCleanups();
        const durationMs = Date.now() - startedAt;
        emit?.(SOCKET_EVENTS.COMPOSE_FINISHED, { projectName, exitCode: 1, durationMs });
        logger.warn({ projectName, key, purpose, err: err.message }, 'Compose spawn error');
        resolve({ exitCode: 1, stdout: stdoutBuf, stderr: stderrBuf || err.message, durationMs });
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        runCleanups();
        const cancelled = entry.cancelled;
        const exitCode = cancelled ? 130 : (code ?? (signal ? 1 : 0));
        const durationMs = Date.now() - startedAt;
        if (/exists but doesn't match configuration/i.test(stdoutBuf + stderrBuf)) {
          // Compose kept the existing volume (the prompt got "no" from the closed stdin).
          const warning = '[volumes] Compose kept an existing volume whose configuration differs from the compose file (answered "no" to recreating it — data untouched).\n';
          stdoutBuf += warning;
          emit?.(SOCKET_EVENTS.COMPOSE_LOG, { projectName, stream: 'stdout', chunk: warning });
          logger.warn({ projectName }, 'Compose reported a volume whose configuration differs from the compose file — existing volume kept');
        }
        emit?.(SOCKET_EVENTS.COMPOSE_FINISHED, { projectName, exitCode, durationMs });
        if (stream) logger.info({ projectName, exitCode, signal, durationMs, cancelled }, 'Compose command finished');
        else logger.info({ purpose, key, exitCode, durationMs }, 'Background compose command finished');
        resolve({ exitCode, stdout: stdoutBuf, stderr: cancelled ? 'Cancelled by user' : stderrBuf, durationMs });
      });
    });
  } finally {
    // Every exit path (refusal, throw, spawn result) releases the engine env and temp files; a no-op
    // when the child's close/error handler already did.
    runCleanups();
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export const composeRunner = {
  resolveTarget,
  execCompose,
  isBusy,
  isQuietBusy,
  /**
   * Resolves the engine's managed daemon key (NULL = the legacy local socket); true only while a run
   * that can create or start containers holds the project. Holds and image pulls do not count, so the
   * priority watchdog is not kept from yielding for minutes by a git-poll hold or a long pull.
   */
  async isRecreatingFor(engineId: number | null, project: string): Promise<boolean> {
    return isRecreating(await engineFactsService.managedDaemonKey(engineId), project);
  },
  cancel,
  isRunning,
  holdProject,
  readLinkedLimits,
  previewResources,
  describeOverrideFile,
  resolveEngineEnv,
  sweepStale,
  composeRoom,
  COMPOSE_ADMINS_ROOM,
  /** COMPOSE_* event for a project outside a runner call (e.g. a refusal before any run); same rooms. */
  emitComposeEvent,
};
