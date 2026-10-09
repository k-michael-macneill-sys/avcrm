import { WEATHER_REGIONS, type WeatherRegionKey } from '../../../../src/config/weatherRegions';
import type {
  MapCollection,
  MapCrewProps,
  MapPoint,
  MapPropertyProps,
  MapPropertyStatus,
} from '../../../../src/types/weatherMap';

/**
 * Made-up properties and crews in all four territories, so the map can be
 * shown working — clustering, popups, region switching, the layer toggles —
 * before a branch has a single geocoded customer. Every feature is marked
 * `sample`, and the map labels the layer as sample data whenever it is on.
 *
 * Generated rather than typed out, from a fixed seed, so it is the same on
 * every load. Each territory scatters its houses around a few real
 * neighbourhoods (on land: Kingston's points stay north of the lake shore,
 * Lethbridge's either side of the Oldman River coulee).
 */

interface Neighbourhood {
  latitude: number;
  longitude: number;
  /** Degrees of scatter either way. */
  spread: number;
  city: string;
  streets: string[];
}

const NEIGHBOURHOODS: Record<WeatherRegionKey, Neighbourhood[]> = {
  kingston: [
    { latitude: 44.2385, longitude: -76.4935, spread: 0.006, city: 'Kingston', streets: ['Johnson St', 'Earl St', 'Brock St', 'Clergy St'] },
    { latitude: 44.2475, longitude: -76.5225, spread: 0.008, city: 'Kingston', streets: ['Bath Rd', 'Portsmouth Ave', 'Days Rd'] },
    { latitude: 44.2565, longitude: -76.5685, spread: 0.008, city: 'Kingston', streets: ['Gardiners Rd', 'Taylor-Kidd Blvd', 'Centennial Dr'] },
    { latitude: 44.2595, longitude: -76.4975, spread: 0.006, city: 'Kingston', streets: ['Division St', 'Sir John A. Macdonald Blvd', 'Elliott Ave'] },
  ],
  regina: [
    { latitude: 50.4415, longitude: -104.6185, spread: 0.007, city: 'Regina', streets: ['Albert St', 'College Ave', 'Robinson St'] },
    { latitude: 50.4205, longitude: -104.5915, spread: 0.008, city: 'Regina', streets: ['Hill Ave', 'Grant Rd', 'Rae St'] },
    { latitude: 50.4865, longitude: -104.6325, spread: 0.008, city: 'Regina', streets: ['Rochdale Blvd', 'Sangster Blvd', 'McCarthy Blvd'] },
    { latitude: 50.4515, longitude: -104.5385, spread: 0.008, city: 'Regina', streets: ['Arcola Ave', 'Fleet St', 'Prince of Wales Dr'] },
  ],
  lethbridge: [
    { latitude: 49.6925, longitude: -112.8275, spread: 0.007, city: 'Lethbridge', streets: ['6 Ave S', '13 St S', 'Mayor Magrath Dr S'] },
    { latitude: 49.7125, longitude: -112.8235, spread: 0.006, city: 'Lethbridge', streets: ['13 St N', 'Stafford Dr N', '26 Ave N'] },
    { latitude: 49.6835, longitude: -112.8925, spread: 0.006, city: 'Lethbridge', streets: ['Columbia Blvd W', 'University Dr W', 'Walsh Dr W'] },
    { latitude: 49.7225, longitude: -112.6195, spread: 0.005, city: 'Coaldale', streets: ['20 Ave', '17 St', '21 St'] },
    { latitude: 49.7855, longitude: -112.1505, spread: 0.005, city: 'Taber', streets: ['50 St', '48 Ave', '52 St'] },
  ],
  cranbrook: [
    { latitude: 49.5115, longitude: -115.7645, spread: 0.006, city: 'Cranbrook', streets: ['Baker St', 'Victoria Ave', '10 Ave S'] },
    { latitude: 49.4955, longitude: -115.7835, spread: 0.006, city: 'Cranbrook', streets: ['14 Ave S', '2 St S', 'Kootenay St'] },
    { latitude: 49.5245, longitude: -115.7525, spread: 0.006, city: 'Cranbrook', streets: ['Theatre Rd', '30 Ave N', 'Willowbrook Dr'] },
    { latitude: 49.6695, longitude: -115.9775, spread: 0.005, city: 'Kimberley', streets: ['Wallinger Ave', 'Howard St', 'Spokane St'] },
  ],
};

