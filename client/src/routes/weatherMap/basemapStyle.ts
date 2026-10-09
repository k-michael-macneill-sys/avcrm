import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { blend, css, type MapPalette } from './palette';

/**
 * The basemap: OpenFreeMap's vector tiles (OpenStreetMap data in the
 * OpenMapTiles schema — no key, no account, commercial use allowed), drawn
 * with a style of our own so every colour is one of the app's tokens.
 *
 * Deliberately quiet: a dispatcher is looking at weather and houses, so land
 * is the page background, roads are border-coloured, and labels are the
 * muted foreground. Only water gets a tint, a little of the primary blue.
 */

const TILES = 'https://tiles.openfreemap.org/planet';
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
export const FONT_REGULAR = ['Noto Sans Regular'];
export const FONT_BOLD = ['Noto Sans Bold'];
const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

/** The colours the basemap is drawn in, all from tokens. */
function shades(p: MapPalette) {
  return {
    land: css(p.background),
    water: css(blend(p.background, p.primary, p.dark ? 0.22 : 0.16)),
    waterLine: css(blend(p.background, p.primary, p.dark ? 0.35 : 0.3)),
    green: css(blend(p.background, p.good, p.dark ? 0.08 : 0.1)),
    built: css(p.muted, p.dark ? 0.35 : 0.55),
    building: css(p.muted, p.dark ? 0.7 : 0.9),
    minorRoad: css(p.border, p.dark ? 0.7 : 1),
    majorRoad: css(blend(p.border, p['muted-foreground'], 0.35)),
    motorway: css(blend(p.border, p['muted-foreground'], 0.6)),
    boundary: css(p['muted-foreground'], 0.5),
    label: css(p['muted-foreground']),
    placeLabel: css(p.foreground, 0.85),
    halo: css(p.background, 0.9),
  };
}

/** Every basemap layer, with its paint for this palette. */
export function basemapLayers(p: MapPalette): LayerSpecification[] {
  const c = shades(p);
  const roads = (id: string, classes: string[], color: string, widths: [number, number][], minzoom = 5): LayerSpecification => ({
    id,
    type: 'line',
    source: 'basemap',
    'source-layer': 'transportation',
    minzoom,
    filter: ['in', ['get', 'class'], ['literal', classes]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': color,
      'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], ...widths.flat()],
    },
  });

  return [
    { id: 'land', type: 'background', paint: { 'background-color': c.land } },
    {
      id: 'landcover-green',
      type: 'fill',
      source: 'basemap',
      'source-layer': 'landcover',
      filter: ['in', ['get', 'class'], ['literal', ['grass', 'wood', 'wetland']]],
      paint: { 'fill-color': c.green },
    },
    {
      id: 'park',
      type: 'fill',
      source: 'basemap',
      'source-layer': 'park',
      paint: { 'fill-color': c.green },
    },
    {
      id: 'landuse-built',
      type: 'fill',
      source: 'basemap',
      'source-layer': 'landuse',
      filter: ['in', ['get', 'class'], ['literal', ['residential', 'commercial', 'industrial', 'retail']]],
      paint: { 'fill-color': c.built },
    },
    {
      id: 'water',
      type: 'fill',
      source: 'basemap',
      'source-layer': 'water',
      paint: { 'fill-color': c.water },
    },
    {
      id: 'waterway',
      type: 'line',
      source: 'basemap',
      'source-layer': 'waterway',
      minzoom: 8,
      paint: { 'line-color': c.waterLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 14, 2] },
    },
    {
      id: 'building',
      type: 'fill',
      source: 'basemap',
      'source-layer': 'building',
      minzoom: 14,
      paint: { 'fill-color': c.building },
    },
    roads('road-minor', ['minor', 'service', 'track'], c.minorRoad, [[12, 0.5], [16, 6]], 12),
    roads('road-secondary', ['secondary', 'tertiary'], c.majorRoad, [[8, 0.5], [16, 8]], 8),
    roads('road-primary', ['primary', 'trunk'], c.majorRoad, [[6, 0.6], [16, 10]], 6),
    roads('road-motorway', ['motorway'], c.motorway, [[5, 0.8], [16, 12]], 5),
    {
      id: 'boundary-province',
      type: 'line',
      source: 'basemap',
      'source-layer': 'boundary',
      filter: ['all', ['in', ['get', 'admin_level'], ['literal', [2, 4]]], ['!=', ['get', 'maritime'], 1]],
      paint: {
        'line-color': c.boundary,
        'line-dasharray': [3, 2],
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 10, 1.4],
      },
    },
    {
      id: 'label-water',
      type: 'symbol',
      source: 'basemap',
      'source-layer': 'water_name',
      layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': FONT_REGULAR, 'text-size': 12 },
      paint: { 'text-color': c.waterLine, 'text-halo-color': c.halo, 'text-halo-width': 1 },
    },
    {
      id: 'label-road',
      type: 'symbol',
      source: 'basemap',
      'source-layer': 'transportation_name',
      minzoom: 13,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-font': FONT_REGULAR,
        'text-size': 11,
      },
      paint: { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.2 },
    },
    {
      id: 'label-place-minor',
      type: 'symbol',
      source: 'basemap',
      'source-layer': 'place',
      minzoom: 10,
      filter: ['in', ['get', 'class'], ['literal', ['village', 'hamlet', 'suburb', 'neighbourhood']]],
      layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': FONT_REGULAR, 'text-size': 12 },
      paint: { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.2 },
    },
    {
      id: 'label-place',
      type: 'symbol',
      source: 'basemap',
      'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
      layout: {
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-font': FONT_BOLD,
        'text-size': ['interpolate', ['linear'], ['zoom'], 5, 11, 12, 16],
      },
      paint: { 'text-color': c.placeLabel, 'text-halo-color': c.halo, 'text-halo-width': 1.5 },
    },
  ];
}

/** The first label layer: weather goes beneath it so town names stay readable. */
export const FIRST_LABEL_LAYER = 'label-water';

export function basemapStyle(p: MapPalette): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      basemap: { type: 'vector', url: TILES, attribution: ATTRIBUTION },
    },
    layers: basemapLayers(p),
  };
}
