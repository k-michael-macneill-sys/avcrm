import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Knex } from 'knex';
import { z } from 'zod';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { MetaConversation, MetaMessage, MetaPlatform } from '../types/models';
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized } from '../utils/errors';
import { logger } from '../utils/logger';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';
import { applyBranchScope } from '../utils/scope';
import type { QueueSummary } from './messages';
import { SendFailure } from './transport';

/**
 * Facebook Page and Instagram direct messages.
 *
 * Both platforms arrive through one Messenger Platform webhook and leave
 * through one Graph API endpoint, sent with the Page's token — an Instagram
 * business account linked to the Page is answered the same way.
 *
 * Replies follow the message_log rule: nothing talks to Meta from inside a
 * request. The reply endpoint writes a `queued` row and returns; the
 * message-queue worker sends it. So a slow Graph API never holds up the
 * screen, and a failed send is retried and then recorded rather than lost.
 */

/** Rows are claimed in batches this size. */
const BATCH_SIZE = 50;

/** Same lease as message_log: a worker killed mid-send holds nothing. */
const LEASE_MS = 5 * 60_000;

/**
 * Meta's standard messaging window. Outside it the Graph API refuses a plain
 * reply, so the endpoint refuses first — with a reason somebody can act on
 * instead of a queued row that is certain to fail.
 */
export const REPLY_WINDOW_MS = 24 * 60 * 60_000;

/** Meta's own cap on a text message. */
export const MAX_MESSAGE_LENGTH = 2000;

const TIMEOUT_MS = 15_000;

// --- Webhook verification ------------------------------------------------

/**
 * The GET Meta sends once, when the webhook is subscribed in the app
 * dashboard. Echoing hub.challenge proves this server is the one that was
 * configured; the verify token proves the request came from whoever set it.
 */
export function verifyWebhookChallenge(query: Record<string, unknown>): string {
  const expected = config.meta.verifyToken;
  if (!expected) {
    throw new ApiError(503, 'meta_not_configured', 'META_VERIFY_TOKEN is not set');
  }

  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode !== 'subscribe' || typeof token !== 'string' || !safeEqual(token, expected)) {
    throw forbidden('Webhook verification failed');
  }
  if (typeof challenge !== 'string' || challenge === '') {
    throw badRequest('hub.challenge is missing');
  }
  return challenge;
}

/**
 * X-Hub-Signature-256: `sha256=` and the hex HMAC of the exact bytes Meta
 * sent, keyed with the app secret. The only thing that makes an
 * unauthenticated POST from the internet trustworthy — so no secret means
 * every delivery is refused, never waved through.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string | null = config.meta.appSecret,
): void {
  if (!secret) {
    throw new ApiError(503, 'meta_not_configured', 'META_APP_SECRET is not set');
  }
  if (!header || !header.startsWith('sha256=')) {
    throw unauthorized('Missing X-Hub-Signature-256');
  }

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!safeEqual(header.slice('sha256='.length).toLowerCase(), expected)) {
    throw unauthorized('Webhook signature does not match');
  }
}

/** Constant-time, and false rather than a throw when the lengths differ. */
function safeEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Incoming messages ---------------------------------------------------

/*
 * Only the fields this reads. Meta adds to these payloads freely, so unknown
 * keys pass through, and an event that does not fit is skipped on its own
 * rather than failing the delivery it came in — a failed delivery is retried,
 * and would fail the same way every time.
 */
const messagingEventSchema = z.object({
  sender: z.object({ id: z.string().min(1) }),
  recipient: z.object({ id: z.string().min(1) }),
  timestamp: z.number().optional(),
  message: z
    .object({
      mid: z.string().min(1),
      text: z.string().optional(),
      is_echo: z.boolean().optional(),
      is_deleted: z.boolean().optional(),
      attachments: z.array(z.object({ type: z.string() }).passthrough()).optional(),
    })
    .passthrough()
    .optional(),
});

const payloadSchema = z.object({
  object: z.string(),
  entry: z
    .array(
      z.object({
        id: z.string(),
        messaging: z.array(z.unknown()).optional(),
      }).passthrough(),
    )
    .default([]),
});

