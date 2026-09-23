export const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];

/** Below this a recurring price gets a second look, but is never refused. */
export const RECURRING_FLOOR = 100;

/**
 * The season a rep is selling into. Before or after winter it is the
 * coming one, 15 November to 15 April; in the middle of winter it starts
 * today, so the first bill is not for weeks that have already gone.
 */
export function defaultSeason(today = new Date()): { season_start: string; season_end: string } {
  // Local date, not UTC: at 9pm in Halifax, UTC is already tomorrow.
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const year = today.getFullYear();
  const md = (today.getMonth() + 1) * 100 + today.getDate();

  if (md >= 1115) {
    return { season_start: iso(today), season_end: `${year + 1}-04-15` };
  }
  if (md < 415) {
    return { season_start: iso(today), season_end: `${year}-04-15` };
  }
  return { season_start: `${year}-11-15`, season_end: `${year + 1}-04-15` };
}

/** "12.5" → 12.5; "" or junk → null. Money is typed, not trusted. */
export function parseMoney(value: string): number | null {
  const trimmed = value.replace(/[$,\s]/g, '');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

export const ADDONS = [
  { key: 'addon_salt', label: 'Salt' },
  { key: 'addon_vehicle', label: 'Vehicle package' },
  { key: 'addon_stairs', label: 'Stairs' },
] as const;
