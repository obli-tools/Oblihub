import { Router } from 'express';
import { stackController } from '../controllers/stack.controller';
import { requireAuth, requireRole } from '../middleware/auth';
import { requirePermission, requireStackAccess } from '../middleware/permissions';

const router = Router();

// Public (token-authenticated) webhook endpoints — MUST be declared before `router.use(requireAuth)`
// so a Critical app calling from outside a browser session can hit them. Auth is a shared secret
// header (X-Oblihub-Priority-Token) validated inside the controller.
router.post('/:id/notify-busy', stackController.notifyBusy);
router.post('/:id/notify-idle', stackController.notifyIdle);

router.use(requireAuth);

// Static-path routes must come before `/:id` so Express doesn't parse "activity" or
// "webhook-secret" as an :id parameter.
router.get('/activity', stackController.getActivity);
router.get('/webhook-secret', requireRole('admin'), stackController.getWebhookSecret);
router.post('/webhook-secret/rotate', requireRole('admin'), stackController.rotateWebhookSecret);

router.get('/', stackController.list); // Filtered by team in controller
router.get('/:id', requirePermission('stacks.view'), requireStackAccess(), stackController.getById);
router.patch('/:id', requirePermission('stacks.manage'), requireStackAccess(), stackController.update);
router.get('/:id/maintenance', requirePermission('stacks.view'), requireStackAccess(), stackController.maintenanceStatus);
router.delete('/:id', requirePermission('stacks.manage'), requireStackAccess(), stackController.delete);
router.post('/:id/check', requirePermission('stacks.check'), requireStackAccess(), stackController.check);
router.post('/:id/update', requirePermission('stacks.update'), requireStackAccess(), stackController.triggerUpdate);
router.post('/:id/restart', requirePermission('stacks.restart'), requireStackAccess(), stackController.restart);
router.get('/:id/history', requirePermission('stacks.view'), requireStackAccess(), stackController.getHistory);
router.get('/:id/resources', requirePermission('stacks.view'), requireStackAccess(), stackController.getResources);
router.put('/:id/resources', requirePermission('stacks.manage'), requireStackAccess(), stackController.setResources);
router.delete('/:id/resources', requirePermission('stacks.manage'), requireStackAccess(), stackController.clearResources);

export default router;
