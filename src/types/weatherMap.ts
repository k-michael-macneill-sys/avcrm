import type { WorkOrderStatus } from './models';
import type { WeatherRegionKey } from '../config/weatherRegions';

/**
 * What the weather map's endpoints answer with. Shared with the client, which
 * imports these types the way it does the models.
 */

/** How a property shows on the map, from the day's visit to it. */
export const MAP_PROPERTY_STATUSES = [
  /** A crew is on the way or on site. */
  'active_route',
  /** Booked for today, not started. */
  'pending',
  /** Done today. */
  'serviced',
  /** Booked today and skipped. */
  'skipped',
  /** An active customer with no visit today. */
  'unscheduled',
] as const;
export type MapPropertyStatus = (typeof MAP_PROPERTY_STATUSES)[number];

export interface MapPoint<P> {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: P;
}

export interface MapCollection<P> {
  type: 'FeatureCollection';
  features: MapPoint<P>[];
}

export interface MapPropertyProps {
  property_id: string;
  customer_id: string;
  customer_name: string;
  address: string;
  city: string;
  branch_name: string;
  /** "Lot size": the driveway, in cars (6 means 6 or more). */
  driveway_size_cars: number | null;
  priority: boolean;
  status: MapPropertyStatus;
  /** The visit the status comes from, if there is one today. */
  work_order_id: string | null;
  visit_status: WorkOrderStatus | null;
  scheduled_for: string | null;
  crew_name: string | null;
  /** Snow depth that triggers a clearing: the weather bot's threshold. */
  trigger_cm: number;
  /** True only for the built-in sample data, never for a real customer. */
  sample?: boolean;
}

export interface MapCrewProps {
  user_id: string;
  crew_name: string;
  /** Where they are in the visit the marker stands on. */
  visit_status: 'en_route' | 'in_progress';
  work_order_id: string;
  address: string;
  customer_name: string;
  since: string | null;
  visits_done: number;
  visits_today: number;
  sample?: boolean;
}

export interface DispatchMap {
  generated_at: string;
  trigger_cm: number;
  properties: MapCollection<MapPropertyProps>;
  crews: MapCollection<MapCrewProps>;
  /** More properties than the map draws; the rest are left off. */
  truncated: boolean;
}

/** A freezing rain / ice call for the next day, from the hourly forecast. */
export interface IceRisk {
  level: 'none' | 'watch' | 'warning';
  /** Plain words: what is expected and when it starts. */
  summary: string;
  /** Local time of the first hour that raised it. */
  starts_at: string | null;
}

export interface SnowSummaryHour {
  /** Local ISO time, in the region's zone. */
  time: string;
  snowfall_cm: number;
  precipitation_mm: number;
  /** Rain and showers: the liquid part, which is what freezes. */
  rain_mm: number;
  temperature_c: number | null;
  weather_code: number | null;
}

export interface SnowSummary {
  region: {
    key: WeatherRegionKey;
    name: string;
    latitude: number;
    longitude: number;
    timezone: string;
  };
  /** When the forecast was fetched from Open-Meteo. */
  fetched_at: string;
  /** Served from the last good answer because Open-Meteo did not respond. */
  stale: boolean;
  /** The weather model behind the snow numbers, as Open-Meteo names it. */
  model: string;
  current: {
    time: string;
    temperature_c: number | null;
    apparent_temperature_c: number | null;
    wind_speed_kmh: number | null;
    wind_gusts_kmh: number | null;
    wind_direction_deg: number | null;
    weather_code: number | null;
    condition: string;
  };
  snow: {
    next_6h_cm: number;
    next_24h_cm: number;
    next_48h_cm: number;
    /** On the ground now; null where no model reports it. */
    depth_cm: number | null;
    /** The clearing trigger, for comparison. */
    trigger_cm: number;
  };
  ice: IceRisk;
  hourly: SnowSummaryHour[];
}

export interface RadarFrame {
  /** Unix seconds. */
  time: number;
  /** Tile URL template, {z}/{x}/{y} for the map to fill in. */
  tiles: string;
  kind: 'past' | 'nowcast';
}

export interface RadarFrames {
  generated_at: number;
  frames: RadarFrame[];
  /** Radar tiles above this zoom come back blank; the map overzooms instead. */
  max_zoom: number;
}
