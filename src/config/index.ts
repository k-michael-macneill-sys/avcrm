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

  // Where the customer-facing links in outbound messages point.
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  // Where a happy customer is sent to leave a public review.
  GOOGLE_REVIEW_URL: z.string().url().default('https://g.page/r/example/review'),
  // How many times the queue worker retries a message before giving up.
  MESSAGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  // Outbound mail. `log` writes to the log and is the default so a dev box
  // and the test suite never need a mail server; `smtp` is a real transport,
  // and every provider worth using (Postmark, SES, Mailgun, SendGrid) speaks
  // it, so one driver covers all of them.
  MAIL_DRIVER: z.enum(['log', 'smtp']).default('log'),
  MAIL_FROM: z.string().trim().min(3).optional(),
  MAIL_REPLY_TO: z.string().trim().min(3).optional(),
  /**
   * Sends every message here instead of to the customer. A staging database
   * is a copy of production, real addresses and all, so this is the switch
   * that stops it mailing them.
   */
  MAIL_REDIRECT_TO: z.string().trim().min(3).optional(),

  SMTP_HOST: z.string().trim().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: booleanish.default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  // Taking money. `manual` records what a processor or a rep with a cheque
  // says happened, which is what an install without Stripe credentials can
  // honestly do. `stripe` actually charges.
  PAYMENT_GATEWAY: z.enum(['manual', 'stripe']).default('manual'),
  PAYMENT_CURRENCY: z.string().trim().length(3).toLowerCase().default('cad'),
  STRIPE_SECRET_KEY: z.string().trim().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().trim().min(1).optional(),
  /**
   * Points the SDK somewhere other than api.stripe.com — at stripe-mock, or
   * at the stand-in scripts/stripe-fake.js runs. Leave unset for real Stripe.
   */
  STRIPE_API_HOST: z.string().trim().min(1).optional(),
  STRIPE_API_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  STRIPE_API_PROTOCOL: z.enum(['http', 'https']).default('https'),

  // Object storage. `local` writes to disk and is the default because it
  // needs no credentials and works offline; `s3` is the seam for a bucket.
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  // How long an issued upload target stays usable.
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(900),

  SEED_PASSWORD: z.string().min(8).default('Password123!'),
});

/**
 * A real transport needs somewhere to send from and somewhere to send
 * through. Failing at startup beats discovering it when the first invoice
 * goes out.
 */
const checkedSchema = envSchema.superRefine((env, ctx) => {
  if (env.MAIL_DRIVER !== 'smtp') return;

  if (!env.SMTP_HOST) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMTP_HOST'],
      message: 'is required when MAIL_DRIVER=smtp',
    });
  }
  if (!env.MAIL_FROM) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAIL_FROM'],
      message: 'is required when MAIL_DRIVER=smtp',
    });
  }
}).superRefine((env, ctx) => {
  if (env.PAYMENT_GATEWAY !== 'stripe') return;

  // Without the webhook secret we would take money and never hear how it
  // went, which is worse than not taking it.
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const) {
    if (!env[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'is required when PAYMENT_GATEWAY=stripe',
      });
    }
  }
});

const parsed = checkedSchema.safeParse(process.env);

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
  storage: {
    driver: env.STORAGE_DRIVER,
    localDir: path.resolve(__dirname, '..', '..', env.STORAGE_LOCAL_DIR),
    uploadTtlSeconds: env.UPLOAD_URL_TTL_SECONDS,
  },
  payments: {
    gateway: env.PAYMENT_GATEWAY,
    currency: env.PAYMENT_CURRENCY,
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY ?? '',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
      host: env.STRIPE_API_HOST ?? null,
      port: env.STRIPE_API_PORT ?? null,
      protocol: env.STRIPE_API_PROTOCOL,
    },
  },
  mail: {
    driver: env.MAIL_DRIVER,
    from: env.MAIL_FROM ?? 'avcrm@localhost',
    replyTo: env.MAIL_REPLY_TO ?? null,
    redirectTo: env.MAIL_REDIRECT_TO ?? null,
    smtp: {
      host: env.SMTP_HOST ?? 'localhost',
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER ?? null,
      password: env.SMTP_PASSWORD ?? null,
    },
  },
  messaging: {
    appBaseUrl: env.APP_BASE_URL.replace(/\/+$/, ''),
    googleReviewUrl: env.GOOGLE_REVIEW_URL,
    maxAttempts: env.MESSAGE_MAX_ATTEMPTS,
  },
  seed: {
    password: env.SEED_PASSWORD,
  },
} as const;

export type Config = typeof config;
