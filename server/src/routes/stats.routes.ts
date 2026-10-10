import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// Get historical stats for a container
router.get('/:dockerId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dockerId } = req.params;
    const range = (req.query.range as string) || '1h';

    let minutes = 60;
    if (range === '6h') minutes = 360;
    else if (range === '24h') minutes = 1440;
    else if (range === '7d') minutes = 10080;

    const since = new Date(Date.now() - minutes * 60 * 1000);

    const rows = await db('container_stats')
      .where({ container_docker_id: dockerId })
      .where('timestamp', '>', since)
      .orderBy('timestamp', 'asc')
      .select('cpu_percent', 'memory_usage', 'memory_limit', 'network_rx', 'network_tx', 'timestamp');

    const data = rows.map(r => ({
      cpuPercent: r.cpu_percent,
      memoryUsage: r.memory_usage,
      memoryLimit: r.memory_limit,
      memoryPercent: Math.round((r.memory_usage / r.memory_limit) * 10000) / 100,
      networkRx: r.network_rx,
      networkTx: r.network_tx,
      timestamp: r.timestamp,
    }));

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// Get bulk history for ALL containers over a recent time window.
// Used by the dashboard to pre-populate sparklines on login instead of waiting for polling to accrue data.
router.get('/bulk/recent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const minutes = Math.max(1, Math.min(120, parseInt((req.query.minutes as string) || '15', 10) || 15));
    const since = new Date(Date.now() - minutes * 60 * 1000);

    const rows = await db('container_stats')
      .where('timestamp', '>', since)
      .orderBy('timestamp', 'asc')
      .select('container_docker_id', 'container_name', 'cpu_percent', 'memory_usage', 'memory_limit', 'network_rx', 'network_tx', 'timestamp');

    const data = rows.map(r => ({
      dockerId: r.container_docker_id,
      containerName: r.container_name,
      cpuPercent: r.cpu_percent,
      memoryUsage: r.memory_usage,
      memoryLimit: r.memory_limit,
      memoryPercent: Math.round((r.memory_usage / r.memory_limit) * 10000) / 100,
      networkRx: r.network_rx,
      networkTx: r.network_tx,
      timestamp: r.timestamp,
    }));

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// Get latest stats for all containers (snapshot)
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Get the most recent stat for each container
    const rows = await db('container_stats')
      .distinctOn('container_docker_id')
      .orderBy('container_docker_id')
      .orderBy('timestamp', 'desc')
      .select('*');

    const data = rows.map(r => ({
      dockerId: r.container_docker_id,
      containerName: r.container_name,
      cpuPercent: r.cpu_percent,
      memoryUsage: r.memory_usage,
      memoryLimit: r.memory_limit,
      memoryPercent: Math.round((r.memory_usage / r.memory_limit) * 10000) / 100,
      networkRx: r.network_rx,
      networkTx: r.network_tx,
      timestamp: r.timestamp,
    }));

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

export default router;
