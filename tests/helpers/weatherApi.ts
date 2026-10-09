import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Open-Meteo: the hourly forecast and the geocoder, just the
 * parts the weather bot reads.
 *
 * A test sets how much snow falls at a place and hour with `snow`, and which
 * postal regions the geocoder knows with `place`. Hours are the local ISO
 * strings Open-Meteo answers with when asked for a timezone, and the forecast
 * covers three days from `startDate`, the way `forecast_days=3` would.
 */

export type SnowFn = (latitude: number, longitude: number, localHour: string) => number;

/** Everything else the weather map reads for an hour; the defaults are a dry, cold night. */
export interface HourConditions {
  temperature_2m?: number;
  weather_code?: number;
  rain?: number;
  showers?: number;
  /** Metres, as Open-Meteo reports it; null when the model has none. */
  snow_depth?: number | null;
}
export type ConditionsFn = (localHour: string, model: string | null) => HourConditions;

export interface FakeWeatherApi {
  /** What WEATHER_API_BASE and WEATHER_GEOCODING_API_BASE should be. */
  url: string;
  startDate: (date: string) => void;
  snow: (fn: SnowFn) => void;
  place: (region: string, latitude: number, longitude: number) => void;
  /** The weather map's extra variables, per hour and model. */
  conditions: (fn: ConditionsFn) => void;
  /** The local time `current.time` reports. */
  now: (localTime: string) => void;
  /** RainViewer's index, as the stand-in serves it at /public/weather-maps.json. */
  radarIndex: (body: unknown) => void;
  /** Radar index requests seen. */
  radarRequests: () => number;
  /** Forecast requests seen, most recent last. */
  forecasts: () => URLSearchParams[];
  /** Make the next forecast requests fail with this status. */
  failWith: (status: number | null) => void;
  reset: () => void;
  close: () => Promise<void>;
}

export async function startWeatherApi(): Promise<FakeWeatherApi> {
  let start = '2026-12-09';
  let snowFn: SnowFn = () => 0;
  let failStatus: number | null = null;
  let conditionsFn: ConditionsFn = () => ({});
  let nowTime = '2026-12-09T20:15';
  let radarBody: unknown = { generated: 0, host: '', radar: { past: [] } };
  let radarCount = 0;
  const places = new Map<string, { latitude: number; longitude: number }>();
  const seen: URLSearchParams[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/search') {
      const hit = places.get(url.searchParams.get('name') ?? '');
      json(200, hit ? { results: [{ name: url.searchParams.get('name'), ...hit }] } : {});
      return;
    }

    if (url.pathname === '/public/weather-maps.json') {
      radarCount += 1;
      if (failStatus) {
        json(failStatus, { error: true });
        return;
      }
      json(200, radarBody);
      return;
    }

    if (url.pathname === '/forecast') {
      seen.push(url.searchParams);
      if (failStatus) {
        json(failStatus, { error: true, reason: 'Stand-in told to fail' });
        return;
      }
      const variables = (url.searchParams.get('hourly') ?? '').split(',').filter(Boolean);
      if (variables.length === 0 || !url.searchParams.get('timezone')) {
        json(400, { error: true, reason: 'hourly and timezone are required' });
        return;
      }
      const model = url.searchParams.get('models');

      const latitude = Number(url.searchParams.get('latitude'));
      const longitude = Number(url.searchParams.get('longitude'));
      const time: string[] = [];
      const columns: Record<string, (number | null)[]> = {};
      for (const v of variables) columns[v] = [];
      for (let day = 0; day < 3; day += 1) {
        const d = new Date(`${start}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + day);
        const date = d.toISOString().slice(0, 10);
        for (let hour = 0; hour < 24; hour += 1) {
          const stamp = `${date}T${String(hour).padStart(2, '0')}:00`;
          time.push(stamp);
          const c = conditionsFn(stamp, model);
          const values: Record<string, number | null> = {
            snowfall: snowFn(latitude, longitude, stamp),
            precipitation: snowFn(latitude, longitude, stamp) / 0.7 + (c.rain ?? 0) + (c.showers ?? 0),
            rain: c.rain ?? 0,
            showers: c.showers ?? 0,
            temperature_2m: c.temperature_2m ?? -6,
            weather_code: c.weather_code ?? 3,
            snow_depth: c.snow_depth === undefined ? 0.12 : c.snow_depth,
          };
          for (const v of variables) columns[v]?.push(values[v] ?? null);
        }
      }
      const current = url.searchParams.get('current');
      const now = conditionsFn(`${nowTime.slice(0, 13)}:00`, model);
      json(200, {
        latitude,
        longitude,
        timezone: url.searchParams.get('timezone'),
        hourly_units: { time: 'iso8601', snowfall: 'cm' },
        hourly: { time, ...columns },
        ...(current
          ? {
              current: {
                time: nowTime,
                interval: 900,
                temperature_2m: now.temperature_2m ?? -6,
                apparent_temperature: (now.temperature_2m ?? -6) - 5,
                wind_speed_10m: 22,
                wind_gusts_10m: 41,
                wind_direction_10m: 270,
                weather_code: now.weather_code ?? 3,
              },
            }
          : {}),
      });
      return;
    }

    json(404, { error: true, reason: 'Not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    startDate: (date) => {
      start = date;
    },
    snow: (fn) => {
      snowFn = fn;
    },
    place: (region, latitude, longitude) => {
      places.set(region, { latitude, longitude });
    },
    forecasts: () => [...seen],
    conditions: (fn) => {
      conditionsFn = fn;
    },
    now: (localTime) => {
      nowTime = localTime;
    },
    radarIndex: (body) => {
      radarBody = body;
    },
    radarRequests: () => radarCount,
    failWith: (status) => {
      failStatus = status;
    },
    reset: () => {
      snowFn = () => 0;
      failStatus = null;
      conditionsFn = () => ({});
      nowTime = '2026-12-09T20:15';
      radarBody = { generated: 0, host: '', radar: { past: [] } };
      radarCount = 0;
      places.clear();
      seen.length = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
