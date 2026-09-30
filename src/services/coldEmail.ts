import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type {
  EmailLead,
  EmailLeadStatus,
  MessageLogEntry,
  OptInSource,
  TemplateCode,
} from '../types/models';
import { badRequest, notFound } from '../utils/errors';
import { logger } from '../utils/logger';
import { applyBranchScope } from '../utils/scope';
import { enqueueMessage } from './messages';

/**
 * The cold email sequence for people who asked to hear from us: somebody who
 * filled in the form on a Google Ads landing page, or said yes at the door.
 *
 * Opting in queues the confirmation at once — the message queue sends it
 * within the minute — and the drip job (runColdEmailDrip) sends each
 * follow-up when it falls due, counted in days from the opt-in.
 *
 * Three things stop the sequence early: the person unsubscribes, somebody in
 * the office stops it, or the person becomes a paying customer. Selling to
 * somebody who has already bought is how a mailing list becomes spam.
 *
 * Every email goes through message_log like everything else, so what was sent
 * and when is on the record, and the templates can be reworded per branch.
 */

export interface DripStep {
  template_code: TemplateCode;
  /** Days after the opt-in. The first step is 0: the instant confirmation. */
  after_days: number;
  label: string;
}

export const DRIP_SEQUENCE: DripStep[] = [
  { template_code: 'drip_welcome', after_days: 0, label: 'Opt-in confirmation' },
  { template_code: 'drip_followup_1', after_days: 2, label: 'How the service works' },
  { template_code: 'drip_followup_2', after_days: 5, label: 'Book before the first snowfall' },
  { template_code: 'drip_followup_3', after_days: 10, label: 'Last note' },
];

/** What somebody agrees to when no other wording is supplied. */
export const DEFAULT_CONSENT =
  'I agree to receive emails about snow clearing services. I can unsubscribe at any time.';

const DAY_MS = 86_400_000;
const BATCH_SIZE = 100;

export function unsubscribeUrl(token: string): string {
  return `${config.messaging.appBaseUrl}/public/unsubscribe/${token}`;
}

export interface OptInInput {
  branch_id: string;
  first_name: string;
  last_name: string | null;
  email: string;
  phone: string | null;
  source: OptInSource;
  consent_text?: string | null;
  campaign?: string | null;
  gclid?: string | null;
  lead_pin_id?: string | null;
  customer_id?: string | null;
  created_by_user_id?: string | null;
}

export interface OptInResult {
  lead: EmailLead;
  /** False when they were already in the sequence and nothing restarted. */
  enrolled: boolean;
}

/**
 * Puts somebody into the sequence and queues their confirmation.
 *
 * Opting in again while already enrolled changes nothing but the contact
 * details: a second form submission is not a reason to send the whole
 * sequence twice. Somebody who had unsubscribed and opts in again has given
 * fresh consent, so they start over.
 */
export async function optIn(input: OptInInput, db: Knex = defaultDb): Promise<OptInResult> {
  const email = input.email.trim();
  if (!email) throw badRequest('An email address is required to opt in');

  const run = async (trx: Knex.Transaction): Promise<OptInResult> => {
    const branch = await trx('branches').where({ id: input.branch_id }).first();
    if (!branch) throw badRequest('branch_id does not match a branch');

    const existing = (await trx('email_leads')
      .where({ branch_id: input.branch_id })
      .whereRaw('lower(email) = lower(?)', [email])
      .forUpdate()
      .first()) as EmailLead | undefined;

    const contact = {
      first_name: input.first_name.trim(),
      last_name: input.last_name?.trim() || null,
      phone: input.phone?.trim() || null,
    };

    if (existing && existing.status !== 'unsubscribed') {
      const [updated] = await trx('email_leads')
        .where({ id: existing.id })
        .update({
          ...contact,
          lead_pin_id: existing.lead_pin_id ?? input.lead_pin_id ?? null,
          customer_id: existing.customer_id ?? input.customer_id ?? null,
        })
        .returning('*');
      return { lead: updated as EmailLead, enrolled: false };
    }

    const fresh = {
      ...contact,
      email,
      source: input.source,
      status: 'active' as const,
      steps_sent: 0,
      next_send_at: new Date(),
      opted_in_at: new Date(),
      consent_text: input.consent_text?.trim() || DEFAULT_CONSENT,
      unsubscribed_at: null,
      campaign: input.campaign ?? null,
      gclid: input.gclid ?? null,
      lead_pin_id: input.lead_pin_id ?? null,
      customer_id: input.customer_id ?? null,
    };

    const [row] = existing
      ? await trx('email_leads').where({ id: existing.id }).update(fresh).returning('*')
      : await trx('email_leads')
          .insert({
            ...fresh,
            branch_id: input.branch_id,
            unsubscribe_token: randomBytes(24).toString('base64url'),
            created_by_user_id: input.created_by_user_id ?? null,
          })
          .returning('*');
    if (!row) throw new Error('Opt-in wrote no email_leads row');

    // The confirmation goes now, in the same transaction as the opt-in: an
    // opt-in that is recorded but never confirmed is the worst of both.
    const lead = await sendNextStep(row as EmailLead, branch.name as string, trx);
    return { lead, enrolled: true };
  };

  // Callers already inside a transaction (the leads map) pass it in.
  return db.isTransaction ? run(db as Knex.Transaction) : db.transaction(run);
}

