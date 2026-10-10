import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { db } from '../db';
import { logger } from '../utils/logger';
import { sshKeyService } from './sshKey.service';
import { workflowTargetService } from './workflowTarget.service';
import { nginxService } from './nginx.service';
import { certificateService } from './proxy.service';
import { stackService } from './stack.service';
import { dockerService } from './docker.service';
import type {
  Workflow, WorkflowActionType, WorkflowTriggerType, WorkflowActionConfig, WorkflowTriggerConfig,
  WorkflowRun, WorkflowRunStatus, WorkflowRunLogEntry, WorkflowRunTriggerSource,
} from '@oblihub/shared';

/**
 * Workflow orchestration.
 *
 * Runtime model: one row in `workflows` = (trigger) → (action). Concrete execution happens in
 * `runWorkflow(workflow, source)` which is called both by the scheduler (cron/interval) and by
 * on-demand HTTP handlers. Result is persisted as a `workflow_runs` row with a structured log.
 *
 * Concurrency: if a workflow already has a `running` run, a new attempt is recorded as `skipped`
 * and returns immediately. Prevents a cron every 5s from stacking up backlogs behind a slow
 * SFTP push.
 *
 * Action registry: `ACTIONS[actionType]` is the executor for that action. Each executor receives
 * an `ExecutionContext` with a scoped `log()` helper — no direct DB writes from the executor;
 * we batch and flush the log to the workflow_runs row at end.
 */

// ── Row mapping ──

