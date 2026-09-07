import path from 'node:path';
import knex, { type Knex } from 'knex';
import pg from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

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
export const knexConfig: Knex.Config = {
  client: 'pg',
  connection: {
    connectionString: config.db.url,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
  },
  pool: { min: config.db.poolMin, max: config.db.poolMax },
  migrations: {
    directory: path.join(__dirname, 'migrations'),
    tableName: 'knex_migrations',
    extension: 'ts',
    loadExtensions: ['.ts', '.js'],
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
