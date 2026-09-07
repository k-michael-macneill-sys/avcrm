import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

/** One line per request, written when the response finishes. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.info(
      {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        duration_ms: Number(durationMs.toFixed(1)),
        user_id: req.user?.id,
      },
      'request',
    );
  });

  next();
}