const PLATFORM_FOR_OBJECT: Record<string, MetaPlatform> = {
  page: 'facebook',
  instagram: 'instagram',
};

export interface WebhookSummary {
  /** New messages from a customer. */
  received: number;
  /** Replies somebody typed into Meta's own inbox, recorded so the thread here is whole. */
  echoes: number;
  /** Redeliveries, reads, reactions, and anything else with nothing to store. */
  ignored: number;
}

/**
 * Stores what a webhook delivery says was said. Idempotent on Meta's message
 * id, because Meta redelivers until it gets a 200 and a redelivery is normal.
 */
export async function handleIncomingWebhook(
  payload: unknown,
  db: Knex = defaultDb,
): Promise<WebhookSummary> {
  const summary: WebhookSummary = { received: 0, echoes: 0, ignored: 0 };

  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw badRequest('Not a Messenger Platform webhook payload');
  }

  const platform = PLATFORM_FOR_OBJECT[parsed.data.object];
  if (!platform) {
    // Page feed changes, Instagram comments, and the like: subscribed to,
    // perhaps, but not messages.
    logger.debug({ object: parsed.data.object }, 'Meta webhook ignored');
    return summary;
  }

  let routing: string | null | undefined;

  for (const entry of parsed.data.entry) {
    for (const raw of entry.messaging ?? []) {
      const event = messagingEventSchema.safeParse(raw);
      const message = event.success ? event.data.message : undefined;
      if (!event.success || !message || message.is_deleted) {
        summary.ignored += 1;
        continue;
      }

      const echo = message.is_echo === true;
      // An echo is the Page talking, so the person is the recipient.
      const externalUserId = echo ? event.data.recipient.id : event.data.sender.id;
      const at = event.data.timestamp ? new Date(event.data.timestamp) : new Date();

      routing ??= await defaultBranch(db);

      const stored = await storeMessage(
        {
          platform,
          externalUserId,
          direction: echo ? 'outbound' : 'inbound',
          text: textOf(message),
          externalMessageId: message.mid,
          at,
          defaultBranchId: routing,
        },
        db,
      );

      if (!stored) summary.ignored += 1;
      else if (echo) summary.echoes += 1;
      else summary.received += 1;
    }
  }

  return summary;
}

/** What to show for a message with no text — a photo, a voice note, a sticker. */
function textOf(message: { text?: string; attachments?: { type: string }[] }): string {
  if (message.text && message.text.trim() !== '') return message.text;
  const kinds = (message.attachments ?? []).map((a) => a.type);
  return kinds.length > 0 ? `[${kinds.join(', ')}]` : '[unsupported message]';
}

/**
 * Where a brand-new conversation goes. With one branch there is nobody to
 * choose; with several, it waits unassigned for corporate, because a Page
 * message says nothing about which town the sender is in.
 */
async function defaultBranch(db: Knex): Promise<string | null> {
  const branches = await db('branches').where({ status: 'active' }).limit(2).select('id');
  return branches.length === 1 ? (branches[0]?.id ?? null) : null;
}

interface StoreInput {
  platform: MetaPlatform;
  externalUserId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  externalMessageId: string;
  at: Date;
  defaultBranchId: string | null;
}

/** False when the message was already here. */
async function storeMessage(input: StoreInput, db: Knex): Promise<boolean> {
  try {
    return await db.transaction(async (trx) => {
      const seen = await trx('meta_messages')
        .where({ external_message_id: input.externalMessageId })
        .first('id');
      if (seen) return false;

      const conversation = await findOrOpenConversation(input, trx);

      await trx('meta_messages').insert({
        conversation_id: conversation.id,
        direction: input.direction,
        message_text: input.text,
        external_message_id: input.externalMessageId,
        status: input.direction === 'inbound' ? 'received' : 'sent',
        sent_at: input.direction === 'outbound' ? input.at : null,
        created_at: input.at,
      });

      // An older message arriving late must not pull the window back.
      await trx('meta_conversations')
        .where({ id: conversation.id })
        .update(
          input.direction === 'inbound'
            ? { last_inbound_at: trx.raw('greatest(last_inbound_at, ?)', [input.at]) }
            : { updated_at: trx.fn.now() },
        );

      return true;
    });
  } catch (err) {
    // Two deliveries of the same message racing: the other one stored it.
    if ((err as { code?: string }).code === '23505') return false;
    throw err;
  }
}

