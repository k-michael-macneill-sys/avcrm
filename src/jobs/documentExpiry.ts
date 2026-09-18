import type { Knex } from 'knex';
import { db as defaultDb, closeConnection } from '../db/client';
import { enqueueMessage } from '../services/messages';
import { addDays } from '../services/operators';
import { logger } from '../utils/logger';

/**
 * Nightly compliance sweep.
 *
 *   1. Approved documents past their expiry flip to `expired`.
 *   2. An operator who loses a *required* document is suspended, which takes
 *      them out of the assignable pool immediately.
 *   3. Operators are warned 30, 14 and 7 days ahead, copying the branch
 *      manager, and each window is only ever sent once.
 *
 * Every message is queued rather than sent here: this job's business is
 * compliance, and delivery is the queue worker's. Run that after this one, or
 * on its own schedule.
 *
 * Run it from cron or a scheduler:  npm run job:document-expiry
 */

/**
 * Days ahead of expiry that we warn on, NARROWEST FIRST. The order matters:
 * the window for a document is the first one it fits inside, so ascending
 * order picks 14 for "11 days left" rather than 30.
 */
export const REMINDER_WINDOWS = [7, 14, 30] as const;

export interface ExpirySummary {
  ran_for: string;
  expired: number;
  suspended: number;
  reminders_sent: number;
}

interface DueRow {
  id: string;
  requirement_code: string;
  label: string;
  expires_on: string;
  is_required: boolean;
  last_reminder_days: number | null;
  user_id: string;
  first_name: string;
  email: string;
  onboarding_status: string;
  branch_id: string | null;
  branch_name: string | null;
  manager_email: string | null;
}

