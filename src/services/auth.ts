import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { Knex } from 'knex';
import { config, DEFAULT_SEED_PASSWORD } from '../config';
import { db as defaultDb } from '../db/client';
import type { AuthenticatedUser, JwtPayload } from '../types/auth';
import type { PublicUser, User, UserRole } from '../types/models';
import { badRequest, conflict, forbidden, unauthorized } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Every token this app signs is HS256 with JWT_SECRET. Saying so on both
 * sides means a token can never pick its own algorithm.
 */
const JWT_ALGORITHM = 'HS256' as const;

/** The shortest password an account may be given. */
export const MIN_PASSWORD_LENGTH = 10;

/** The account the first-run seed creates. */
export const SEED_ADMIN_EMAIL = 'corporate@avcrm.test';

export const PUBLIC_USER_COLUMNS = [
  'id',
  'branch_id',
  'email',
  'first_name',
  'last_name',
  'phone',
  'role',
  'onboarding_status',
  'is_active',
  'created_at',
  'updated_at',
] as const;

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, config.auth.bcryptRounds);
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

export function signToken(user: {
  id: string;
  email: string;
  role: UserRole;
  branch_id: string | null;
}): string {
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    branch_id: user.branch_id,
  };
  return jwt.sign(payload, config.auth.jwtSecret, {
    algorithm: JWT_ALGORITHM,
    expiresIn: config.auth.jwtExpiresIn,
  } as jwt.SignOptions);
}

/**
 * A session token, and only a session token. Upload and signing links are
 * signed with the same secret and carry a `typ`; a session never does, so
 * one of those can never be presented as a sign-in.
 */
export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, config.auth.jwtSecret, { algorithms: [JWT_ALGORITHM] });
  if (typeof decoded === 'string' || typeof decoded.sub !== 'string' || 'typ' in decoded) {
    throw unauthorized('Malformed token payload');
  }
  return decoded as unknown as JwtPayload;
}

/**
 * True when the token was issued before the account's password last
 * changed, which is what signs out every other session on a change.
 * Compared in whole seconds because that is all `iat` carries.
 */
export function issuedBeforePasswordChange(
  payload: Pick<JwtPayload, 'iat'>,
  passwordChangedAt: Date | null,
): boolean {
  if (!passwordChangedAt) return false;
  if (typeof payload.iat !== 'number') return true;
  return payload.iat < Math.floor(passwordChangedAt.getTime() / 1000);
}

/**
 * The development seed's password is printed in this repository, so on a
 * deployment the internet can reach it signs nobody in and is given to
 * nobody, whichever account it would match.
 */
export function refusePublishedPassword(password: string): void {
  if (config.isPublicProduction && password === DEFAULT_SEED_PASSWORD) {
    throw forbidden(
      'That password is the installer default, which is published, so it is not accepted here. ' +
        'Set SEED_PASSWORD on the server and redeploy to replace it on the first admin account.',
    );
  }
}