async function findOrOpenConversation(
  input: StoreInput,
  trx: Knex.Transaction,
): Promise<MetaConversation> {
  const key = { platform: input.platform, external_user_id: input.externalUserId };

  const [opened] = (await trx('meta_conversations')
    .insert({ ...key, branch_id: input.defaultBranchId })
    .onConflict(['platform', 'external_user_id'])
    .ignore()
    .returning('*')) as MetaConversation[];
  if (opened) return opened;

  const existing = (await trx('meta_conversations').where(key).first()) as
    | MetaConversation
    | undefined;
  if (!existing) throw new Error('Conversation vanished between insert and select');
  return existing;
}

// --- Sending ---------------------------------------------------------------

export interface MetaSendResult {
  external_message_id: string;
}

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number };
}

/**
 * Meta's codes for "slow down" and "try again": rate limits (4, 17, 32, 613)
 * and a temporary service problem (2). Everything else in a 4xx is about this
 * message — outside the 24-hour window, a person who has blocked the Page, a
 * token that no longer works — and sending it again will not change that.
 */
const RETRYABLE_GRAPH_CODES = new Set([2, 4, 17, 32, 613]);

/**
 * Sends one text message to the person in a conversation, through the Graph
 * API as the Page. Throws SendFailure, marked permanent or not, so the
 * worker knows whether another attempt could help.
 */