function rowToWorkflow(row: Record<string, unknown>): Workflow {
  return {
    id: row.id as number,
    name: row.name as string,
    description: (row.description as string) || null,
    teamId: (row.team_id as number) || null,
    ownerUserId: (row.owner_user_id as number) || null,
    actionType: row.action_type as WorkflowActionType,
    actionConfig: (row.action_config as WorkflowActionConfig) || ({} as WorkflowActionConfig),
    triggerType: row.trigger_type as WorkflowTriggerType,
    triggerConfig: (row.trigger_config as WorkflowTriggerConfig) || ({} as WorkflowTriggerConfig),
    enabled: !!row.enabled,
    lastFiredAt: row.last_fired_at ? (row.last_fired_at as Date).toISOString() : null,
    nextFireAt: row.next_fire_at ? (row.next_fire_at as Date).toISOString() : null,
    lastRunId: (row.last_run_id as number) || null,
    createdByUserId: (row.created_by_user_id as number) || null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function rowToRun(row: Record<string, unknown>): WorkflowRun {
  return {
    id: row.id as number,
    workflowId: row.workflow_id as number,
    startedAt: (row.started_at as Date).toISOString(),
    finishedAt: row.finished_at ? (row.finished_at as Date).toISOString() : null,
    status: row.status as WorkflowRunStatus,
    triggerSource: (row.trigger_source as WorkflowRunTriggerSource) || 'scheduler',
    outputLog: (row.output_log as WorkflowRunLogEntry[]) || [],
    errorMessage: (row.error_message as string) || null,
    durationMs: (row.duration_ms as number) || null,
  };
}

// ── Action registry ──

interface ExecutionContext {
  workflow: Workflow;
  log: (level: WorkflowRunLogEntry['level'], message: string) => void;
}

type ActionExecutor = (ctx: ExecutionContext) => Promise<void>;

/**
 * Action: ssl-export-sftp
 *
 * Push a certificate's fullchain + key to a remote host over SFTP using the configured SSH key.
 * The workflow_target defines destination host / user / path; the action_config picks WHICH cert
 * to push and optionally the chain-only file.
 *
 * Failure modes explicitly surfaced (each becomes an error log line):
 *   - target missing / disabled
 *   - cert not valid on disk (still pending / errored)
 *   - ssh_key missing on the target
 *   - connection refused / auth denied / write permission
 *   - remote_path does not exist (mkdir -p at destination is opt-in via a future flag)
 */
const actSslExportSftp: ActionExecutor = async (ctx) => {
  const cfg = ctx.workflow.actionConfig as { certificateId?: number; targetId?: number; alsoExportChain?: boolean };
  if (!cfg.certificateId || !cfg.targetId) {
    throw new Error('ssl-export-sftp requires certificateId and targetId');
  }
  const target = await workflowTargetService.getById(cfg.targetId);
  if (!target) throw new Error(`Workflow target ${cfg.targetId} not found`);
  if (!target.sshKeyId) throw new Error(`Target "${target.name}" has no SSH key attached`);
  const cert = await certificateService.getById(cfg.certificateId);
  if (!cert) throw new Error(`Certificate ${cfg.certificateId} not found`);
  if (cert.status !== 'valid') throw new Error(`Certificate ${cert.domainNames[0]} is not valid (status: ${cert.status})`);

  // Resolve on-disk paths through the compat helper (new naming vs legacy). If the files aren't
  // on disk we can't push anything — surface the specific reason rather than "generic error".
  const resolved = nginxService.resolveExistingCertFile(cert);
  if (!resolved) throw new Error(`Certificate files not found on disk for cert ${cert.id} (${cert.domainNames[0]})`);

  const privateKeyPem = await sshKeyService.getPrivateKey(target.sshKeyId);
  if (!privateKeyPem) throw new Error(`Private key for ssh_key ${target.sshKeyId} could not be decrypted`);

  ctx.log('info', `Connecting to ${target.username}@${target.host}:${target.port} → ${target.remotePath}`);

  // ssh2 is heavy — lazy-imported so a workflow-less install doesn't pay the cold-start cost.
  const { Client } = await import('ssh2');
  await new Promise<void>((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }
        const uploads: Array<{ local: string; remoteName: string }> = [
          { local: resolved.fullchain, remoteName: `${cert.domainNames[0]}.fullchain.crt` },
          { local: resolved.key,        remoteName: `${cert.domainNames[0]}.key` },
        ];
        if (cfg.alsoExportChain) {
          // Try to include the chain file too when it exists — it's optional; a self-signed
          // upload won't have one and that's fine.
          const chainCandidate = path.join(path.dirname(resolved.fullchain), path.basename(resolved.fullchain).replace('.fullchain.crt', '.chain.crt'));
          if (fs.existsSync(chainCandidate)) {
            uploads.push({ local: chainCandidate, remoteName: `${cert.domainNames[0]}.chain.crt` });
          }
        }
        (async () => {
          try {
            for (const up of uploads) {
              const remote = path.posix.join(target.remotePath.endsWith('/') ? target.remotePath : `${target.remotePath}/`, up.remoteName);
              ctx.log('info', `SFTP put ${path.basename(up.local)} → ${remote}`);
              await new Promise<void>((res, rej) => sftp.fastPut(up.local, remote, {}, e => e ? rej(e) : res()));
            }
            ctx.log('info', `Uploaded ${uploads.length} file(s) successfully`);
            conn.end();
            resolve();
          } catch (e) {
            conn.end();
            reject(e);
          }
        })();
      });
    });
    conn.on('error', (err) => reject(err));
    conn.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      privateKey: privateKeyPem,
      // Host key check: pin when we have a fingerprint on record, accept anything otherwise
      // (matches OpenSSH's `StrictHostKeyChecking=accept-new`). Non-null hostKeyFingerprint =
      // strict enforcement, mismatched key → error.
      hostVerifier: target.hostKeyFingerprint
        ? (key: Buffer) => {
            const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
            const ok = fp === target.hostKeyFingerprint;
            if (!ok) ctx.log('error', `Host key mismatch: got ${fp}, expected ${target.hostKeyFingerprint}`);
            return ok;
          }
        : undefined,
      readyTimeout: 15000,
    });
  });
};

/**
 * Action: restart-stacks
 *
 * Restart every container of every stack matching the scope. Serialized per-container (docker
 * restart returns quick, no need to parallelize) but continues on individual failures so a
 * single crashing container doesn't abort the whole sweep — the log records each failure.
 */
