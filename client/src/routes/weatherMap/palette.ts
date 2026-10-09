/**
 * The map's colours, read from the app's own design tokens.
 *
 * Nothing here is a colour of its own: the basemap, the markers and the
 * clusters are all painted from the CSS custom properties in index.css
 * (--background, --card, --border, --primary, --good and the rest), read at
 * run time, so the map is whichever theme the app is in — and is repainted
 * when the theme changes. The few in-between shades a map needs (water, park
 * land, the casing of a major road) are blends of two tokens, never a new
 * hue.
 *
 * MapLibre's colour parser predates the space-separated CSS syntax the tokens
 * are written in ("217 91% 60%"), so they are handed over as hsla() with
 * commas.
 */

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

const TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'muted',
  'muted-foreground',
  'border',
  'primary',
  'primary-foreground',
  'good',
  'warning',
  'serious',
  'critical',
] as const;
type Token = (typeof TOKENS)[number];

export type MapPalette = Record<Token, Hsl> & { dark: boolean };

/** Neutral grey, for a token that is somehow missing; never expected. */
const FALLBACK: Hsl = { h: 215, s: 15, l: 50 };

function parseToken(raw: string): Hsl | null {
  const match = raw.trim().match(/^(-?[\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!match) return null;
  return { h: Number(match[1]), s: Number(match[2]), l: Number(match[3]) };
}

/** The tokens as the document has them right now. */
export function readPalette(root: HTMLElement = document.documentElement): MapPalette {
  const style = getComputedStyle(root);
  const out = {} as Record<Token, Hsl>;
  for (const token of TOKENS) {
    out[token] = parseToken(style.getPropertyValue(`--${token}`)) ?? FALLBACK;
  }
  return { ...out, dark: root.dataset.theme !== 'light' };
}

export function css(color: Hsl, alpha = 1): string {
  const r = (n: number) => Math.round(n * 10) / 10;
  return `hsla(${r(color.h)}, ${r(color.s)}%, ${r(color.l)}%, ${alpha})`;
}

function toRgb({ h, s, l }: Hsl): [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

function toHsl([r, g, b]: [number, number, number]): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

/**
 * Part way from one token to another, mixed as light is (in RGB): blending
 * the near-white page toward the primary blue gives a pale blue, where a mix
 * of hues would wander through yellow on the way.
 */
export function blend(from: Hsl, to: Hsl, amount: number): Hsl {
  const a = toRgb(from);
  const b = toRgb(to);
  return toHsl([0, 1, 2].map((i) => (a[i] as number) + ((b[i] as number) - (a[i] as number)) * amount) as [number, number, number]);
}
