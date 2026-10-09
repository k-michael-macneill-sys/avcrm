import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { useNavigate } from 'react-router-dom';
import { Truck } from 'lucide-react';
import {
  AttributionControl,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type GeoJSONSource,
  type LngLatLike,
  type MapGeoJSONFeature,
} from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre finds its worker relative to its own file, which a bundle moves;
// Vite builds the worker and says where it went.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import {
  WEATHER_REGIONS,
  WEATHER_REGION_KEYS,
  regionForBranch,
  type WeatherRegionKey,
} from '../../../../src/config/weatherRegions';
import type {
  DispatchMap,
  MapCollection,
  MapCrewProps,
  MapPropertyProps,
  MapPropertyStatus,
  RadarFrames,
  SnowSummary,
} from '../../../../src/types/weatherMap';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import * as api from '@/lib/api';
import { basemapStyle } from './basemapStyle';
import { CrewPopup, LayersPanel, PropertyPopup, RadarTimeline, WeatherPanel, type LayerState } from './Hud';
import {
  addPropertyLayers,
  CLUSTER_PROPERTIES,
  LAYER_CLUSTER,
  LAYER_PROPERTY,
  PROPERTY_SOURCE,
  RADAR_LAYER_PREFIX,
  radarBeforeId,
  repaint,
  setPropertiesVisible,
} from './overlays';
import { readPalette } from './palette';
import { SAMPLE } from './sampleData';
import './stormMap.css';

setWorkerUrl(workerUrl);

/**
 * The snow map: where it is snowing now (radar), how much more is coming
 * (Environment Canada's HRDPS through Open-Meteo), and where the crews and
 * the customers are, on one screen. Nothing here needs a key.
 */

const SUMMARY_EVERY_MS = 10 * 60_000;
const RADAR_EVERY_MS = 5 * 60_000;
const DISPATCH_EVERY_MS = 60_000;
const FRAME_MS = 600;
/** Frames to linger on the newest picture before the loop starts again. */
const HOLD_FRAMES = 3;