const actRestartStacks: ActionExecutor = async (ctx) => {
  const cfg = ctx.workflow.actionConfig as { scope?: 'stack' | 'team' | 'all'; stackId?: number; teamId?: number };
  const scope = cfg.scope || 'stack';
  let stackIds: number[] = [];
  if (scope === 'stack') {
    if (!cfg.stackId) throw new Error('restart-stacks scope=stack requires stackId');
    stackIds = [cfg.stackId];
  } else if (scope === 'team') {
    if (!cfg.teamId) throw new Error('restart-stacks scope=team requires teamId');
    const rows = await db('stacks').where({ team_id: cfg.teamId }).select('id');
    stackIds = rows.map(r => r.id as number);
  } else {
    const rows = await db('stacks').select('id');
    stackIds = rows.map(r => r.id as number);
  }
  ctx.log('info', `Restarting ${stackIds.length} stack(s)`);

  let ok = 0, fail = 0;
  for (const sid of stackIds) {
    const stack = await stackService.getById(sid);
    if (!stack) { ctx.log('warn', `Stack ${sid} vanished mid-run`); continue; }
    for (const c of stack.containers) {
      if (c.engineId == null) {
        // Orphaned row: restarting "its" docker id on some other daemon could hit an unrelated container.
        ctx.log('warn', `skipped ${stack.name} / ${c.containerName}: its engine no longer exists`);
        continue;
      }
      try {
        await dockerService.restartContainer(c.dockerId, c.engineId);
        ctx.log('info', `↻ ${stack.name} / ${c.containerName}`);
        ok++;
      } catch (err) {
        ctx.log('error', `✗ ${stack.name} / ${c.containerName}: ${err instanceof Error ? err.message : String(err)}`);
        fail++;
      }
    }
  }
  ctx.log('info', `Done — ${ok} restarted, ${fail} failed`);
  if (fail > 0 && ok === 0) throw new Error(`All ${fail} container restarts failed`);
};

const ACTIONS: Record<WorkflowActionType, ActionExecutor> = {
  'ssl-export-sftp': actSslExportSftp,
  'restart-stacks':  actRestartStacks,
};

// ── Runner ──

/**
 * Fire a workflow. Called from the scheduler and from on-demand handlers. Returns the created
 * run row (with terminal status set) or the skipped-run row if a previous execution is still
 * in-flight.
 */
