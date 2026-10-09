import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

/**
 * Paths whose last segment is the permission itself: a customer's pay or
 * card link, a signing or upload token, an unsubscribe link, the one-tap
 * review link. Anyone who can read the log could otherwise open them.
 */
const CAPABILITY_PATHS = [
  /^(\/pay\/(?:card\/)?)[^/?#]+/,
  /^(\/portal\/(?:invoices|cards)\/)[^/?#]+/,
  /^(\/public\/(?:sign|unsubscribe)\/)[^/?#]+/,
  /^(\/app\/sign\/)[^/?#]+/,
  /^(\/uploads\/)[^/?#]+/,
  /^(\/review-requests\/)[^/?#]+(?=\/rat)/,
];

/** The URL as it is safe to keep: capabilities and webhook queries blanked. */
export function redactPath(url: string): string {
  let path = url;
  for (const pattern of CAPABILITY_PATHS) {
    path = path.replace(pattern, '$1[redacted]');
  }
  // Meta's subscription handshake carries the verify token in the query.
  if (path.startsWith('/webhooks/')) path = path.replace(/\?.*$/, '?[redacted]');
  return path;
}

/** One line per request, written when the response finishes. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.info(
      {
        method: req.method,
        path: redactPath(req.originalUrl),
        status: res.statusCode,
        duration_ms: Number(durationMs.toFixed(1)),
        user_id: req.user?.id,
      },
      'request',
    );
  });

  next();
}
