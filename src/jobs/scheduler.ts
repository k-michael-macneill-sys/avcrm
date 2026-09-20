import { closeConnection } from '../db/client';
import { closeTransport } from '../services/notifications';
import { runReviewRequests } from '../services/reviews';
import { logger } from '../utils/logger';
import { runBilling } from './billing';
import { runDocumentExpiry } from './documentExpiry';
import { runMessageQueue } from './messageQueue';

/**
 * Runs the four jobs, so a deployment is `docker compose up` and nothing else.
 *
 * Cron on the host would work just as well, and is documented in the README
 * for anyone who prefers it. This exists because the alternative is a machine
 * where the application is running, everything looks healthy, and no customer
 * has been emailed for a week because one crontab line was never added.
 *
 * Three rules it keeps:
 *
 *   - A job never overlaps itself. A billing pass that takes four minutes on
 *     a slow night must not have a second one start on top of it.
 *   - A job that throws never stops the others, and never stops the process.
 *     One bad card, one unreachable gateway, is not a reason to stop sending
 *     mail.
 *   - Shutdown is graceful: on SIGTERM it stops starting new work and waits
 *     for what is running, so a deploy cannot cut a billing run in half.
 *
 * Intervals run from boot rather than at a wall-clock hour. Every job here is
 * safe to run twice — a period already invoiced is skipped, a customer inside
 * the review cooldown is not asked again, an expiry reminder already sent is
 * not resent — so a redeploy shifting the hour costs nothing. If you need
 * billing to land at 3am specifically, use host cron instead.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface ScheduledJob {
  name: string;
  everyMs: number;
  /** Staggered so a restart does not run all four at once. */
  delayMs: number;
  run: () => Promise<unknown>;
}

const JOBS: ScheduledJob[] = [
  {
    // The one that matters most: nothing reaches a customer until it runs.
    name: 'message-queue',
    everyMs: MINUTE,
    delayMs: 10_000,
    run: runMessageQueue,
  },
  {
    name: 'review-requests',
    everyMs: HOUR,
    delayMs: 30_000,
    run: () => runReviewRequests(),
  },
  {
    name: 'document-expiry',
    everyMs: 24 * HOUR,
    delayMs: 60_000,
    run: () => runDocumentExpiry(),
  },
  {
    name: 'billing',
    everyMs: 24 * HOUR,
    delayMs: 90_000,
    run: () => runBilling(),
  },
];

export interface Scheduler {
  /** Arms every job's timer. */
  start(): void;
  /**
   * Stops starting new work and waits for whatever is mid-run, so a deploy
   * cannot cut a billing pass in half. Safe to call twice.
   */
  drain(signal: string): Promise<void>;
  /** Which jobs are running right now. */
  readonly running: string[];
}

/**
 * The machinery, separated from the job list so the shutdown path can be
 * tested with a job that takes long enough to still be running when the
 * signal arrives. The real jobs finish in milliseconds, which makes the
 * interesting case impossible to hit against them.
 */
export function createScheduler(jobs: ScheduledJob[]): Scheduler {
  let stopping = false;
  /** What is mid-run, so shutdown can wait for it. */
  const inFlight = new Map<string, Promise<void>>();
  const timers: NodeJS.Timeout[] = [];

  async function tick(job: ScheduledJob): Promise<void> {
    if (stopping) return;
    if (inFlight.has(job.name)) {
      logger.warn({ job: job.name }, 'Still running from last time; skipping this turn');
      return;
    }

    const started = Date.now();
    const running = (async () => {
      try {
        const summary = await job.run();
        logger.info(
          { job: job.name, duration_ms: Date.now() - started, summary },
          'Job finished',
        );
      } catch (error) {
        // One bad card or unreachable gateway is not a reason to stop the
        // others, or the process.
        logger.error(
          { job: job.name, duration_ms: Date.now() - started, err: error },
          'Job failed',
        );
      }
    })();

    inFlight.set(job.name, running);
    await running;
    inFlight.delete(job.name);
  }

  function schedule(job: ScheduledJob): void {
    const start = setTimeout(() => {
      void tick(job);
      const repeat = setInterval(() => void tick(job), job.everyMs);
      timers.push(repeat);
    }, job.delayMs);

    timers.push(start);
  }

  return {
    start(): void {
      for (const job of jobs) schedule(job);
      logger.info(
        { jobs: jobs.map((j) => ({ name: j.name, every_ms: j.everyMs })) },
        'Scheduler started',
      );
    },

    async drain(signal: string): Promise<void> {
      if (stopping) return;
      stopping = true;
      logger.info({ signal, waiting_for: [...inFlight.keys()] }, 'Scheduler stopping');

      for (const timer of timers) clearTimeout(timer);
      // Let whatever is mid-run finish rather than cutting a billing pass in half.
      await Promise.allSettled([...inFlight.values()]);
    },

    get running(): string[] {
      return [...inFlight.keys()];
    },
  };
}

function main(): void {
  const scheduler = createScheduler(JOBS);
  scheduler.start();

  const stop = (signal: string): void => {
    void (async () => {
      await scheduler.drain(signal);
      await closeTransport();
      await closeConnection();
      logger.info('Scheduler stopped');
      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

// Only when run as the process entry point, so importing this for a test does
// not arm four real timers against the database.
if (require.main === module) {
  main();
}
