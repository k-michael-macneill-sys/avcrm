import { closeConnection } from '../db/client';
import { runReviewRequests, type ReviewRunSummary } from '../services/reviews';
import { logger } from '../utils/logger';

/**
 * Asks for a rating a day after each finished visit, capped at one ask per
 * customer per 90 days. Queues the messages; the queue worker delivers them.
 *
 *   npm run job:review-requests
 *
 * Run it daily. Missing a night is not a problem — the window looks a week
 * back, so the next run catches up.
 */
if (require.main === module) {
  runReviewRequests()
    .then(async (summary: ReviewRunSummary) => {
      await closeConnection();
      logger.info(summary, 'Done');
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'Review request run failed');
      await closeConnection();
      process.exit(1);
    });
}
