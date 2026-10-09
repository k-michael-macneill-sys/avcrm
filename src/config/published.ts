/**
 * Values anyone can look up, kept apart from config/index.ts so the deploy
 * preflight can check a .env against them without loading (and validating)
 * the whole configuration.
 */

/**
 * The development seed's password. Fine on a laptop; refused anywhere the
 * internet can reach, because it is printed in this repository.
 */
export const DEFAULT_SEED_PASSWORD = 'Password123!';

/**
 * Secrets that have been published — in the example env files, in the test
 * and CI setup, or committed to this public repository by mistake — and so
 * are known to anyone who looks. A JWT_SECRET from this list lets a stranger
 * sign a token for any account and walk in without a password, and a
 * SECRETS_KEY from it decrypts the payment credentials saved under Settings.
 */
export const PUBLISHED_SECRETS: ReadonlySet<string> = new Set([
  'change-me-in-every-environment-at-least-32-chars',
  'Awk8clQl5efZ00FW9OSwOgcki1Z4WjxT',
  '6FNaDXhAOlqrV8ImlRAJG4V9HQmPvcwi',
  'dev-jwt-secret-at-least-32-characters-long-thats-why-im-long',
  'dev-secrets-key-at-least-48-characters-which-is-why-this-is-so-long',
  'test-secret-that-is-long-enough-for-the-schema',
  'ci-only-secret-long-enough-for-the-schema-check',
  // The first branch reset code, written into branchSignIn.ts.
  'B3NJ3wman50%',
]);

/** The shortest shared branch password accepted on a public address. */
export const MIN_BRANCH_SIGN_IN_PASSWORD = 10;

/** The shortest BRANCH_RESET_CODE accepted on a public address. */
export const MIN_BRANCH_RESET_CODE = 12;
