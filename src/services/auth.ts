import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import type { AuthenticatedUser, JwtPayload } from '../types/auth';
import type { PublicUser, User, UserRole } from '../types/models';
import { badRequest, conflict, unauthorized } from '../utils/errors';

const PUBLIC_USER_COLUMNS = [
  'id',
  'email',
  'name',
  'role',
  'branch_id',
  'created_at',
] as const;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, config.auth.bcryptRounds);
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

export function signToken(user: AuthenticatedUser): string {
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

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  role: UserRole;
  branch_id: string | null;
}

export async function registerUser(
  input: RegisterInput,
  db: Knex = defaultDb,
): Promise<PublicUser> {
  const email = normalizeEmail(input.email);

  const existing = await db('users').where({ email }).first('id');
  if (existing) {
    throw conflict('A user with that email already exists');
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
      email,
      password_hash,
      name: input.name.trim(),
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
  const user = (await db('users')
    .where({ email: normalizeEmail(email) })
    .first()) as User | undefined;

  // Same error and roughly the same work either way, so the response does not
  // reveal whether the address is registered.
  const hash = user?.password_hash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = await verifyPassword(password, hash);

  if (!user || !ok) {
    throw unauthorized('Invalid email or password');
  }

  const { password_hash: _ignored, ...publicUser } = user;
  const token = signToken({
    id: user.id,
    email: user.email,
    role: user.role,
    branch_id: user.branch_id,
  });

  return { token, user: publicUser };
}

export async function findUserById(
  id: string,
  db: Knex = defaultDb,
): Promise<PublicUser | undefined> {
  const user = await db('users').where({ id }).first([...PUBLIC_USER_COLUMNS]);
  return user as PublicUser | undefined;
}
