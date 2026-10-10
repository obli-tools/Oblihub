import { Router } from 'express';
import { engineController } from '../controllers/engine.controller';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();
router.use(requireAuth);
// Before the admin gate: non-admins need engine names for badges and tabs. The payload carries no
// host and no secret.
router.get('/summary', engineController.listSummary);
router.use(requireRole('admin'));

router.get('/', engineController.list);
router.post('/', engineController.create);
router.post('/test', engineController.testTransient);
router.post('/generate-ssh-key', engineController.generateSshKey);
router.get('/:id', engineController.getById);
router.patch('/:id', engineController.update);
router.delete('/:id', engineController.delete);
router.post('/:id/test', engineController.testExisting);
router.post('/:id/set-default', engineController.setDefault);

export default router;
