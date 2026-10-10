/**
 * Managed stacks whose stop-and-deploy / migrate-data engine migration is running
 * (managedStackController.migrateEngine). The migration also holds the runner's lock on the source
 * and target daemons, which refuses quiet runs, GitPollWorker and withProjectHold callers, but a hold
 * never refuses a UI stream run: without this set a deploy, redeploy or pull started mid-migration
 * would bring the stack up on the source daemon (engine_id is not flipped until the data is copied)
 * or race the target `up`, leaving it live on both engines.
 *
 * A leaf module rather than controller state so workers can read it without importing the
 * controller graph. Single process, like the other state/ holders: Oblihub is a singleton.
 */
const migratingStacks = new Set<number>();

export function isEngineMigrationRunning(managedStackId: number): boolean {
  return migratingStacks.has(managedStackId);
}

/** Claims the stack for a migration; false when one already runs (the caller refuses). */
export function beginEngineMigration(managedStackId: number): boolean {
  if (migratingStacks.has(managedStackId)) return false;
  migratingStacks.add(managedStackId);
  return true;
}

export function endEngineMigration(managedStackId: number): void {
  migratingStacks.delete(managedStackId);
}
