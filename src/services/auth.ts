import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import type { AuthenticatedUser, JwtPayload } from '../types/auth';
import type { PublicUser, User, UserRole } from '../types/models';
import { badRequest, conflict, forbidden, unauthorized } from '../utils/errors';

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
    expiresIn: config.auth.jwtExpiresIn,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, config.auth.jwtSecret);
  if (typeof decoded === 'string') {
    throw unauthorized('Malformed token payload');
  }
  return decoded as unknown as JwtPayload;
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

  if (input.role === 'operator' && !input.branch_id) {
    throw badRequest('An operator must belong to a branch');
  }

  if (input.branch_id) {
    const branch = await db('branches').where({ id: input.branch_id }).first('id');
    if (!branch) {
      throw badRequest('branch_id does not match an existing branch');
    }
  }

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
    .first(['id', 'email', 'role', 'branch_id', 'onboarding_status', 'is_active']);
  return user as AuthenticatedUser | undefined;
}
