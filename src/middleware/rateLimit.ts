import type { NextFunction, Request, Response } from 'express';
import { tooManyRequests } from '../utils/errors';

/**
 * Throttling for the endpoints that are reachable without a session.
 *
 * `/auth/login` is a password oracle open to the internet: without a limit,
 * a list of common passwords against one known address is free, and nothing
 * in the log distinguishes it from ordinary traffic until someone gets in.
 *
 * Two rules run on a login, and both must pass, because they stop different
 * attacks:
 *
 *   - by address — one host working through many accounts;
 *   - by email — many hosts working on one account.
 *
 * A sliding window rather than a fixed one: with fixed windows an attacker
 * gets `max` attempts at the end of one window and `max` more at the start of
 * the next, which is twice the budget at the moment it matters.
 *
 * **A successful sign-in is forgiven.** The hit is recorded first and released
 * when the response comes back under 400, so an operator signing in on the
 * truck, the office desktop and a phone never spends the budget — only
 * failures accumulate. That is what makes a tight limit safe to set.
 *
 * Registration is the exception, and `forgiveSuccess: false` says so there: a
 * sign-up that works is the thing being abused, not evidence of a legitimate
 * user, so it counts against the limit like any other attempt.
 *
 * State is in this process and nowhere else. That suits the deployment, which
 * runs one application container; a second one would keep its own counters and
 * the effective limit would be per-container. Moving this to Postgres or Redis
 * is the change to make when there are two, and the interface would not move.
 */

interface Hit {
  at: number;
  /** Released on a successful response, so only failures count against it. */
  forgiven: boolean;
}

const store = new Map<string, Hit[]>();

export interface RateLimitRule {
  /** Names the bucket, so two rules on one request cannot collide. */
  name: string;
  windowMs: number;
  max: number;
  /**
   * What is being counted. Returning null skips this rule for this request —
   * a login with no email in the body has nothing to key on, and the address
   * rule still applies.
   */
  key: (req: Request) => string | null;
  message: string;
  /**
   * Whether a successful response releases the hit. True for a sign-in, where
   * success means a legitimate user and the budget should only track failures.
   *
   * False for registration, where success *is* the thing being abused: a
   * script creating one valid account after another would otherwise forgive
   * itself every time and never meet the limit at all.
   */
  forgiveSuccess?: boolean;
}

function recent(bucket: Hit[], since: number): Hit[] {
  return bucket.filter((hit) => hit.at > since && !hit.forgiven);
}

export function rateLimit(...rules: RateLimitRule[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const taken: Hit[] = [];
    const forgivable: Hit[] = [];

    for (const rule of rules) {
      const value = rule.key(req);
      if (value === null) continue;

      const id = `${rule.name}:${value}`;
      const since = now - rule.windowMs;
      const bucket = recent(store.get(id) ?? [], since);

      if (bucket.length >= rule.max) {
        // How long until the oldest hit falls out of the window, which is when
        // one attempt frees up. Told plainly rather than left to guesswork.
        const oldest = bucket[0]?.at ?? now;
        const retryAfter = Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000));

        store.set(id, bucket);
        // Release anything this request already took from an earlier rule: it
        // was refused, so it should not also cost the other budget.
        for (const hit of taken) hit.forgiven = true;

        res.setHeader('Retry-After', String(retryAfter));
        next(tooManyRequests(rule.message, { retry_after_seconds: retryAfter }));
        return;
      }

      const hit: Hit = { at: now, forgiven: false };
      bucket.push(hit);
      taken.push(hit);
      if (rule.forgiveSuccess !== false) forgivable.push(hit);
      store.set(id, bucket);
    }

    if (forgivable.length > 0) {
      res.on('finish', () => {
        if (res.statusCode < 400) {
          for (const hit of forgivable) hit.forgiven = true;
        }
      });
    }

    next();
  };
}

/**
 * Drops everything outside the longest window we use. Without this the map
 * grows by one key per address that ever touched the endpoint.
 */
export function sweepRateLimits(olderThanMs: number, now = Date.now()): void {
  for (const [id, bucket] of store) {
    const live = recent(bucket, now - olderThanMs);
    if (live.length === 0) store.delete(id);
    else store.set(id, live);
  }
}

/** For tests, which must not inherit the previous test's attempts. */
export function resetRateLimits(): void {
  store.clear();
}
