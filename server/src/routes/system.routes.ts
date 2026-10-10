import { Router } from 'express';
import { stackController } from '../controllers/stack.controller';
import { requireAuth } from '../middleware/auth';
import { hostStatsService } from '../services/hostStats.service';
import { engineFactsService } from '../services/engineFacts.service';
import { engineService } from '../services/engine.service';
import { logger } from '../utils/logger';

const router = Router();

router.use(requireAuth);

/** The local engine row (Oblihub's own socket), or null when there is none or it cannot be read. */
async function localEngineRef(): Promise<{ id: number; name: string } | null> {
  try {
    const id = await engineFactsService.resolveLocalEngineId();
    if (id == null) return null;
    const engine = await engineService.getById(id);
    return engine ? { id: engine.id, name: engine.name } : null;
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'host-stats: local engine lookup failed');
    return null;
  }
}

router.get('/', stackController.systemInfo);
router.get('/features', stackController.systemFeatures);
router.post('/discovery/refresh', stackController.refreshDiscovery);
// The header indicator stays hub-local: these numbers are measured inside Oblihub's own
// container. `localEngine` lets the UI label them "<name> (hub)" so nobody mistakes them for a
// remote engine's load.
router.get('/host-stats', async (_req, res, next) => {
  try {
    const [stats, localEngine] = await Promise.all([hostStatsService.get(), localEngineRef()]);
    res.json({ success: true, data: { ...stats, localEngine } });
  } catch (err) { next(err); }
});

export default router;
