import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { config } from './config';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimiter';
import { routes } from './routes';
import obligateCallbackRoutes from './routes/obligateCallback.routes';
import wakeInternalRoutes from './routes/wakeInternal.routes';
import { obligateService } from './services/obligate.service';

const PgSession = connectPgSimple(session);

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: ["'self'", "wss:", "ws:"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: { maxAge: 31536000, includeSubDomains: true },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    }),
  );
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  app.use(session({
    store: new PgSession({ conString: config.databaseUrl, createTableIfMissing: true }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
    },
  }));

  app.use(apiLimiter);

  app.get('/health', async (_req, res) => {
    try {
      const { db } = await import('./db');
      await db.raw('SELECT 1');
      res.json({ status: 'ok', app: 'oblihub' });
    } catch {
      res.status(503).json({ status: 'error', app: 'oblihub', error: 'database unreachable' });
    }
  });

  // Obligate SSO routes — browser redirects at /auth, API calls at /api/auth
  app.use('/auth', obligateCallbackRoutes);
  app.use('/api/auth', obligateCallbackRoutes);

  app.use('/api', routes);
  // Internal wake endpoint — only callable from the nginx proxy (shared-secret auth inside the router)
  app.use('/__oblihub_internal', wakeInternalRoutes);
  app.use(errorHandler);

  return app;
}
