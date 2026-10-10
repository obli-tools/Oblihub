import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { db } from '../db';
import { logger } from '../utils/logger';
import { isSafeStackFolder } from '../utils/composeProject';
import { withTimeout } from '../utils/withTimeout';
import { dockerService } from './docker.service';

/**
 * Which compose project is Oblihub's own.
 *
 * The set (`getSelfProjects`) is an EXEMPTION, not a mere refusal: the priority watchdog never yields
 * those stacks, stackPower treats their containers as Oblihub itself, resource limits refuse them
 * (and stop applying stored caps), and the compose runner refuses their mutating verbs, admin
 * included. A false positive therefore shields a tenant stack from the admin, so only sources a
 * tenant cannot forge are trusted: the compose label on Oblihub's own container and the operator's
 * OBLIHUB_COMPOSE_PROJECT. The `oblihub.proxy=true` label is a guess of last resort, because any
 * compose file can carry it: see proxyLabelProject().
 *
 * The deploy-via-helper decision in managed-stack.controller keeps its own-container-only check on
 * purpose: a false positive there would copy another stack's compose over Oblihub's own compose file.
 */

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const PROXY_LABEL = 'oblihub.proxy';
const SELF_PROJECTS_TTL_MS = 60_000;
// A partial answer (a source failed) is kept briefly only: the set keeps the watchdog, limits and
// compose actions off Oblihub's own stack, so a source that was down must be retried soon rather
// than trusted as "not self" for a whole minute.
const PARTIAL_TTL_MS = 5_000;
const LOCAL_CALL_TIMEOUT_MS = 5_000;

// The own container's labels and mounts cannot change while this process lives: cached once found.
let ownProject: string | null = null;
let hostStacksDir: string | null = null;
let selfProjectsCache: { set: Set<string>; expiresAt: number } | null = null;
let selfProjectsInflight: Promise<Set<string>> | null = null;
// Recomputed every minute: warn once per distinct ambiguous set, not on every refresh.
let lastAmbiguousWarning = '';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stripTrailingSlashes(p: string): string {
  return p.replace(/\/+$/, '') || '/';
}

async function inspectSelf() {
  const selfId = dockerService.getSelfContainerId();
  if (!selfId) return null;
  return withTimeout(dockerService.inspectContainer(selfId), LOCAL_CALL_TIMEOUT_MS, 'inspect own container');
}

/** Own container's compose project; `ok` false when the inspect failed (the answer is unknown). */
async function readOwnProject(): Promise<{ project: string | null; ok: boolean }> {
  if (ownProject) return { project: ownProject, ok: true };
  try {
    const info = await inspectSelf();
    if (!info) return { project: null, ok: true };
    const project = info.Config?.Labels?.[COMPOSE_PROJECT_LABEL] || null;
    if (project) ownProject = project;
    return { project, ok: true };
  } catch (err) {
    logger.debug({ err: errMessage(err) }, 'Cannot inspect the Oblihub container for its compose project');
    return { project: null, ok: false };
  }
}

/**
 * Fallback for an Oblihub that runs outside any compose container (dev run, `docker run`): the
 * project of the local container labelled oblihub.proxy=true. A tenant can put that label on its own
 * compose, so a project that is a managed stack (any engine) or a stacks-dir folder is never taken,
 * and when several projects remain none is: guessing wrong would exempt a tenant stack.
 */
