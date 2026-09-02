import { Router } from 'express';
import { z } from 'zod';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { findUserById, login, registerUser } from '../services/auth';
import { USER_ROLES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { unauthorized } from '../utils/errors';
import { parse } from '../utils/validate';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(200),
  role: z.enum(USER_ROLES).default('operator'),
  branch_id: z.string().uuid().nullable().default(null),
});

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

/**
 * Open registration, but `role` and `branch_id` are only honoured for an admin
 * caller. Without an admin token you get an unassigned operator, which cannot
 * read any branch until an admin assigns one. That keeps the endpoint usable
 * for bootstrapping without making it a privilege-escalation route.
 */
authRouter.post(
  '/register',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const body = parse(registerSchema, req.body);
    const callerIsAdmin = req.user?.role === 'admin';

    const user = await registerUser({
      email: body.email,
      password: body.password,
      name: body.name,
      role: callerIsAdmin ? body.role : 'operator',
      branch_id: callerIsAdmin ? body.branch_id : null,
    });

    res.status(201).json({ data: user });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const result = await login(body.email, body.password);
    res.json({ data: result });
  }),
);

/** Handy for confirming a token works. */
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