/**
 * Queues the lead's next email and moves them along, or finishes the
 * sequence. The lead row must already be locked by the caller.
 */
async function sendNextStep(lead: EmailLead, branchName: string, trx: Knex): Promise<EmailLead> {
  const step = DRIP_SEQUENCE[lead.steps_sent];
  if (!step) {
    const [done] = await trx('email_leads')
      .where({ id: lead.id })
      .update({ status: 'completed', next_send_at: null })
      .returning('*');
    return done as EmailLead;
  }

  await enqueueMessage(
    {
      template_code: step.template_code,
      channel: 'email',
      recipient: lead.email,
      branch_id: lead.branch_id,
      customer_id: lead.customer_id,
      email_lead_id: lead.id,
      context: {
        first_name: lead.first_name,
        last_name: lead.last_name,
        branch_name: branchName,
        unsubscribe_url: unsubscribeUrl(lead.unsubscribe_token),
      },
    },
    trx,
  );

  const following = DRIP_SEQUENCE[lead.steps_sent + 1];
  const [updated] = await trx('email_leads')
    .where({ id: lead.id })
    .update({
      steps_sent: lead.steps_sent + 1,
      status: following ? 'active' : 'completed',
      next_send_at: following
        ? new Date(new Date(lead.opted_in_at).getTime() + following.after_days * DAY_MS)
        : null,
    })
    .returning('*');
  return updated as EmailLead;
}

export interface DripSummary {
  sent: number;
  converted: number;
}

/**
 * One pass of the drip: every lead whose next email is due gets it.
 *
 * Claimed with FOR UPDATE SKIP LOCKED in batches, so two copies of the job
 * never send the same step twice, and the message itself is only queued —
 * the message queue does the talking to SMTP.
 */
export async function runColdEmailDrip(
  now: Date = new Date(),
  db: Knex = defaultDb,
): Promise<DripSummary> {
  const summary: DripSummary = { sent: 0, converted: 0 };

  for (;;) {
    const claimed = await db.transaction(async (trx) => {
      const due = (await trx('email_leads')
        .join('branches', 'branches.id', 'email_leads.branch_id')
        .where('email_leads.status', 'active')
        .andWhere('email_leads.next_send_at', '<=', now)
        .orderBy('email_leads.next_send_at', 'asc')
        .limit(BATCH_SIZE)
        .forUpdate('email_leads')
        .skipLocked()
        .select('email_leads.*', 'branches.name as branch_name')) as (EmailLead & {
        branch_name: string;
      })[];

      for (const lead of due) {
        if (await hasBecomeCustomer(lead, trx)) {
          await trx('email_leads')
            .where({ id: lead.id })
            .update({ status: 'converted', next_send_at: null });
          summary.converted += 1;
          continue;
        }
        await sendNextStep(lead, lead.branch_name, trx);
        summary.sent += 1;
      }
      return due.length;
    });

    if (claimed < BATCH_SIZE) break;
  }

  if (summary.sent || summary.converted) logger.info(summary, 'Cold email drip ran');
  return summary;
}

/** An active customer in the same branch, by link or by email address. */
async function hasBecomeCustomer(lead: EmailLead, db: Knex): Promise<boolean> {
  const customer = await db('customers')
    .where({ branch_id: lead.branch_id, status: 'active' })
    .andWhere((qb) => {
      qb.whereRaw('lower(email) = lower(?)', [lead.email]);
      if (lead.customer_id) qb.orWhere('id', lead.customer_id);
    })
    .first('id');
  return !!customer;
}

/**
 * Stops the sequence for good. Anything already queued but not yet sent is
 * withdrawn too: "unsubscribe" followed by one more email is exactly the
 * complaint CASL was written for.
 */
async function stop(
  lead: EmailLead,
  status: Extract<EmailLeadStatus, 'unsubscribed' | 'converted'>,
  trx: Knex,
): Promise<EmailLead> {
  const [updated] = await trx('email_leads')
    .where({ id: lead.id })
    .update({
      status,
      next_send_at: null,
      unsubscribed_at: status === 'unsubscribed' ? new Date() : null,
    })
    .returning('*');

  await trx('message_log')
    .where({ email_lead_id: lead.id, status: 'queued' })
    .update({ status: 'failed', error: `Withdrawn: lead ${status} before it was sent` });

  return updated as EmailLead;
}