async function proxyLabelProject(): Promise<{ project: string | null; partial: boolean }> {
  const candidates = new Set<string>();
  try {
    const docker = await dockerService.forEngine(null);
    const proxies = await withTimeout(
      docker.listContainers({ all: true, filters: { label: [`${PROXY_LABEL}=true`] } }),
      LOCAL_CALL_TIMEOUT_MS,
      'list Oblihub proxy containers',
    );
    for (const c of proxies) {
      const project = c.Labels?.[COMPOSE_PROJECT_LABEL];
      if (project) candidates.add(project);
    }
  } catch (err) {
    logger.debug({ err: errMessage(err) }, 'Cannot list the Oblihub proxy container for its compose project');
    return { project: null, partial: true };
  }
  if (candidates.size === 0) return { project: null, partial: false };

  try {
    const rows = await db('managed_stacks').whereIn('compose_project', [...candidates])
      .distinct('compose_project') as Array<{ compose_project: string }>;
    for (const r of rows) candidates.delete(r.compose_project);
  } catch (err) {
    // Unfiltered, the label could name a tenant's managed stack: take nothing until the check works.
    logger.debug({ err: errMessage(err) }, 'Cannot check the Oblihub proxy compose project against managed stacks');
    return { project: null, partial: true };
  }
  for (const project of [...candidates]) {
    if (isSafeStackFolder(project) && fs.existsSync(path.join(config.stacksDir, project))) candidates.delete(project);
  }

  if (candidates.size > 1) {
    const key = [...candidates].sort().join(',');
    if (key !== lastAmbiguousWarning) {
      lastAmbiguousWarning = key;
      logger.warn({ projects: [...candidates] },
        'Several compose projects carry oblihub.proxy=true: none is treated as Oblihub\'s own stack. Set OBLIHUB_COMPOSE_PROJECT.');
    }
    return { project: null, partial: false };
  }
  return { project: candidates.size === 1 ? [...candidates][0] : null, partial: false };
}

async function computeSelfProjects(): Promise<{ set: Set<string>; partial: boolean }> {
  const set = new Set<string>();

  // The compose files pass OBLIHUB_COMPOSE_PROJECT through with an empty default: empty = unset.
  const fromEnv = (process.env.OBLIHUB_COMPOSE_PROJECT || '').trim();
  if (fromEnv) set.add(fromEnv);

  const own = await readOwnProject();
  if (own.project) {
    set.add(own.project);
    return { set, partial: false };
  }
  // A failed inspect means "unknown", not "no project": falling back to the label there would let a
  // labelled tenant stack in whenever the inspect happens to fail. Retry soon instead.
  if (!own.ok) return { set, partial: true };
  // The operator named the project: the tenant-writable label adds nothing but risk.
  if (fromEnv) return { set, partial: false };

  const fallback = await proxyLabelProject();
  if (fallback.project) set.add(fallback.project);
  return { set, partial: fallback.partial };
}

export const selfProjectService = {
  getSelfContainerId(): string | null {
    return dockerService.getSelfContainerId();
  },

  /**
   * Projects exempt as Oblihub's own (never for deploy-via-helper decisions): own container project
   * ∪ OBLIHUB_COMPOSE_PROJECT env (trimmed, empty ignored). Only when the own-container inspect
   * succeeded without finding a project and the env is unset: the single LOCAL oblihub.proxy=true
   * project that is neither a managed stack nor a stacks-dir folder. Cached 60 s (5 s when a source
   * failed). A failing source never drops the others.
   */
  async getSelfProjects(): Promise<Set<string>> {
    if (selfProjectsCache && Date.now() < selfProjectsCache.expiresAt) return new Set(selfProjectsCache.set);
    if (!selfProjectsInflight) {
      selfProjectsInflight = computeSelfProjects()
        .then(({ set, partial }) => {
          selfProjectsCache = { set, expiresAt: Date.now() + (partial ? PARTIAL_TTL_MS : SELF_PROJECTS_TTL_MS) };
          return set;
        })
        .finally(() => { selfProjectsInflight = null; });
    }
    return new Set(await selfProjectsInflight);
  },

  /** Only the LOCAL daemon can run Oblihub's own stack: a same-named project on a remote engine is not self. */
  async isSelfProject(project: string | null, daemonKey: string): Promise<boolean> {
    if (project == null || daemonKey !== 'local') return false;
    return (await selfProjectService.getSelfProjects()).has(project);
  },

  /** Host Source of the mount whose Destination is config.stacksDir; null when unknown. */
  async getHostStacksDir(): Promise<string | null> {
    if (hostStacksDir) return hostStacksDir;
    try {
      const info = await inspectSelf();
      if (!info) return null;
      const target = stripTrailingSlashes(path.posix.normalize(config.stacksDir));
      const mount = (info.Mounts || []).find((m) => typeof m.Destination === 'string'
        && stripTrailingSlashes(path.posix.normalize(m.Destination)) === target);
      if (!mount?.Source) return null;
      hostStacksDir = stripTrailingSlashes(mount.Source);
      return hostStacksDir;
    } catch (err) {
      logger.debug({ err: errMessage(err) }, 'Cannot inspect the Oblihub container for its stacks dir mount');
      return null;
    }
  },
};
