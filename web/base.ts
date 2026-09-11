/**
 * Where the client lives. The API owns the root paths — /customers is an
 * endpoint — so every screen sits under this prefix.
 *
 * Its own module because both the router and the link helper need it, and
 * the router already imports the link helper.
 */
export const BASE = '/app';

/** An in-app path as a real URL. Idempotent, so prefixing twice is safe. */
export function appHref(path: string): string {
  if (!path.startsWith('/')) return path;
  return path.startsWith(`${BASE}/`) || path === BASE ? path : `${BASE}${path}`;
}
