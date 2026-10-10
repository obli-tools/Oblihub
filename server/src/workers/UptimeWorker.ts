import { db } from '../db';
import { notificationService } from '../services/notification.service';
import { logger } from '../utils/logger';
import http from 'http';
import https from 'https';
import net from 'net';

const monitorTimers = new Map<number, ReturnType<typeof setInterval>>();

async function checkHttp(url: string, timeout: number, expectedStatus: number, keyword?: string | null): Promise<{ status: 'up' | 'down'; responseTimeMs: number; statusCode: number | null; message: string | null }> {
  const start = Date.now();
  return new Promise((resolve) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout, rejectUnauthorized: false }, (res) => {
      const responseTimeMs = Date.now() - start;
      const statusCode = res.statusCode || 0;

      if (keyword) {
        let body = '';
        res.on('data', (chunk) => { body += chunk.toString(); });
        res.on('end', () => {
          const found = body.includes(keyword);
          resolve({ status: found ? 'up' : 'down', responseTimeMs, statusCode, message: found ? null : `Keyword "${keyword}" not found` });
        });
      } else {
        // Drain the response
        res.resume();
        resolve({ status: statusCode === expectedStatus ? 'up' : 'down', responseTimeMs, statusCode, message: statusCode !== expectedStatus ? `Expected ${expectedStatus}, got ${statusCode}` : null });
      }
    });
    req.on('error', (err) => { resolve({ status: 'down', responseTimeMs: Date.now() - start, statusCode: null, message: err.message }); });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'down', responseTimeMs: timeout, statusCode: null, message: 'Timeout' }); });
  });
}

async function checkTcp(url: string, timeout: number): Promise<{ status: 'up' | 'down'; responseTimeMs: number; message: string | null }> {
  const start = Date.now();
  const [host, portStr] = url.replace(/^tcp:\/\//, '').split(':');
  const port = parseInt(portStr || '80', 10);

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout }, () => {
      socket.destroy();
      resolve({ status: 'up', responseTimeMs: Date.now() - start, message: null });
    });
    socket.on('error', (err) => { resolve({ status: 'down', responseTimeMs: Date.now() - start, message: err.message }); });
    socket.on('timeout', () => { socket.destroy(); resolve({ status: 'down', responseTimeMs: timeout, message: 'Timeout' }); });
  });
}

async function checkMonitor(monitorId: number): Promise<void> {
  const monitor = await db('uptime_monitors').where({ id: monitorId }).first();
  if (!monitor || !monitor.enabled) return;

  let result: { status: 'up' | 'down'; responseTimeMs: number; statusCode?: number | null; message: string | null };

  if (monitor.type === 'tcp') {
    result = await checkTcp(monitor.url, monitor.timeout_ms);
  } else {
    result = await checkHttp(monitor.url, monitor.timeout_ms, monitor.expected_status, monitor.keyword);
  }

  // Record heartbeat
  await db('uptime_heartbeats').insert({
    monitor_id: monitorId,
    status: result.status,
    response_time_ms: result.responseTimeMs,
    status_code: (result as { statusCode?: number | null }).statusCode || null,
    message: result.message,
  });

  // Update monitor status
  const prevStatus = monitor.current_status;
  const consecutive = result.status === 'down' ? (monitor.consecutive_failures || 0) + 1 : 0;

  await db('uptime_monitors').where({ id: monitorId }).update({
    current_status: result.status,
    consecutive_failures: consecutive,
    updated_at: new Date(),
  });

  // Notify on status change (down after 3 consecutive failures, or back up)
  const shouldNotifyDown = result.status === 'down' && consecutive === 3 && prevStatus !== 'down';
  const shouldNotifyUp = result.status === 'up' && prevStatus === 'down';

  if (shouldNotifyDown || shouldNotifyUp) {
    const payload = {
      stackName: 'Uptime',
      containerName: monitor.name,
      eventType: (shouldNotifyDown ? 'update_failed' : 'update_applied') as 'update_failed' | 'update_applied',
      message: shouldNotifyDown
        ? `Monitor "${monitor.name}" is DOWN: ${result.message || 'No response'}`
        : `Monitor "${monitor.name}" is back UP (${result.responseTimeMs}ms)`,
      timestamp: new Date().toISOString(),
    };

    // Use monitor-specific channel, or stack channel if proxy_host has stack_id, or global default
    if (monitor.notification_channel_id) {
      // Send to specific channel
      const channel = await db('notification_channels').where({ id: monitor.notification_channel_id, is_enabled: true }).first();
      if (channel) {
        const { getPlugin } = await import('../notifications/registry');
        const plugin = getPlugin(channel.type);
        if (plugin) plugin.send(channel.config, payload).catch(() => {});
      }
    } else {
      // Fall back to global notification channels
      notificationService.sendForStack(0, 'Uptime', payload).catch(() => {});
    }

    if (shouldNotifyDown) logger.warn({ monitorId, name: monitor.name }, 'Monitor is DOWN');
    else logger.info({ monitorId, name: monitor.name }, 'Monitor is back UP');
  }

  // Cleanup old heartbeats (keep 30 days)
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await db('uptime_heartbeats').where('timestamp', '<', cutoff).where({ monitor_id: monitorId }).delete();
}

export async function startUptimeWorker(): Promise<void> {
  const monitors = await db('uptime_monitors').where({ enabled: true });

  for (const monitor of monitors) {
    const interval = (monitor.interval_seconds || 60) * 1000;
    const timer = setInterval(() => checkMonitor(monitor.id), interval);
    monitorTimers.set(monitor.id, timer);
    // First check after a short delay
    setTimeout(() => checkMonitor(monitor.id), Math.random() * 5000);
  }

  logger.info({ count: monitors.length }, 'Uptime worker started');
}

export function rescheduleMonitor(monitorId: number, intervalSeconds: number, enabled: boolean): void {
  const existing = monitorTimers.get(monitorId);
  if (existing) { clearInterval(existing); monitorTimers.delete(monitorId); }

  if (enabled) {
    const timer = setInterval(() => checkMonitor(monitorId), intervalSeconds * 1000);
    monitorTimers.set(monitorId, timer);
    setTimeout(() => checkMonitor(monitorId), 1000);
  }
}

export function stopUptimeWorker(): void {
  for (const timer of monitorTimers.values()) clearInterval(timer);
  monitorTimers.clear();
}
