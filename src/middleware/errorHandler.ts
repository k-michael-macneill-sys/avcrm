import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/errors';
import { logger } from '../utils/logger';

/** 404 for anything no route matched. Mounted after all routes. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` },
  });
}

/**
 * Single place that turns thrown values into JSON responses.
 * Must keep four arguments — that is how Express recognises an error handler.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    logger.warn(
      { status: err.status, code: err.code, path: req.path, method: req.method },
      err.message,
    );
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // Body-parser throws this for malformed JSON.
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: { code: 'bad_request', message: 'Request body is not valid JSON' },
    });
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  res.status(500).json({
    error: { code: 'internal_error', message: 'Internal server error' },
  });
}
