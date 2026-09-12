import { db } from './client';
import { logger } from '../utils/logger';

/**
 * The one way migrations are run, from a checkout or from the image.
 *
 * A script rather than the knex CLI because of the step below: an existing
 * database recorded its migrations with a file extension, and that has to be
 * put right before Knex compares the two lists and refuses to do anything.
 *
 *   npm run migrate                  # from source, via tsx
 *   node dist/db/migrate.js          # from the built image
 */

/**
 * Drops the `.ts` or `.js` from names recorded before migrations were named
 * by what they are. Idempotent, and a no-op on a database that never had
 * them — which is every new one.
 *
 * Without this, upgrading past that change leaves a database that cannot be
 * migrated again, explaining itself only as "the migration directory is
 * corrupt".
 */
async function normalizeRecordedNames(): Promise<void> {
  const exists = await db.raw("select to_regclass('knex_migrations') as table");
  if (!exists.rows[0]?.table) return;

  const updated = await db('knex_migrations')
    .whereRaw("name ~ '\\.(ts|js)$'")
    .update({ name: db.raw("regexp_replace(name, '\\.(ts|js)$', '')") });

  if (updated > 0) {
    logger.info({ updated }, 'Migration names normalized: dropped the file extension');
  }
}

async function main(): Promise<void> {
  await normalizeRecordedNames();

  const [batch, applied] = (await db.migrate.latest()) as [number, string[]];

  if (applied.length === 0) {
    logger.info('Already up to date');
  } else {
    logger.info({ batch, applied }, `Ran ${applied.length} migration(s)`);
  }
}

main()
  .then(async () => {
    await db.destroy();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    logger.error({ err }, 'Migration failed');
    await db.destroy();
    process.exit(1);
  });
