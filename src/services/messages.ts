import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type {
  MessageChannel,
  MessageLogEntry,
  MessageStatus,
  MessageTemplate,
  TemplateCode,
} from '../types/models';
import { badRequest, notFound } from '../utils/errors';
import { logger } from '../utils/logger';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';
import { applyBranchScope } from '../utils/scope';
import { sendEmail, sendSms } from './notifications';

/**
 * The outbound queue. Nothing in the application talks to a provider
 * directly: callers enqueue, and the worker sends. That is what makes
 * message_log a complete record, and what keeps an API response from ever
 * waiting on SMTP.
 */

/** Rows are claimed in batches this size. */
const BATCH_SIZE = 50;

/**
 * How long a claimed row is left alone before another worker may retry it.
 *
 * The claim marks last_attempt_at and commits before the send starts, so a
 * worker killed mid-send does not hold a lock — the row simply becomes
 * eligible again once the lease runs out.
 */
const LEASE_MS = 5 * 60_000;

export type RenderContext = Record<string, string | number | null | undefined>;

/**
 * Fills {{token}} placeholders. An unknown or null token renders empty and is
 * logged: mailing a customer a literal {{customer_first_name}} is worse than
 * a gap, and the warning is what gets the template fixed.
 */
export function renderTemplate(
  text: string,
  context: RenderContext,
  where = 'template',
): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, token: string) => {
    const value = context[token];
    if (value === undefined || value === null || value === '') {
      logger.warn({ token, where }, 'Message template token had no value');
      return '';
    }
    return String(value);
  });
}

/**
 * The template for a code and channel: the branch's own wording if it has
 * any, otherwise the global default.
 */
export async function templateFor(
  code: string,
  channel: MessageChannel,
  branchId: string | null,
  db: Knex = defaultDb,
): Promise<MessageTemplate> {
  const query = db('message_templates').where({ code, channel });

  if (branchId) {
    query.andWhere((qb) => qb.where('branch_id', branchId).orWhereNull('branch_id'));
  } else {
    query.whereNull('branch_id');
  }

  // A branch row sorts before the global one, so the override wins.
  const template = await query.orderByRaw('branch_id nulls last').first();
  if (!template) {
    throw notFound(`No ${channel} template for ${code}`);
  }
  return template;
}

export interface EnqueueInput {
  template_code: TemplateCode;
  channel: MessageChannel;
  recipient: string;
  context: RenderContext;
  branch_id?: string | null;
  customer_id?: string | null;
  work_order_id?: string | null;
}

/**
 * Renders now, sends later. The rendered subject and body are stored on the
 * row, so editing a template afterwards cannot rewrite what was sent, and the
 * worker needs no context of its own.
 */
export async function enqueueMessage(
  input: EnqueueInput,
  db: Knex = defaultDb,
): Promise<MessageLogEntry> {
  const recipient = input.recipient.trim();
  if (!recipient) {
    throw badRequest('A message needs a recipient');
  }

  const template = await templateFor(
    input.template_code,
    input.channel,
    input.branch_id ?? null,
    db,
  );

  const [row] = await db('message_log')
    .insert({
      branch_id: input.branch_id ?? null,
      customer_id: input.customer_id ?? null,
      work_order_id: input.work_order_id ?? null,
      template_code: input.template_code,
      channel: input.channel,
      recipient,
      subject: template.subject
        ? renderTemplate(template.subject, input.context, `${input.template_code}.subject`)
        : null,
      body: renderTemplate(template.body, input.context, `${input.template_code}.body`),
      status: 'queued',
    })
    .returning('*');

  if (!row) {
    throw new Error('Insert returned no message_log row');
  }
  return row;
}

export interface QueueSummary {
  claimed: number;
  sent: number;
  failed: number;
  /** Left queued for another pass, because the attempt budget is not spent. */
  retrying: number;
}

