import './env';
import http from 'http';
import { createApp } from './app';
import { createSocketServer } from './socket';
import { db } from './db';
import { config } from './config';
import { logger } from './utils/logger';
import { authService } from './services/auth.service';
import { obligateService } from './services/obligate.service';
import { setUpdateServiceIO } from './services/update.service';
import { setComposeServiceIO } from './services/compose.service';
import { startDiscoveryWorker, stopDiscoveryWorker } from './workers/DiscoveryWorker';
import { startGitPollWorker, stopGitPollWorker } from './workers/GitPollWorker';
import { startStatsWorker, stopStatsWorker, cleanupOldStats } from './workers/StatsWorker';
import { startUptimeWorker, stopUptimeWorker } from './workers/UptimeWorker';
import { startWorkflowScheduler, stopWorkflowScheduler } from './workers/WorkflowScheduler';
import { startRetentionWorker, stopRetentionWorker } from './workers/RetentionWorker';
import { startTrafficLogWorker, stopTrafficLogWorker } from './workers/TrafficLogWorker';
import { startTrafficDownsampleWorker, stopTrafficDownsampleWorker } from './workers/TrafficDownsampleWorker';
import { startHoneypotWorker, stopHoneypotWorker } from './workers/HoneypotWorker';
import { startSleepWorker, stopSleepWorker } from './workers/SleepWorker';
import { startPriorityWatchdogWorker, stopPriorityWatchdogWorker } from './workers/PriorityWatchdogWorker';
import { startGpuUtilPoller, stopGpuUtilPoller } from './workers/GpuUtilPoller';
import { startActivityTracker, stopActivityTracker } from './workers/ActivityTracker';
import { schedulerService } from './services/scheduler.service';
import { dockerService } from './services/docker.service';
import { composeRunner } from './services/composeRunner.service';
import { engineFactsService } from './services/engineFacts.service';
import { hostAgentService } from './services/hostAgent.service';
import { sleep } from './utils/withTimeout';

async function waitForDatabase(maxRetries = 30, delayMs = 2000): Promise<void> {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      await db.raw('SELECT 1');
      logger.info(`Database connected (attempt ${i})`);
      return;
    } catch {
      logger.warn(`Database not ready (attempt ${i}/${maxRetries}), retrying in ${delayMs / 1000}s...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Database unreachable after ${maxRetries} attempts`);
}

