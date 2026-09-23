import type { PublicUser } from '../../../src/types/models';

/**
 * The only place that talks to the API. Everything else asks this for data.
 *
 * The token lives in localStorage, which is the ordinary trade for a
 * Bearer-token SPA: it survives a reload, and it is readable by any script
 * that gets onto the page. See the frontend section of the README — the fix
 * is an httpOnly cookie, which is an API change rather than a UI one.
 */

const TOKEN_KEY = 'avcrm.token';
const USER_KEY = 'avcrm.user';

export interface ApiErrorDetail {
  path?: string;
  message?: string;
}

/** Carries the API's own error shape so a form can show what it said. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetail[];

  constructor(status: number, code: string, message: string, details: ApiErrorDetail[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** The message plus whatever the server said was wrong with each field. */
  get full(): string {
    if (this.details.length === 0) return this.message;
    const parts = this.details.map((d) =>
      d.path ? `${d.path}: ${d.message ?? ''}` : (d.message ?? ''),
    );
    return `${this.message} (${parts.join('; ')})`;
  }
}

export interface Paginated<T> {
  data: T[];
  meta: { page: number; page_size: number; total: number; total_pages: number };
}

export function token(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function currentUser(): PublicUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PublicUser;
  } catch {
    return null;
  }
}

export function isCorporate(): boolean {
  return currentUser()?.role === 'corporate';
}

export function signOut(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** Raised on a 401 so the shell can bounce back to the login screen. */
export class Unauthenticated extends Error {}

type Query = Record<string, string | number | boolean | undefined | null>;

export function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const auth = token();
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    if (response.status === 401) {
      signOut();
      throw new Unauthenticated('Your session has expired');
    }
    const error = (payload.error ?? {}) as Record<string, unknown>;
    throw new ApiError(
      response.status,
      String(error.code ?? 'error'),
      String(error.message ?? `Request failed with ${response.status}`),
      Array.isArray(error.details) ? (error.details as ApiErrorDetail[]) : [],
    );
  }

  return payload as T;
}

/** `{ data: … }` responses. */
export async function get<T>(path: string, query?: Query): Promise<T> {
  const body = await request<{ data: T }>('GET', withQuery(path, query));
  return body.data;
}

/** `{ data: [], meta: {} }` responses. */
export function list<T>(path: string, query?: Query): Promise<Paginated<T>> {
  return request<Paginated<T>>('GET', withQuery(path, query));
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const payload = await request<{ data: T }>('POST', path, body ?? {});
  return payload.data;
}

export async function put<T>(path: string, body: unknown): Promise<T> {
  const payload = await request<{ data: T }>('PUT', path, body);
  return payload.data;
}

export async function patch<T>(path: string, body: unknown): Promise<T> {
  const payload = await request<{ data: T }>('PATCH', path, body);
  return payload.data;
}

/** DELETE answers 204 with no body. */
export async function del(path: string): Promise<void> {
  await request<void>('DELETE', path);
}

export interface Session {
  token: string;
  user: PublicUser;
}

export async function signIn(email: string, password: string): Promise<Session> {
  // Deliberately not through request(): a 401 here is a wrong password, not
  // an expired session, and must not trigger the sign-out path.
  const response = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const error = (payload.error ?? {}) as Record<string, unknown>;
    throw new ApiError(
      response.status,
      String(error.code ?? 'error'),
      response.status === 401
        ? 'That email and password do not match'
        : String(error.message ?? 'Could not sign in'),
      [],
    );
  }

  const session = (payload.data ?? {}) as Session;
  localStorage.setItem(TOKEN_KEY, session.token);
  localStorage.setItem(USER_KEY, JSON.stringify(session.user));
  return session;
}
