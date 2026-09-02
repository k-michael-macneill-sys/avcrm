import type { z } from 'zod';
import { badRequest } from './errors';

/**
 * Parses unknown input with a Zod schema and converts failures into a 400.
 * Kept as a plain function so routes read as: const body = parse(schema, req.body).
 */
export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest(
      'Request validation failed',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
