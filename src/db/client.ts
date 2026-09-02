import path from 'node:path';
import knex, { type Knex } from 'knex';
import { config } from '../config';
import { logger } from '../utils/logger';

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
