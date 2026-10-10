import { Router } from 'express';
import { tailscaleController } from '../controllers/tailscale.controller';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();
router.use(requireAuth);
router.use(requireRole('admin'));

router.get('/status', tailscaleController.status);
router.get('/peers', tailscaleController.peerSuggestions);
router.post('/install-command', tailscaleController.installCommand);
router.get('/resolve-upstream/:containerId', tailscaleController.resolveContainerUpstream);

export default router;
