/** Compose project name Oblihub derives from a managed stack's display name. */
export function toComposeProject(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

/** Docker Compose requires project names to start with a lowercase letter or a digit. */
export function isValidComposeProject(project: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(project);
}

// Folders under the stacks dir owned by Oblihub itself (`_proxy` = nginx config, certs, logs).
const RESERVED_FOLDERS = new Set(['_proxy']);

/**
 * Whether `project` can safely name a folder under the stacks dir. An empty name would resolve to
 * the stacks dir itself — a stack wipe or delete would then take every stack (and `.volumes`,
 * where new stacks keep their data) with it.
 */
export function isSafeStackFolder(project: string): boolean {
  return /^[a-z0-9_-]+$/.test(project) && !RESERVED_FOLDERS.has(project);
}
