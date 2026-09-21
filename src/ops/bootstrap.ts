import { randomBytes } from 'node:crypto';
import { installAppConfig } from '../db/appConfig';
import { db as defaultDb } from '../db/client';
import { createUser } from '../services/auth';

/**
 * Makes a freshly deployed install usable.
 *
 * Migrations create the schema and nothing else, so a new production database
 * is empty in a way that cannot be recovered from through the API: signing in
 * needs a user, creating a user needs a corporate session, creating a branch
 * needs a corporate session, and self-registration needs a branch that exists
 * and only ever produces a pending operator. Every route in is a dead end.
 * The development seed would solve it and deliberately refuses to run with
 * NODE_ENV=production, which is right — nobody wants Harold Bell and six
 * sample quotes in their real database.
 *
 * So: one command, run once, that installs the configuration the application
 * treats as given and creates the first branch and the first corporate user.
 *
 *   npm run bootstrap -- --branch "Kingston" --province ON \
 *     --email owner@example.ca --first-name Kieran --last-name MacNeill
 *
 * It will not touch an install that already has users, because the thing it
 * would do there is create an administrator nobody asked for.
 */

export interface BootstrapInput {
  branchName: string;
  province: string;
  email: string;
  firstName: string;
  lastName: string;
  /** Generated and printed once if not supplied. */
  password?: string;
  timezone?: string;
}

export interface BootstrapResult {
  config: { document_requirements: number; checklist_requirements: number; message_templates: number };
  branch: { id: string; name: string } | null;
  user: { id: string; email: string } | null;
  password: string | null;
  /** Set when the install already had users and was left alone. */
  skipped: string | null;
}

/** Readable aloud over a phone, unlike base64: no l/1/O/0 to mishear. */
function readablePassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(20);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15, 20)}`;
}

export async function bootstrap(
  input: BootstrapInput,
  db = defaultDb,
): Promise<BootstrapResult> {
  return db.transaction(async (trx) => {
    // Idempotent, and worth running on an existing install too: an upgrade
    // that adds a message template needs it installed here.
    const config = await installAppConfig(trx);

    const existingUser = await trx('users').first('id');
    if (existingUser) {
      return {
        config,
        branch: null,
        user: null,
        password: null,
        skipped: 'this install already has users, so no branch or administrator was created',
      };
    }

    const [branch] = await trx('branches')
      .insert({
        name: input.branchName,
        province: input.province,
        timezone: input.timezone ?? 'America/Toronto',
        status: 'active',
      })
      .returning(['id', 'name']);

    if (!branch) throw new Error('Could not create the first branch');

    const password = input.password ?? readablePassword();

    // Through the same service the API uses, so the hash, the validation and
    // the role rules are the ones everything else is held to.
    const user = await createUser(
      {
        email: input.email,
        password,
        first_name: input.firstName,
        last_name: input.lastName,
        phone: null,
        role: 'corporate',
        // Corporate sees every branch; a branch_id here would only narrow it.
        branch_id: null,
      },
      trx,
    );

    return {
      config,
      branch: { id: branch.id, name: branch.name },
      user: { id: user.id, email: user.email },
      password,
      skipped: null,
    };
  });
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const branchName = arg('branch');
  const province = arg('province');
  const email = arg('email');
  const firstName = arg('first-name');
  const lastName = arg('last-name');

  if (!branchName || !province || !email || !firstName || !lastName) {
    process.stderr.write(
      [
        '',
        'Creates the first branch and the first corporate user, and installs',
        'the configuration the application treats as given.',
        '',
        '  npm run bootstrap -- \\',
        '    --branch "Kingston" --province ON \\',
        '    --email owner@example.ca --first-name Kieran --last-name MacNeill',
        '',
        'Optional: --password (one is generated and printed if you omit it),',
        '          --timezone (default America/Toronto)',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  const result = await bootstrap({
    branchName,
    province,
    email,
    firstName,
    lastName,
    password: arg('password'),
    timezone: arg('timezone'),
  });

  const { config } = result;
  process.stdout.write(
    `\nConfiguration installed: ${config.document_requirements} document requirements, ` +
      `${config.checklist_requirements} checklist items, ${config.message_templates} message templates.\n` +
      '(Zero means they were already there, which is fine.)\n',
  );

  if (result.skipped) {
    process.stdout.write(`\n${result.skipped}\n\n`);
    return;
  }

  process.stdout.write(
    [
      '',
      `Branch:   ${result.branch?.name}`,
      `Sign in:  ${result.user?.email}`,
      `Password: ${result.password}`,
      '',
      'That password is shown once and is not stored anywhere in readable form.',
      'Sign in, change it, and put it in your password manager.',
      '',
    ].join('\n'),
  );
}

if (require.main === module) {
  main()
    .then(() => defaultDb.destroy())
    .catch(async (error) => {
      process.stderr.write(`\n${(error as Error).message}\n\n`);
      await defaultDb.destroy();
      process.exit(1);
    });
}
