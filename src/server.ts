import { config } from './config';
import { checkConnection, closeConnection, db } from './db/client';
import { installAppConfig } from './db/appConfig';
import { runMigrations } from './db/migrate';
import { seed } from './db/seeds/001_sample_data';
import { createApp } from './app';
import { startScheduler } from './jobs/scheduler';
import { closeTransport } from './services/notifications';
import { sweepRateLimits } from './middleware/rateLimit';
import { retirePublishedPassword } from './services/auth';
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
  if (existingUser) {
    // New message templates and the like, added without touching anything
    // already there. The build's seed step does this too, but a deploy that
    // only starts the server (the Docker image) never runs it, and a missing
    // template is an error the moment something tries to send it.
    const installed = await installAppConfig(db);
    if (installed.message_templates) {
      logger.info({ message_templates: installed.message_templates }, 'Installed missing message templates');
    }
    // An install made before the published default was refused may still
    // have it; this swaps it for SEED_PASSWORD, or says how to.
    await retirePublishedPassword(db);
    return;
  }

  logger.warn('No users found — installing the first login so this install can be signed into');
  await seed(db);
  logger.warn('Installed. Sign in as ADMIN with SEED_PASSWORD, then change it under your name in the menu.');
}

async function main(): Promise<void> {
  await checkConnection();
  logger.info('Database connection OK');

  await runMigrations();
  await seedIfEmpty();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`API listening on http://localhost:${config.port} (${config.env})`);
    logger.info(`Customer links (card, pay, review) point at ${config.messaging.appBaseUrl}`);
    if (config.isProduction && /\/\/(localhost|127\.0\.0\.1)\b/.test(config.messaging.appBaseUrl)) {
      logger.error('APP_BASE_URL is not set, so customer links point at localhost and will not open. Set it to this site\'s public https address.');
    }
  });

  // Nothing queued reaches a customer until the message queue runs, so a host
  // with only a web process runs the jobs here. See RUN_SCHEDULER.
  const scheduler = config.jobs.runInWeb ? startScheduler() : null;

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      // Let a billing pass that is mid-run finish before the pool closes.
      await scheduler?.drain(signal);
      await closeTransport();
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
