import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import { sshKeyController, workflowTargetController, workflowController } from '../controllers/automation.controller';

const router = Router();
router.use(requireAuth);

// ── SSH keys ──
router.get('/ssh-keys',           requirePermission('ssh_keys.view'),   sshKeyController.list);
router.get('/ssh-keys/:id',       requirePermission('ssh_keys.view'),   sshKeyController.get);
router.post('/ssh-keys',          requirePermission('ssh_keys.create'), sshKeyController.create);
router.patch('/ssh-keys/:id',     requirePermission('ssh_keys.create'), sshKeyController.update);
router.delete('/ssh-keys/:id',    requirePermission('ssh_keys.delete'), sshKeyController.delete);

// ── Workflow targets ──
router.get('/targets',            requirePermission('targets.view'),    workflowTargetController.list);
router.get('/targets/:id',        requirePermission('targets.view'),    workflowTargetController.get);
router.post('/targets',           requirePermission('targets.manage'),  workflowTargetController.create);
router.patch('/targets/:id',      requirePermission('targets.manage'),  workflowTargetController.update);
router.delete('/targets/:id',     requirePermission('targets.manage'),  workflowTargetController.delete);

// ── Workflows ──
router.get('/workflows',              requirePermission('workflows.view'),    workflowController.list);
router.get('/workflows/:id',          requirePermission('workflows.view'),    workflowController.get);
router.post('/workflows',             requirePermission('workflows.create'),  workflowController.create);
router.patch('/workflows/:id',        requirePermission('workflows.edit'),    workflowController.update);
router.delete('/workflows/:id',       requirePermission('workflows.delete'),  workflowController.delete);
router.post('/workflows/:id/run',     requirePermission('workflows.execute'), workflowController.runNow);
router.get('/workflows/:id/runs',     requirePermission('workflows.view'),    workflowController.listRuns);

export default router;
