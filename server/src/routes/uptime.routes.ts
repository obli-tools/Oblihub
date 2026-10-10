import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import { rescheduleMonitor } from '../workers/UptimeWorker';
import { AppError } from '../middleware/errorHandler';

const router = Router();

// Public status page endpoint (no auth)
router.get('/status/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = await db('status_pages').where({ slug: req.params.slug, is_public: true }).first();
    if (!page) throw new AppError(404, 'Status page not found');

    const monitorIds = page.monitor_ids as number[];
    const monitors = await db('uptime_monitors').whereIn('id', monitorIds);

    // Get uptime % for each monitor (last 24h)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const data = await Promise.all(monitors.map(async (m) => {
      const heartbeats = await db('uptime_heartbeats').where({ monitor_id: m.id }).where('timestamp', '>', since).orderBy('timestamp', 'desc');
      const total = heartbeats.length;
      const up = heartbeats.filter(h => h.status === 'up').length;
      const avgTime = heartbeats.filter(h => h.response_time_ms).reduce((sum, h) => sum + h.response_time_ms, 0) / (heartbeats.filter(h => h.response_time_ms).length || 1);

      return {
        name: m.name,
        currentStatus: m.current_status,
        uptimePercent: total > 0 ? Math.round((up / total) * 10000) / 100 : 100,
        avgResponseTime: Math.round(avgTime),
        lastCheck: heartbeats[0]?.timestamp || null,
      };
    }));

    res.json({ success: true, data: { name: page.name, customCss: page.custom_css, monitors: data } });
  } catch (err) { next(err); }
});

// Auth required for management
router.use(requireAuth);