const FIRST = ['Avery', 'Jordan', 'Morgan', 'Riley', 'Casey', 'Taylor', 'Quinn', 'Reese', 'Hayden', 'Rowan', 'Emerson', 'Parker'];
const LAST = ['Tremblay', 'Gagnon', 'MacLeod', 'Bouchard', 'Fraser', 'Nguyen', 'Campbell', 'Singh', 'Lavoie', 'Wilson', 'Chen', 'Robinson'];
const CREWS: Record<WeatherRegionKey, string[]> = {
  kingston: ['Kingston Crew 1', 'Kingston Crew 2', 'Kingston Crew 3'],
  regina: ['Regina Crew 1', 'Regina Crew 2'],
  lethbridge: ['Lethbridge Crew 1', 'Lethbridge Crew 2', 'Taber Crew'],
  cranbrook: ['Cranbrook Crew 1', 'Kimberley Crew'],
};
const PER_REGION = 26;
/** Roughly a storm morning half done. */
const STATUS_MIX: MapPropertyStatus[] = [
  'serviced', 'serviced', 'serviced', 'pending', 'pending', 'pending',
  'active_route', 'active_route', 'unscheduled', 'unscheduled', 'skipped',
];

/** mulberry32: a small, fixed-seed generator, so the sample never moves. */
function generator(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)] as T;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

function buildSample(): { properties: MapCollection<MapPropertyProps>; crews: MapCollection<MapCrewProps> } {
  const properties: MapPoint<MapPropertyProps>[] = [];
  const crews: MapPoint<MapCrewProps>[] = [];
  const today = new Date();
  today.setHours(5, 0, 0, 0);

  (Object.keys(NEIGHBOURHOODS) as WeatherRegionKey[]).forEach((key, regionIndex) => {
    const random = generator(2026 + regionIndex * 97);
    const region = WEATHER_REGIONS[key];
    const crewNames = CREWS[key];
    const crewOnSite = new Set<string>();

    for (let i = 0; i < PER_REGION; i += 1) {
      const area = pick(random, NEIGHBOURHOODS[key]);
      const latitude = round(area.latitude + (random() * 2 - 1) * area.spread);
      const longitude = round(area.longitude + (random() * 2 - 1) * area.spread * 1.4);
      const status = pick(random, STATUS_MIX);
      const crew = status === 'unscheduled' ? null : pick(random, crewNames);
      const scheduled = new Date(today.getTime() + Math.floor(random() * 8) * 30 * 60_000);
      const id = `sample-${key}-${i + 1}`;
      const customerName = `${pick(random, FIRST)} ${pick(random, LAST)}`;
      const address = `${100 + Math.floor(random() * 880)} ${pick(random, area.streets)}`;
      const visitStatus: MapPropertyProps['visit_status'] =
        status === 'active_route' ? (random() < 0.5 ? 'en_route' : 'in_progress')
        : status === 'pending' ? 'scheduled'
        : status === 'serviced' ? 'completed'
        : status === 'skipped' ? 'skipped'
        : null;

      properties.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [longitude, latitude] },
        properties: {
          property_id: id,
          customer_id: id,
          customer_name: customerName,
          address,
          city: area.city,
          branch_name: region.branch,
          driveway_size_cars: 1 + Math.floor(random() * 4),
          priority: random() < 0.12,
          status,
          work_order_id: null,
          visit_status: visitStatus,
          scheduled_for: status === 'unscheduled' ? null : scheduled.toISOString(),
          crew_name: crew,
          trigger_cm: 3,
          sample: true,
        },
      });

      // One marker per crew, on the first house it is working.
      if ((visitStatus === 'en_route' || visitStatus === 'in_progress') && crew && !crewOnSite.has(crew)) {
        crewOnSite.add(crew);
        crews.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [longitude, latitude] },
          properties: {
            user_id: `sample-crew-${key}-${crewOnSite.size}`,
            crew_name: crew,
            visit_status: visitStatus,
            work_order_id: id,
            address,
            customer_name: customerName,
            since: new Date(scheduled.getTime() + 10 * 60_000).toISOString(),
            visits_done: 2 + Math.floor(random() * 6),
            visits_today: 9 + Math.floor(random() * 5),
            sample: true,
          },
        });
      }
    }
  });

  return {
    properties: { type: 'FeatureCollection', features: properties },
    crews: { type: 'FeatureCollection', features: crews },
  };
}

export const SAMPLE = buildSample();