/** Gives an account a new password, and signs out every session it had. */
export async function setPassword(
  userId: string,
  plaintext: string,
  db: Knex = defaultDb,
): Promise<void> {
  refusePublishedPassword(plaintext);
  if (plaintext.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`A password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const updated = await db('users')
    .where({ id: userId })
    .update({ password_hash: await hashPassword(plaintext), password_changed_at: new Date() });
  if (!updated) throw unauthorized('User no longer exists');
}

/**
 * The signed-in person changing their own password. The current one is
 * asked for again so that a session left open on a shared screen, or a
 * stolen token, cannot be turned into the account itself.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  db: Knex = defaultDb,
): Promise<LoginResult> {
  const user = (await db('users').where({ id: userId }).first()) as User | undefined;
  if (!user || !user.is_active) throw unauthorized('User no longer exists');
  if (user.role === 'branch') {
    throw forbidden('A branch sign-in has no password of its own: it is BRANCH_SIGN_IN_PASSWORD on the server');
  }
  // 403, not 401: the session is fine, and a 401 signs the screen out.
  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw forbidden('Your current password is not right');
  }
  if (currentPassword === newPassword) {
    throw badRequest('Choose a password different from the current one');
  }

  await setPassword(user.id, newPassword, db);

  const { password_hash: _ignored, ...publicUser } = (await db('users').where({ id: userId }).first()) as User;
  return { token: signToken(user), user: publicUser };
}

/**
 * Asks the signed-in person for their password again, for the changes that
 * matter most — where customers' money goes. A session left open on a shared
 * screen, or a token lifted from a browser, is not enough on its own.
 */
export async function confirmPassword(
  userId: string,
  password: string,
  db: Knex = defaultDb,
): Promise<void> {
  const user = (await db('users').where({ id: userId }).first('password_hash')) as
    | Pick<User, 'password_hash'>
    | undefined;
  // 403, not 401: the session is fine, and a 401 signs the screen out.
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw forbidden('That password is not right');
  }
}

/**
 * The first-run seed's account, if it still has the published default.
 *
 * With SEED_PASSWORD set to something else, that becomes its password — the
 * way back in for an install that was deployed before the default was
 * refused. Without it, the account stays locked (sign-in refuses the
 * default) and the log says what to do.
 */
export async function retirePublishedPassword(db: Knex = defaultDb): Promise<boolean> {
  if (!config.isPublicProduction) return false;

  const admin = (await db('users').where({ email: SEED_ADMIN_EMAIL }).first()) as User | undefined;
  if (!admin || !(await verifyPassword(DEFAULT_SEED_PASSWORD, admin.password_hash))) return false;

  if (config.seed.password === DEFAULT_SEED_PASSWORD || config.seed.password.length < MIN_PASSWORD_LENGTH) {
    logger.error(
      { email: SEED_ADMIN_EMAIL },
      'The first admin account still has the published default password, so it cannot sign in. ' +
        `Set SEED_PASSWORD on the server to a new password of at least ${MIN_PASSWORD_LENGTH} characters and redeploy.`,
    );
    return false;
  }

  await setPassword(admin.id, config.seed.password, db);
  logger.warn({ email: SEED_ADMIN_EMAIL }, 'Replaced the published default password with SEED_PASSWORD');
  return true;
}

export interface CreateUserInput {
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  role: UserRole;
  branch_id: string | null;
}

/**
 * Role is set here, on the backend, never taken from an unauthenticated
 * client. Callers decide what role they are allowed to ask for.
 */
export async function createUser(
  input: CreateUserInput,
  db: Knex = defaultDb,
): Promise<PublicUser> {
  // citext makes this comparison case-insensitive.
  const existing = await db('users').where({ email: input.email }).first('id');
  if (existing) {
    throw conflict('A user with that email already exists');
  }

  if (input.role !== 'corporate' && !input.branch_id) {
    const who = { sales: 'A sales rep', operator: 'An operator', branch: 'A branch sign-in' } as const;
    throw badRequest(`${who[input.role]} must belong to a branch`);
  }

  if (input.branch_id) {
    const branch = await db('branches').where({ id: input.branch_id }).first('id');
    if (!branch) {
      throw badRequest('branch_id does not match an existing branch');
    }
  }

  refusePublishedPassword(input.password);
  const password_hash = await hashPassword(input.password);

  const [user] = await db('users')
    .insert({
      email: input.email.trim(),
      password_hash,
      first_name: input.first_name.trim(),
      last_name: input.last_name.trim(),
      phone: input.phone,
      role: input.role,
      branch_id: input.branch_id,
    })
    .returning([...PUBLIC_USER_COLUMNS]);

  if (!user) {
    throw new Error('Insert returned no user row');
  }
  return user as PublicUser;
}

export interface LoginResult {
  token: string;
  user: PublicUser;
}

export async function login(
  email: string,
  password: string,
  db: Knex = defaultDb,
): Promise<LoginResult> {
  refusePublishedPassword(password);
  const user = (await db('users').where({ email }).first()) as User | undefined;

  // Same error and roughly the same work either way, so the response does not
  // reveal whether the address is registered.
  const hash =
    user?.password_hash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = await verifyPassword(password, hash);

  if (!user || !ok) {
    throw unauthorized('Invalid email or password');
  }

  if (!user.is_active) {
    throw forbidden('This account has been deactivated');
  }

  const { password_hash: _ignored, ...publicUser } = user;
  return { token: signToken(user), user: publicUser };
}

export async function findUserById(
  id: string,
  db: Knex = defaultDb,
): Promise<PublicUser | undefined> {
  const user = await db('users').where({ id }).first([...PUBLIC_USER_COLUMNS]);
  return user as PublicUser | undefined;
}

/** Used by requireAuth on every request. */
export async function loadAuthenticatedUser(
  id: string,
  db: Knex = defaultDb,
): Promise<AuthenticatedUser | undefined> {
  const user = await db('users')
    .where({ id })
    .first(['id', 'email', 'role', 'branch_id', 'onboarding_status', 'is_active', 'password_changed_at']);
  return user as AuthenticatedUser | undefined;
}
