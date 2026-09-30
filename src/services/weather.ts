import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import type { Branch, Customer, WeatherAlertRun } from '../types/models';
import { logger } from '../utils/logger';
import { enqueueMessage } from './messages';

/**
 * The weather bot.
 *
 * Every evening it asks the forecast how much snow will fall, region by
 * region, overnight — from the evening check until the hour the crews go
 * out (5am). Where that is more
 * than the threshold (3 cm), every active customer in the region is told to
 * move their cars off the driveway tonight — by text, email, or both,
 * whichever they said they prefer.
 *
 * "Region" is the postal region: the first three characters of a Canadian
 * postal code (the forward sortation area, a few thousand households), or a
 * US ZIP code. Snow falls very differently across a city, and a notice to
 * move the car when nothing falls is how people learn to ignore them.
 *
 * Where a region is on the map is worked out from its customers' own
 * properties when they have coordinates, and from the postal code through
 * Open-Meteo's geocoder when none do.
 *
 * Idempotent by construction: weather_alert_runs has one row per branch,
 * region and morning. A region already alerted for a morning is never
 * alerted again, however often the job runs; a region that was below the
 * threshold is looked at again next hour, because a forecast at 6pm and one
 * at 10pm can disagree, and it is the later one that matters.
 */

export interface RegionForecast {
  region: string;
  latitude: number | null;
  longitude: number | null;
  customers: number;
  /** Null when the region could not be placed or the forecast failed. */
  snowfall_cm: number | null;
  triggered: boolean;
  /** Already alerted for this morning: not looked at again. */
  already_alerted: boolean;
  /** Customers queued a notice on this pass. */
  notified: number;
  error: string | null;
}

export interface BranchCheck {
  branch_id: string;
  branch_name: string;
  timezone: string;
  service_date: string;
  /** Local time the forecast window runs from and to. */
  window_from: string;
  window_to: string;
  threshold_cm: number;
  sent: boolean;
  regions: RegionForecast[];
}

/** Normalises a postal or ZIP code to its region, or null if it is neither. */
export function regionOf(postalCode: string | null | undefined): string | null {
  const compact = (postalCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z]\d[A-Z]/.test(compact)) return compact.slice(0, 3);
  if (/^\d{5}/.test(compact)) return compact.slice(0, 5);
  return null;
}

interface LocalTime {
  date: string;
  hour: number;
}

/** What the wall clock reads in a timezone. */
export function localTime(at: Date, timezone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The next service morning — tomorrow, unless it is already the small hours,
 * in which case it is this morning — and the stretch of the forecast that
 * decides it: from the evening check hour the night before, up to the hour
 * the crews go out.
 *
 * The window is fixed per morning rather than running from "now", so every
 * hourly re-check measures the same night: snow that fell at 9pm is still on
 * the driveway at 5am, and a 10pm check must not forget it.
 */
export function serviceWindow(
  at: Date,
  timezone: string,
): { service_date: string; from: string; to: string } {
  const now = localTime(at, timezone);
  const serviceDate = now.hour < config.weather.serviceHour ? now.date : addDays(now.date, 1);
  return {
    service_date: serviceDate,
    // Open-Meteo's hourly snowfall at T is what falls in the hour before T,
    // so `from` is exclusive and `to` inclusive.
    from: `${addDays(serviceDate, -1)}T${pad(config.weather.checkHour)}:00`,
    to: `${serviceDate}T${pad(config.weather.serviceHour)}:00`,
  };
}

interface Located {
  latitude: number;
  longitude: number;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`${new URL(url).host} answered ${response.status}`);
  }
  return response.json();
}

