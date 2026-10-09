import { config } from '../config';
import { WEATHER_REGIONS, type WeatherRegionKey } from '../config/weatherRegions';
import type { IceRisk, RadarFrame, RadarFrames, SnowSummary, SnowSummaryHour } from '../types/weatherMap';
import { logger } from '../utils/logger';

/**
 * What the weather map's HUD shows for a territory, and the radar frames it
 * animates.
 *
 * Forecasts come from Open-Meteo with Environment Canada's GEM models:
 * `gem_seamless` is HRDPS (2.5 km) for the first two days, blended into the
 * regional and global runs after that — the highest-resolution Canadian
 * snow forecast there is, and no key. GEM does not report snow on the
 * ground, so when its snow depth comes back empty the depth alone is asked
 * of Open-Meteo's default blend.
 *
 * Every answer is cached per region for ten minutes (the models update
 * hourly at best), and the same request in flight is shared, so however
 * many dispatchers have the map open the upstream sees a handful of calls an
 * hour. When Open-Meteo does not answer, the last good summary is served,
 * marked stale, rather than an error over the map.
 */

const SUMMARY_TTL_MS = 10 * 60_000;
const RADAR_TTL_MS = 2 * 60_000;
const FORECAST_MODEL = 'gem_seamless';

/** WMO weather codes, in the words a dispatcher uses. */
const CONDITIONS: Record<number, string> = {
  0: 'Clear',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Freezing fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Light freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers',
  81: 'Showers',
  82: 'Heavy showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with hail',
};

const FREEZING_CODES = new Set([56, 57, 66, 67]);
/** Rain at or below this, °C, can freeze on a cold driveway. */
const NEAR_FREEZING_C = 0.5;

export function conditionOf(code: number | null): string {
  if (code === null) return 'Unknown';
  return CONDITIONS[code] ?? 'Unknown';
}

class UpstreamError extends Error {}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    let reason = '';
    try {
      const body = (await response.json()) as { reason?: unknown };
      if (typeof body.reason === 'string') reason = `: ${body.reason}`;
    } catch {
      // Not JSON; the status says enough.
    }
    throw new UpstreamError(`${url.host} answered ${response.status}${reason}`);
  }
  return response.json();
}

type Series = (number | null)[];

