import type { LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import type { MapPropertyStatus } from '../../../../src/types/weatherMap';
import { basemapLayers, FIRST_LABEL_LAYER, FONT_BOLD } from './basemapStyle';
import { css, type MapPalette, type Hsl } from './palette';

/**
 * The CRM's layers over the basemap: client properties (clustered when
 * zoomed out) and the radar frames. Crews are DOM markers, see StormMap.
 */

export const PROPERTY_SOURCE = 'properties';
export const LAYER_CLUSTER = 'property-clusters';
export const LAYER_CLUSTER_COUNT = 'property-cluster-count';
export const LAYER_PROPERTY = 'property-points';
const PROPERTY_LAYERS = [LAYER_CLUSTER, LAYER_CLUSTER_COUNT, LAYER_PROPERTY];

/** Each status's token, the legend's and the markers' alike. */
export const STATUS_TOKEN: Record<MapPropertyStatus, keyof Omit<MapPalette, 'dark'>> = {
  active_route: 'primary',
  pending: 'warning',
  serviced: 'good',
  skipped: 'serious',
  unscheduled: 'muted-foreground',
};

export const STATUS_LABEL: Record<MapPropertyStatus, string> = {
  active_route: 'Active route',
  pending: 'Pending',
  serviced: 'Serviced',
  skipped: 'Skipped',
  unscheduled: 'No visit today',
};

/** The legend's dot class for each status, from the same tokens. */
export const STATUS_DOT: Record<MapPropertyStatus, string> = {
  active_route: 'bg-primary',
  pending: 'bg-warning',
  serviced: 'bg-good',
  skipped: 'bg-serious',
  unscheduled: 'bg-muted-foreground',
};

const count = (status: MapPropertyStatus) => ['+', ['case', ['==', ['get', 'status'], status], 1, 0]];

/** What a cluster adds up, so its ring can say the most urgent thing inside it. */
export const CLUSTER_PROPERTIES = {
  active_route: count('active_route'),
  pending: count('pending'),
  skipped: count('skipped'),
  serviced: count('serviced'),
};

const tokenOf = (p: MapPalette, status: MapPropertyStatus): Hsl => p[STATUS_TOKEN[status]];

function propertyLayers(p: MapPalette): LayerSpecification[] {
  const statusColor = [
    'match',
    ['get', 'status'],
    ...(['active_route', 'pending', 'serviced', 'skipped'] as const).flatMap((s) => [s, css(tokenOf(p, s))]),
    css(tokenOf(p, 'unscheduled')),
  ];
  // A cluster wears the most urgent status inside it.
  const clusterColor = [
    'case',
    ['>', ['get', 'active_route'], 0], css(p.primary),
    ['>', ['get', 'pending'], 0], css(p.warning),
    ['>', ['get', 'skipped'], 0], css(p.serious),
    ['>', ['get', 'serviced'], 0], css(p.good),
    css(p['muted-foreground']),
  ];
  return [
    {
      id: LAYER_CLUSTER,
      type: 'circle',
      source: PROPERTY_SOURCE,
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': css(p.card, 0.92),
        'circle-stroke-color': clusterColor as never,
        'circle-stroke-width': 3,
        'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 50, 24],
      },
    },
    {
      id: LAYER_CLUSTER_COUNT,
      type: 'symbol',
      source: PROPERTY_SOURCE,
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': FONT_BOLD,
        'text-size': 12,
        'text-allow-overlap': true,
      },
      paint: { 'text-color': css(p['card-foreground']) },
    },
    {
      id: LAYER_PROPERTY,
      type: 'circle',
      source: PROPERTY_SOURCE,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': statusColor as never,
        'circle-radius': ['case', ['get', 'priority'], 8, 6.5],
        'circle-stroke-color': css(p.card),
        'circle-stroke-width': 2,
      },
    },
  ];
}

export const RADAR_LAYER_PREFIX = 'radar-';

/** Puts the property layers on the map, above everything. */
export function addPropertyLayers(map: MapLibreMap, p: MapPalette): void {
  for (const layer of propertyLayers(p)) map.addLayer(layer);
}

export function setPropertiesVisible(map: MapLibreMap, visible: boolean): void {
  for (const id of PROPERTY_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

/** Radar layers go under the labels, over roads and water. */
export function radarBeforeId(map: MapLibreMap): string | undefined {
  return map.getLayer(FIRST_LABEL_LAYER) ? FIRST_LABEL_LAYER : undefined;
}

/**
 * Repaints every layer of ours for a new palette — what a theme switch does,
 * without reloading a tile.
 */
export function repaint(map: MapLibreMap, p: MapPalette): void {
  for (const layer of [...basemapLayers(p), ...propertyLayers(p)]) {
    if (!map.getLayer(layer.id) || !('paint' in layer) || !layer.paint) continue;
    for (const [key, value] of Object.entries(layer.paint)) {
      map.setPaintProperty(layer.id, key as never, value as never);
    }
  }
}