/** `today` is injectable so the behaviour can be exercised without waiting. */
export async function runDocumentExpiry(
  today: Date = new Date(),
  db: Knex = defaultDb,
): Promise<ExpirySummary> {
  const asOf = today.toISOString().slice(0, 10);

  const summary: ExpirySummary = {
    ran_for: asOf,
    expired: 0,
    suspended: 0,
    reminders_sent: 0,
  };

  // 1. Expire anything past its date.
  const expired = await db('operator_documents')
    .where({ status: 'approved' })
    .whereNotNull('expires_on')
    .andWhere('expires_on', '<', asOf)
    .update({ status: 'expired' })
    .returning(['id', 'user_id', 'requirement_code']);

  summary.expired = expired.length;

  // 2. Suspend operators who just lost a required document.
  const affectedUserIds = [...new Set(expired.map((row) => row.user_id))];

  for (const userId of affectedUserIds) {
    const stillRequired = await db('operator_documents')
      .join(
        'document_requirements',
        'document_requirements.code',
        'operator_documents.requirement_code',
      )
      .where('operator_documents.user_id', userId)
      .andWhere('operator_documents.status', 'expired')
      .andWhere('document_requirements.is_required', true)
      .first('operator_documents.id');

    if (!stillRequired) continue;

    const [user] = await db('users')
      .where({ id: userId, role: 'operator' })
      .whereNot({ onboarding_status: 'suspended' })
      .update({ onboarding_status: 'suspended' })
      .returning(['id', 'email', 'first_name']);

    if (!user) continue;

    summary.suspended += 1;
    logger.warn({ user_id: userId }, 'Operator suspended: required document expired');

    const branch = await branchOf(userId, db);
    const context = {
      first_name: user.first_name,
      operator_name: user.first_name,
      branch_name: branch?.branch_name ?? 'their branch',
    };

    await enqueueMessage(
      {
        template_code: 'operator_suspended',
        channel: 'email',
        recipient: user.email,
        branch_id: branch?.branch_id ?? null,
        context,
      },
      db,
    );
    if (branch?.manager_email) {
      await enqueueMessage(
        {
          template_code: 'operator_suspended_internal',
          channel: 'email',
          recipient: branch.manager_email,
          branch_id: branch.branch_id,
          context,
        },
        db,
      );
    }
  }

  // 3. Warn on documents approaching expiry.
  const widest = REMINDER_WINDOWS[REMINDER_WINDOWS.length - 1] ?? 30;
  const horizon = addDays(asOf, widest);

  const due = (await db('operator_documents')
    .join(
      'document_requirements',
      'document_requirements.code',
      'operator_documents.requirement_code',
    )
    .join('users', 'users.id', 'operator_documents.user_id')
    .leftJoin('branches', 'branches.id', 'users.branch_id')
    .leftJoin('users as managers', 'managers.id', 'branches.manager_user_id')
    .where('operator_documents.status', 'approved')
    .whereNotNull('operator_documents.expires_on')
    .andWhere('operator_documents.expires_on', '>=', asOf)
    .andWhere('operator_documents.expires_on', '<=', horizon)
    .andWhere('users.is_active', true)
    .select([
      'operator_documents.id',
      'operator_documents.requirement_code',
      'operator_documents.expires_on',
      'operator_documents.last_reminder_days',
      'operator_documents.user_id',
      'document_requirements.label',
      'document_requirements.is_required',
      'users.first_name',
      'users.email',
      'users.onboarding_status',
      'branches.id as branch_id',
      'branches.name as branch_name',
      'managers.email as manager_email',
    ])) as unknown as DueRow[];

  for (const row of due) {
    const daysLeft = daysBetween(asOf, row.expires_on);
    // Narrowest window this document has reached, e.g. 11 days left -> 14.
    const window = REMINDER_WINDOWS.find((w) => daysLeft <= w);
    if (window === undefined) continue;

    // Already warned at this window or a tighter one, so the operator has
    // heard about it at this urgency; the next warning waits for the next step.
    if (row.last_reminder_days !== null && row.last_reminder_days <= window) continue;

    // The templates have no conditionals, so the "this one is required"
    // sentence is rendered here and passed in as a token.
    const context = {
      first_name: row.first_name,
      operator_name: row.first_name,
      label: row.label,
      expires_on: row.expires_on,
      days_left: daysLeft,
      day_word: daysLeft === 1 ? 'day' : 'days',
      branch_name: row.branch_name ?? 'their branch',
      required_note: row.is_required
        ? ' It is required, so your account will be suspended automatically if it lapses.'
        : '',
    };

    await enqueueMessage(
      {
        template_code: 'document_expiring',
        channel: 'email',
        recipient: row.email,
        branch_id: row.branch_id,
        context,
      },
      db,
    );
    if (row.manager_email) {
      await enqueueMessage(
        {
          template_code: 'document_expiring_internal',
          channel: 'email',
          recipient: row.manager_email,
          branch_id: row.branch_id,
          context,
        },
        db,
      );
    }

    await db('operator_documents')
      .where({ id: row.id })
      .update({ last_reminder_days: window });

    summary.reminders_sent += 1;
  }

  logger.info(summary, 'Document expiry sweep complete');
  return summary;
}

interface BranchContact {
  branch_id: string;
  branch_name: string;
  manager_email: string | null;
}

async function branchOf(userId: string, db: Knex): Promise<BranchContact | null> {
  const row = (await db('users')
    .join('branches', 'branches.id', 'users.branch_id')
    .leftJoin('users as managers', 'managers.id', 'branches.manager_user_id')
    .where('users.id', userId)
    .first([
      'branches.id as branch_id',
      'branches.name as branch_name',
      'managers.email as manager_email',
    ])) as BranchContact | undefined;
  return row ?? null;
}

/** Whole days from one YYYY-MM-DD to another. */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

// Entry point when run as a script rather than imported.
if (require.main === module) {
  runDocumentExpiry()
    .then(async (summary) => {
      await closeConnection();
      logger.info(summary, 'Done');
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'Document expiry sweep failed');
      await closeConnection();
      process.exit(1);
    });
}
