import type { UserRole } from './models';

/** What we put in the JWT payload. Small on purpose. */
export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  branch_id: string | null;
}

/** What requireAuth attaches to req.user. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  branch_id: string | null;
}
