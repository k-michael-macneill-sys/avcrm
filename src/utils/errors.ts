/**
 * Errors that carry an HTTP status. Anything thrown that is not an ApiError is
 * treated as a 500 by the error handler and logged with a stack trace.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new ApiError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have access to this resource') =>
  new ApiError(403, 'forbidden', message);

export const notFound = (message = 'Resource not found') =>
  new ApiError(404, 'not_found', message);

export const conflict = (message: string, details?: unknown) =>
  new ApiError(409, 'conflict', message, details);
