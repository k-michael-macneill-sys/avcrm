import * as api from './api.js';
import { appHref, BASE } from './base.js';
import { clear, h } from './dom.js';

/**
 * Path routing under /app. The API owns the root paths (/customers is an
 * endpoint), so the UI lives under a prefix that cannot collide with it.
 */

export { BASE };

export type View = (root: HTMLElement, params: string[]) => Promise<void> | void;

export interface Route {
  /** Matched against the path with BASE stripped off. */
  pattern: RegExp;
  view: View;
  /** Nav item to mark current. */
  nav?: string;
  corporateOnly?: boolean;
  /** Why, in this section's own terms, when an operator lands on it. */
  deniedMessage?: string;
}

let routes: Route[] = [];
let outlet: HTMLElement | null = null;
let onUnauthenticated: () => void = () => {};
let onNavigate: (nav: string | undefined) => void = () => {};

export function configure(options: {
  routes: Route[];
  outlet: HTMLElement;
  onUnauthenticated: () => void;
  onNavigate: (nav: string | undefined) => void;
}): void {
  routes = options.routes;
  outlet = options.outlet;
  onUnauthenticated = options.onUnauthenticated;
  onNavigate = options.onNavigate;
}

export function path(): string {
  const raw = location.pathname.startsWith(BASE)
    ? location.pathname.slice(BASE.length)
    : '/';
  return raw === '' ? '/' : raw;
}

export function navigate(to: string, replace = false): void {
  const href = appHref(to);
  if (replace) history.replaceState(null, '', href);
  else history.pushState(null, '', href);
  void render();
}

export async function render(): Promise<void> {
  if (!outlet) return;
  const current = path();

  for (const route of routes) {
    const match = route.pattern.exec(current);
    if (!match) continue;

    if (route.corporateOnly && !api.isCorporate()) {
      clear(outlet);
      outlet.appendChild(
        notice(
          'Corporate only',
          route.deniedMessage
            ?? 'This section is corporate work. Your own visits are under Dispatch.',
        ),
      );
      onNavigate(route.nav);
      return;
    }

    onNavigate(route.nav);
    clear(outlet);
    outlet.appendChild(h('p', { class: 'loading', 'aria-live': 'polite' }, 'Loading…'));

    try {
      const target = outlet;
      const content = document.createElement('div');
      await route.view(content, match.slice(1) as string[]);
      clear(target);
      target.appendChild(content);
      // A new screen starts at the top, the way a page load would.
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (err instanceof api.Unauthenticated) {
        onUnauthenticated();
        return;
      }
      clear(outlet);
      outlet.appendChild(
        notice(
          'That did not load',
          err instanceof api.ApiError ? err.full : String(err),
        ),
      );
    }
    return;
  }

  clear(outlet);
  outlet.appendChild(notice('No such screen', `Nothing is routed at ${current}.`));
  onNavigate(undefined);
}

export function notice(title: string, message: string): HTMLElement {
  return h(
    'section',
    { class: 'card notice' },
    h('h2', {}, title),
    h('p', {}, message),
  );
}

/** Intercepts in-app links so they do not reload the page. */
export function interceptLinks(): void {
  document.addEventListener('click', (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest('a[data-link]');
    if (!anchor) return;

    // Leave the browser's own behaviour alone: a new tab, a new window and a
    // download are all things the reader asked for on purpose.
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const href = anchor.getAttribute('href');
    if (!href) return;

    event.preventDefault();
    navigate(href);
  });

  window.addEventListener('popstate', () => void render());
}
