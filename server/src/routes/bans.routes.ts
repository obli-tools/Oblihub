import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import { banController, honeypotController, obliguardController } from '../controllers/ban.controller';

const router = Router();
router.use(requireAuth);

// Reuse proxy.manage for admin actions on bans (unban + manual ban). proxy.view suffices for
// read-only list — same principle as the /bans page: on-call responders should see the ban
// history without needing full proxy perms.
router.get('/bans',                     requirePermission('proxy.view'),   banController.list);
router.post('/bans',                    requirePermission('proxy.manage'), banController.createManual);
router.delete('/bans/:id',              requirePermission('proxy.manage'), banController.unban);

router.get('/honeypot/defaults',        requirePermission('proxy.view'),   honeypotController.getDefaults);
router.get('/honeypot/:hostId/paths',   requirePermission('proxy.view'),   honeypotController.listForHost);
router.put('/honeypot/:hostId/paths',   requirePermission('proxy.manage'), honeypotController.replaceAll);
router.post('/honeypot/:hostId/preset', requirePermission('proxy.manage'), honeypotController.addPreset);

router.get('/obliguard/status',         requirePermission('proxy.view'),   obliguardController.status);
router.post('/obliguard/test',          requirePermission('proxy.manage'), obliguardController.testPing);

export default router;
