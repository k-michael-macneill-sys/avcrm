import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { rateLimit, type RateLimitRule } from '../middleware/rateLimit';
import { createUser, findUserById, login } from '../services/auth';
import { asyncHandler } from '../utils/async';
import { forbidden, unauthorized } from '../utils/errors';
import { parse } from '../utils/validate';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(200),
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(40).nullable().default(null),
  branch_id: z.string().uuid(),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(200),
});

const { windowMs, maxPerEmail, maxPerIp } = config.auth.rateLimit;

/**
 * req.ip, not a header read directly: behind the proxy it is the customer's
 * address and in front of one it is the socket's, which is the same decision
 * `signed_ip` on a contract rests on. See `trust proxy` in src/app.ts.
 */
const byIp = (name: string, max: number, message: string): RateLimitRule => ({
  name,
  windowMs,
  max,
  key: (req) => req.ip ?? null,
  message,
});

/**
 * Lower-cased so `Harold@…` and `harold@…` share one budget rather than
 * handing out a fresh one per spelling.
 */
const byEmail: RateLimitRule = {
  name: 'login-email',
  windowMs,
  max: maxPerEmail,
  key: (req) => {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    return typeof email === 'string' && email.trim() !== ''
      ? email.trim().toLowerCase()
      : null;
  },
  message: 'Too many failed sign-in attempts for that account. Try again shortly.',
};

// max 0 switches a rule off, which is what the test harness does so a suite
// of deliberate failures does not lock itself out.
const rules: RateLimitRule[] = [];
if (maxPerIp > 0) {
  rules.push(byIp('login-ip', maxPerIp, 'Too many sign-in attempts. Try again shortly.'));
}
if (maxPerEmail > 0) rules.push(byEmail);

const loginLimiter = rateLimit(...rules);

// Registration is open so a branch can onboard operators, which also means
// anyone can fill the users table from a script.
const registerLimiter =
  maxPerIp > 0
    ? rateLimit({
        ...byIp('register-ip', maxPerIp, 'Too many sign-ups from here. Try again shortly.'),
        // A successful sign-up is exactly what is being abused, so it counts.
        forgiveSuccess: false,
      })
    : rateLimit();

/**
 * Self-signup, off by default.
 *
 * It only ever produced a pending operator — the role is set on the backend
 * and never read from the request, so it could not mint a corporate account —
 * but an open endpoint that creates rows is still not something to leave
 * facing the internet on a system holding customers' names and addresses.
 * Corporate adds staff through `POST /users`, which is how a real branch
 * onboards somebody anyway: the person's account exists before they arrive.
 *
 * Set ALLOW_SELF_REGISTRATION=true to open it again.
 */
authRouter.post(
  '/register',
  registerLimiter,
  optionalAuth,
  asyncHandler(async (req, res) => {
    if (!config.auth.allowSelfRegistration) {
      throw forbidden('Accounts are created by an administrator, not signed up for');
    }

    const body = parse(registerSchema, req.body);

    const user = await createUser({
      email: body.email,
      password: body.password,
      first_name: body.first_name,
      last_name: body.last_name,
      phone: body.phone,
      role: 'operator',
      branch_id: body.branch_id,
    });

    res.status(201).json({ data: user });
  }),
);

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const result = await login(body.email, body.password);
    res.json({ data: result });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.user) throw unauthorized();
    const user = await findUserById(req.user.id);
    if (!user) throw unauthorized('User no longer exists');
    res.json({ data: user });
  }),
);
