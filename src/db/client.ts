import path from 'node:path';
import knex, { type Knex } from 'knex';
import pg from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';
import { DirectoryMigrationSource } from './migrationSource';

/**
 * Return DATE columns as plain 'YYYY-MM-DD' strings.
 *
 * By default node-postgres turns them into JS Date objects at local midnight,
 * which drags a timezone into values that have none — a licence expiry is a
 * calendar date, not an instant. That conversion shifts the day either side of
 * UTC and quietly breaks date arithmetic. The row types in src/types/models.ts
 * declare these columns as strings, and this is what makes that true.
 *
 * NUMERIC already arrives as a string, which is why money and coordinates are
 * typed that way too.
 */
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

/**
 * Single Knex instance for the process. Imported directly by services; there is
 * no container and no repository layer — services just take `db` or use this.
 */
/**
 * Managed Postgres reached over the public internet refuses a plaintext
 * connection, and the driver reports that refusal as a connection error like
 * any other — which surfaces as a 500 on the first query and explains nothing.
 * DATABASE_SSL stays the override; this is the default for the hosts that are
 * known to require it, so a correct connection string is enough on its own.
 */
function needsSsl(url: string): boolean {
  if (config.db.ssl) return true;
  try {
    const host = new URL(url).hostname;
    return /\.(render\.com|neon\.tech|supabase\.co|railway\.app)$/.test(host);
  } catch {
    return false;
  }
}

export const knexConfig: Knex.Config = {
  client: 'pg',
  connection: {
    connectionString: config.db.url,
    // rejectUnauthorized is off because these providers terminate TLS with a
    // certificate signed by their own internal CA.
    ssl: needsSsl(config.db.url) ? { rejectUnauthorized: false } : false,
  },
  pool: { min: config.db.poolMin, max: config.db.poolMax },
  migrations: {
    tableName: 'knex_migrations',
    /*
     * Deliberately the only migration option here. Knex discards a custom
     * source if `directory` or `extension` sit beside it ("FS-related option
     * specified ... This resets migrationSource"), so the directory for
     * `migrate:make` is passed on the command line instead — see the
     * migrate:make script in package.json.
     */
    migrationSource: new DirectoryMigrationSource(path.join(__dirname, 'migrations')),
  },
  seeds: {
    directory: path.join(__dirname, 'seeds'),
    loadExtensions: ['.ts', '.js'],
  },
};

export const db = knex(knexConfig);

export async function checkConnection(): Promise<void> {
  await db.raw('select 1');
}

export async function closeConnection(): Promise<void> {
  await db.destroy();
  logger.info('Database pool closed');
}
