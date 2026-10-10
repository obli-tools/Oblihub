import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import { trafficController } from '../controllers/traffic.controller';

const router = Router();
router.use(requireAuth);

router.get('/proxy-host/:id/timeseries',     requirePermission('proxy.view'), trafficController.hostTimeSeries);
router.get('/proxy-host/:id/top-ips',        requirePermission('proxy.view'), trafficController.hostTopIps);
router.get('/proxy-host/:id/top-uris',       requirePermission('proxy.view'), trafficController.hostTopUris);
router.get('/proxy-host/:id/error-summary',  requirePermission('proxy.view'), trafficController.hostErrorSummary);
router.get('/proxy-host/:id/error-samples',  requirePermission('proxy.view'), trafficController.hostErrorSamples);
router.get('/proxy-host/:id/slow-samples',   requirePermission('proxy.view'), trafficController.hostSlowSamples);
router.get('/summary',                       requirePermission('proxy.view'), trafficController.hostsSummary);
router.get('/team-cumul',                    requirePermission('proxy.view'), trafficController.teamCumul);
router.get('/geo',                           requirePermission('proxy.view'), trafficController.geoAggregated);
router.get('/top-ips',                       requirePermission('proxy.view'), trafficController.topIpsGlobal);
router.get('/top-uris',                      requirePermission('proxy.view'), trafficController.topUrisGlobal);
router.get('/percentiles',                   requirePermission('proxy.view'), trafficController.percentileSummary);

export default router;