export async function runWorkflow(workflow: Workflow, triggerSource: WorkflowRunTriggerSource): Promise<WorkflowRun> {
  // Concurrency guard — skip if a previous run of THIS workflow hasn't finished.
  const running = await db('workflow_runs').where({ workflow_id: workflow.id, status: 'running' }).first();
  if (running) {
    logger.warn({ workflowId: workflow.id, runningRunId: running.id }, 'Skipping workflow run — previous still active');
    const [row] = await db('workflow_runs').insert({
      workflow_id: workflow.id,
      status: 'skipped',
      trigger_source: triggerSource,
      finished_at: new Date(),
      output_log: JSON.stringify([{ ts: new Date().toISOString(), level: 'warn', message: `Previous run #${running.id} still active — skipped` }]),
      duration_ms: 0,
    }).returning('*');
    await db('workflows').where({ id: workflow.id }).update({ last_run_id: row.id, last_fired_at: new Date() });
    return rowToRun(row);
  }

  const startedAt = new Date();
  const [runRow] = await db('workflow_runs').insert({
    workflow_id: workflow.id,
    status: 'running',
    trigger_source: triggerSource,
    started_at: startedAt,
    output_log: JSON.stringify([]),
  }).returning('*');
  const runId = runRow.id as number;
  await db('workflows').where({ id: workflow.id }).update({ last_run_id: runId, last_fired_at: startedAt });

  // Buffer log entries in memory; flush at end. Bounded so a runaway action can't blow the row.
  const MAX_LOG_ENTRIES = 200;
  const buffer: WorkflowRunLogEntry[] = [];
  const log = (level: WorkflowRunLogEntry['level'], message: string) => {
    if (buffer.length >= MAX_LOG_ENTRIES) return;
    buffer.push({ ts: new Date().toISOString(), level, message });
  };

  let status: WorkflowRunStatus = 'success';
  let errorMessage: string | null = null;
  try {
    const executor = ACTIONS[workflow.actionType];
    if (!executor) throw new Error(`Unknown action type: ${workflow.actionType}`);
    log('info', `Starting action ${workflow.actionType} (trigger: ${triggerSource})`);
    await executor({ workflow, log });
    log('info', 'Done.');
  } catch (err) {
    status = 'failed';
    errorMessage = err instanceof Error ? err.message : String(err);
    log('error', errorMessage);
    logger.error({ workflowId: workflow.id, runId, err: errorMessage }, 'Workflow run failed');
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  await db('workflow_runs').where({ id: runId }).update({
    status,
    error_message: errorMessage,
    finished_at: finishedAt,
    duration_ms: durationMs,
    output_log: JSON.stringify(buffer),
  });

  const [updated] = await db('workflow_runs').where({ id: runId });
  return rowToRun(updated);
}

// ── CRUD ──

export const workflowService = {
  async list(filter?: { teamIds?: number[]; ownerUserId?: number; includeGlobal?: boolean }): Promise<Workflow[]> {
    const rows = await db('workflows')
      .where(function () {
        if (filter?.teamIds?.length) this.orWhereIn('team_id', filter.teamIds);
        if (filter?.ownerUserId) this.orWhere({ owner_user_id: filter.ownerUserId });
        if (filter?.includeGlobal) {
          this.orWhere(function () { this.whereNull('team_id').whereNull('owner_user_id'); });
        }
      })
      .orderBy('name');
    return rows.map(rowToWorkflow);
  },

  async getById(id: number): Promise<Workflow | null> {
    const row = await db('workflows').where({ id }).first();
    return row ? rowToWorkflow(row) : null;
  },

  async create(data: {
    name: string;
    description?: string | null;
    teamId?: number | null;
    ownerUserId?: number | null;
    actionType: WorkflowActionType;
    actionConfig?: WorkflowActionConfig;
    triggerType: WorkflowTriggerType;
    triggerConfig?: WorkflowTriggerConfig;
    enabled?: boolean;
    createdByUserId?: number | null;
  }): Promise<Workflow> {
    if (data.teamId && data.ownerUserId) throw new Error('Workflow cannot be both team-scoped and personal — pick one');
    const [row] = await db('workflows').insert({
      name: data.name,
      description: data.description || null,
      team_id: data.teamId || null,
      owner_user_id: data.ownerUserId || null,
      action_type: data.actionType,
      action_config: JSON.stringify(data.actionConfig || {}),
      trigger_type: data.triggerType,
      trigger_config: JSON.stringify(data.triggerConfig || {}),
      enabled: data.enabled !== false,
      created_by_user_id: data.createdByUserId || null,
    }).returning('*');
    return rowToWorkflow(row);
  },

  async update(id: number, data: Partial<{
    name: string;
    description: string | null;
    teamId: number | null;
    ownerUserId: number | null;
    actionType: WorkflowActionType;
    actionConfig: WorkflowActionConfig;
    triggerType: WorkflowTriggerType;
    triggerConfig: WorkflowTriggerConfig;
    enabled: boolean;
  }>): Promise<Workflow | null> {
    if (data.teamId && data.ownerUserId) throw new Error('Workflow cannot be both team-scoped and personal — pick one');
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.teamId !== undefined) update.team_id = data.teamId;
    if (data.ownerUserId !== undefined) update.owner_user_id = data.ownerUserId;
    if (data.actionType !== undefined) update.action_type = data.actionType;
    if (data.actionConfig !== undefined) update.action_config = JSON.stringify(data.actionConfig);
    if (data.triggerType !== undefined) update.trigger_type = data.triggerType;
    if (data.triggerConfig !== undefined) update.trigger_config = JSON.stringify(data.triggerConfig);
    if (data.enabled !== undefined) update.enabled = data.enabled;
    const [row] = await db('workflows').where({ id }).update(update).returning('*');
    return row ? rowToWorkflow(row) : null;
  },

  async delete(id: number): Promise<void> {
    await db('workflows').where({ id }).delete();
  },

  async listRuns(workflowId: number, limit = 50): Promise<WorkflowRun[]> {
    const rows = await db('workflow_runs').where({ workflow_id: workflowId }).orderBy('started_at', 'desc').limit(limit);
    return rows.map(rowToRun);
  },
};

export { runWorkflow as _runWorkflow };
