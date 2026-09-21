import * as React from 'react';
import { useAuth } from '@/auth/AuthContext';
import * as api from '@/lib/api';

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Re-runs the fetcher — after a mutation elsewhere on the same screen. */
  reload: () => void;
}

/**
 * The same shape every screen's data loading was in the old router: show a
 * spinner, then either the data, or — if the fetch turns out to be a session
 * that expired — nothing, because the shell is about to replace the whole
 * screen with the login form anyway.
 */
export function useQuery<T>(fetcher: () => Promise<T>, deps: React.DependencyList): QueryState<T> {
  const { handleUnauthenticated } = useAuth();
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetcher()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof api.Unauthenticated) {
          handleUnauthenticated();
          return;
        }
        setError(err instanceof api.ApiError ? err.full : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = React.useCallback(() => setTick((t) => t + 1), []);

  return { data, loading, error, reload };
}
