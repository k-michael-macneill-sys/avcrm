import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuditActor } from '../services/audit';
import type { CrewActor } from '../services/workOrders';
import { loadAuthenticatedUser, verifyToken } from '../services/auth';
import type { BranchScope } from '../types/auth';
import type { UserRole } from '../types/models';
import { badRequest, forbidden, unauthorized } from '../utils/errors';

const BEARER = /^Bearer (.+)$/i;

function tokenFrom(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const match = BEARER.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Reads `Authorization: Bearer <token>`, then loads the user row.
 *
 * The row is read on every request rather than trusted from the token, so a
 * suspension, deactivation, role change or branch move takes effect at once
 * instead of whenever the token happens to expire. That costs one indexed
 * primary-key lookup per request, which is the right trade here.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = tokenFrom(req);
  if (!token) {
    next(unauthorized('Missing or malformed Authorization header'));
    return;
  }

  let userId: string;
  try {
    userId = verifyToken(token).sub;
  } catch {
    next(unauthorized('Invalid or expired token'));
    return;
  }

  loadAuthenticatedUser(userId)
    .then((user) => {
      if (!user) {
        next(unauthorized('User no longer exists'));
        return;
      }
      if (!user.is_active) {
        next(forbidden('This account has been deactivated'));
        return;
      }
      req.user = user;
      next();
    })
    .catch(next);
}

/**
 * Same as requireAuth, but a missing or invalid token leaves req.user
 * undefined instead of erroring. Used by /auth/register, where a corporate
 * token unlocks extra fields but is not required.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = tokenFrom(req);
  if (!token) {
    next();
    return;
  }

  let userId: string;
  try {
    userId = verifyToken(token).sub;
  } catch {
    // An unusable token is treated as no token here.
    next();
    return;
  }

  loadAuthenticatedUser(userId)
    .then((user) => {
      if (user?.is_active) {
        req.user = user;
      }
      next();
    })
    .catch(next);
}

/**
 * Who to record against a write, and where from. Lives here with the other
 * request readers so services keep taking values rather than the request.
 *
 * The IP is taken from the connection, never the body — that is what makes a
 * contract's signed_ip evidence. See `trust proxy` in src/app.ts.
 */
export function resolveActor(req: Request): AuditActor {
  if (!req.user) {
    throw unauthorized();
  }
  return { user_id: req.user.id, ip_address: req.ip ?? null };
}

/**
 * The caller as the work order rules see them. Branch scope decides which
 * visits are visible; this decides whose may be touched, so it carries the
 * role as well as the id.
 */
export function resolveCrewActor(req: Request): CrewActor {
  if (!req.user) {
    throw unauthorized();
  }
  return { user_id: req.user.id, is_corporate: req.user.role === 'corporate' };
}

/** Route guard for roles. Use after requireAuth. */
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

/** Shorthand for the common case. */
export const requireCorporate = requireRole('corporate');

/**
 * Which branches this request may READ.
 *
 * Corporate sees every branch by default, and may narrow to one with
 * ?branch_id=. An operator is hard-scoped to their own branch and gets a 403
 * if they ask for another. This is the query-layer enforcement the spec calls
 * for — services take the scope and never look at the request.
 */
export function resolveBranchScope(
  req: Request,
  requestedBranchId?: string | null,
): BranchScope {
  const user = req.user;
  if (!user) {
    throw unauthorized();
  }

  if (user.role === 'corporate') {
    return requestedBranchId
      ? { kind: 'branch', branchId: requestedBranchId }
      : { kind: 'all' };
  }

  if (!user.branch_id) {
    throw forbidden('Your account is not assigned to a branch');
  }
  if (requestedBranchId && requestedBranchId !== user.branch_id) {
    throw forbidden('You may only access your own branch');
  }
  return { kind: 'branch', branchId: user.branch_id };
}

/**
 * Which branch this request may WRITE to. A write always lands in exactly one
 * branch, so corporate must say which one when they are not tied to a branch.
 */
export function resolveWriteBranch(
  req: Request,
  requestedBranchId?: string | null,
): string {
  const scope = resolveBranchScope(req, requestedBranchId);
  if (scope.kind === 'branch') {
    return scope.branchId;
  }
  throw badRequest('branch_id is required: corporate users must name the branch');
}
