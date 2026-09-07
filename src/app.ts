import express, { type Express } from 'express';
import { config } from './config';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { apiRouter } from './routes';

/**
 * Builds the Express app. Separated from server.ts so tests can import the app
 * without binding a port.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Contracts store the IP the signature came from, so req.ip has to be the
  // real client. Left off by default: trusting a header nobody set is worse
  // than recording the proxy.
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime_s: Math.round(process.uptime()) });
  });

  app.use(apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
