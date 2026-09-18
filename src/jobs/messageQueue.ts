import { closeConnection } from '../db/client';
import { sendQueued, type QueueSummary } from '../services/messages';
import { closeTransport } from '../services/notifications';
import { logger } from '../utils/logger';

/**
 * The outbound worker. Drains message_log until there is nothing left to
 * claim, then exits.
 *
 * Run it from cron every minute, or wrap it in a loop as a long-lived
 * process — the claim uses FOR UPDATE SKIP LOCKED and a lease, so several
 * copies can run at once without sending anything twice.
 *
 *   npm run job:message-queue
 */
export async function runMessageQueue(): Promise<QueueSummary> {
  const total: QueueSummary = {
    claimed: 0,
    sent: 0,
    failed: 0,
    retrying: 0,
    rejected: 0,
  };

  // Keep going while a pass still finds work, so one run empties a backlog
  // rather than trickling a batch per minute.
  for (;;) {
    const pass = await sendQueued();
    total.claimed += pass.claimed;
    total.sent += pass.sent;
    total.failed += pass.failed;
    total.retrying += pass.retrying;
    total.rejected += pass.rejected;

    if (pass.claimed === 0) break;
  }

  logger.info(total, 'Message queue drained');
  return total;
}

// Entry point when run as a script rather than imported.
if (require.main === module) {
  runMessageQueue()
    .then(async (summary) => {
      // Let the pooled SMTP connection go, or the process hangs on it.
      await closeTransport();
      await closeConnection();
      logger.info(summary, 'Done');
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'Message queue run failed');
      await closeTransport();
      await closeConnection();
      process.exit(1);
    });
}
