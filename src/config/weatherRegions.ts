/**
 * The service territories the weather map knows, with the exact point each
 * one's forecast is taken at.
 *
 * The server uses these for every Open-Meteo request (a `region` that is not
 * here is refused, so the endpoint cannot be used to fetch weather for
 * anywhere else), and the client imports the same list for its region tabs
 * and camera — so the place the map flies to is the place the numbers are
 * for. Plain data with no imports, which is what lets the browser bundle it.
 *
 * `branch` is the CRM branch that serves the territory, by its sign-in name
 * (see SIGN_IN_BRANCHES), so a branch's own sign-in opens the map on home.
 */

export interface WeatherRegion {
  key: string;
  /** As the tabs and the HUD show it. */
  name: string;
  /** For a narrow tab. */
  short: string;
  latitude: number;
  longitude: number;
  /** Open-Meteo answers in this zone's local time. */
  timezone: string;
  branch: string;
  /** Camera zoom on arrival: a city, or a stretch of country. */
  zoom: number;
}

export const WEATHER_REGIONS = {
  kingston: {
    key: 'kingston',
    name: 'Kingston, ON',
    short: 'Kingston',
    latitude: 44.2312,
    longitude: -76.486,
    timezone: 'America/Toronto',
    branch: 'Kingston',
    zoom: 10.5,
  },
  regina: {
    key: 'regina',
    name: 'Regina, SK',
    short: 'Regina',
    latitude: 50.4547,
    longitude: -104.6067,
    timezone: 'America/Regina',
    branch: 'Regina',
    zoom: 10.5,
  },
  lethbridge: {
    key: 'lethbridge',
    name: 'Lethbridge & Southern Alberta',
    short: 'Lethbridge',
    latitude: 49.6936,
    longitude: -112.8419,
    timezone: 'America/Edmonton',
    branch: 'Alberta',
    zoom: 9,
  },
  cranbrook: {
    key: 'cranbrook',
    name: 'Cranbrook, BC (Kootenays)',
    short: 'Cranbrook',
    latitude: 49.5097,
    longitude: -115.7688,
    // The East Kootenays keep Mountain time with Alberta, not Pacific.
    timezone: 'America/Edmonton',
    branch: 'Cranbrook',
    zoom: 9.5,
  },
} as const satisfies Record<string, WeatherRegion>;

export type WeatherRegionKey = keyof typeof WEATHER_REGIONS;

/** In the order the tabs show them, east to west. */
export const WEATHER_REGION_KEYS = Object.keys(WEATHER_REGIONS) as WeatherRegionKey[];

export function isWeatherRegionKey(value: string): value is WeatherRegionKey {
  return Object.prototype.hasOwnProperty.call(WEATHER_REGIONS, value);
}

/** The territory a branch serves, by the branch's name; null for one without. */
export function regionForBranch(branchName: string | null | undefined): WeatherRegionKey | null {
  const hit = WEATHER_REGION_KEYS.find((key) => WEATHER_REGIONS[key].branch === branchName);
  return hit ?? null;
}
