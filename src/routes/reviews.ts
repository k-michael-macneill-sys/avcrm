import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, resolveBranchScope } from '../middleware/auth';
import {
  getReviewRequest,
  listReviewRequests,
  submitRating,
  type RatingResult,
} from '../services/reviews';
import { REVIEW_ROUTES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

export const reviewRequestsRouter = Router();

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });
const ratingSchema = z.object({ rating: z.coerce.number().int().min(1).max(5) });

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  routed_to: z.enum(REVIEW_ROUTES).optional(),
  answered: booleanish.optional(),
  customer_id: z.string().uuid().optional(),
});

/**
 * The one-tap link from the email. Public and unauthenticated, because the
 * customer has no account — the row's random id is the capability.
 *
 * A GET that writes is not something to do lightly, but an emailed link is a
 * GET and nothing else, and the whole feature is one tap. A good rating
 * redirects straight to the public review page; a poor one is kept in here
 * and the branch manager is told.
 *
 * Declared before requireAuth is mounted below, so it stays open.
 */
reviewRequestsRouter.get(
  '/:id/rate',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const { rating } = parse(ratingSchema, req.query);

    const result = await submitRating(id, rating);
    if (result.redirect_url) {
      res.redirect(302, result.redirect_url);
      return;
    }

    res.json({ data: acknowledge(result) });
  }),
);

/** The same action for an API client that can send a body. */
reviewRequestsRouter.post(
  '/:id/rating',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const { rating } = parse(ratingSchema, req.body);

    res.json({ data: acknowledge(await submitRating(id, rating)) });
  }),
);

// Everything below needs a login.
reviewRequestsRouter.use(requireAuth);

reviewRequestsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);

    res.json(
      await listReviewRequests(
        scope,
        {
          routed_to: query.routed_to,
          answered: query.answered,
          customer_id: query.customer_id,
        },
        { page: query.page, page_size: query.page_size },
      ),
    );
  }),
);

reviewRequestsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await getReviewRequest(id, scope) });
  }),
);

/**
 * What the customer sees back. Deliberately thin: it says the rating landed
 * and nothing about who else was told.
 */
function acknowledge(result: RatingResult) {
  return {
    id: result.review_request.id,
    rating: result.review_request.rating_response,
    routed_to: result.routed_to,
    redirect_url: result.redirect_url,
    message:
      result.routed_to === 'google_review'
        ? 'Thanks! We would love a public review.'
        : 'Thanks for telling us — someone from the branch will be in touch.',
  };
}
