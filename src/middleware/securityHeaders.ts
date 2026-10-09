import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { NextFunction, Request, Response } from 'express';

/**
 * Response headers that tell the browser what this app never does, so that a
 * bug which would otherwise be exploitable is not.
 *
 * Set here rather than at the proxy because Render has no proxy of ours in
 * front of it: whatever the app does not send, a customer's browser never
 * gets. The Caddyfile leaves these to the app for the same reason.
 *
 * The session token lives in localStorage, so script injected into the app is
 * the one bug that turns straight into somebody else's account. The policy on
 * /app is what stands in its way: only this origin's own scripts, the one
 * inline script index.html carries (by hash), Google Maps, and the weather
 * map's two tile hosts.
 */

type Directives = Record<string, string[]>;

function serialize(directives: Directives): string {
  return Object.entries(directives)
    .map(([name, sources]) => [name, ...sources].join(' '))
    .join('; ');
}

/** Nothing on any page of ours belongs in somebody else's frame. */
const NEVER: Directives = {
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'object-src': ["'none'"],
};

/**
 * JSON, plus the few small pages the API renders itself (the opt-in thank-you
 * and the unsubscribe button), which carry an inline stylesheet and post back
 * to themselves.
 */
export const API_POLICY = serialize({
  'default-src': ["'none'"],
  'style-src': ["'unsafe-inline'"],
  'form-action': ["'self'"],
  ...NEVER,
});

/**
 * Stored files: served only to the app's own fetch, never meant to render as
 * a page. `sandbox` makes an uploaded file that is really HTML inert even if
 * someone opens it directly.
 */
export const FILE_POLICY = serialize({ 'default-src': ["'none'"], sandbox: [], ...NEVER });

/**
 * Google's own allowlist for the Maps JavaScript API — see
 * developers.google.com/maps/documentation/javascript/content-security-policy.
 * Its sample also lists 'unsafe-inline' for scripts, which browsers ignore
 * once a hash is present, so it is left out.
 */
const GOOGLE = ['https://*.googleapis.com', 'https://*.gstatic.com', '*.google.com', 'https://*.ggpht.com', '*.googleusercontent.com'];

/**
 * The weather map's keyless tile hosts: OpenFreeMap for the basemap's vector
 * tiles and label fonts. The radar's tile host comes from configuration and
 * is passed in beside it. MapLibre fetches tiles and fonts, so they are
 * connect-src, and img-src for the radar's PNGs.
 */
export const BASEMAP_HOST = 'https://tiles.openfreemap.org';

export function appPolicy(inlineScriptHashes: string[], mapHosts: string[] = []): string {
  return serialize({
    'default-src': ["'self'"],
    'script-src': ["'self'", ...inlineScriptHashes.map((h) => `'${h}'`), ...GOOGLE, 'blob:', "'unsafe-eval'"],
    // Radix, Recharts and the theme set inline styles; Maps loads its own.
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'img-src': ["'self'", 'data:', 'blob:', ...GOOGLE, ...mapHosts],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
    'connect-src': ["'self'", ...GOOGLE, ...mapHosts, 'data:', 'blob:'],
    // pdf.js and the weather map run their workers from this origin.
    'worker-src': ["'self'", 'blob:'],
    'frame-src': ['*.google.com'],
    'form-action': ["'self'"],
    'manifest-src': ["'self'"],
    ...NEVER,
  });
}

/**
 * The customer's pay page. Square's card form is its own iframe, and the
 * scripts behind it (3-D Secure included) reach hosts Square does not fully
 * document, so a script allowlist here risks refusing a customer's payment.
 * What is set cannot touch Square: nobody may frame the page, rewrite its
 * base URL or load a plugin into it. The page itself writes only textContent.
 */
export const PAY_POLICY = serialize({ 'form-action': ["'self'"], ...NEVER });

/** sha256 hashes of each inline <script> in an HTML file, CSP-ready. */
export function inlineScriptHashes(htmlPath: string): string[] {
  let html: string;
  try {
    html = readFileSync(htmlPath, 'utf8');
  } catch {
    // No client build (the API-only test suite). Nothing inline to allow.
    return [];
  }
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = match[1] ?? '';
    if (body.trim() === '') continue;
    hashes.push(`sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`);
  }
  return hashes;
}

/**
 * The headers every response gets. Routes that serve a page (the app, the
 * pay page, a stored file) replace the Content-Security-Policy with their own.
 */
export function securityHeaders(options: { hsts: boolean }) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // Origin only to other sites: pay and signing links carry their token in
    // the path, and a full Referer would hand it to every host the page loads.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', API_POLICY);
    if (options.hsts) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}