/** Places a postal region on the map when none of its properties are. */
export async function geocodeRegion(region: string): Promise<Located | null> {
  const country = /^\d/.test(region) ? 'US' : 'CA';
  const url = new URL(`${config.weather.geocodingApiBase}/search`);
  url.searchParams.set('name', region);
  url.searchParams.set('count', '1');
  url.searchParams.set('countryCode', country);
  url.searchParams.set('format', 'json');

  const body = (await fetchJson(url.toString())) as {
    results?: { latitude: number; longitude: number }[];
  };
  const hit = body.results?.[0];
  return hit ? { latitude: hit.latitude, longitude: hit.longitude } : null;
}

/** Total snowfall (cm) the forecast puts in (from, to], local time. */
export async function forecastSnowfall(
  at: Located,
  timezone: string,
  from: string,
  to: string,
): Promise<number> {
  const url = new URL(`${config.weather.apiBase}/forecast`);
  url.searchParams.set('latitude', at.latitude.toFixed(4));
  url.searchParams.set('longitude', at.longitude.toFixed(4));
  url.searchParams.set('hourly', 'snowfall');
  url.searchParams.set('timezone', timezone);
  url.searchParams.set('forecast_days', '3');

  const body = (await fetchJson(url.toString())) as {
    hourly?: { time?: string[]; snowfall?: (number | null)[] };
  };
  const times = body.hourly?.time;
  const snowfall = body.hourly?.snowfall;
  if (!Array.isArray(times) || !Array.isArray(snowfall)) {
    throw new Error('The forecast came back without hourly snowfall');
  }

  let total = 0;
  times.forEach((time, i) => {
    // Local ISO strings of one shape compare correctly as text.
    if (time > from && time <= to) total += Number(snowfall[i] ?? 0);
  });
  return Math.round(total * 100) / 100;
}

interface RosterEntry {
  customer: Customer;
  regions: Set<string>;
}

interface Region {
  region: string;
  located: Located | null;
  customers: number;
}

/** Active customers in the branch, and the postal regions their properties are in. */
async function roster(
  branchId: string,
  db: Knex,
): Promise<{ customers: Map<string, RosterEntry>; regions: Region[] }> {
  const rows = (await db('customers')
    .join('properties', 'properties.customer_id', 'customers.id')
    .where('customers.branch_id', branchId)
    .andWhere('customers.status', 'active')
    .select(
      'customers.*',
      'properties.postal_code as property_postal_code',
      'properties.latitude as property_latitude',
      'properties.longitude as property_longitude',
    )) as (Customer & {
    property_postal_code: string;
    property_latitude: string | null;
    property_longitude: string | null;
  })[];

  const customers = new Map<string, RosterEntry>();
  const points = new Map<string, { lat: number; lng: number; n: number; ids: Set<string> }>();

  for (const row of rows) {
    const region = regionOf(row.property_postal_code);
    if (!region) continue;

    const entry = customers.get(row.id) ?? { customer: row, regions: new Set<string>() };
    entry.regions.add(region);
    customers.set(row.id, entry);

    const point = points.get(region) ?? { lat: 0, lng: 0, n: 0, ids: new Set<string>() };
    point.ids.add(row.id);
    if (row.property_latitude !== null && row.property_longitude !== null) {
      point.lat += Number(row.property_latitude);
      point.lng += Number(row.property_longitude);
      point.n += 1;
    }
    points.set(region, point);
  }

  const regions = [...points.entries()]
    .map(([region, p]) => ({
      region,
      // The middle of the region's customers: where the snow that matters falls.
      located: p.n > 0 ? { latitude: p.lat / p.n, longitude: p.lng / p.n } : null,
      customers: p.ids.size,
    }))
    .sort((a, b) => a.region.localeCompare(b.region));

  return { customers, regions };
}