/** The link in every email. Idempotent: a second click changes nothing. */
export async function unsubscribe(token: string, db: Knex = defaultDb): Promise<EmailLead> {
  return db.transaction(async (trx) => {
    const lead = (await trx('email_leads')
      .where({ unsubscribe_token: token })
      .forUpdate()
      .first()) as EmailLead | undefined;
    if (!lead) throw notFound('That unsubscribe link is not recognised');
    if (lead.status === 'unsubscribed') return lead;
    return stop(lead, 'unsubscribed', trx);
  });
}

/** Who the link belongs to, so the page can say which address it stops. */
export async function leadForToken(token: string, db: Knex = defaultDb): Promise<EmailLead> {
  const lead = (await db('email_leads').where({ unsubscribe_token: token }).first()) as
    | EmailLead
    | undefined;
  if (!lead) throw notFound('That unsubscribe link is not recognised');
  return lead;
}

export interface EmailLeadView extends EmailLead {
  branch_name: string;
  emails_sent: number;
  next_step: string | null;
}

export interface LeadFilters {
  status?: EmailLeadStatus;
  source?: OptInSource;
}

export async function listEmailLeads(
  scope: BranchScope,
  filters: LeadFilters,
  db: Knex = defaultDb,
): Promise<EmailLeadView[]> {
  const query = applyBranchScope(
    db('email_leads').join('branches', 'branches.id', 'email_leads.branch_id'),
    'email_leads.branch_id',
    scope,
  )
    .select(
      'email_leads.*',
      'branches.name as branch_name',
      db('message_log')
        .whereRaw('message_log.email_lead_id = email_leads.id')
        .andWhere('message_log.status', 'sent')
        .count('*')
        .as('emails_sent'),
    )
    .orderBy('email_leads.opted_in_at', 'desc')
    .limit(500);

  if (filters.status) query.where('email_leads.status', filters.status);
  if (filters.source) query.where('email_leads.source', filters.source);

  const rows = (await query) as (EmailLead & { branch_name: string; emails_sent: string })[];
  return rows.map((row) => ({
    ...row,
    emails_sent: Number(row.emails_sent),
    next_step:
      row.status === 'active' ? (DRIP_SEQUENCE[row.steps_sent]?.label ?? null) : null,
  }));
}

export interface EmailLeadDetail extends EmailLeadView {
  messages: Pick<MessageLogEntry, 'id' | 'template_code' | 'subject' | 'status' | 'sent_at' | 'created_at' | 'error'>[];
}

export async function getEmailLead(
  id: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<EmailLeadDetail> {
  const lead = (await applyBranchScope(
    db('email_leads').join('branches', 'branches.id', 'email_leads.branch_id'),
    'email_leads.branch_id',
    scope,
  )
    .where('email_leads.id', id)
    .first('email_leads.*', 'branches.name as branch_name')) as
    | (EmailLead & { branch_name: string })
    | undefined;
  if (!lead) throw notFound('No such lead');

  const messages = await db('message_log')
    .where({ email_lead_id: id })
    .orderBy('created_at', 'asc')
    .select('id', 'template_code', 'subject', 'status', 'sent_at', 'created_at', 'error');

  return {
    ...lead,
    emails_sent: messages.filter((m) => m.status === 'sent').length,
    next_step: lead.status === 'active' ? (DRIP_SEQUENCE[lead.steps_sent]?.label ?? null) : null,
    messages,
  };
}

/** The office stopping a sequence by hand: they asked on the phone, or they bought. */
export async function stopEmailLead(
  id: string,
  status: Extract<EmailLeadStatus, 'unsubscribed' | 'converted'>,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<EmailLead> {
  return db.transaction(async (trx) => {
    const lead = (await applyBranchScope(trx('email_leads'), 'branch_id', scope)
      .where({ id })
      .forUpdate()
      .first()) as EmailLead | undefined;
    if (!lead) throw notFound('No such lead');
    if (lead.status === 'unsubscribed') {
      throw badRequest('That lead has unsubscribed; only they can opt back in');
    }
    return stop(lead, status, trx);
  });
}

/** Counts for the top of the page. */
export async function coldEmailStats(
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<Record<EmailLeadStatus | 'total' | OptInSource, number>> {
  const [row] = (await applyBranchScope(db('email_leads'), 'branch_id', scope).select(
    db.raw('count(*) as total'),
    db.raw(`count(*) filter (where status = 'active') as active`),
    db.raw(`count(*) filter (where status = 'completed') as completed`),
    db.raw(`count(*) filter (where status = 'unsubscribed') as unsubscribed`),
    db.raw(`count(*) filter (where status = 'converted') as converted`),
    db.raw(`count(*) filter (where source = 'google_ads') as google_ads`),
    db.raw(`count(*) filter (where source = 'door_to_door') as door_to_door`),
  )) as Record<string, string>[];

  const n = (key: string) => Number(row?.[key] ?? 0);
  return {
    total: n('total'),
    active: n('active'),
    completed: n('completed'),
    unsubscribed: n('unsubscribed'),
    converted: n('converted'),
    google_ads: n('google_ads'),
    door_to_door: n('door_to_door'),
  };
}
