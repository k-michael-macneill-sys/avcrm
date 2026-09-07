import { Router } from 'express';
import { z } from 'zod';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { createUser, findUserById, login } from '../services/auth';
import { asyncHandler } from '../utils/async';
import { unauthorized } from '../utils/errors';
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

/**
 * Self-signup for operators only. Role is set on the backend and is never
 * read from the request, so this endpoint cannot mint a corporate account.
 * New operators land on onboarding_status 'pending' and stay unassignable
 * until their documents are approved. Corporate creates staff via POST /users.
 */
authRouter.post(
  '/register',
  optionalAuth,
  asyncHandler(async (req, res) => {
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
