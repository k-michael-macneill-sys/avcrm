import type { AuthenticatedUser } from './auth';

declare global {
  namespace Express {
    interface Request {
      /** Set by the requireAuth middleware. Undefined on public routes. */
      user?: AuthenticatedUser;
    }
  }
}

export {};
