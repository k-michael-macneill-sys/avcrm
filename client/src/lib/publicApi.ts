import * as React from 'react';
import { ApiError } from '@/lib/api';

/**
 * Requests to the /public routes, which need no session. Kept apart from the
 * main client on purpose: that one treats a 401 as "your session expired" and
 * signs you out, which is the wrong answer to a customer whose signing link
 * has lapsed.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const error = (payload.error ?? {}) as Record<string, unknown>;
    throw new ApiError(
      response.status,
      String(error.code ?? 'error'),
      String(error.message ?? `Request failed with ${response.status}`),
      [],
    );
  }
  return (payload as { data: T }).data;
}

export const publicGet = <T>(path: string): Promise<T> => request<T>('GET', path);
export const publicPost = <T>(path: string, body: unknown): Promise<T> =>
  request<T>('POST', path, body);

export interface PublicConfig {
  /** Whether a card can be taken at all — false until Square is connected. */
  card_capture: boolean;
  maps_api_key: string | null;
}

let cached: Promise<PublicConfig> | null = null;

export interface PublicConfigState {
  config: PublicConfig | null;
  /** Why it could not be loaded; a screen waiting on it should say so, not spin. */
  error: string | null;
}

/** Fetched once per page load; it only changes with a redeploy. */
export function usePublicConfigState(): PublicConfigState {
  const [state, setState] = React.useState<PublicConfigState>({ config: null, error: null });
  React.useEffect(() => {
    cached ??= publicGet<PublicConfig>('/public/config').catch((err: unknown) => {
      cached = null;
      throw err;
    });
    let live = true;
    cached
      .then((config) => live && setState({ config, error: null }))
      .catch((err: unknown) => {
        if (!live) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ config: null, error: `Could not load the server's settings: ${message}` });
      });
    return () => {
      live = false;
    };
  }, []);
  return state;
}

export function usePublicConfig(): PublicConfig | null {
  return usePublicConfigState().config;
}
