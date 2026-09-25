import path from 'node:path';
import express, { type Express } from 'express';
import { config } from './config';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { apiRouter } from './routes';
import { checkReadiness } from './services/health';
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

  // Liveness: is this process answering at all? What the container
  // healthcheck polls, and what it restarts on.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime_s: Math.round(process.uptime()) });
  });

  /*
   * Readiness: is the system actually doing its job? Answers 503 when it is
   * not, so an uptime monitor can say so — see src/services/health.ts for why
   * a queue that has quietly stopped draining is the failure worth catching.
   *
   * No session, because a monitor has no account.
   */
  app.get('/ready', (_req, res, next) => {
    checkReadiness()
      .then((readiness) => {
        res.status(readiness.status === 'ready' ? 200 : 503)
          .set('Cache-Control', 'no-store')
          .json(readiness);
      })
      .catch(next);
  });

  app.use(apiRouter);

  /*
   * The browser client, under /app because the API owns the root paths —
   * /customers is an endpoint, and the UI needs its own space rather than a
   * fight over it. Resolved from this file so it works the same whether the
   * process started from src/ under tsx or dist/ after a build.
   *
   * Built by Vite into client/dist, not into public/: public/ also holds
   * card-complete.html, a standalone page outside the SPA that a full
   * `emptyOutDir` build must never be able to overwrite or delete.
   */
  const publicDir = path.resolve(__dirname, '..', 'public');
  const clientDir = path.resolve(__dirname, '..', 'client', 'dist');
  // redirect:false so a bare /app is served by the route below rather than
  // bounced to /app/ first.
  app.use('/app', express.static(clientDir, { index: false, redirect: false }));

  // Client routing: anything under /app that is not a file is a screen.
  app.get(/^\/app(?:\/.*)?$/, (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });

  // Where the processor sends the customer after they have entered a card.
  // Public: they have no account here and never will.
  app.get('/card-complete', (_req, res) => {
    res.sendFile(path.join(publicDir, 'card-complete.html'));
  });

  // The customer's pay page and card page: one self-contained file, which
  // reads its token from the path and asks /portal for the rest.
  app.get(/^\/pay\/(?:card\/)?[A-Za-z0-9_-]{20,80}$/, (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(path.join(publicDir, 'pay.html'));
  });

  app.get('/', (_req, res) => res.redirect('/app'));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
