import { closeConnection } from '../db/client';
import { runColdEmailDrip } from '../services/coldEmail';
import { logger } from '../utils/logger';

/**
 * Standalone entry point for host cron, for anyone not running the
 * scheduler. The scheduler runs the same function on its own timer.
 */
if (require.main === module) {
  runColdEmailDrip()
    .then(async (summary) => {
      await closeConnection();
      logger.info(summary, 'Done');
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'Cold email drip failed');
      await closeConnection();
      process.exit(1);
    });
}
