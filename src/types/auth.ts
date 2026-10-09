import type { OnboardingStatus, UserRole } from './models';

/** What we put in the JWT payload. Small on purpose. */
export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  branch_id: string | null;
  /** Issued-at, in seconds; set by jsonwebtoken. */
  iat?: number;
}

/**
 * What requireAuth attaches to req.user. Loaded fresh from the database on
 * every request, so a suspension or role change takes effect immediately
 * rather than when the token expires.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  branch_id: string | null;
  onboarding_status: OnboardingStatus;
  is_active: boolean;
  password_changed_at: Date | null;
}

/**
 * Which branches a request may touch.
 * `all` is corporate looking across the whole company.
 */
export type BranchScope = { kind: 'all' } | { kind: 'branch'; branchId: string };
