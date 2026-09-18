import path from 'node:path';
import express, { type Express } from 'express';
import { config } from './config';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { apiRouter } from './routes';
import { webhooksRouter } from './routes/webhooks';

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
  /*
   * Before the JSON parser, deliberately. A webhook signature is computed
   * over the exact bytes that were sent, so the body has to reach the handler
   * as a Buffer — parsing and re-serialising it breaks the check that makes
   * an unauthenticated request from the internet trustworthy.
   */
  app.use('/webhooks', webhooksRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime_s: Math.round(process.uptime()) });
  });

  app.use(apiRouter);

  /*
   * The browser client, under /app because the API owns the root paths —
   * /customers is an endpoint, and the UI needs its own space rather than a
   * fight over it. Resolved from this file so it works the same whether the
   * process started from src/ under tsx or dist/ after a build.
   */
  const publicDir = path.resolve(__dirname, '..', 'public');
  // redirect:false so a bare /app is served by the route below rather than
  // bounced to /app/ first.
  app.use('/app', express.static(publicDir, { index: false, redirect: false }));

  // Client routing: anything under /app that is not a file is a screen.
  app.get(/^\/app(?:\/.*)?$/, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Where the processor sends the customer after they have entered a card.
  // Public: they have no account here and never will.
  app.get('/card-complete', (_req, res) => {
    res.sendFile(path.join(publicDir, 'card-complete.html'));
  });

  app.get('/', (_req, res) => res.redirect('/app'));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
