import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { MessageChannel, ReviewRequest, ReviewRoute } from '../types/models';
import { badRequest, conflict, notFound } from '../utils/errors';
import { logger } from '../utils/logger';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';
import { applyBranchScope } from '../utils/scope';
import { enqueueMessage } from './messages';

/**
 * The review gate from the spec: ask a day after the work, send the happy
 * ones to Google and route the unhappy ones to the branch manager instead of
 * to a public star rating.
 */

/** A day after the visit, so the driveway has been walked on. */
const ASK_AFTER_HOURS = 24;

/**
 * How far back a run will look. Bounded so the first run after deploying this
 * does not mail every customer in the history of the company, and wide enough
 * that a few missed nights catch up on their own.
 */
const LOOKBACK_DAYS = 7;

/**
 * One ask per customer per 90 days. A season is long, and a list that gets
 * asked after every snowfall stops answering — which costs more than the
 * reviews are worth.
 */
const COOLDOWN_DAYS = 90;

/** 4 and 5 go to Google; 3 and below go to someone who can fix it. */
const GOOD_RATING = 4;

export interface ReviewFilters {
  routed_to?: ReviewRoute;
  answered?: boolean;
  customer_id?: string;
}

export async function listReviewRequests(
  scope: BranchScope,
  filters: ReviewFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<ReviewRequest>> {
  const base = applyBranchScope(db('review_requests'), 'branch_id', scope);

  if (filters.routed_to) base.andWhere({ routed_to: filters.routed_to });
  if (filters.customer_id) base.andWhere({ customer_id: filters.customer_id });
  if (filters.answered !== undefined) {
    if (filters.answered) base.whereNotNull('completed_at');
    else base.whereNull('completed_at');
  }

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .orderBy([
        { column: 'sent_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('*'),
    base.clone().count<{ count: string }[]>({ count: '*' }).first(),
  ]);

  return paginated(rows, Number(countRow?.count ?? 0), pagination);
}

export async function getReviewRequest(
  id: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<ReviewRequest> {
  const row = await applyBranchScope(db('review_requests'), 'branch_id', scope)
    .andWhere({ id })
    .first();
  if (!row) {
    throw notFound('Review request not found');
  }
  return row;
}

export interface RatingResult {
  review_request: ReviewRequest;
  routed_to: ReviewRoute;
  /** Where a happy customer is sent next; null for internal feedback. */
  redirect_url: string | null;
}

/**
 * The one tap. Public and unauthenticated — a customer has no account — with
 * the row's random id serving as the capability. Answering the same way twice
 * is treated as the same answer, because a customer who taps the link again
 * should not be shown an error.
 */
export async function submitRating(
  id: string,
  rating: number,
  db: Knex = defaultDb,
): Promise<RatingResult> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw badRequest('rating must be a whole number from 1 to 5');
  }

  const result = await db.transaction(async (trx) => {
    const request = await trx('review_requests').where({ id }).forUpdate().first();
    if (!request) {
      throw notFound('Review request not found');
    }

    if (request.completed_at) {
      if (request.rating_response !== rating) {
        throw conflict('This review has already been answered');
      }
      // Same answer again: the customer tapped twice.
      return { request, alreadyAnswered: true };
    }

    const routedTo: ReviewRoute =
      rating >= GOOD_RATING ? 'google_review' : 'internal_feedback';

    const [updated] = await trx('review_requests')
      .where({ id })
      .update({
        rating_response: rating,
        routed_to: routedTo,
        completed_at: new Date(),
      })
      .returning('*');
    if (!updated) {
      throw notFound('Review request not found');
    }

    return { request: updated, alreadyAnswered: false };
  });

  const request = result.request;
  const routedTo = request.routed_to ?? 'internal_feedback';

  if (!result.alreadyAnswered && routedTo === 'internal_feedback') {
    await alertBranchManager(request, db);
  }

  return {
    review_request: request,
    routed_to: routedTo,
    redirect_url:
      routedTo === 'google_review' ? config.messaging.googleReviewUrl : null,
  };
}

/** A rating of 3 or less is a problem report, so a person hears about it. */
async function alertBranchManager(request: ReviewRequest, db: Knex): Promise<void> {
  const row = (await db('customers')
    .join('branches', 'branches.id', 'customers.branch_id')
    .leftJoin('users as manager', 'manager.id', 'branches.manager_user_id')
    .leftJoin('properties', 'properties.customer_id', 'customers.id')
    .where('customers.id', request.customer_id)
    .first([
      'customers.first_name',
      'customers.last_name',
      'customers.email',
      'customers.phone',
      'branches.name as branch_name',
      'manager.email as manager_email',
    ])) as
    | {
        first_name: string;
        last_name: string;
        email: string | null;
        phone: string | null;
        branch_name: string;
        manager_email: string | null;
      }
    | undefined;

  if (!row?.manager_email) {
    logger.warn(
      { review_request_id: request.id },
      'Low rating with no branch manager to tell',
    );
    return;
  }

  await enqueueMessage(
    {
      template_code: 'low_rating_internal',
      channel: 'email',
      recipient: row.manager_email,
      branch_id: request.branch_id,
      customer_id: request.customer_id,
      work_order_id: request.work_order_id,
      context: {
        customer_name: `${row.first_name} ${row.last_name}`,
        customer_email: row.email ?? 'no email on file',
        customer_phone: row.phone ?? 'no phone on file',
        branch_name: row.branch_name,
        rating: request.rating_response,
      },
    },
    db,
  );
}

export interface ReviewRunSummary {
  ran_at: string;
  considered: number;
  asked: number;
  /** Skipped because the customer was asked inside the cooldown. */
  in_cooldown: number;
  /** Skipped because there is no way to reach the customer. */
  unreachable: number;
}

interface CandidateRow {
  work_order_id: string;
  customer_id: string;
  branch_id: string;
  completed_at: Date;
  first_name: string;
  email: string | null;
  phone: string | null;
  preferred_contact: string;
  address_line1: string;
  branch_name: string;
}

/**
 * Finds visits finished at least a day ago that nobody has been asked about,
 * and queues the ask. `now` is injectable so the window can be exercised
 * without waiting a day.
 */
export async function runReviewRequests(
  now: Date = new Date(),
  db: Knex = defaultDb,
): Promise<ReviewRunSummary> {
  const summary: ReviewRunSummary = {
    ran_at: now.toISOString(),
    considered: 0,
    asked: 0,
    in_cooldown: 0,
    unreachable: 0,
  };

  const askBefore = new Date(now.getTime() - ASK_AFTER_HOURS * 3_600_000);
  const lookBackTo = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);

  const candidates = (await db('work_orders')
    .join('contracts', 'contracts.id', 'work_orders.contract_id')
    .join('customers', 'customers.id', 'contracts.customer_id')
    .join('properties', 'properties.id', 'work_orders.property_id')
    .join('branches', 'branches.id', 'work_orders.branch_id')
    .leftJoin('review_requests', 'review_requests.work_order_id', 'work_orders.id')
    .where('work_orders.status', 'completed')
    .andWhere('work_orders.completed_at', '<=', askBefore)
    .andWhere('work_orders.completed_at', '>=', lookBackTo)
    .whereNull('review_requests.id')
    .orderBy('work_orders.completed_at', 'asc')
    .select([
      'work_orders.id as work_order_id',
      'work_orders.completed_at',
      'work_orders.branch_id',
      'customers.id as customer_id',
      'customers.first_name',
      'customers.email',
      'customers.phone',
      'customers.preferred_contact',
      'properties.address_line1',
      'branches.name as branch_name',
    ])) as unknown as CandidateRow[];

  summary.considered = candidates.length;

  for (const candidate of candidates) {
    // Re-read per candidate rather than once up front: two visits for the
    // same customer in one run must not both get an ask.
    const recent = await db('review_requests')
      .where({ customer_id: candidate.customer_id })
      .andWhere('sent_at', '>=', new Date(now.getTime() - COOLDOWN_DAYS * 86_400_000))
      .first('id');
    if (recent) {
      summary.in_cooldown += 1;
      continue;
    }

    const channel = channelFor(candidate);
    if (!channel) {
      summary.unreachable += 1;
      logger.info(
        { customer_id: candidate.customer_id },
        'No usable contact method; review request skipped',
      );
      continue;
    }

    await db.transaction(async (trx) => {
      const [request] = await trx('review_requests')
        .insert({
          customer_id: candidate.customer_id,
          work_order_id: candidate.work_order_id,
          branch_id: candidate.branch_id,
          channel: channel.channel,
          sent_at: now,
        })
        .returning('*');
      if (!request) {
        throw new Error('Insert returned no review_request row');
      }

      await enqueueMessage(
        {
          template_code: 'review_request',
          channel: channel.channel,
          recipient: channel.recipient,
          branch_id: candidate.branch_id,
          customer_id: candidate.customer_id,
          work_order_id: candidate.work_order_id,
          context: {
            customer_first_name: candidate.first_name,
            address_line1: candidate.address_line1,
            branch_name: candidate.branch_name,
            ...ratingLinks(request.id),
          },
        },
        trx,
      );
    });

    summary.asked += 1;
  }

  logger.info(summary, 'Review request run complete');
  return summary;
}

/** Honours preferred_contact, falling back to whatever is on file. */
function channelFor(
  candidate: CandidateRow,
): { channel: MessageChannel; recipient: string } | null {
  if (candidate.preferred_contact === 'sms' && candidate.phone) {
    return { channel: 'sms', recipient: candidate.phone };
  }
  if (candidate.email) {
    return { channel: 'email', recipient: candidate.email };
  }
  if (candidate.phone) {
    return { channel: 'sms', recipient: candidate.phone };
  }
  return null;
}

/**
 * One link per star, because the whole point is a single tap. The template
 * decides how to lay them out.
 */
export function ratingLinks(reviewRequestId: string): Record<string, string> {
  const base = `${config.messaging.appBaseUrl}/review-requests/${reviewRequestId}/rate`;
  const links: Record<string, string> = { rating_url: base };
  for (let rating = 1; rating <= 5; rating += 1) {
    links[`rating_url_${rating}`] = `${base}?rating=${rating}`;
  }
  return links;
}