/** Whichever of text and email they asked for, falling back to what we have. */
function channelsFor(customer: Customer): { channel: 'email' | 'sms'; to: string }[] {
  const email = customer.email?.trim() || null;
  const phone = customer.phone?.trim() || null;
  const wantsEmail = customer.preferred_contact !== 'sms';
  const wantsSms = customer.preferred_contact !== 'email';

  const out: { channel: 'email' | 'sms'; to: string }[] = [];
  if (wantsSms && phone) out.push({ channel: 'sms', to: phone });
  if (wantsEmail && email) out.push({ channel: 'email', to: email });
  // Asked for a channel we have no address for: better the other than nothing.
  if (out.length === 0) {
    if (phone) out.push({ channel: 'sms', to: phone });
    else if (email) out.push({ channel: 'email', to: email });
  }
  return out;
}

export interface CheckOptions {
  now?: Date;
  /** Look only: write nothing, send nothing. */
  dryRun?: boolean;
}

/**
 * Checks one branch: forecast per region, and — unless a dry run — records
 * the result and queues a notice to every active customer in a region that
 * crossed the threshold.
 */
export async function checkBranch(
  branch: Pick<Branch, 'id' | 'name' | 'timezone'>,
  options: CheckOptions = {},
  db: Knex = defaultDb,
): Promise<BranchCheck> {
  const now = options.now ?? new Date();
  const window = serviceWindow(now, branch.timezone);
  const threshold = config.weather.thresholdCm;
  const { customers, regions } = await roster(branch.id, db);

  const alerted = new Set(
    (
      (await db('weather_alert_runs')
        .where({ branch_id: branch.id, service_date: window.service_date, triggered: true })
        .select('region')) as Pick<WeatherAlertRun, 'region'>[]
    ).map((r) => r.region),
  );

  // The network calls happen before any transaction opens, so a slow
  // forecast never holds a lock.
  const forecasts: RegionForecast[] = [];
  for (const region of regions) {
    const forecast: RegionForecast = {
      region: region.region,
      latitude: region.located?.latitude ?? null,
      longitude: region.located?.longitude ?? null,
      customers: region.customers,
      snowfall_cm: null,
      triggered: false,
      already_alerted: alerted.has(region.region),
      notified: 0,
      error: null,
    };
    forecasts.push(forecast);
    if (forecast.already_alerted) continue;

    try {
      const located = region.located ?? (await geocodeRegion(region.region));
      if (!located) {
        forecast.error = 'Could not place this postal region on the map';
        continue;
      }
      forecast.latitude = located.latitude;
      forecast.longitude = located.longitude;
      forecast.snowfall_cm = await forecastSnowfall(
        located,
        branch.timezone,
        window.from,
        window.to,
      );
      forecast.triggered = forecast.snowfall_cm > threshold;
    } catch (err) {
      forecast.error = err instanceof Error ? err.message : String(err);
      logger.warn({ err, branch_id: branch.id, region: region.region }, 'Weather check failed for a region');
    }
  }

  const result: BranchCheck = {
    branch_id: branch.id,
    branch_name: branch.name,
    timezone: branch.timezone,
    service_date: window.service_date,
    window_from: window.from,
    window_to: window.to,
    threshold_cm: threshold,
    sent: false,
    regions: forecasts,
  };
  if (options.dryRun) return result;

  await db.transaction(async (trx) => {
    const newlyTriggered = new Set<string>();

    for (const forecast of forecasts) {
      if (forecast.already_alerted || forecast.snowfall_cm === null) continue;

      // Insert, or refresh a region that was below the threshold last time.
      // A region already alerted is left alone, and returns nothing — which
      // is what stops two overlapping runs from both sending.
      const [row] = (await trx('weather_alert_runs')
        .insert({
          branch_id: branch.id,
          service_date: window.service_date,
          region: forecast.region,
          latitude: (forecast.latitude ?? 0).toFixed(6),
          longitude: (forecast.longitude ?? 0).toFixed(6),
          snowfall_cm: forecast.snowfall_cm.toFixed(2),
          threshold_cm: threshold.toFixed(2),
          triggered: forecast.triggered,
        })
        .onConflict(['branch_id', 'service_date', 'region'])
        .merge(['latitude', 'longitude', 'snowfall_cm', 'threshold_cm', 'triggered'])
        .where('weather_alert_runs.triggered', false)
        .returning('*')) as WeatherAlertRun[];

      if (!row) {
        forecast.already_alerted = true;
        forecast.triggered = false;
        continue;
      }
      if (row.triggered) newlyTriggered.add(forecast.region);
    }

    if (newlyTriggered.size === 0) return;

    // Anyone with a property in a region alerted earlier tonight has had
    // their notice already, even if another of their properties is in a
    // region that has only now crossed the line.
    for (const { customer, regions: theirs } of customers.values()) {
      const hit = [...theirs].find((r) => newlyTriggered.has(r));
      if (!hit || [...theirs].some((r) => alerted.has(r))) continue;

      for (const { channel, to } of channelsFor(customer)) {
        await enqueueMessage(
          {
            template_code: 'snowfall_notice',
            channel,
            recipient: to,
            branch_id: branch.id,
            customer_id: customer.id,
            context: {
              customer_first_name: customer.first_name,
              branch_name: branch.name,
              service_date: window.service_date,
            },
          },
          trx,
        );
      }
      const forecast = forecasts.find((f) => f.region === hit);
      if (forecast) forecast.notified += 1;
    }

    for (const forecast of forecasts) {
      if (forecast.notified > 0) {
        await trx('weather_alert_runs')
          .where({ branch_id: branch.id, service_date: window.service_date, region: forecast.region })
          .update({ notified: forecast.notified });
      }
    }
    result.sent = true;
  });

  return result;
}

