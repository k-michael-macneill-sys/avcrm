import * as React from 'react';
import { Layers, Pause, Play, Snowflake, Truck, Wind, X } from 'lucide-react';
import type {
  MapCrewProps,
  MapPropertyProps,
  MapPropertyStatus,
  RadarFrame,
  SnowSummary,
} from '../../../../src/types/weatherMap';
import { ErrorNotice } from '@/components/Misc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { humanize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { STATUS_DOT, STATUS_LABEL } from './overlays';

/**
 * The map's heads-up display: the weather readout, the layer switches, the
 * radar timeline and the popups. Built only from the app's own components
 * and token classes, so it is the app's theme, light or dark.
 */

const clock = (iso: string, timeZone?: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone });

/** "2026-12-10T02:00" (local to the region) → "2am Thu". */
function localHour(time: string): string {
  const [date, hm] = time.split('T');
  const hour = Number(hm?.slice(0, 2));
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${hour < 12 ? 'am' : 'pm'} ${day}`;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg: number | null): string => (deg === null ? '' : (COMPASS[Math.round(deg / 45) % 8] ?? ''));
const n0 = (v: number | null): string => (v === null ? '—' : String(Math.round(v)));
const cm = (v: number | null): string => (v === null ? '—' : `${v.toFixed(1)} cm`);

function Stat({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

export function WeatherPanel({
  summary,
  error,
  loading,
}: {
  summary: SnowSummary | null;
  error: string | null;
  loading: boolean;
}): JSX.Element {
  if (!summary) {
    return (
      <Card className="p-4 text-sm text-muted-foreground" aria-live="polite">
        {error ? <ErrorNotice message={error} /> : loading ? 'Fetching the forecast…' : 'No forecast yet.'}
      </Card>
    );
  }

  const { current, snow, ice } = summary;
  const aboveTrigger = snow.next_24h_cm >= snow.trigger_cm;
  const peak = Math.max(1, ...summary.hourly.map((h) => h.snowfall_cm));

  return (
    <Card className="p-4" aria-label={`Weather for ${summary.region.name}`} role="region">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{summary.region.name}</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-foreground">
            {n0(current.temperature_c)}°<span className="text-base font-normal text-muted-foreground">C</span>
          </p>
          <p className="text-sm text-muted-foreground">
            {current.condition} · feels {n0(current.apparent_temperature_c)}°
          </p>
        </div>
        <Snowflake className="size-6 shrink-0 text-primary" aria-hidden />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
        <Stat label="Wind">
          <span className="inline-flex items-center gap-1">
            <Wind className="size-3.5 text-muted-foreground" aria-hidden />
            {n0(current.wind_speed_kmh)} km/h {compass(current.wind_direction_deg)}
          </span>
        </Stat>
        <Stat label="Gusts">{n0(current.wind_gusts_kmh)} km/h</Stat>
        <Stat label="Snow, next 24h">
          <span className={cn(aboveTrigger && 'font-semibold text-warning')}>{cm(snow.next_24h_cm)}</span>
        </Stat>
        <Stat label="Snow depth">{cm(snow.depth_cm)}</Stat>
        <Stat label="Next 6h / 48h">
          {cm(snow.next_6h_cm)} / {cm(snow.next_48h_cm)}
        </Stat>
        <Stat label="Trigger">{snow.trigger_cm} cm</Stat>
      </dl>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {aboveTrigger ? (
          <Badge variant="warning" dot>
            Above the {snow.trigger_cm} cm trigger
          </Badge>
        ) : null}
        {ice.level === 'warning' ? (
          <Badge variant="critical" dot>
            {ice.summary}
            {ice.starts_at ? ` · ${localHour(ice.starts_at)}` : ''}
          </Badge>
        ) : ice.level === 'watch' ? (
          <Badge variant="serious" dot>
            {ice.summary}
            {ice.starts_at ? ` · ${localHour(ice.starts_at)}` : ''}
          </Badge>
        ) : (
          <Badge variant="neutral">No freezing rain</Badge>
        )}
        {summary.stale ? <Badge variant="neutral">Forecast not refreshed</Badge> : null}
      </div>

      {/* 48 hours of snowfall, one bar an hour: the shape of the storm. */}
      <div className="mt-4">
        <div
          className="flex h-10 items-end gap-px"
          role="img"
          aria-label={`Hourly snowfall for the next 48 hours, peaking at ${peak.toFixed(1)} cm an hour`}
        >
          {summary.hourly.map((h) => (
            <div
              key={h.time}
              title={`${localHour(h.time)}: ${h.snowfall_cm.toFixed(1)} cm`}
              className={cn('flex-1 rounded-t-sm', h.snowfall_cm > 0 ? 'bg-primary' : 'bg-border')}
              style={{ height: h.snowfall_cm > 0 ? `${Math.max(8, (h.snowfall_cm / peak) * 100)}%` : '2px' }}
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
          <span>Now</span>
          <span>+24h</span>
          <span>+48h</span>
        </div>
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">
        Open-Meteo · Environment Canada GEM (HRDPS 2.5 km) · {clock(summary.fetched_at)}
      </p>
    </Card>
  );
}

export interface LayerState {
  radar: boolean;
  properties: boolean;
  crews: boolean;
  sample: boolean;
}

export function LayersPanel({
  layers,
  onChange,
  hasRealData,
  counts,
}: {
  layers: LayerState;
  onChange: (next: LayerState) => void;
  hasRealData: boolean;
  counts: Partial<Record<MapPropertyStatus, number>>;
}): JSX.Element {
  const [open, setOpen] = React.useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 721px)').matches,
  );
  const toggle = (key: keyof LayerState) => onChange({ ...layers, [key]: !layers[key] });
  const row = (key: keyof LayerState, label: string) => (
    <div className="flex items-center gap-2">
      <Checkbox id={`layer-${key}`} checked={layers[key]} onCheckedChange={() => toggle(key)} />
      <Label htmlFor={`layer-${key}`} className="text-sm font-normal">
        {label}
      </Label>
    </div>
  );

  if (!open) {
    return (
      <Button type="button" variant="secondary" size="sm" className="bg-card/80 backdrop-blur" onClick={() => setOpen(true)}>
        <Layers /> Layers
      </Button>
    );
  }

  return (
    <Card className="w-56 p-3" role="region" aria-label="Map layers">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Layers</p>
        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Hide layers" onClick={() => setOpen(false)}>
          <X />
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {row('radar', 'Radar loop')}
        {row('properties', 'Client properties')}
        {row('crews', 'Dispatch crews')}
        {row('sample', hasRealData ? 'Sample data' : 'Sample data (no geocoded customers yet)')}
      </div>
      {layers.properties ? (
        <ul className="mt-3 flex flex-col gap-1 border-t border-border pt-2 text-xs text-muted-foreground">
          {(Object.keys(STATUS_LABEL) as MapPropertyStatus[]).map((status) => (
            <li key={status} className="flex items-center gap-2">
              <span className={cn('size-2.5 rounded-full', STATUS_DOT[status])} aria-hidden />
              <span className="flex-1">{STATUS_LABEL[status]}</span>
              <span className="tabular-nums">{counts[status] ?? 0}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function RadarTimeline({
  frames,
  index,
  onIndex,
  playing,
  onPlaying,
  opacity,
  onOpacity,
  error,
}: {
  frames: RadarFrame[];
  index: number;
  onIndex: (i: number) => void;
  playing: boolean;
  onPlaying: (p: boolean) => void;
  opacity: number;
  onOpacity: (o: number) => void;
  error: string | null;
}): JSX.Element {
  const frame = frames[index];
  const latestPast = frames.reduce((last, f, i) => (f.kind === 'past' ? i : last), -1);
  const minutes = frame && latestPast >= 0 ? Math.round((frame.time - (frames[latestPast]?.time ?? 0)) / 60) : 0;

  return (
    <Card className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2" role="region" aria-label="Radar timeline">
      {error ? (
        <p className="text-xs text-critical">{error}</p>
      ) : frames.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading radar…</p>
      ) : (
        <>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="size-8"
            aria-label={playing ? 'Pause radar loop' : 'Play radar loop'}
            onClick={() => onPlaying(!playing)}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
          <div className="flex min-w-[180px] flex-1 flex-col">
            <input
              type="range"
              min={0}
              max={frames.length - 1}
              step={1}
              value={index}
              onChange={(e) => {
                onPlaying(false);
                onIndex(Number(e.target.value));
              }}
              aria-label="Radar frame"
              aria-valuetext={frame ? clock(new Date(frame.time * 1000).toISOString()) : undefined}
              className="w-full accent-primary"
            />
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="tabular-nums">{frame ? clock(new Date(frame.time * 1000).toISOString()) : ''}</span>
              {frame?.kind === 'nowcast' ? (
                <Badge variant="primary" className="px-1.5 py-0 text-[10px]">
                  Forecast +{minutes} min
                </Badge>
              ) : (
                <span>{minutes === 0 ? 'Latest' : `${-minutes} min ago`}</span>
              )}
            </div>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            Opacity
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={Math.round(opacity * 100)}
              onChange={(e) => onOpacity(Number(e.target.value) / 100)}
              className="w-20 accent-primary"
            />
          </label>
        </>
      )}
    </Card>
  );
}

export function PropertyPopup({
  props,
  onOpenVisit,
}: {
  props: MapPropertyProps;
  /** The popup renders outside the router, so the map does the navigating. */
  onOpenVisit: (workOrderId: string) => void;
}): JSX.Element {
  const cars = props.driveway_size_cars;
  return (
    <div className="min-w-[220px] max-w-[260px] text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-foreground">{props.customer_name}</p>
        {props.sample ? <Badge variant="neutral">Sample</Badge> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {props.address}, {props.city}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant={props.status === 'active_route' ? 'primary' : props.status === 'pending' ? 'warning' : props.status === 'serviced' ? 'good' : props.status === 'skipped' ? 'serious' : 'neutral'} dot>
          {STATUS_LABEL[props.status]}
        </Badge>
        {props.priority ? <Badge variant="critical">Priority</Badge> : null}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
        <Stat label="Lot size">{cars === null ? '—' : `${cars === 6 ? '6+' : cars}-car driveway`}</Stat>
        <Stat label="Snow trigger">{props.trigger_cm} cm</Stat>
        <Stat label="Assigned crew">{props.crew_name ?? 'Unassigned'}</Stat>
        <Stat label="Visit">
          {props.visit_status ? humanize(props.visit_status) : '—'}
          {props.scheduled_for ? ` · ${clock(props.scheduled_for)}` : ''}
        </Stat>
      </dl>
      {props.work_order_id && !props.sample ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mt-2 h-auto px-0"
          onClick={() => onOpenVisit(props.work_order_id as string)}
        >
          Open the visit
        </Button>
      ) : null}
    </div>
  );
}

export function CrewPopup({ props }: { props: MapCrewProps }): JSX.Element {
  return (
    <div className="min-w-[200px] max-w-[260px] text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-1.5 font-semibold text-foreground">
          <Truck className="size-4 text-primary" aria-hidden /> {props.crew_name}
        </p>
        {props.sample ? <Badge variant="neutral">Sample</Badge> : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {props.visit_status === 'in_progress' ? 'On site at' : 'En route to'} {props.address} ({props.customer_name})
        {props.since ? ` since ${clock(props.since)}` : ''}
      </p>
      <p className="mt-2 text-xs text-foreground">
        {props.visits_done} of {props.visits_today} visits done today
      </p>
    </div>
  );
}
