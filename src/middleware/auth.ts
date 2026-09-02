import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { verifyToken } from '../services/auth';
import type { UserRole } from '../types/models';
import { forbidden, unauthorized } from '../utils/errors';

const BEARER = /^Bearer (.+)$/i;

/**
 * Reads `Authorization: Bearer <token>` and attaches req.user.
 * Rejects with 401 when the header is missing, malformed, or the token is bad.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (!header) {
    next(unauthorized('Missing Authorization header'));
    return;
  }

  const match = BEARER.exec(header.trim());
  if (!match || !match[1]) {
    next(unauthorized('Authorization header must be "Bearer <token>"'));
    return;
  }

  try {
    const payload = verifyToken(match[1]);
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      branch_id: payload.branch_id,
    };
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
}

/**
 * Same as requireAuth, but a missing or invalid token is not an error — it just
 * leaves req.user undefined. Used by /auth/register, where an admin token
 * unlocks extra fields but is not required.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  const match = header ? BEARER.exec(header.trim()) : null;
  if (!match || !match[1]) {
    next();
    return;
  }

  try {
    const payload = verifyToken(match[1]);
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      branch_id: payload.branch_id,
    };
  } catch {
    // Ignored on purpose: an unusable token is treated as no token here.
  }
  next();
}

/**
 * Route guard for roles. Use after requireAuth:
 *   router.post('/', requireAuth, requireRole('admin', 'manager'), handler)
 */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(unauthorized());
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(forbidden(`Requires role: ${roles.join(' or ')}`));
      return;
    }
    next();
  };
}

/**
 * Every non-admin is pinned to their own branch. Admins may pass ?branch_id= to
 * look at another one. Returns the branch a request is allowed to read/write.
 */
export function resolveBranchScope(
  req: Request,
  requestedBranchId?: string | null,
): string {
  const user = req.user;
  if (!user) {
    throw unauthorized();
  }

  if (user.role === 'admin') {
    const branchId = requestedBranchId ?? user.branch_id;
    if (!branchId) {
      throw forbidden('Specify a branch_id; this admin is not assigned to a branch');
    }
    return branchId;
  }

  if (!user.branch_id) {
    throw forbidden('Your account is not assigned to a branch');
  }
  if (requestedBranchId && requestedBranchId !== user.branch_id) {
    throw forbidden('You may only access your own branch');
  }
  return user.branch_id;
}
