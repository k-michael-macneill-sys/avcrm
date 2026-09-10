/** Postgres error codes we translate into HTTP responses. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
export const PG_FK_VIOLATION = '23503';

export function isPgError(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === code
  );
}

/** Name of the constraint a Postgres error refers to, if it names one. */
export function pgConstraint(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    return (err as { constraint?: string }).constraint;
  }
  return undefined;
}
