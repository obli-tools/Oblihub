import { Router } from 'express';
import { azureAuthController } from '../controllers/azureAuth.controller';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';

const router = Router();

router.use(requireAuth);

router.get('/', requirePermission('proxy.view'), azureAuthController.list);
router.post('/', requirePermission('proxy.manage'), azureAuthController.create);
router.put('/:id', requirePermission('proxy.manage'), azureAuthController.update);
router.delete('/:id', requirePermission('proxy.manage'), azureAuthController.delete);
router.post('/:id/redeploy', requirePermission('proxy.manage'), azureAuthController.redeploy);
router.get('/:id/callback-urls', requirePermission('proxy.view'), azureAuthController.callbackUrls);

export default router;
