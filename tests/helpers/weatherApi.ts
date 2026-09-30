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

export interface FakeWeatherApi {
  /** What WEATHER_API_BASE and WEATHER_GEOCODING_API_BASE should be. */
  url: string;
  startDate: (date: string) => void;
  snow: (fn: SnowFn) => void;
  place: (region: string, latitude: number, longitude: number) => void;
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

    if (url.pathname === '/forecast') {
      seen.push(url.searchParams);
      if (failStatus) {
        json(failStatus, { error: true, reason: 'Stand-in told to fail' });
        return;
      }
      if (url.searchParams.get('hourly') !== 'snowfall' || !url.searchParams.get('timezone')) {
        json(400, { error: true, reason: 'hourly=snowfall and timezone are required' });
        return;
      }

      const latitude = Number(url.searchParams.get('latitude'));
      const longitude = Number(url.searchParams.get('longitude'));
      const time: string[] = [];
      const snowfall: number[] = [];
      for (let day = 0; day < 3; day += 1) {
        const d = new Date(`${start}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + day);
        const date = d.toISOString().slice(0, 10);
        for (let hour = 0; hour < 24; hour += 1) {
          const stamp = `${date}T${String(hour).padStart(2, '0')}:00`;
          time.push(stamp);
          snowfall.push(snowFn(latitude, longitude, stamp));
        }
      }
      json(200, {
        latitude,
        longitude,
        timezone: url.searchParams.get('timezone'),
        hourly_units: { time: 'iso8601', snowfall: 'cm' },
        hourly: { time, snowfall },
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
    failWith: (status) => {
      failStatus = status;
    },
    reset: () => {
      snowFn = () => 0;
      failStatus = null;
      places.clear();
      seen.length = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
