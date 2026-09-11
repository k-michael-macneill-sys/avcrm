import { h } from './dom.js';

/**
 * Display formatting, and the one place that decides what a status looks
 * like.
 *
 * Status colour comes from the fixed good / warning / serious / critical
 * palette and is never the only signal: every pill carries its label as text,
 * so the meaning survives colour blindness, greyscale printing and forced
 * colours.
 */

type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral';

const TONES: Record<string, Tone> = {
  // Onboarding
  approved: 'good',
  docs_submitted: 'warning',
  pending: 'warning',
  suspended: 'critical',
  // Customers
  lead: 'warning',
  churned: 'critical',
  // Quotes
  draft: 'neutral',
  presented: 'warning',
  accepted: 'good',
  declined: 'critical',
  expired: 'critical',
  // Contracts and invoices
  active: 'good',
  cancelled: 'critical',
  completed: 'good',
  sent: 'warning',
  paid: 'good',
  overdue: 'serious',
  void: 'neutral',
  // Work orders
  scheduled: 'neutral',
  en_route: 'warning',
  in_progress: 'warning',
  skipped: 'serious',
  // Documents, messages, payments
  submitted: 'warning',
  rejected: 'critical',
  queued: 'neutral',
  succeeded: 'good',
  failed: 'critical',
  refunded: 'serious',
  bounced: 'critical',
  // Flags
  priority: 'serious',
  // Review routing
  google_review: 'good',
  internal_feedback: 'serious',
};

export function humanize(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function statusPill(status: string | null | undefined): HTMLElement {
  if (!status) return h('span', { class: 'pill pill-neutral' }, '—');
  const tone = TONES[status] ?? 'neutral';
  return h(
    'span',
    { class: `pill pill-${tone}` },
    h('span', { class: 'pill-dot', 'aria-hidden': 'true' }),
    humanize(status),
  );
}

/** numeric columns arrive as strings; they stay exact all the way to the DOM. */
export function money(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const amount = Number(value);
  if (Number.isNaN(amount)) return '—';
  return amount.toLocaleString(undefined, {
    style: 'currency',
    currency: 'CAD',
    currencyDisplay: 'narrowSymbol',
  });
}

/** Compact form for a stat tile, where the column width is the constraint. */
export function compactMoney(value: string | number | null | undefined): string {
  const amount = Number(value ?? 0);
  if (Number.isNaN(amount)) return '—';
  if (Math.abs(amount) >= 10_000) {
    return `$${(amount / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k`;
  }
  return money(amount);
}

export function count(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString();
}

export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value * 100)}%`;
}

/** A calendar date — no timezone, because a YYYY-MM-DD has none. */
export function date(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** An instant, shown in the reader's own timezone. */
export function stamp(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "in 3 days" / "2 hours ago", for anything a dispatcher is watching. */
export function relative(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';

  const diffMs = parsed.getTime() - Date.now();
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  for (const [unit, ms] of units) {
    if (Math.abs(diffMs) >= ms) {
      return formatter.format(Math.round(diffMs / ms), unit);
    }
  }
  return 'just now';
}

export function fullName(row: { first_name: string; last_name: string }): string {
  return `${row.first_name} ${row.last_name}`;
}

/** YYYY-MM-DD for a date input, `days` from today. */
export function isoDate(days = 0): string {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}