export interface WeatherSummary {
  branches_checked: number;
  regions_alerted: number;
  customers_notified: number;
}

/**
 * The scheduled pass. A branch is checked only in its own evening, from
 * WEATHER_CHECK_HOUR until midnight, so a branch in Halifax and one in
 * Vancouver each get their notice at a sensible hour of their own.
 */
export async function runWeatherAlerts(
  now: Date = new Date(),
  db: Knex = defaultDb,
): Promise<WeatherSummary> {
  const summary: WeatherSummary = { branches_checked: 0, regions_alerted: 0, customers_notified: 0 };
  if (!config.weather.enabled) return summary;

  const branches = (await db('branches').where({ status: 'active' })) as Branch[];
  for (const branch of branches) {
    if (localTime(now, branch.timezone).hour < config.weather.checkHour) continue;

    try {
      const check = await checkBranch(branch, { now }, db);
      summary.branches_checked += 1;
      for (const region of check.regions) {
        if (region.notified > 0) {
          summary.regions_alerted += 1;
          summary.customers_notified += region.notified;
        }
      }
    } catch (err) {
      // One branch's bad night is not a reason to skip the others.
      logger.error({ err, branch_id: branch.id }, 'Weather alert check failed');
    }
  }
  return summary;
}

export interface WeatherRunView extends WeatherAlertRun {
  branch_name: string;
}

export async function listWeatherRuns(
  branchId: string | undefined,
  db: Knex = defaultDb,
): Promise<WeatherRunView[]> {
  const query = db('weather_alert_runs')
    .join('branches', 'branches.id', 'weather_alert_runs.branch_id')
    .select('weather_alert_runs.*', 'branches.name as branch_name')
    .orderBy([
      { column: 'weather_alert_runs.service_date', order: 'desc' },
      { column: 'weather_alert_runs.region', order: 'asc' },
    ])
    .limit(200);
  if (branchId) query.where('weather_alert_runs.branch_id', branchId);
  return query as Promise<WeatherRunView[]>;
}

/** What the settings page shows: the rules the bot runs on. */
export function weatherSettings() {
  return {
    enabled: config.weather.enabled,
    threshold_cm: config.weather.thresholdCm,
    check_hour: config.weather.checkHour,
    service_hour: config.weather.serviceHour,
    provider: 'Open-Meteo',
  };
}