const RADAR_ATTRIBUTION = '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>';
const WEATHER_ATTRIBUTION = '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>';

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Polled<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Fetches now and again every `everyMs`, skipping the beats a hidden tab would waste. */
function usePolled<T>(fetcher: () => Promise<T>, everyMs: number, deps: React.DependencyList): Polled<T> {
  const { handleUnauthenticated } = useAuth();
  const [state, setState] = React.useState<Polled<T>>({ data: null, error: null, loading: true });

  React.useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, ...(deps.length ? { data: null } : {}) }));
    const load = () => {
      if (document.visibilityState === 'hidden') return;
      fetcher()
        .then((data) => !cancelled && setState({ data, error: null, loading: false }))
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof api.Unauthenticated) {
            handleUnauthenticated();
            return;
          }
          const message = err instanceof api.ApiError ? err.message : String(err);
          // Keep showing the last good answer under the error.
          setState((s) => ({ data: s.data, error: message, loading: false }));
        });
    };
    load();
    const timer = window.setInterval(load, everyMs);
    document.addEventListener('visibilitychange', load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

/** Renders a React node into a MapLibre popup, and tidies it away on close. */
function openPopup(map: MapLibreMap, at: LngLatLike, node: React.ReactNode): Popup {
  const container = document.createElement('div');
  const root = createRoot(container);
  root.render(node);
  const popup = new Popup({ maxWidth: '300px', className: 'storm-popup', focusAfterOpen: true })
    .setLngLat(at)
    .setDOMContent(container)
    .addTo(map);
  // Not during MapLibre's own event: React will not unmount mid-dispatch.
  popup.on('close', () => window.setTimeout(() => root.unmount(), 0));
  return popup;
}

function merge<P>(...collections: (MapCollection<P> | null)[]): MapCollection<P> {
  return { type: 'FeatureCollection', features: collections.flatMap((c) => c?.features ?? []) };
}

export default function StormMap(): JSX.Element {
  const { branch } = useAuth();
  const navigate = useNavigate();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<MapLibreMap | null>(null);
  const popupRef = React.useRef<Popup | null>(null);
  const [ready, setReady] = React.useState(false);
  const [mapError, setMapError] = React.useState<string | null>(null);

  const [region, setRegion] = React.useState<WeatherRegionKey>(() => regionForBranch(branch?.name) ?? 'kingston');
  const [layers, setLayers] = React.useState<LayerState>({ radar: true, properties: true, crews: true, sample: false });
  const [frameIndex, setFrameIndex] = React.useState(0);
  const [playing, setPlaying] = React.useState(() => !reducedMotion());
  const [opacity, setOpacity] = React.useState(0.7);

  const summary = usePolled(
    () => api.get<SnowSummary>(`/weather/snow-summary?region=${region}`),
    SUMMARY_EVERY_MS,
    [region],
  );
  const radar = usePolled(() => api.get<RadarFrames>('/weather/radar'), RADAR_EVERY_MS, []);
  const dispatch = usePolled(() => api.get<DispatchMap>('/weather/dispatch-map'), DISPATCH_EVERY_MS, []);

  const hasRealData = (dispatch.data?.properties.features.length ?? 0) > 0;
  // With no geocoded customers yet, the sample is on so the map has something to show.
  const sampleDecided = React.useRef(false);
  React.useEffect(() => {
    if (sampleDecided.current || !dispatch.data) return;
    sampleDecided.current = true;
    if (!hasRealData) setLayers((l) => ({ ...l, sample: true }));
  }, [dispatch.data, hasRealData]);

  const properties = React.useMemo(
    () => merge<MapPropertyProps>(dispatch.data?.properties ?? null, layers.sample ? SAMPLE.properties : null),
    [dispatch.data, layers.sample],
  );
  const crews = React.useMemo(
    () => merge<MapCrewProps>(dispatch.data?.crews ?? null, layers.sample ? SAMPLE.crews : null),
    [dispatch.data, layers.sample],
  );
  const counts = React.useMemo(() => {
    const out: Partial<Record<MapPropertyStatus, number>> = {};
    for (const f of properties.features) out[f.properties.status] = (out[f.properties.status] ?? 0) + 1;
    return out;
  }, [properties]);

  // --- The map -----------------------------------------------------------------
  React.useEffect(() => {
    if (!containerRef.current) return;
    const start = WEATHER_REGIONS[region];
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: containerRef.current,
        style: basemapStyle(readPalette()),
        center: [start.longitude, start.latitude],
        zoom: start.zoom,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
      });
    } catch (err) {
      // No WebGL: an old machine, or a browser with it switched off.
      setMapError(err instanceof Error ? err.message : String(err));
      return;
    }
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(
      new AttributionControl({ compact: true, customAttribution: WEATHER_ATTRIBUTION }),
      'bottom-right',
    );

    map.on('load', () => {
      map.addSource(PROPERTY_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterRadius: 48,
        clusterMaxZoom: 13,
        clusterProperties: CLUSTER_PROPERTIES as never,
      });
      addPropertyLayers(map, readPalette());
      setReady(true);
    });

    map.on('click', LAYER_CLUSTER, (e) => {
      const feature = e.features?.[0] as MapGeoJSONFeature | undefined;
      const clusterId = feature?.properties?.cluster_id as number | undefined;
      if (!feature || clusterId === undefined) return;
      const source = map.getSource(PROPERTY_SOURCE) as GeoJSONSource;
      void source.getClusterExpansionZoom(clusterId).then((zoom) => {
        const [lng, lat] = (feature.geometry as Point).coordinates as [number, number];
        map.easeTo({ center: [lng, lat], zoom, duration: reducedMotion() ? 0 : 500 });
      });
    });
    map.on('click', LAYER_PROPERTY, (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const props = feature.properties as unknown as MapPropertyProps;
      const [lng, lat] = (feature.geometry as Point).coordinates as [number, number];
      popupRef.current?.remove();
      popupRef.current = openPopup(
        map,
        [lng, lat],
        <PropertyPopup props={props} onOpenVisit={(id) => navigate(`/work-orders/${id}`)} />,
      );
    });
    for (const id of [LAYER_CLUSTER, LAYER_PROPERTY]) {
      map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
    }

    // The theme toggle flips data-theme on <html>: repaint from the new tokens.
    const observer = new MutationObserver(() => {
      if (map.isStyleLoaded()) repaint(map, readPalette());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      observer.disconnect();
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // The map is made once; region changes fly it, below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Region ------------------------------------------------------------------
  const firstFlight = React.useRef(true);
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (firstFlight.current) {
      firstFlight.current = false;
      return;
    }
    const to = WEATHER_REGIONS[region];
    popupRef.current?.remove();
    const camera = { center: [to.longitude, to.latitude] as [number, number], zoom: to.zoom };
    if (reducedMotion()) map.jumpTo(camera);
    else map.flyTo({ ...camera, speed: 1.6, curve: 1.4, essential: true });
  }, [region]);

  // --- Properties --------------------------------------------------------------
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource(PROPERTY_SOURCE) as GeoJSONSource | undefined)?.setData(properties as FeatureCollection);
  }, [properties, ready]);

  React.useEffect(() => {
    const map = mapRef.current;
    if (map && ready) setPropertiesVisible(map, layers.properties);
  }, [layers.properties, ready]);

  // --- Crews -------------------------------------------------------------------
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !layers.crews) return;
    const markers = crews.features.map((feature) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className =
        'grid size-8 place-items-center rounded-full border-2 border-primary bg-card text-primary shadow-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';
      el.setAttribute('aria-label', `${feature.properties.crew_name}, ${feature.properties.visit_status === 'in_progress' ? 'on site' : 'en route'}`);
      const root = createRoot(el);
      root.render(<Truck className="size-4" aria-hidden />);
      const marker = new Marker({ element: el }).setLngLat(feature.geometry.coordinates).addTo(map);
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        popupRef.current?.remove();
        popupRef.current = openPopup(map, feature.geometry.coordinates, <CrewPopup props={feature.properties} />);
      });
      return { marker, root };
    });
    return () => {
      for (const { marker, root } of markers) {
        marker.remove();
        window.setTimeout(() => root.unmount(), 0);
      }
    };
  }, [crews, layers.crews, ready]);

  // --- Radar -------------------------------------------------------------------
  const frames = React.useMemo(() => radar.data?.frames ?? [], [radar.data]);
  const latestPast = React.useMemo(
    () => frames.reduce((last, f, i) => (f.kind === 'past' ? i : last), frames.length - 1),
    [frames],
  );

  // A new set of frames: one raster layer each, all loading at once, shown one at a time.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || frames.length === 0) return;
    const ids = frames.map((_, i) => `${RADAR_LAYER_PREFIX}${i}`);
    frames.forEach((frame, i) => {
      const id = ids[i] as string;
      map.addSource(id, {
        type: 'raster',
        tiles: [frame.tiles],
        tileSize: 256,
        maxzoom: radar.data?.max_zoom ?? 7,
        attribution: RADAR_ATTRIBUTION,
      });
      map.addLayer(
        {
          id,
          type: 'raster',
          source: id,
          paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 },
        },
        radarBeforeId(map),
      );
    });
    setFrameIndex(latestPast);
    return () => {
      if (!mapRef.current) return;
      for (const id of ids) {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
      }
    };
  }, [frames, latestPast, ready, radar.data?.max_zoom]);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    frames.forEach((_, i) => {
      const id = `${RADAR_LAYER_PREFIX}${i}`;
      if (!map.getLayer(id)) return;
      map.setLayoutProperty(id, 'visibility', layers.radar ? 'visible' : 'none');
      map.setPaintProperty(id, 'raster-opacity', i === frameIndex ? opacity : 0);
    });
  }, [frames, frameIndex, opacity, layers.radar, ready]);

  React.useEffect(() => {
    if (!playing || !layers.radar || frames.length < 2) return;
    let held = 0;
    const timer = window.setInterval(() => {
      setFrameIndex((i) => {
        if (i === frames.length - 1 && held < HOLD_FRAMES) {
          held += 1;
          return i;
        }
        held = 0;
        return (i + 1) % frames.length;
      });
    }, FRAME_MS);
    return () => window.clearInterval(timer);
  }, [playing, layers.radar, frames.length]);

  // -----------------------------------------------------------------------------
  const showSampleBadge = layers.sample && (layers.properties || layers.crews);

  return (
    <>
      <PageHeader
        title="Snow Map"
        subtitle="Radar, Environment Canada’s high-resolution snow forecast, and today’s routes"
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tabs value={region} onValueChange={(v) => setRegion(v as WeatherRegionKey)} className="max-[720px]:hidden">
          <TabsList aria-label="Service region">
            {WEATHER_REGION_KEYS.map((key) => (
              <TabsTrigger key={key} value={key}>
                {WEATHER_REGIONS[key].short}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="hidden w-full max-[720px]:block">
          <Select value={region} onValueChange={(v) => setRegion(v as WeatherRegionKey)}>
            <SelectTrigger aria-label="Service region">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEATHER_REGION_KEYS.map((key) => (
                <SelectItem key={key} value={key}>
                  {WEATHER_REGIONS[key].name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {showSampleBadge ? (
          <Badge variant="warning" className="ml-auto max-[720px]:ml-0">
            Sample data shown — not real customers
          </Badge>
        ) : null}
        {dispatch.data?.truncated ? <Badge variant="serious">Showing the first 5,000 properties</Badge> : null}
      </div>

      <div className="relative">
        {/* On a phone the map owns every swipe, so it has to fit on screen. */}
        <div className="relative h-[calc(100vh-13rem)] min-h-[460px] overflow-hidden rounded-xl border border-border max-[720px]:h-[60dvh] max-[720px]:min-h-[340px]">
          {mapError ? (
            <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">
              The map could not start in this browser ({mapError}). It needs WebGL switched on.
            </div>
          ) : (
            <div ref={containerRef} data-testid="storm-map" className="storm-map size-full bg-background" />
          )}

          <div className="absolute left-3 top-3 z-10">
            <LayersPanel layers={layers} onChange={setLayers} hasRealData={hasRealData} counts={counts} />
          </div>

          {layers.radar ? (
            <div className="absolute bottom-3 left-3 right-14 z-10 max-w-xl">
              <RadarTimeline
                frames={frames}
                index={Math.min(frameIndex, Math.max(0, frames.length - 1))}
                onIndex={setFrameIndex}
                playing={playing}
                onPlaying={setPlaying}
                opacity={opacity}
                onOpacity={setOpacity}
                error={radar.data ? null : radar.error}
              />
            </div>
          ) : null}
        </div>

        <div className="absolute right-3 top-3 z-10 w-72 max-[720px]:static max-[720px]:mt-3 max-[720px]:w-full">
          <WeatherPanel summary={summary.data} error={summary.error} loading={summary.loading} />
        </div>
      </div>
      {dispatch.error && !dispatch.data ? (
        <p className="mt-2 text-xs text-critical">Could not load the dispatch layer: {dispatch.error}</p>
      ) : null}
    </>
  );
}
