import * as React from 'react';
import { useAuth } from '@/auth/AuthContext';
import * as api from '@/lib/api';

/**
 * Wraps a mutation so a button can disable itself while it runs and an
 * ApiError lands on the screen as text instead of the console — the same
 * contract the old `submitter` gave every form.
 */
export function useSubmit(onDone?: () => void): {
  run: (action: () => Promise<unknown>) => void;
  pending: boolean;
  error: string | null;
  clearError: () => void;
} {
  const { handleUnauthenticated } = useAuth();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const run = React.useCallback(
    (action: () => Promise<unknown>) => {
      setError(null);
      setPending(true);
      action()
        .then(() => {
          setPending(false);
          onDone?.();
        })
        .catch((err: unknown) => {
          setPending(false);
          if (err instanceof api.Unauthenticated) {
            handleUnauthenticated();
            return;
          }
          setError(err instanceof api.ApiError ? err.full : String(err));
        });
    },
    [onDone, handleUnauthenticated],
  );

  return { run, pending, error, clearError: () => setError(null) };
}
