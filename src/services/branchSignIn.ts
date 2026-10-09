import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Knex } from 'knex';
import { config } from '../config';
import { MIN_BRANCH_SIGN_IN_PASSWORD } from '../config/published';
import { db as defaultDb } from '../db/client';
import { SIGN_IN_CHOICES, type Branch, type PublicUser, type SignInChoice, type User } from '../types/models';
import { forbidden, unauthorized } from '../utils/errors';
import {
  hashPassword,
  PUBLIC_USER_COLUMNS,
  refusePublishedPassword,
  signToken,
  verifyPassword,
} from './auth';

/**
 * Signing in by branch, from the sign-in screen's dropdown.
 *
 * Choosing a branch signs in as that branch's own shared account with the
 * branch password (BRANCH_SIGN_IN_PASSWORD; `1234` in development, and no
 * default at all in production). The account
 * has the `branch` role: selling and dispatch in that branch, nothing of
 * corporate's. It is made the first time somebody signs in to it, and so is
 * the branch itself if it has gone missing.
 *
 * Choosing ADMIN keeps the corporate accounts' own passwords: the password is
 * checked against each active corporate account in turn, oldest first.
 *
 * The email-and-password route (POST /auth/login) is still there for staff
 * accounts and scripts; only the screen stopped asking for an email.
 */

export interface BranchSetup {
  name: Exclude<SignInChoice, 'ADMIN'>;
  province: string;
  timezone: string;
  /** Null: the branch covers several towns, so the city is typed each time. */
  default_city: string | null;
}

export const SIGN_IN_BRANCHES: BranchSetup[] = [
  { name: 'Cranbrook', province: 'BC', timezone: 'America/Edmonton', default_city: 'Cranbrook' },
  { name: 'Kingston', province: 'ON', timezone: 'America/Toronto', default_city: 'Kingston' },
  { name: 'Alberta', province: 'AB', timezone: 'America/Edmonton', default_city: null },
  { name: 'Regina', province: 'SK', timezone: 'America/Regina', default_city: 'Regina' },
];

export { SIGN_IN_CHOICES };
export const ADMIN_CHOICE: SignInChoice = 'ADMIN';

/** What the client keeps about the branch it signed in to. */
export type SessionBranch = Pick<Branch, 'id' | 'name' | 'province' | 'default_city'>;

export interface BranchSignInResult {
  token: string;
  user: PublicUser;
  /** Null for ADMIN, which works across every branch. */
  branch: SessionBranch | null;
}

/** How many corporate accounts ADMIN will try, so a wrong password stays cheap. */
const MAX_ADMIN_ACCOUNTS = 25;

/**
 * The branch password, or why branch sign-in is switched off.
 *
 * On a public address it has a minimum length. It is shared by every branch
 * and typed with no email in front of it, so it is the whole of the lock: a
 * four-digit PIN falls to a few days of patient guessing even through the
 * rate limit.
 */
function branchPassword(): string {
  const password = config.branchSignInPassword;
  if (!password) {
    throw forbidden('Branch sign-in is switched off until BRANCH_SIGN_IN_PASSWORD is set on the server');
  }
  if (config.isPublicProduction && password.length < MIN_BRANCH_SIGN_IN_PASSWORD) {
    throw forbidden(
      `Branch sign-in is switched off: BRANCH_SIGN_IN_PASSWORD must be at least ` +
        `${MIN_BRANCH_SIGN_IN_PASSWORD} characters. Sign in as ADMIN, or ask the owner to change it.`,
    );
  }
  return password;
}

function sameSecret(given: string, expected: string): boolean {
  // Hashed first so the comparison is constant-time whatever the lengths.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function branchAccountEmail(branchName: string): string {
  return `${slug(branchName)}@branch.avcrm.local`;
}

async function adminSignIn(password: string, db: Knex): Promise<BranchSignInResult> {
  refusePublishedPassword(password);
  const admins = (await db('users')
    .where({ role: 'corporate' })
    .orderBy('created_at', 'asc')
    .limit(MAX_ADMIN_ACCOUNTS)) as User[];

  for (const admin of admins) {
    if (await verifyPassword(password, admin.password_hash)) {
      if (!admin.is_active) throw forbidden('This account has been deactivated');
      const { password_hash: _ignored, ...user } = admin;
      return { token: signToken(admin), user, branch: null };
    }
  }
  throw unauthorized('That password is not right for ADMIN');
}

