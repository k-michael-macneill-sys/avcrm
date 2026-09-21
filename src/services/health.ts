import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import { logger } from '../utils/logger';

/**
 * What an outside monitor should ask, as opposed to what the container
 * healthcheck asks.
 *
 * `/health` is liveness: is this process answering? Docker restarts the
 * container when it is not. That catches a wedged process and nothing else —
 * and it tells nobody, which is the gap this closes.
 *
 * `/ready` is the question that matters operationally: is the system doing
 * its job? The failure this exists for is the quiet one. Nothing in the
 * application sends anything directly; everything is queued and drained by
 * the scheduler. If that process dies, or its database user loses a grant, or
 * an SMTP credential is rotated, then every screen keeps working, every
 * request still returns 200, and no customer hears anything — until somebody
 * notices weeks later that no invoice went out.
 *
 * Point an uptime monitor at this and a 503 arrives the same hour.
 *
 * It answers without a session, because a monitor has no account. That is why
 * the details it returns are deliberately coarse — "unreachable", not the
 * driver's message, which can carry a host and port. The real error goes to
 * the log, where it is already behind whatever protects the machine.
 */

export type CheckStatus = 'ok' | 'failed';

export interface Check {
  status: CheckStatus;
  detail?: string;
}

export interface Readiness {
  status: 'ready' | 'degraded';
  checks: {
    database: Check;
    queue: Check;
    storage: Check;
  };
}

/**
 * How far behind the outbound queue may fall before it counts as broken.
 *
 * The worker runs every minute and drains to empty, so a healthy backlog is
 * seconds old. Twenty minutes is loose enough to survive a slow provider or a
 * restart mid-drain, and tight enough that a dead scheduler is noticed on the
 * same working day rather than the next month.
 */
const QUEUE_STALE_AFTER_MS = 20 * 60 * 1000;

async function checkDatabase(db: Knex): Promise<Check> {
  try {
    await db.raw('select 1');
    return { status: 'ok' };
  } catch (error) {
    logger.error({ err: error }, 'Readiness: database check failed');
    return { status: 'failed', detail: 'unreachable' };
  }
}

/**
 * Looks at the oldest thing still waiting rather than the size of the queue.
 * A big backlog draining steadily is fine; one message stuck for an hour means
 * nothing is draining at all.
 */
async function checkQueue(db: Knex, now: Date): Promise<Check> {
  try {
    const row = await db('message_log')
      .where({ status: 'queued' })
      .min<{ oldest: Date | null }>('created_at as oldest')
      .first();

    const oldest = row?.oldest ?? null;
    if (oldest === null) return { status: 'ok', detail: 'nothing waiting' };

    const waitingMs = now.getTime() - new Date(oldest).getTime();
    const waitingMinutes = Math.round(waitingMs / 60_000);

    if (waitingMs > QUEUE_STALE_AFTER_MS) {
      return {
        status: 'failed',
        detail:
          `the oldest queued message has been waiting ${waitingMinutes} minutes — ` +
          'the scheduler is probably not running',
      };
    }

    return { status: 'ok', detail: `oldest waiting ${waitingMinutes} minutes` };
  } catch (error) {
    logger.error({ err: error }, 'Readiness: queue check failed');
    return { status: 'failed', detail: 'could not be read' };
  }
}

/**
 * Signatures, photos and generated documents all land here. A volume that
 * failed to mount leaves the application running and every upload failing,
 * which is exactly the shape of problem this endpoint is for.
 */
async function checkStorage(): Promise<Check> {
  if (config.storage.driver !== 'local') {
    return { status: 'ok', detail: `driver ${config.storage.driver}` };
  }

  const dir = config.storage.localDir;
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    return { status: 'ok' };
  } catch (error) {
    logger.error({ err: error, dir }, 'Readiness: storage check failed');
    return { status: 'failed', detail: 'not writable' };
  }
}

export async function checkReadiness(db: Knex = defaultDb, now = new Date()): Promise<Readiness> {
  const [database, queue, storage] = await Promise.all([
    checkDatabase(db),
    checkQueue(db, now),
    checkStorage(),
  ]);

  const checks = { database, queue, storage };
  const ready = Object.values(checks).every((check) => check.status === 'ok');

  return { status: ready ? 'ready' : 'degraded', checks };
}