/**
 * One pass of the worker. Claims what is due, sends it, records the outcome.
 *
 * The claim is its own short transaction using FOR UPDATE SKIP LOCKED, so two
 * workers never take the same row and neither holds a lock across a network
 * call to the provider.
 */
export async function sendQueued(
  limit = BATCH_SIZE,
  db: Knex = defaultDb,
): Promise<QueueSummary> {
  const summary: QueueSummary = { claimed: 0, sent: 0, failed: 0, retrying: 0 };

  const claimed = await claim(limit, db);
  summary.claimed = claimed.length;

  for (const message of claimed) {
    try {
      const result =
        message.channel === 'sms'
          ? await sendSms(message.recipient, message.body)
          : await sendEmail(message.recipient, message.subject ?? '', message.body);

      await db('message_log').where({ id: message.id }).update({
        status: 'sent',
        sent_at: new Date(),
        provider_message_id: result.provider_message_id,
        error: null,
      });
      summary.sent += 1;
    } catch (err) {
      // attempts was already incremented by the claim, so this row has had
      // its go. Out of budget means failed; otherwise the lease expiring puts
      // it back in front of a worker.
      const spent = message.attempts >= config.messaging.maxAttempts;
      await db('message_log')
        .where({ id: message.id })
        .update({
          status: spent ? 'failed' : 'queued',
          error: err instanceof Error ? err.message : String(err),
        });

      if (spent) {
        summary.failed += 1;
        logger.error(
          { err, message_id: message.id, attempts: message.attempts },
          'Message failed permanently',
        );
      } else {
        summary.retrying += 1;
        logger.warn(
          { err, message_id: message.id, attempts: message.attempts },
          'Message send failed, will retry',
        );
      }
    }
  }

  return summary;
}

async function claim(limit: number, db: Knex): Promise<MessageLogEntry[]> {
  return db.transaction(async (trx) => {
    const rows = (await trx('message_log')
      .where({ status: 'queued' })
      .andWhere((qb) =>
        qb
          .whereNull('last_attempt_at')
          .orWhere('last_attempt_at', '<', new Date(Date.now() - LEASE_MS)),
      )
      .orderBy('created_at', 'asc')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .select('*')) as MessageLogEntry[];

    if (rows.length === 0) return [];

    await trx('message_log')
      .whereIn(
        'id',
        rows.map((row) => row.id),
      )
      .update({
        attempts: trx.raw('attempts + 1'),
        last_attempt_at: new Date(),
      });

    // Reflect the increment the caller is about to reason about.
    return rows.map((row) => ({ ...row, attempts: row.attempts + 1 }));
  });
}

export interface MessageFilters {
  status?: MessageStatus;
  channel?: MessageChannel;
  template_code?: string;
  customer_id?: string;
  work_order_id?: string;
}

export async function listMessageLog(
  scope: BranchScope,
  filters: MessageFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<MessageLogEntry>> {
  const base = applyBranchScope(db('message_log'), 'branch_id', scope);

  if (filters.status) base.andWhere({ status: filters.status });
  if (filters.channel) base.andWhere({ channel: filters.channel });
  if (filters.template_code) base.andWhere({ template_code: filters.template_code });
  if (filters.customer_id) base.andWhere({ customer_id: filters.customer_id });
  if (filters.work_order_id) base.andWhere({ work_order_id: filters.work_order_id });

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('*'),
    base.clone().count<{ count: string }[]>({ count: '*' }).first(),
  ]);

  return paginated(rows, Number(countRow?.count ?? 0), pagination);
}

/** Global templates, plus the caller's branch overrides. */
export async function listMessageTemplates(
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<MessageTemplate[]> {
  const query = db('message_templates');

  if (scope.kind === 'branch') {
    query.where((qb) => qb.where('branch_id', scope.branchId).orWhereNull('branch_id'));
  }

  return query
    .orderBy([
      { column: 'code', order: 'asc' },
      { column: 'channel', order: 'asc' },
      { column: 'branch_id', order: 'asc' },
    ])
    .select('*');
}
