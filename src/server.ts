import { config } from './config';
import { checkConnection, closeConnection, db } from './db/client';
import { runMigrations } from './db/migrate';
import { seed } from './db/seeds/001_sample_data';
import { createApp } from './app';
import { sweepRateLimits } from './middleware/rateLimit';
import { logger } from './utils/logger';

/**
 * A database with no users in it cannot be signed into, and every route that
 * would create the first one needs a session it is impossible to get. On a
 * host with no shell there is nothing to run by hand either, so the first boot
 * against an empty database installs the app configuration and one corporate
 * account, and with it a way in. Branches, crew and customers are not seeded:
 * they are the operator's own, added through the app after the first sign-in.
 *
 * Only ever on an empty database: the seed wipes the tables it owns, and the
 * guard inside it refuses outright once a single user exists.
 */
async function seedIfEmpty(): Promise<void> {
  const existingUser = await db('users').first('id');
  if (existingUser) return;

  logger.warn('No users found — installing the first login so this install can be signed into');
  await seed(db);
  logger.warn('Installed. Sign in as corporate@avcrm.test and change the password.');
}

async function main(): Promise<void> {
  await checkConnection();
  logger.info('Database connection OK');

  await runMigrations();
  await seedIfEmpty();

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
