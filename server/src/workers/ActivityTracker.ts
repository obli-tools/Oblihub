import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { db } from '../db';
import { sleepService } from '../services/sleep.service';
import { logger } from '../utils/logger';

/**
 * ActivityTracker — tails the nginx sleep activity log and updates containers.last_active_at.
 *
 * Nginx writes one line per request to `/data/stacks/_proxy/sleep_activity.log` with the format:
 *   <proxy_host_id>|<msec>|<status>|<user_agent>|<request_uri>
 *
 * We tail with fs.watchFile (poll-based, robust to log rotation), batch updates per 5s
 * to avoid hammering Postgres. Filter rules drop bot/health/probe traffic before
 * touching last_active_at.
 */

const LOG_PATH = path.join(config.stacksDir, '_proxy', 'sleep_activity.log');
const FLUSH_INTERVAL_MS = 5_000;
const POLL_INTERVAL_MS = 1_000;

// Patterns considered "non-user" traffic — never reset the idle timer.
// Conservative defaults; tunable later via per-host or global config.
const BOT_UA_PATTERNS: RegExp[] = [
  /\bbot\b/i, /\bcrawl/i, /\bspider\b/i, /\bslurp\b/i,
  /headlesschrome/i, /phantomjs/i, /puppeteer/i, /lighthouse/i,
  /pingdom/i, /uptimerobot/i, /statuscake/i, /better.?uptime/i, /datadog/i,
  /prometheus/i, /grafana/i, /blackbox.?exporter/i,
  /curl\//i, /wget/i, /python-requests/i, /go-http-client/i, /java\//i,
];

const NON_USER_PATH_PREFIXES = [
  '/health', '/healthz', '/ready', '/readyz', '/live', '/livez',
  '/metrics', '/.well-known/', '/favicon.ico', '/robots.txt',
];

function isUserTraffic(userAgent: string, requestUri: string): boolean {
  if (!userAgent || userAgent === '-') return false; // anonymous = probably scripted
  for (const re of BOT_UA_PATTERNS) if (re.test(userAgent)) return false;
  for (const prefix of NON_USER_PATH_PREFIXES) if (requestUri.startsWith(prefix)) return false;
  return true;
}

interface PendingActivity {
  containerId: number;
  ts: Date;
}

let watching = false;
let lastSize = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
const pendingByContainer = new Map<number, PendingActivity>();

// Cache: proxy_host_id → wake_container_id (avoid hammering DB)
const wakeContainerCache = new Map<number, number | null>();
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30_000;

async function refreshCache(): Promise<void> {
  if (Date.now() - cacheLoadedAt < CACHE_TTL_MS) return;
  try {
    const rows = await db('proxy_hosts').select('id', 'wake_container_id');
    wakeContainerCache.clear();
    for (const r of rows) wakeContainerCache.set(r.id, r.wake_container_id ?? null);
    cacheLoadedAt = Date.now();
  } catch (err) {
    logger.warn({ err }, 'ActivityTracker: cache refresh failed');
  }
}

async function processLine(line: string): Promise<void> {
  if (!line) return;
  const parts = line.split('|');
  if (parts.length < 5) return;
  const proxyHostId = parseInt(parts[0], 10);
  if (!proxyHostId || isNaN(proxyHostId)) return;
  const userAgent = parts[3] || '';
  const requestUri = parts[4] || '';
  if (!isUserTraffic(userAgent, requestUri)) return;

  await refreshCache();
  const containerId = wakeContainerCache.get(proxyHostId);
  if (!containerId) return;

  // Coalesce: only keep the most recent ts per container for the next flush
  pendingByContainer.set(containerId, { containerId, ts: new Date() });
}

async function flush(): Promise<void> {
  if (pendingByContainer.size === 0) return;
  const batch = [...pendingByContainer.values()];
  pendingByContainer.clear();
  for (const item of batch) {
    try {
      await sleepService.recordActivity(item.containerId);
    } catch (err) {
      logger.warn({ err, containerId: item.containerId }, 'ActivityTracker: recordActivity failed');
    }
  }
}

async function pollFile(): Promise<void> {
  let stat: fs.Stats;
  try { stat = fs.statSync(LOG_PATH); }
  catch { return; } // file not created yet

  if (stat.size === lastSize) return;
  if (stat.size < lastSize) {
    // log was rotated / truncated — reset
    lastSize = 0;
  }

  const fd = fs.openSync(LOG_PATH, 'r');
  try {
    const toRead = stat.size - lastSize;
    if (toRead > 0) {
      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, lastSize);
      lastSize = stat.size;
      const text = buf.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim()) await processLine(line);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function startActivityTracker(): void {
  if (watching) return;
  watching = true;
  // Initialize at end-of-file so we don't replay historical lines on first boot.
  try { lastSize = fs.statSync(LOG_PATH).size; } catch { lastSize = 0; }
  pollTimer = setInterval(() => { pollFile().catch(err => logger.warn({ err }, 'ActivityTracker poll failed')); }, POLL_INTERVAL_MS);
  flushTimer = setInterval(() => { flush().catch(err => logger.warn({ err }, 'ActivityTracker flush failed')); }, FLUSH_INTERVAL_MS);
  logger.info({ logPath: LOG_PATH }, 'Activity tracker started');
}

export function stopActivityTracker(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  watching = false;
}
