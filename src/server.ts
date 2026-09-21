import { config } from './config';
import { checkConnection, closeConnection } from './db/client';
import { createApp } from './app';
import { sweepRateLimits } from './middleware/rateLimit';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  await checkConnection();
  logger.info('Database connection OK');

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`API listening on http://localhost:${config.port} (${config.env})`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await closeConnection();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  // The rate limiter keeps a bucket per address and per account it has seen.
  // Without this the map grows for the life of the process; unref'd so it
  // never holds shutdown open.
  const window = config.auth.rateLimit.windowMs;
  setInterval(() => sweepRateLimits(window), window).unref();

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
