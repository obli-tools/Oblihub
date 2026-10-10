import { db } from '../db';
import { logger } from '../utils/logger';
import { maintenanceService } from '../services/maintenance.service';
import { managedStackService } from '../services/managed-stack.service';
import { sourceManagerService } from '../services/sourceManager.service';
import { composeService } from '../services/compose.service';
import { composeRunner, type ProjectHold } from '../services/composeRunner.service';
import { isEngineMigrationRunning } from '../state/engineMigrations';
import type { ManagedStack } from '@oblihub/shared';

/**
 * Poll every git-sourced managed stack that has `poll_git_interval_s > 0`. For each, check
 * whether the remote HEAD SHA moved since the last recorded ref; if so, pull + rebuild.
 *
 * DELIBERATELY NOT a webhook. Two reasons:
 *   1. Oblihub is a poll-out only system by design — it doesn't accept unsolicited ingress
 *      (see architecture in the repo docs). Adding a webhook route would break that invariant
 *      and open a new attack surface (replay, HMAC key rotation, DoS via spam).
 *   2. Polling works transparently behind NAT / firewall / air-gapped VPN with zero operator
 *      config on the Gitea side. Trade-off is up-to-60s latency between push and deploy,
 *      which is fine for the target audience.
 *
 * The worker is a SINGLE global tick every 60s that iterates eligible stacks and, for each,
 * only actually calls `git ls-remote` when `last_git_poll_at + poll_git_interval_s` has passed.
 * That way a stack set to poll every 3600s doesn't get pinged 60x more than it asked for.
 */

const TICK_MS = 60_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  const now = Date.now();
  let candidates: Array<{ id: number; poll_git_interval_s: number; last_git_poll_at: Date | null }>;
  try {
    candidates = await db('managed_stacks')
      .where('source_type', 'git')
      .where('poll_git_interval_s', '>', 0)
      .select('id', 'poll_git_interval_s', 'last_git_poll_at');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'GitPollWorker DB query failed');
    return;
  }

  for (const row of candidates) {
    const lastPoll = row.last_git_poll_at ? new Date(row.last_git_poll_at).getTime() : 0;
    const nextDueAt = lastPoll + row.poll_git_interval_s * 1000;
    if (now < nextDueAt) continue;
    await pollOne(row.id, row.last_git_poll_at).catch(err => {
      logger.warn({ stackId: row.id, err: err instanceof Error ? err.message : String(err) }, 'Git poll failed for stack');
    });
  }
}

/** Leave a detected commit pending: put the poll stamp back so the next 60s tick treats the stack
 *  as due again instead of waiting a full poll interval, and — once gitPull has advanced git_ref —
 *  rewind it too, or the next tick would see remoteRef === gitRef and never deploy this commit. */
async function deferCommit(stackId: number, previousPollAt: Date | null, previousGitRef?: string | null): Promise<void> {
  const update: Record<string, unknown> = { last_git_poll_at: previousPollAt };
  if (previousGitRef !== undefined) update.git_ref = previousGitRef;
  await db('managed_stacks').where({ id: stackId }).update(update);
}

/** Same rule as the runner's disabled-engine refusal (resolveEngineEnv in composeRunner.service.ts):
 *  a set engine_id whose row has enabled=false, or a legacy NULL engine_id when local-type rows exist
 *  and all of them are disabled (they share the one local socket; no local row = bare socket). */
async function engineDisabled(engineId: number | null): Promise<boolean> {
  if (engineId == null) {
    const locals = await db('docker_engines').where({ type: 'local' }).select('enabled') as Array<{ enabled: boolean }>;
    return locals.length > 0 && locals.every((e) => e.enabled === false);
  }
  const row = await db('docker_engines').where({ id: engineId }).first('enabled') as { enabled: boolean } | undefined;
  return row?.enabled === false;
}