export async function sendMetaMessage(
  conversationId: string,
  text: string,
  db: Knex = defaultDb,
): Promise<MetaSendResult> {
  const token = config.meta.pageAccessToken;
  if (!token) {
    // Not permanent: the message is fine, the install is missing a setting.
    throw new SendFailure('META_PAGE_ACCESS_TOKEN is not set', false, 'meta_not_configured');
  }

  const conversation = (await db('meta_conversations').where({ id: conversationId }).first()) as
    | MetaConversation
    | undefined;
  if (!conversation) {
    throw new SendFailure(`Conversation ${conversationId} does not exist`, true);
  }

  let status: number;
  let body: unknown;
  try {
    const response = await fetch(`${config.meta.graphApiBase}/me/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: conversation.external_user_id },
        messaging_type: 'RESPONSE',
        message: { text },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
    body = await response.json().catch(() => null);
  } catch (err) {
    // Never reached Meta: DNS, refused, or timed out. Always worth another go.
    throw new SendFailure(
      err instanceof Error ? err.message : 'The Graph API could not be reached',
      false,
    );
  }

  const messageId = (body as { message_id?: unknown } | null)?.message_id;
  if (status >= 200 && status < 300 && typeof messageId === 'string') {
    return { external_message_id: messageId };
  }

  const error = (body as GraphError | null)?.error;
  const reason = error?.message ?? `The Graph API answered ${status}`;
  const retryable =
    status >= 500 ||
    status === 429 ||
    (error?.code !== undefined && RETRYABLE_GRAPH_CODES.has(error.code)) ||
    // A 2xx without a message id is Meta misbehaving, not the message.
    (status >= 200 && status < 300);

  throw new SendFailure(
    reason,
    !retryable,
    error?.code !== undefined ? `graph_${error.code}${error.error_subcode ? `_${error.error_subcode}` : ''}` : undefined,
  );
}

/**
 * Queues a reply from a member of staff. Refused up front when it could not
 * possibly be delivered, so the person typing finds out now rather than
 * from a failed row later.
 */
export async function queueMetaReply(
  conversationId: string,
  text: string,
  userId: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<MetaMessage> {
  const trimmed = text.trim();
  if (!trimmed) throw badRequest('A reply needs some text');
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw badRequest(`A reply can be at most ${MAX_MESSAGE_LENGTH} characters`);
  }
  if (!config.meta.pageAccessToken) {
    throw new ApiError(
      503,
      'meta_not_configured',
      'Facebook and Instagram replies are not set up: META_PAGE_ACCESS_TOKEN is missing',
    );
  }

  const conversation = await getConversation(conversationId, scope, db);

  const lastInbound = conversation.last_inbound_at?.getTime() ?? 0;
  if (Date.now() - lastInbound > REPLY_WINDOW_MS) {
    throw conflict(
      'Meta only allows a reply within 24 hours of the customer’s last message. ' +
        'Reach them another way, or wait for them to write again.',
    );
  }

  return db.transaction(async (trx) => {
    const [row] = (await trx('meta_messages')
      .insert({
        conversation_id: conversation.id,
        direction: 'outbound',
        message_text: trimmed,
        status: 'queued',
        sent_by_user_id: userId,
      })
      .returning('*')) as MetaMessage[];
    if (!row) throw new Error('Insert returned no meta_messages row');

    await trx('meta_conversations')
      .where({ id: conversation.id })
      .update({ updated_at: trx.fn.now() });

    return row;
  });
}

/**
 * One pass of the worker over queued replies. The same shape as
 * sendQueued for message_log: a short claim transaction with SKIP LOCKED and
 * a lease, then the sends outside it, then the outcome stamped per row.
 */
export async function sendQueuedMeta(
  limit = BATCH_SIZE,
  db: Knex = defaultDb,
): Promise<QueueSummary> {
  const summary: QueueSummary = { claimed: 0, sent: 0, failed: 0, retrying: 0, rejected: 0 };

  const claimed = await claim(limit, db);
  summary.claimed = claimed.length;

  for (const message of claimed) {
    try {
      const result = await sendMetaMessage(message.conversation_id, message.message_text, db);

      await db.transaction(async (trx) => {
        // Meta echoes every Page message back through the webhook, ours
        // included, and the echo can land before this does. It carries the
        // same id, so the echo's copy goes and this row — which knows who
        // wrote it — stays.
        await trx('meta_messages')
          .where({ external_message_id: result.external_message_id })
          .whereNot({ id: message.id })
          .delete();

        await trx('meta_messages').where({ id: message.id }).update({
          status: 'sent',
          sent_at: new Date(),
          external_message_id: result.external_message_id,
          error: null,
        });
      });
      summary.sent += 1;
    } catch (err) {
      const permanent = err instanceof SendFailure && err.permanent;
      const spent = message.attempts >= config.messaging.maxAttempts;
      const done = permanent || spent;

      await db('meta_messages')
        .where({ id: message.id })
        .update({
          status: done ? 'failed' : 'queued',
          error: err instanceof Error ? err.message : String(err),
        });

      if (permanent) {
        summary.rejected += 1;
        logger.error({ err, meta_message_id: message.id }, 'Meta refused the reply');
      } else if (spent) {
        summary.failed += 1;
        logger.error(
          { err, meta_message_id: message.id, attempts: message.attempts },
          'Meta reply failed after every attempt',
        );
      } else {
        summary.retrying += 1;
        logger.warn(
          { err, meta_message_id: message.id, attempts: message.attempts },
          'Meta reply failed, will retry',
        );
      }
    }
  }

  return summary;
}

async function claim(limit: number, db: Knex): Promise<MetaMessage[]> {
  return db.transaction(async (trx) => {
    const rows = (await trx('meta_messages')
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
      .select('*')) as MetaMessage[];

    if (rows.length === 0) return [];

    await trx('meta_messages')
      .whereIn(
        'id',
        rows.map((row) => row.id),
      )
      .update({
        attempts: trx.raw('attempts + 1'),
        last_attempt_at: new Date(),
      });

    return rows.map((row) => ({ ...row, attempts: row.attempts + 1 }));
  });
}

// --- Reading and routing -----------------------------------------------------

export interface ConversationFilters {
  platform?: MetaPlatform;
  customer_id?: string;
  /** Corporate's triage view: conversations no branch has been given yet. */
  unassigned?: boolean;
}

export interface ConversationSummary extends MetaConversation {
  customer_name: string | null;
  last_message_text: string | null;
  last_message_direction: 'inbound' | 'outbound' | null;
  last_message_at: Date | null;
}

/**
 * The inbox, most recently active first. A branch-scoped caller never sees an
 * unassigned conversation: until it has a branch it is corporate's to route.
 */
export async function listConversations(
  scope: BranchScope,
  filters: ConversationFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<ConversationSummary>> {
  const base = applyBranchScope(db('meta_conversations as c'), 'c.branch_id', scope);

  if (filters.platform) base.andWhere('c.platform', filters.platform);
  if (filters.customer_id) base.andWhere('c.customer_id', filters.customer_id);
  if (filters.unassigned) base.whereNull('c.branch_id');

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .leftJoin('customers as cu', 'cu.id', 'c.customer_id')
      .joinRaw(
        `left join lateral (
           select m.message_text, m.direction, m.created_at
             from meta_messages m
            where m.conversation_id = c.id
            order by m.created_at desc, m.id desc
            limit 1
         ) last on true`,
      )
      .orderBy([
        { column: 'c.updated_at', order: 'desc' },
        { column: 'c.id', order: 'desc' },
      ])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select(
        'c.*',
        db.raw(`nullif(trim(concat_ws(' ', cu.first_name, cu.last_name)), '') as customer_name`),
        'last.message_text as last_message_text',
        'last.direction as last_message_direction',
        'last.created_at as last_message_at',
      ),
    base.clone().count<{ count: string }[]>({ count: '*' }).first(),
  ]);

  return paginated(rows as ConversationSummary[], Number(countRow?.count ?? 0), pagination);
}

export async function getConversation(
  id: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<MetaConversation> {
  const conversation = (await applyBranchScope(
    db('meta_conversations').where({ id }),
    'branch_id',
    scope,
  ).first()) as MetaConversation | undefined;

  if (!conversation) throw notFound('Conversation not found');
  return conversation;
}

/** A thread, oldest first, the way it reads. */
export async function listConversationMessages(
  conversationId: string,
  scope: BranchScope,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<MetaMessage>> {
  await getConversation(conversationId, scope, db);

  const base = db('meta_messages').where({ conversation_id: conversationId });

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .orderBy([
        { column: 'created_at', order: 'asc' },
        { column: 'id', order: 'asc' },
      ])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('*'),
    base.clone().count<{ count: string }[]>({ count: '*' }).first(),
  ]);

  return paginated(rows as MetaMessage[], Number(countRow?.count ?? 0), pagination);
}

export interface ConversationUpdate {
  branch_id?: string;
  customer_id?: string | null;
}

/**
 * Routes a conversation to a branch, and says which customer it is. Linking
 * a customer to an unassigned conversation also gives it the customer's
 * branch — the question of where it belongs has just been answered.
 *
 * Only corporate may move a conversation between branches: a branch-scoped
 * caller can link a customer, not hand the thread to somebody else.
 */
export async function updateConversation(
  id: string,
  scope: BranchScope,
  input: ConversationUpdate,
  db: Knex = defaultDb,
): Promise<MetaConversation> {
  const conversation = await getConversation(id, scope, db);
  const changes: Partial<MetaConversation> = {};

  if (input.branch_id !== undefined && input.branch_id !== conversation.branch_id) {
    if (scope.kind === 'branch' && input.branch_id !== scope.branchId) {
      throw forbidden('You may only route conversations to your own branch');
    }
    const branch = await db('branches').where({ id: input.branch_id }).first('id');
    if (!branch) throw badRequest('That branch does not exist');
    changes.branch_id = input.branch_id;
  }

  if (input.customer_id !== undefined) {
    if (input.customer_id === null) {
      changes.customer_id = null;
    } else {
      const customer = (await db('customers').where({ id: input.customer_id }).first('id', 'branch_id')) as
        | { id: string; branch_id: string }
        | undefined;
      const branchId = changes.branch_id ?? conversation.branch_id ?? customer?.branch_id;
      if (!customer || (scope.kind === 'branch' && customer.branch_id !== scope.branchId)) {
        throw badRequest('That customer does not exist');
      }
      if (customer.branch_id !== branchId) {
        throw badRequest('That customer belongs to a different branch than this conversation');
      }
      changes.customer_id = customer.id;
      changes.branch_id ??= conversation.branch_id ?? customer.branch_id;
    }
  }

  if (Object.keys(changes).length === 0) return conversation;

  const [updated] = (await db('meta_conversations')
    .where({ id })
    .update(changes)
    .returning('*')) as MetaConversation[];
  if (!updated) throw notFound('Conversation not found');
  return updated;
}
