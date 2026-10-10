import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { db } from '../db';
import { logger } from '../utils/logger';
import { banService } from '../services/ban.service';
import { nginxService } from '../services/nginx.service';
import { obliguardHubService } from '../services/obliguardHub.service';
import { appConfigService } from '../services/appConfig.service';

/**
 * HoneypotWorker — tails /etc/nginx/oblihub_honeypot.log (bind-mounted from the proxy container
 * to <stacksDir>/_proxy/), extracts scanner IPs, and issues global bans via banService.
 *
 * Log line format (pipe-separated, 5 fields, defined in nginx.service.ts main config):
 *   $proxy_host_id|$msec|$remote_addr|$request_uri|$server_name
 *
 * Each ban triggers:
 *   1. banService.create() — records the ban + fires Obliguard sync fire-and-forget
 *   2. nginxService.writeBanMap() — regenerates ban_map.conf + sighups nginx (fast path, no
 *      full config regen)
 * Both are debounced: multiple hits from the same IP in the same burst produce one insert
 * (thanks to the ip UNIQUE + hit_count increment) and one ban_map rewrite (via the flush
 * timer). Cheap enough that we don't need bespoke coalescing beyond the DB level.
 *
 * Retention: also runs a periodic retry of unsynced-to-Obliguard bans so a temporary Obliguard
 * outage self-heals without manual intervention.
 */

const LOG_PATH = path.join(config.stacksDir, '_proxy', 'oblihub_honeypot.log');
const POLL_INTERVAL_MS = 1_000;
const MAP_REFRESH_INTERVAL_MS = 5_000;       // batch bans into one nginx reload every 5s max
const OBLIGUARD_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const BAN_PURGE_INTERVAL_MS = 60 * 60 * 1000;

let watching = false;
let lastSize = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let mapTimer: ReturnType<typeof setInterval> | null = null;
let obliguardTimer: ReturnType<typeof setInterval> | null = null;
let purgeTimer: ReturnType<typeof setInterval> | null = null;
let mapDirty = false;

async function processLine(line: string): Promise<void> {
  if (!line || line[0] === '#') return;
  const parts = line.split('|');
  if (parts.length < 5) return;
  const proxyHostId = parseInt(parts[0], 10) || null;
  const ip = parts[2];
  const uri = parts[3] || '';
  const serverName = parts[4] || '';
  if (!ip || ip === '-') return;

  // Reason string surfaces in the /bans UI so the operator can tell WHY someone was banned.
  const reason = `${uri} on ${serverName || 'host #' + proxyHostId}`.slice(0, 512);

  // Ban duration: per-host override → app-level default → permanent. Null in both = permanent.
  let banDurationSeconds: number | null = null;
  if (proxyHostId) {
    const row = await db('proxy_hosts').where({ id: proxyHostId }).first().catch(() => null);
    if (row?.honeypot_ban_duration_seconds != null) banDurationSeconds = Number(row.honeypot_ban_duration_seconds);
  }
  if (banDurationSeconds == null) {
    const def = await appConfigService.get('default_honeypot_ban_duration_seconds');
    if (def) {
      const parsed = parseInt(def, 10);
      if (!isNaN(parsed) && parsed > 0) banDurationSeconds = parsed;
    }
  }

  const source: 'honeypot-path' | 'honeypot-acl' = uri.startsWith('/') ? 'honeypot-path' : 'honeypot-acl';
  // We can't perfectly tell path-hit vs ACL-hit from the log alone (both write here). Heuristic:
  // path hits always start with `/`, ACL hits also start with `/`. So we always tag as
  // 'honeypot-path' unless the URI is empty/dash. Refined in a v2 with a distinguishing field.

  const created = await banService.create({
    ip,
    reason,
    sourceType: source,
    sourceProxyHostId: proxyHostId,
    banDurationSeconds,
  });
  if (created) {
    mapDirty = true;
    logger.info({ ip, uri, host: serverName }, 'Honeypot triggered — IP banned');
  }
}

async function pollFile(): Promise<void> {
  if (!fs.existsSync(LOG_PATH)) return;
  let stat: fs.Stats;
  try { stat = fs.statSync(LOG_PATH); } catch { return; }
  if (stat.size === lastSize) return;
  if (stat.size < lastSize) { lastSize = 0; }
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
  } finally { fs.closeSync(fd); }
}

async function refreshBanMapIfDirty(): Promise<void> {
  if (!mapDirty) return;
  mapDirty = false;
  try {
    await nginxService.writeBanMap();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ban_map regeneration failed');
    mapDirty = true; // retry next tick
  }
}

async function retryObliguardSync(): Promise<void> {
  try {
    const { attempted } = await obliguardHubService.retryUnsyncedBans(100);
    if (attempted > 0) logger.info({ attempted }, 'Retried Obliguard sync for unsynced bans');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Obliguard retry batch failed');
  }
}

async function purgeExpiredBans(): Promise<void> {
  try {
    const { expired, oldInactive } = await banService.purge();
    if (expired > 0 || oldInactive > 0) {
      logger.info({ expired, oldInactive }, 'Ban retention sweep');
      if (expired > 0) mapDirty = true; // expired bans → shorter ban_map → regen
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Ban purge failed');
  }
}

export function startHoneypotWorker(): void {
  if (watching) return;
  watching = true;
  logger.info({ logPath: LOG_PATH }, 'Starting honeypot worker (1s poll, 5s map refresh)');
  try { lastSize = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0; } catch { lastSize = 0; }
  pollTimer = setInterval(() => { pollFile().catch(err => logger.warn({ err }, 'HoneypotWorker poll failed')); }, POLL_INTERVAL_MS);
  mapTimer = setInterval(() => { refreshBanMapIfDirty().catch(() => {}); }, MAP_REFRESH_INTERVAL_MS);
  obliguardTimer = setInterval(() => { retryObliguardSync().catch(() => {}); }, OBLIGUARD_RETRY_INTERVAL_MS);
  purgeTimer = setInterval(() => { purgeExpiredBans().catch(() => {}); }, BAN_PURGE_INTERVAL_MS);
}

export function stopHoneypotWorker(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (mapTimer) { clearInterval(mapTimer); mapTimer = null; }
  if (obliguardTimer) { clearInterval(obliguardTimer); obliguardTimer = null; }
  if (purgeTimer) { clearInterval(purgeTimer); purgeTimer = null; }
  watching = false;
}