async function pollOne(stackId: number, previousPollAt: Date | null): Promise<void> {
  const stack = await managedStackService.getById(stackId);
  if (!stack || stack.sourceType !== 'git' || !stack.gitUrl) return;
  const branch = stack.gitBranch || 'main';

  // The runner refuses a redeploy on a disabled engine with a plain failure, but only after gitPull
  // has rewritten the tree and advanced git_ref, so the commit would read as deployed and never run.
  // Skip before ls-remote and before the poll stamp: git_ref stays put and the stack stays due, so the
  // first tick after the engine is re-enabled deploys the commit.
  if (await engineDisabled(stack.engineId)) {
    logger.debug({ stackId, engineId: stack.engineId }, 'Git poll skipped — the stack\'s engine is disabled');
    return;
  }
  // Defence in depth: the migration's source and target holds already make holdProject below refuse
  // (deferCommit), but skipping here, before the stamp, also spares the ls-remote and keeps the stack
  // due, so the first tick after the migration picks the commit up on the engine it ended on.
  if (isEngineMigrationRunning(stackId)) {
    logger.debug({ stackId }, 'Git poll skipped — an engine migration is running');
    return;
  }
  // Auto-pull is automatic update work: outside the maintenance window, skip before the poll stamp so
  // the stack stays due and the first tick inside the window picks the new commit up.
  if (!(await maintenanceService.allowsManagedStack(stack.composeProject, stack.engineId))) {
    logger.debug({ stackId }, 'Git poll skipped — outside the maintenance window');
    return;
  }

  // Stamp the poll time immediately so a slow ls-remote (or a hung one) doesn't cause the
  // worker to re-attempt the same stack every tick until it finishes.
  await db('managed_stacks').where({ id: stackId }).update({ last_git_poll_at: new Date() });

  const remoteRef = await sourceManagerService.remoteHeadRef(stackId, stack.gitUrl, branch);
  if (!remoteRef) return; // network/auth failure — try again next interval
  if (remoteRef === stack.gitRef) {
    // No new commits — cheapest happy path.
    return;
  }

  // gitPull's `git reset --hard` and redeploy's file writes happen outside any compose command, so
  // the whole pull + redeploy holds the runner's daemonKey:project lock: a background resources apply
  // (quiet `up`) cannot start and read a half-rewritten tree meanwhile, while the redeploy's own
  // stream `pull`/`up` still run under the hold. Taken after ls-remote so an unchanged repo never
  // holds it. Without a target (no managed row) no compose run can lock this stack either.
  const target = await composeRunner.resolveTarget({ managedStackId: stackId });
  if (!target) {
    await pullAndRedeploy(stackId, stack, remoteRef, previousPollAt, null);
    return;
  }
  const outcome = await composeRunner.holdProject(target, (hold) => pullAndRedeploy(stackId, stack, remoteRef, previousPollAt, hold));
  if (!outcome.held) {
    // Deferring rather than failing: the runner would refuse the redeploy anyway, and the commit
    // must stay pending for the next tick.
    logger.info({ stackId, to: remoteRef }, 'Git poll found a new commit but a compose command holds the stack — retrying next tick');
    await deferCommit(stackId, previousPollAt);
  }
}

async function pullAndRedeploy(
  stackId: number,
  stack: ManagedStack,
  remoteRef: string,
  previousPollAt: Date | null,
  hold: ProjectHold | null,
): Promise<void> {
  logger.info({ stackId, from: stack.gitRef, to: remoteRef, branch: stack.gitBranch || 'main' }, 'Git poll detected new commit — pulling + redeploying');
  try {
    await sourceManagerService.gitPull(stackId);
    const refreshed = await managedStackService.getById(stackId);
    if (!refreshed) return;
    // The hold keeps quiet runs out, not UI stream runs (deploy, pull, redeploy): one started
    // during the fetch is left to finish alone rather than raced by a second `up`.
    if (hold?.othersRunning()) {
      logger.info({ stackId, to: refreshed.gitRef }, 'Git poll pulled a new commit but a compose command now runs on the stack — redeploying next tick');
      await deferCommit(stackId, previousPollAt, stack.gitRef);
      return;
    }
    const result = await composeService.redeploy(refreshed.composeProject, refreshed.composeContent, refreshed.envContent, refreshed.engineId);
    if (result.refused || result.busy) {
      // Not expected under the hold (a quiet run cannot start while it exists); kept for the
      // no-target path: a background compose run refused the redeploy, no container was recreated.
      // No failed history row — the retry on the next tick records the real outcome.
      logger.info({ stackId, to: refreshed.gitRef }, 'Git poll redeploy refused by a background compose run — retrying next tick');
      await deferCommit(stackId, previousPollAt, stack.gitRef);
      return;
    }
    if (result.exitCode !== 0 && await engineDisabled(refreshed.engineId)) {
      // The engine was disabled after pollOne's check, during the pull. The runner reports that as a
      // plain failure, not refused/busy, so without this the commit would be consumed the same way.
      logger.info({ stackId, to: refreshed.gitRef }, 'Git poll redeploy refused — the engine was disabled during the pull; deploying after it is re-enabled');
      await deferCommit(stackId, previousPollAt, stack.gitRef);
      return;
    }
    await managedStackService.recordDeployHistory({
      managedStackId: stackId,
      sourceType: refreshed.sourceType,
      gitUrl: refreshed.gitUrl,
      gitBranch: refreshed.gitBranch,
      gitRef: refreshed.gitRef,
      composePath: refreshed.composePath,
      buildEnabled: refreshed.buildEnabled,
      success: result.exitCode === 0,
      notes: `Auto: git poll ${stack.gitRef ?? '?'} → ${refreshed.gitRef ?? '?'}`,
      deployedByUserId: null,
    });
  } catch (err) {
    logger.warn({ stackId, err: err instanceof Error ? err.message : String(err) }, 'Auto pull+redeploy failed after git poll');
  }
}

export function startGitPollWorker(): void {
  tick().catch(err => logger.error(err, 'GitPollWorker initial run failed'));
  pollTimer = setInterval(() => { tick().catch(err => logger.error(err, 'GitPollWorker run failed')); }, TICK_MS);
  logger.info({ intervalMs: TICK_MS }, 'Git-poll worker started');
}

export function stopGitPollWorker(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
