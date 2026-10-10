import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { proxyController } from '../controllers/proxy.controller';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import { config } from '../config';

const router = Router();

router.use(requireAuth);
router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!config.allowNginx) {
    res.status(403).json({ success: false, error: 'Nginx proxy is disabled. Set ALLOW_NGINX=true to enable.' });
    return;
  }
  next();
});

// Proxy hosts
router.get('/hosts', requirePermission('proxy.view'), proxyController.listProxyHosts);
router.get('/hosts/by-stack/:stackId', requirePermission('proxy.view'), proxyController.getProxyHostsByStack);
router.post('/hosts/quick-setup', requirePermission('proxy.manage'), proxyController.quickSetupProxyHost);
router.get('/hosts/:id', requirePermission('proxy.view'), proxyController.getProxyHost);
router.post('/hosts', requirePermission('proxy.manage'), proxyController.createProxyHost);
router.put('/hosts/:id', requirePermission('proxy.manage'), proxyController.updateProxyHost);
router.delete('/hosts/:id', requirePermission('proxy.manage'), proxyController.deleteProxyHost);
router.post('/hosts/:id/toggle', requirePermission('proxy.manage'), proxyController.toggleProxyHost);
router.post('/restore-networks', requirePermission('proxy.manage'), proxyController.restoreProxyNetworks);

// Certificates
router.get('/certificates', requirePermission('proxy.certificates'), proxyController.listCertificates);
router.post('/certificates', requirePermission('proxy.certificates'), proxyController.createCertificate);
router.post('/certificates/:id/upload', requirePermission('proxy.certificates'), proxyController.uploadCertificate);
router.delete('/certificates/:id', requirePermission('proxy.certificates'), proxyController.deleteCertificate);
router.post('/certificates/:id/retry', requirePermission('proxy.certificates'), proxyController.retryCertificate);

// Redirections
router.get('/redirections', requirePermission('proxy.manage'), proxyController.listRedirections);
router.post('/redirections', requirePermission('proxy.manage'), proxyController.createRedirection);
router.put('/redirections/:id', requirePermission('proxy.manage'), proxyController.updateRedirection);
router.delete('/redirections/:id', requirePermission('proxy.manage'), proxyController.deleteRedirection);

// Streams
router.get('/streams', requirePermission('proxy.manage'), proxyController.listStreams);
router.post('/streams', requirePermission('proxy.manage'), proxyController.createStream);
router.put('/streams/:id', requirePermission('proxy.manage'), proxyController.updateStream);
router.delete('/streams/:id', requirePermission('proxy.manage'), proxyController.deleteStream);

// Dead hosts
router.get('/dead-hosts', requirePermission('proxy.manage'), proxyController.listDeadHosts);
router.post('/dead-hosts', requirePermission('proxy.manage'), proxyController.createDeadHost);
router.delete('/dead-hosts/:id', requirePermission('proxy.manage'), proxyController.deleteDeadHost);

// Access lists
router.get('/access-lists', requirePermission('proxy.access_lists'), proxyController.listAccessLists);
router.post('/access-lists', requirePermission('proxy.access_lists'), proxyController.createAccessList);
router.put('/access-lists/:id', requirePermission('proxy.access_lists'), proxyController.updateAccessList);
router.delete('/access-lists/:id', requirePermission('proxy.access_lists'), proxyController.deleteAccessList);
router.post('/access-lists/:id/clients', requirePermission('proxy.access_lists'), proxyController.addAccessListClient);
router.put('/access-lists/:id/clients/:clientId', requirePermission('proxy.access_lists'), proxyController.updateAccessListClient);
router.delete('/access-lists/:id/clients/:clientId', requirePermission('proxy.access_lists'), proxyController.removeAccessListClient);
router.post('/access-lists/:id/auth', requirePermission('proxy.access_lists'), proxyController.addAccessListAuth);
router.put('/access-lists/:id/auth/:authId', requirePermission('proxy.access_lists'), proxyController.updateAccessListAuth);
router.delete('/access-lists/:id/auth/:authId', requirePermission('proxy.access_lists'), proxyController.removeAccessListAuth);

// Custom pages
router.get('/custom-pages', requirePermission('proxy.custom_pages'), proxyController.listCustomPages);
router.post('/custom-pages', requirePermission('proxy.custom_pages'), proxyController.createCustomPage);
router.put('/custom-pages/:id', requirePermission('proxy.custom_pages'), proxyController.updateCustomPage);
router.delete('/custom-pages/:id', requirePermission('proxy.custom_pages'), proxyController.deleteCustomPage);

// Status
router.get('/status', proxyController.getProxyStatus);

// Nginx control
router.post('/nginx/reload', requirePermission('proxy.nginx'), proxyController.reloadNginx);
router.post('/nginx/test', requirePermission('proxy.nginx'), proxyController.testNginx);

export default router;