// Monitors CRUD
router.get('/monitors', requirePermission('uptime.view'), async (_req, res, next) => {
  try {
    const monitors = await db('uptime_monitors').orderBy('id');
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const data = await Promise.all(monitors.map(async (m) => {
      const heartbeats = await db('uptime_heartbeats').where({ monitor_id: m.id }).where('timestamp', '>', since);
      const total = heartbeats.length;
      const up = heartbeats.filter(h => h.status === 'up').length;
      const avgTime = heartbeats.filter(h => h.response_time_ms).reduce((sum, h) => sum + h.response_time_ms, 0) / (heartbeats.filter(h => h.response_time_ms).length || 1);

      return {
        id: m.id, name: m.name, url: m.url, type: m.type,
        intervalSeconds: m.interval_seconds, timeoutMs: m.timeout_ms, expectedStatus: m.expected_status,
        keyword: m.keyword, proxyHostId: m.proxy_host_id, enabled: m.enabled,
        currentStatus: m.current_status, consecutiveFailures: m.consecutive_failures,
        notificationChannelId: m.notification_channel_id || null,
        uptimePercent: total > 0 ? Math.round((up / total) * 10000) / 100 : 100,
        avgResponseTime: Math.round(avgTime),
        createdAt: m.created_at, updatedAt: m.updated_at,
      };
    }));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/monitors', requirePermission('uptime.manage'), async (req, res, next) => {
  try {
    const { name, url, type, intervalSeconds, timeoutMs, expectedStatus, keyword, proxyHostId } = req.body;
    if (!name || !url) throw new AppError(400, 'Name and URL required');
    const [row] = await db('uptime_monitors').insert({
      name, url, type: type || 'http',
      interval_seconds: intervalSeconds || 60, timeout_ms: timeoutMs || 5000,
      expected_status: expectedStatus || 200, keyword: keyword || null,
      proxy_host_id: proxyHostId || null, enabled: true,
    }).returning('*');
    rescheduleMonitor(row.id, row.interval_seconds, true);
    res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

router.delete('/monitors/:id', requirePermission('uptime.manage'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    rescheduleMonitor(id, 0, false);
    await db('uptime_monitors').where({ id }).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/monitors/:id/toggle', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const monitor = await db('uptime_monitors').where({ id }).first();
    if (!monitor) throw new AppError(404, 'Monitor not found');
    const enabled = !monitor.enabled;
    await db('uptime_monitors').where({ id }).update({ enabled });
    rescheduleMonitor(id, monitor.interval_seconds, enabled);
    res.json({ success: true, data: { enabled } });
  } catch (err) { next(err); }
});

// Update monitor notification channel
router.patch('/monitors/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { notificationChannelId, intervalSeconds } = req.body;
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (notificationChannelId !== undefined) update.notification_channel_id = notificationChannelId;
    if (intervalSeconds !== undefined) {
      update.interval_seconds = intervalSeconds;
      const monitor = await db('uptime_monitors').where({ id }).first();
      if (monitor) rescheduleMonitor(id, intervalSeconds, monitor.enabled);
    }
    await db('uptime_monitors').where({ id }).update(update);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Get monitor for a proxy host
router.get('/monitors/by-proxy/:proxyHostId', async (req, res, next) => {
  try {
    const proxyHostId = parseInt(req.params.proxyHostId, 10);
    const monitor = await db('uptime_monitors').where({ proxy_host_id: proxyHostId }).first();
    res.json({ success: true, data: monitor ? {
      id: monitor.id, name: monitor.name, url: monitor.url, currentStatus: monitor.current_status,
      enabled: monitor.enabled, intervalSeconds: monitor.interval_seconds,
    } : null });
  } catch (err) { next(err); }
});

// Sync: create monitors for all proxy hosts that don't have one
router.post('/monitors/sync-proxy-hosts', async (req, res, next) => {
  try {
    const proxyHosts = await db('proxy_hosts').where({ enabled: true });
    let created = 0;
    for (const host of proxyHosts) {
      const existing = await db('uptime_monitors').where({ proxy_host_id: host.id }).first();
      if (existing) continue;
      const domains = host.domain_names as string[];
      if (!domains?.length) continue;
      const scheme = host.ssl_forced ? 'https' : 'http';
      const [row] = await db('uptime_monitors').insert({
        name: domains[0], url: `${scheme}://${domains[0]}`,
        type: 'http', interval_seconds: 60, timeout_ms: 5000, expected_status: 200,
        proxy_host_id: host.id, enabled: true,
      }).returning('*');
      rescheduleMonitor(row.id, 60, true);
      created++;
    }
    res.json({ success: true, data: { created } });
  } catch (err) { next(err); }
});

// Heartbeats
router.get('/monitors/:id/heartbeats', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const range = (req.query.range as string) || '24h';
    let minutes = 1440;
    if (range === '1h') minutes = 60;
    else if (range === '7d') minutes = 10080;
    else if (range === '30d') minutes = 43200;
    const since = new Date(Date.now() - minutes * 60 * 1000);
    const rows = await db('uptime_heartbeats').where({ monitor_id: id }).where('timestamp', '>', since).orderBy('timestamp', 'desc').limit(500);
    res.json({ success: true, data: rows.map(r => ({ id: r.id, monitorId: r.monitor_id, status: r.status, responseTimeMs: r.response_time_ms, statusCode: r.status_code, message: r.message, timestamp: r.timestamp })) });
  } catch (err) { next(err); }
});

// Status pages CRUD
router.get('/pages', async (_req, res, next) => {
  try {
    const pages = await db('status_pages').orderBy('id');
    res.json({ success: true, data: pages.map(p => ({ id: p.id, name: p.name, slug: p.slug, isPublic: p.is_public, customCss: p.custom_css, monitorIds: p.monitor_ids, createdAt: p.created_at, updatedAt: p.updated_at })) });
  } catch (err) { next(err); }
});

router.post('/pages', async (req, res, next) => {
  try {
    const { name, slug, isPublic, customCss, monitorIds } = req.body;
    if (!name || !slug) throw new AppError(400, 'Name and slug required');
    const [row] = await db('status_pages').insert({ name, slug, is_public: isPublic !== false, custom_css: customCss || null, monitor_ids: JSON.stringify(monitorIds || []) }).returning('*');
    res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

router.delete('/pages/:id', async (req, res, next) => {
  try {
    await db('status_pages').where({ id: parseInt(req.params.id, 10) }).delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