/** The branch by name, made from its setup if it is not there. */
async function branchFor(setup: BranchSetup, trx: Knex): Promise<Branch> {
  const existing = (await trx('branches')
    .whereRaw('lower(name) = lower(?)', [setup.name])
    .first()) as Branch | undefined;
  if (existing) {
    // A branch made before cities were kept picks its city up here.
    if (existing.default_city === null && setup.default_city !== null) {
      const [updated] = await trx('branches')
        .where({ id: existing.id })
        .update({ default_city: setup.default_city })
        .returning('*');
      return updated as Branch;
    }
    return existing;
  }

  const [created] = await trx('branches').insert(setup).returning('*');
  return created as Branch;
}

/**
 * Makes sure every branch the sign-in screen offers exists, with its city.
 * Part of the installed configuration (db/appConfig.ts), so a fresh install
 * has them before anybody signs in. Returns how many it added.
 */
export async function ensureSignInBranches(db: Knex = defaultDb): Promise<number> {
  let added = 0;
  for (const setup of SIGN_IN_BRANCHES) {
    const before = await db('branches').whereRaw('lower(name) = lower(?)', [setup.name]).first('id');
    await branchFor(setup, db);
    if (!before) added += 1;
  }
  return added;
}

async function branchSignIn(setup: BranchSetup, db: Knex): Promise<BranchSignInResult> {
  return db.transaction(async (trx) => {
    const branch = await branchFor(setup, trx);
    if (branch.status !== 'active') throw forbidden(`${branch.name} is not an active branch`);

    const email = branchAccountEmail(branch.name);
    let account = (await trx('users').where({ email }).first([...PUBLIC_USER_COLUMNS])) as
      | PublicUser
      | undefined;

    if (!account) {
      [account] = (await trx('users')
        .insert({
          email,
          // Never a usable password: this account is signed in to through the
          // branch password only, never the email route.
          password_hash: await hashPassword(randomBytes(32).toString('hex')),
          first_name: branch.name,
          last_name: 'Branch',
          role: 'branch',
          branch_id: branch.id,
          onboarding_status: 'approved',
        })
        .returning([...PUBLIC_USER_COLUMNS])) as PublicUser[];
    }
    if (!account) throw new Error('Branch sign-in wrote no user row');
    if (!account.is_active) throw forbidden(`The ${branch.name} sign-in has been switched off`);

    return {
      token: signToken(account),
      user: account,
      branch: {
        id: branch.id,
        name: branch.name,
        province: branch.province,
        default_city: branch.default_city,
      },
    };
  });
}

export async function signInByChoice(
  choice: SignInChoice,
  password: string,
  db: Knex = defaultDb,
): Promise<BranchSignInResult> {
  if (choice === ADMIN_CHOICE) return adminSignIn(password, db);

  const setup = SIGN_IN_BRANCHES.find((b) => b.name === choice);
  if (!setup) throw unauthorized('Choose a branch to sign in to');
  if (!sameSecret(password, branchPassword())) {
    throw unauthorized(`That password is not right for ${setup.name}`);
  }
  return branchSignIn(setup, db);
}

/** The branch a signed-in user's session is for, as the client keeps it. */
export async function sessionBranch(
  user: Pick<PublicUser, 'role' | 'branch_id'>,
  db: Knex = defaultDb,
): Promise<SessionBranch | null> {
  if (user.role === 'corporate' || !user.branch_id) return null;
  const branch = await db('branches')
    .where({ id: user.branch_id })
    .first('id', 'name', 'province', 'default_city');
  return (branch as SessionBranch | undefined) ?? null;
}

/**
 * The city a new property gets when a branch's own sign-in writes it: the
 * branch's default city, or null when there is none (or the writer is not a
 * branch sign-in) — in which case whatever was typed stands.
 */
export async function forcedCity(
  user: { role: string; branch_id: string | null },
  db: Knex = defaultDb,
): Promise<string | null> {
  if (user.role !== 'branch' || !user.branch_id) return null;
  const branch = await db('branches').where({ id: user.branch_id }).first('default_city');
  return (branch?.default_city as string | null | undefined) ?? null;
}