async function main() {
  // Wait for PostgreSQL to be ready (up to 60s)
  await waitForDatabase();

  logger.info('Running database migrations...');
  await db.migrate.latest();
  logger.info('Migrations complete');

  // After a crash or a `docker stop` in the middle of a compose command, decrypted SSH/TLS private
  // keys, DOCKER_CONFIG registry passwords and `# oblihub:engine-` ssh config blocks stayed in /tmp
  // and ~/.ssh until the next compose command, which on a hub that never runs one meant forever.
  // The runner still sweeps lazily on its first command as a fallback (it only runs once).
  try {
    composeRunner.sweepStale();
  } catch (err) {
    logger.warn({ err }, 'Startup temp-file sweep failed');
  }

  await authService.ensureDefaultAdmin(config.defaultAdminUsername, config.defaultAdminPassword);

  // Clean up old containers left from self-updates
  await dockerService.cleanupOldSelfContainers();

  // Ensure the shared `proxy` bridge network exists on the local engine. Failsafe in case a
  // `docker compose down` (or a fresh install where it wasn't created yet) left it missing —
  // we want the proxy<->managed-stacks routing to "just work" without ops intervention.
  await dockerService.ensureProxyNetwork(null);
  // Fan out the same check across every enabled remote engine in the background. Doesn't block
  // boot; failures are logged. Each managed stack deploy also re-asserts the network on its
  // target engine, so this is just a courtesy for the operator browsing networks early on.
  (async () => {
    try {
      const { engineService } = await import('./services/engine.service');
      const engines = await engineService.getAll();
      for (const e of engines.filter(eng => eng.enabled && !eng.isDefault)) {
        void dockerService.ensureProxyNetwork(e.id);
      }
    } catch { /* non-critical */ }
  })();

  // If we were restarted mid-self-deploy, reset the self-stack's status from 'deploying' to 'deployed'.
  // We just booted, so the deploy clearly completed — we're the new instance it spawned.
  try {
    const selfId = dockerService.getSelfContainerId();
    if (selfId) {
      const info = await dockerService.inspectContainer(selfId);
      const selfProject = info.Config?.Labels?.['com.docker.compose.project'];
      if (selfProject) {
        const { managedStackService } = await import('./services/managed-stack.service');
        const stacks = await managedStackService.getAll();
        // Only the local daemon's row is us: a remote stack with the same project name may really
        // be mid-deploy, and resetting it would hide that deploy's outcome.
        let selfStack: (typeof stacks)[number] | null = null;
        for (const s of stacks) {
          if (s.composeProject === selfProject && s.status === 'deploying'
            && await engineFactsService.managedDaemonKey(s.engineId ?? null) === 'local') {
            selfStack = s;
            break;
          }
        }
        if (selfStack) {
          await managedStackService.setStatus(selfStack.id, 'deployed', 'Self-deploy completed (new instance booted)');
          logger.info({ projectName: selfProject }, 'Reset self-stack status from deploying → deployed on boot');
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Self-stack status reset on boot failed (non-fatal)');
  }

  const app = createApp();
  const server = http.createServer(app);
  const io = createSocketServer(server);
  app.set('io', io);

  // Provide io to update service for real-time progress events
  setUpdateServiceIO(io);
  // Provide io to compose service so deploy/pull stream stdout/stderr live to subscribers.
  // The source manager (zip / git progress) and the volume migration (tar progress) reuse the
  // compose:log channel through the same io, sent to the stack's compose room only.
  setComposeServiceIO(io);

  // Start Docker discovery worker
  startDiscoveryWorker(io);

  // Start git-poll worker — checks git-sourced stacks with poll_git_interval_s>0 for new
  // commits and auto pull+redeploy. Poll-out only (no ingress webhook by design).
  startGitPollWorker();

  // Start per-stack check scheduler
  await schedulerService.startAll();

  // Start container stats worker
  startStatsWorker(io);
  // Cleanup old stats every hour
  setInterval(() => cleanupOldStats(), 60 * 60 * 1000);
  // Hourly retention purges: ip_geo_cache (30 d), update_history (365 d),
  // managed_stack_deploy_history (last 100 per stack or 90 d)
  startRetentionWorker();

  // Start uptime monitoring worker
  await startUptimeWorker();

  // Start workflow scheduler (fires cron/interval workflows, purges runs history hourly)
  startWorkflowScheduler();

  // Start traffic log workers — tail nginx access log for stats + hourly downsample/purge.
  // Behind the same allowNginx guard as the activity tracker (no point tailing a log that
  // doesn't exist in installs without the built-in proxy).
  if (config.allowNginx) {
    startTrafficLogWorker();
    startTrafficDownsampleWorker();
    startHoneypotWorker();
  }

  // Start sleep worker (idle container detection)
  startSleepWorker();

  // Priority watchdog — tails the same nginx traffic log as TrafficLogWorker to detect activity
  // on Critical stacks, then pauses/stops any Opportunistic stack that yields to them. Runs even
  // when allowNginx=false: without a proxy the traffic log won't exist and the tailer no-ops,
  // but future signal sources (gpu-util, webhook) still work.
  startPriorityWatchdogWorker(io);
  // GPU-util signal source for the priority watchdog. Silently no-ops when nvidia-smi is missing.
  startGpuUtilPoller();

  // Start activity tracker (tails nginx access log → updates last_active_at)
  if (config.allowNginx) startActivityTracker();

  // Nginx proxy: regenerate configs on startup + auto-renewal
  if (config.allowNginx) {
    const { nginxService } = await import('./services/nginx.service');
    const { letsEncryptService } = await import('./services/certificate.service');
    nginxService.regenerateAndReload().then(() => {
      logger.info('Nginx proxy configs regenerated on startup');
    }).catch(err => {
      logger.warn({ err }, 'Nginx proxy config regeneration failed on startup (proxy may not be running yet)');
    });
    setInterval(() => letsEncryptService.checkRenewals(), 12 * 60 * 60 * 1000);
    logger.info('Certificate auto-renewal scheduler started (12h interval)');
  }

  server.listen(config.port, () => {
    logger.info(`Oblihub server listening on port ${config.port}`);
    logger.info({ allowConsole: config.allowConsole, allowStack: config.allowStack, allowNginx: config.allowNginx, stacksDir: config.stacksDir }, 'Feature flags');
    void obligateService.announceSelfInfo();
  });

  // Graceful shutdown. A second signal while this runs is ignored: the first one already owns the exit.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down...');
    try {
      stopDiscoveryWorker();
      stopGitPollWorker();
      stopStatsWorker();
      stopUptimeWorker();
      stopWorkflowScheduler();
      stopRetentionWorker();
      stopTrafficLogWorker();
      stopTrafficDownsampleWorker();
      stopHoneypotWorker();
      stopSleepWorker();
      stopGpuUtilPoller();
      stopActivityTracker();
      schedulerService.stopAll();
      hostAgentService.stop();
      engineFactsService.stopRefreshLoop();
      // The watchdog resumes what it paused or stopped. That used to be fire-and-forget and
      // process.exit killed it half-way; `docker stop` allows 10 s before SIGKILL, so wait at most 8.
      // Rows it could not resume stay journalled and are resumed at the next boot.
      await Promise.race([stopPriorityWatchdogWorker(), sleep(8_000)]);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    }
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  logger.error(err, 'Failed to start server');
  process.exit(1);
});
