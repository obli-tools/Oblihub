import rateLimit from 'express-rate-limit';

export const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !!req.session?.userId || req.path === '/health' || req.path === '/api/auth/me',
});

export const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}-${(req.body as { username?: string })?.username || ''}`,
});
