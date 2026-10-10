import { Router } from 'express';
import {
  appConfigService,
  envInboundSecret,
  OBLIGATE_INBOUND_SECRET_KEY,
  OBLIGATE_INBOUND_SECRET_MIN_LENGTH,
  OBLIGATE_SYNC_DISABLED_KEY_PREFIX,
} from '../services/appConfig.service';
import { requireAuth, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config';
import { logger } from '../utils/logger';
import { MAINTENANCE_CONFIG_KEY, validateGlobalMaintenance } from '@oblihub/shared';

const router = Router();
router.use(requireAuth);
router.use(requireRole('admin'));

// Keys that affect nginx config and require a proxy regenerate when changed.
const NGINX_SENSITIVE_KEYS = new Set(['default_error_page_id']);

// Secrets: never returned in clear (the mask is ignored when sent back).
const SECRET_MASK = '••••••••';
const MASKED_KEYS = new Set(['obligate_api_key', OBLIGATE_INBOUND_SECRET_KEY]);

// Read-only fact added to GET for the Obligate SSO section (the environment
// overrides the Settings value). Never written back.
const OBLIGATE_INBOUND_SECRET_ENV_KEY = 'obligate_inbound_secret_env';
const READ_ONLY_KEYS = new Set([OBLIGATE_INBOUND_SECRET_ENV_KEY]);

// Former "client id mode" setting (raw | sha256) and its read-only facts
// (…_effective, …_env): the browser-facing client_id is now always the public
// id sha256(API key). A stored row is ignored and never shown; a write asking
// for 'raw' is refused, any other value dropped.
const LEGACY_CLIENT_ID_MODE_KEY = 'obligate_client_id_mode';
const isLegacyClientIdModeKey = (key: string): boolean =>
  key === LEGACY_CLIENT_ID_MODE_KEY || key.startsWith(`${LEGACY_CLIENT_ID_MODE_KEY}_`);

router.get('/', async (_req, res, next) => {
  try {
    const all = await appConfigService.getAll();
    // Internal SSO sync state and the former client id mode: not settings
    // (the page sends back what it got)
    for (const key of Object.keys(all)) {
      if (key.startsWith(OBLIGATE_SYNC_DISABLED_KEY_PREFIX) || isLegacyClientIdModeKey(key)) delete all[key];
    }
    // Mask sensitive values
    for (const key of MASKED_KEYS) {
      if (all[key]) all[key] = SECRET_MASK;
    }
    all[OBLIGATE_INBOUND_SECRET_ENV_KEY] = envInboundSecret() ? 'true' : 'false';
    res.json({ success: true, data: all });
  } catch (err) { next(err); }
});

router.patch('/', async (req, res, next) => {
  try {
    const entries = req.body as Record<string, string | null>;
    // Validate the Obligate keys before writing anything
    const legacyMode: unknown = entries[LEGACY_CLIENT_ID_MODE_KEY];
    if (typeof legacyMode === 'string' && legacyMode.trim().toLowerCase() === 'raw') {
      throw new AppError(400, 'The raw API key can no longer be sent as the Obligate client_id (obligate_client_id_mode=raw is not supported any more): Oblihub always sends the public id sha256(API key). Reload the page and save again.');
    }
    if (OBLIGATE_INBOUND_SECRET_KEY in entries) {
      const v = entries[OBLIGATE_INBOUND_SECRET_KEY];
      if (v !== null && typeof v !== 'string') throw new AppError(400, 'obligate_inbound_secret must be a string or null');
      const trimmed = typeof v === 'string' ? v.trim() : '';
      if (v !== SECRET_MASK && trimmed.length > 0 && trimmed.length < OBLIGATE_INBOUND_SECRET_MIN_LENGTH) {
        throw new AppError(400, `obligate_inbound_secret must be at least ${OBLIGATE_INBOUND_SECRET_MIN_LENGTH} characters`);
      }
    }
    // Maintenance window: stored as normalised JSON, refused when invalid (a broken stored value is
    // ignored at read time, which would silently mean "updates at any time").
    if (MAINTENANCE_CONFIG_KEY in entries && entries[MAINTENANCE_CONFIG_KEY] != null) {
      try {
        const raw = entries[MAINTENANCE_CONFIG_KEY];
        entries[MAINTENANCE_CONFIG_KEY] = JSON.stringify(validateGlobalMaintenance(typeof raw === 'string' ? JSON.parse(raw) : raw));
      } catch (err) {
        throw new AppError(400, `maintenance_window: ${err instanceof Error ? err.message : 'invalid value'}`);
      }
    }
    let nginxAffected = false;
    const obligateAffected = Object.keys(entries).some(k => k === 'obligate_url' || k === 'obligate_api_key' || k === 'obligate_enabled');
    for (const [key, value] of Object.entries(entries)) {
      if (READ_ONLY_KEYS.has(key) || key.startsWith(OBLIGATE_SYNC_DISABLED_KEY_PREFIX) || isLegacyClientIdModeKey(key)) continue;
      // Don't overwrite a secret with its masked value
      if (MASKED_KEYS.has(key) && value === SECRET_MASK) continue;
      let stored = value;
      if (key === OBLIGATE_INBOUND_SECRET_KEY) stored = typeof value === 'string' && value.trim() ? value.trim() : null;
      await appConfigService.set(key, stored);
      if (NGINX_SENSITIVE_KEYS.has(key)) nginxAffected = true;
    }
    if (nginxAffected && config.allowNginx) {
      const { nginxService } = await import('../services/nginx.service');
      nginxService.regenerateAndReload().catch(err => logger.warn({ err }, 'Nginx regenerate after settings update failed'));
    }
    if (obligateAffected) {
      const { obligateService } = await import('../services/obligate.service');
      void obligateService.announceSelfInfo();
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