interface ForecastBody {
  current?: Record<string, unknown> & { time?: string };
  hourly?: Record<string, unknown> & { time?: string[] };
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function series(hourly: ForecastBody['hourly'], name: string, length: number): Series {
  const raw = hourly?.[name];
  if (!Array.isArray(raw)) return new Array<number | null>(length).fill(null);
  return Array.from({ length }, (_, i) => num(raw[i]));
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The hour a local ISO time falls in: "2026-12-09T21:15" → "2026-12-09T21:00". */
const hourOf = (time: string): string => `${time.slice(0, 13)}:00`;

/**
 * Freezing rain ahead, from the hourly forecast: a freezing drizzle or
 * freezing rain code is a warning; rain falling at or near zero is a watch,
 * because that is the rain that glazes a driveway even when the model does
 * not call it freezing.
 */
export function iceRisk(hours: SnowSummaryHour[]): IceRisk {
  const freezing = hours.find((h) => h.weather_code !== null && FREEZING_CODES.has(h.weather_code));
  if (freezing) {
    return {
      level: 'warning',
      summary: `${conditionOf(freezing.weather_code)} forecast`,
      starts_at: freezing.time,
    };
  }
  const nearZeroRain = hours.find(
    (h) =>
      h.rain_mm > 0.1 &&
      h.temperature_c !== null &&
      h.temperature_c <= NEAR_FREEZING_C &&
      h.temperature_c >= -3,
  );
  if (nearZeroRain) {
    return { level: 'watch', summary: 'Rain near freezing: ice possible', starts_at: nearZeroRain.time };
  }
  return { level: 'none', summary: 'No freezing rain forecast', starts_at: null };
}

async function fetchSummary(key: WeatherRegionKey): Promise<SnowSummary> {
  const region = WEATHER_REGIONS[key];
  const url = new URL(`${config.weather.apiBase}/forecast`);
  url.searchParams.set('latitude', region.latitude.toFixed(4));
  url.searchParams.set('longitude', region.longitude.toFixed(4));
  url.searchParams.set('timezone', region.timezone);
  url.searchParams.set('models', FORECAST_MODEL);
  url.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code',
  );
  url.searchParams.set('hourly', 'snowfall,precipitation,rain,showers,temperature_2m,weather_code,snow_depth');
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('forecast_days', '3');

  const body = (await fetchJson(url)) as ForecastBody;
  const times = body.hourly?.time;
  const currentTime = typeof body.current?.time === 'string' ? body.current.time : null;
  if (!Array.isArray(times) || !currentTime) {
    throw new UpstreamError('The forecast came back without hourly or current data');
  }

  const n = times.length;
  const snowfall = series(body.hourly, 'snowfall', n);
  const precipitation = series(body.hourly, 'precipitation', n);
  const rain = series(body.hourly, 'rain', n);
  const showers = series(body.hourly, 'showers', n);
  const temperature = series(body.hourly, 'temperature_2m', n);
  const codes = series(body.hourly, 'weather_code', n);
  const depth = series(body.hourly, 'snow_depth', n);

  // Open-Meteo's hourly value at T is what falls in the hour before T, so
  // the hours ahead are the ones after the current hour.
  const nowHour = hourOf(currentTime);
  const start = times.findIndex((t) => t > nowHour);
  const ahead = start === -1 ? [] : times.slice(start, start + 48).map((time, i) => i + start);
  const hourly: SnowSummaryHour[] = ahead.map((i) => ({
    time: times[i] as string,
    snowfall_cm: round1(snowfall[i] ?? 0),
    precipitation_mm: round1(precipitation[i] ?? 0),
    rain_mm: round1((rain[i] ?? 0) + (showers[i] ?? 0)),
    temperature_c: temperature[i] ?? null,
    weather_code: codes[i] ?? null,
  }));
  const total = (hoursAhead: number) =>
    round1(hourly.slice(0, hoursAhead).reduce((sum, h) => sum + h.snowfall_cm, 0));

  const nowIndex = times.indexOf(nowHour);
  let depthM = nowIndex === -1 ? null : (depth[nowIndex] ?? null);
  if (depthM === null) depthM = await fetchDepthFallback(key, nowHour);

  const current = body.current ?? {};
  const code = num(current.weather_code);
  return {
    region: {
      key,
      name: region.name,
      latitude: region.latitude,
      longitude: region.longitude,
      timezone: region.timezone,
    },
    fetched_at: new Date().toISOString(),
    stale: false,
    model: FORECAST_MODEL,
    current: {
      time: currentTime,
      temperature_c: num(current.temperature_2m),
      apparent_temperature_c: num(current.apparent_temperature),
      wind_speed_kmh: num(current.wind_speed_10m),
      wind_gusts_kmh: num(current.wind_gusts_10m),
      wind_direction_deg: num(current.wind_direction_10m),
      weather_code: code,
      condition: conditionOf(code),
    },
    snow: {
      next_6h_cm: total(6),
      next_24h_cm: total(24),
      next_48h_cm: total(48),
      depth_cm: depthM === null ? null : round1(depthM * 100),
      trigger_cm: config.weather.thresholdCm,
    },
    ice: iceRisk(hourly.slice(0, 24)),
    hourly,
  };
}

/** Snow on the ground from Open-Meteo's default blend, in metres; null if it has none either. */
async function fetchDepthFallback(key: WeatherRegionKey, nowHour: string): Promise<number | null> {
  const region = WEATHER_REGIONS[key];
  const url = new URL(`${config.weather.apiBase}/forecast`);
  url.searchParams.set('latitude', region.latitude.toFixed(4));
  url.searchParams.set('longitude', region.longitude.toFixed(4));
  url.searchParams.set('timezone', region.timezone);
  url.searchParams.set('hourly', 'snow_depth');
  url.searchParams.set('forecast_days', '1');
  try {
    const body = (await fetchJson(url)) as ForecastBody;
    const times = body.hourly?.time ?? [];
    const i = times.indexOf(nowHour);
    return i === -1 ? null : series(body.hourly, 'snow_depth', times.length)[i] ?? null;
  } catch (err) {
    // Depth is a nice-to-have beside the forecast; its absence is shown as "—".
    logger.warn({ err, region: key }, 'Snow depth fallback failed');
    return null;
  }
}

interface Cached<T> {
  value: T;
  at: number;
}

const summaries = new Map<WeatherRegionKey, Cached<SnowSummary>>();
const inFlight = new Map<WeatherRegionKey, Promise<SnowSummary>>();

/**
 * The snow summary for a territory: cached, shared while in flight, and the
 * last good one (marked stale) when Open-Meteo is down.
 */
export async function snowSummary(key: WeatherRegionKey, now: number = Date.now()): Promise<SnowSummary> {
  const hit = summaries.get(key);
  if (hit && now - hit.at < SUMMARY_TTL_MS) return hit.value;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = fetchSummary(key).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  try {
    const value = await pending;
    summaries.set(key, { value, at: Date.now() });
    return value;
  } catch (err) {
    if (hit) {
      logger.warn({ err, region: key }, 'Open-Meteo did not answer; serving the last summary');
      return { ...hit.value, stale: true };
    }
    throw err;
  }
}

// --- Radar ---------------------------------------------------------------------

/**
 * RainViewer's radar tiles above this zoom are blank on the public API; the
 * map stretches the zoom-7 tiles instead of asking for them.
 */
export const RADAR_MAX_ZOOM = 7;
/** 256px tiles, colour scheme 2 (Universal Blue), smoothed, snow shown in its own colours. */
const RADAR_TILE_SUFFIX = '/256/{z}/{x}/{y}/2/1_1.png';
const FRAME_PATH = /^\/v2\/radar\/[A-Za-z0-9_]+$/;

interface RadarIndex {
  generated?: unknown;
  host?: unknown;
  radar?: { past?: unknown; nowcast?: unknown };
}

function frames(list: unknown, kind: RadarFrame['kind'], host: string): RadarFrame[] {
  if (!Array.isArray(list)) return [];
  const out: RadarFrame[] = [];
  for (const item of list as { time?: unknown; path?: unknown }[]) {
    const time = num(item?.time);
    const path = typeof item?.path === 'string' ? item.path : null;
    // Only a path of the documented shape is ever put into a tile URL.
    if (time === null || !path || !FRAME_PATH.test(path)) continue;
    out.push({ time, tiles: `${host}${path}${RADAR_TILE_SUFFIX}`, kind });
  }
  return out;
}

async function fetchRadar(): Promise<RadarFrames> {
  const body = (await fetchJson(new URL(`${config.weather.radarApiBase}/public/weather-maps.json`))) as RadarIndex;
  // The tile host is ours to name, not the index's: whatever the index says,
  // the browser is only ever pointed at the one host the page's policy allows.
  const host = config.weather.radarTileHost;
  if (typeof body.host === 'string' && body.host.replace(/\/+$/, '') !== host) {
    logger.warn({ host: body.host }, 'RainViewer named a tile host other than the one configured');
  }
  const past = frames(body.radar?.past, 'past', host);
  const nowcast = frames(body.radar?.nowcast, 'nowcast', host);
  if (past.length === 0) throw new UpstreamError('RainViewer returned no radar frames');
  return {
    generated_at: num(body.generated) ?? Math.floor(Date.now() / 1000),
    frames: [...past, ...nowcast].sort((a, b) => a.time - b.time),
    max_zoom: RADAR_MAX_ZOOM,
  };
}

let radarCache: Cached<RadarFrames> | null = null;
let radarInFlight: Promise<RadarFrames> | null = null;

export async function radarFrames(now: number = Date.now()): Promise<RadarFrames> {
  if (radarCache && now - radarCache.at < RADAR_TTL_MS) return radarCache.value;
  radarInFlight ??= fetchRadar().finally(() => {
    radarInFlight = null;
  });
  try {
    const value = await radarInFlight;
    radarCache = { value, at: Date.now() };
    return value;
  } catch (err) {
    if (radarCache) {
      logger.warn({ err }, 'RainViewer did not answer; serving the last frames');
      return radarCache.value;
    }
    throw err;
  }
}

/** For the test suite: forget every cached answer. */
export function resetWeatherCaches(): void {
  summaries.clear();
  inFlight.clear();
  radarCache = null;
  radarInFlight = null;
}

export { UpstreamError };
