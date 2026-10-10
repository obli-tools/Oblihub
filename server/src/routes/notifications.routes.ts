import { Router } from 'express';
import { notificationController } from '../controllers/notification.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

router.get('/channels', notificationController.listChannels);
router.post('/channels', notificationController.createChannel);
router.patch('/channels/:id', notificationController.updateChannel);
router.delete('/channels/:id', notificationController.deleteChannel);
router.post('/channels/:id/test', notificationController.testChannel);
router.get('/plugins', notificationController.listPlugins);
router.get('/bindings', notificationController.getBindings);
router.post('/bindings', notificationController.addBinding);
router.delete('/bindings', notificationController.removeBinding);

export default router;
