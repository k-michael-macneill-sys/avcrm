import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Resolved from this file, not process.cwd(): the knex CLI chdirs to the
// knexfile's directory, so a cwd-relative lookup would miss the root .env.
// src/config -> repo root, and dist/config -> repo root after a build.
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  // Express `trust proxy` setting. Contracts record the IP the signature came
  // from, so behind a load balancer this has to be set or every contract is
  // stamped with the proxy's address. Accepts false, true, a hop count, or a
  // comma-separated list of trusted addresses.
  TRUST_PROXY: z.string().default('false'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: booleanish.default('false'),
  DATABASE_POOL_MIN: z.coerce.number().int().min(0).default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

  SEED_PASSWORD: z.string().min(8).default('Password123!'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  // Fail loudly at startup rather than halfway through the first request.
  throw new Error(`Invalid environment configuration:\n${details}`);
}

const env = parsed.data;

/** Express accepts a boolean, a hop count, or a list of trusted addresses. */
function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'false') return false;
  if (value === 'true') return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  db: {
    url: env.DATABASE_URL,
    ssl: env.DATABASE_SSL,
    poolMin: env.DATABASE_POOL_MIN,
    poolMax: env.DATABASE_POOL_MAX,
  },
  auth: {
    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
    bcryptRounds: env.BCRYPT_ROUNDS,
  },
  seed: {
    password: env.SEED_PASSWORD,
  },
} as const;

export type Config = typeof config;
