/*
 * The weather map's endpoints: the snow summary from Open-Meteo, the radar
 * frames from RainViewer, and the dispatch layer from our own visits — the
 * first two against a stand-in, configured before the app loads.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { startWeatherApi, type FakeWeatherApi } from './helpers/weatherApi';

const weather: FakeWeatherApi = await startWeatherApi();
process.env.WEATHER_API_BASE = weather.url;
process.env.WEATHER_GEOCODING_API_BASE = weather.url;
process.env.WEATHER_RADAR_API_BASE = weather.url;
process.env.WEATHER_RADAR_TILE_HOST = 'https://tiles.example.test';
process.env.WEATHER_SNOWFALL_THRESHOLD_CM = '3';

const { db } = await import('./helpers/database');
const { makeContract, makeWorkOrder } = await import('./helpers/fixtures');
const { harness } = await import('./helpers/harness');
const { call, login } = await import('./helpers/server');
const { iceRisk, resetWeatherCaches } = await import('../src/services/snowSummary');
const { dispatchMap } = await import('../src/services/dispatchMap');
const { WEATHER_REGIONS } = await import('../src/config/weatherRegions');

after(() => weather.close());

/** 8:15pm in Kingston; three days of hours from 9 December. */
const NOW = '2026-12-09T20:15';
/** A centimetre an hour from 10pm to 3am: 6 cm by morning. */
const overnight = (_lat: number, _lng: number, hour: string): number =>
  hour >= '2026-12-09T22:00' && hour <= '2026-12-10T03:00' ? 1 : 0;

describe('the snow summary', () => {
  const h = harness();

  beforeEach(() => {
    weather.reset();
    weather.startDate('2026-12-09');
    weather.now(NOW);
    resetWeatherCaches();
  });

  it('asks Open-Meteo for the HRDPS blend at the region’s exact coordinates', async () => {
    weather.snow(overnight);
    const token = await login(h.server(), h.world().emails.operator);
    const reply = await call(h.server(), 'GET', '/weather/snow-summary?region=kingston', { token });
    assert.equal(reply.status, 200);

    const asked = weather.forecasts()[0]!;
    assert.equal(asked.get('latitude'), '44.2312');
    assert.equal(asked.get('longitude'), '-76.4860');
    assert.equal(asked.get('models'), 'gem_seamless');
    assert.equal(asked.get('timezone'), 'America/Toronto');

    const summary = reply.body.data;
    assert.equal(summary.region.name, 'Kingston, ON');
    assert.equal(summary.current.temperature_c, -6);
    assert.equal(summary.current.wind_gusts_kmh, 41);
    assert.equal(summary.current.condition, 'Overcast');
    // Hours from 9pm (the current hour is 8pm) onward.
    assert.equal(summary.hourly[0].time, '2026-12-09T21:00');
    assert.equal(summary.hourly.length, 48);
    // 9pm to 2am: five of the six hours snow.
    assert.equal(summary.snow.next_6h_cm, 5);
    assert.equal(summary.snow.next_24h_cm, 6);
    assert.equal(summary.snow.next_48h_cm, 6);
    assert.equal(summary.snow.depth_cm, 12);
    assert.equal(summary.snow.trigger_cm, 3);
    assert.equal(summary.ice.level, 'none');
    assert.equal(summary.stale, false);
  });

  it('uses each territory’s preset', async () => {
    const token = await login(h.server(), h.world().emails.corporate);
    for (const [key, region] of Object.entries(WEATHER_REGIONS)) {
      weather.reset();
      weather.now(NOW);
      const reply = await call(h.server(), 'GET', `/weather/snow-summary?region=${key}`, { token });
      assert.equal(reply.status, 200, key);
      const asked = weather.forecasts()[0]!;
      assert.equal(Number(asked.get('latitude')), region.latitude, key);
      assert.equal(Number(asked.get('longitude')), region.longitude, key);
      assert.equal(asked.get('timezone'), region.timezone, key);
    }
  });

  it('refuses anywhere that is not a territory, and anyone not signed in', async () => {
    const token = await login(h.server(), h.world().emails.sales);
    const elsewhere = await call(h.server(), 'GET', '/weather/snow-summary?region=halifax', { token });
    assert.equal(elsewhere.status, 400);
    const missing = await call(h.server(), 'GET', '/weather/snow-summary', { token });
    assert.equal(missing.status, 400);
    const anonymous = await call(h.server(), 'GET', '/weather/snow-summary?region=kingston');
    assert.equal(anonymous.status, 401);
    assert.equal(weather.forecasts().length, 0);
  });

  it('asks the default blend for snow depth when GEM has none', async () => {
    weather.conditions((_hour, model) => ({ snow_depth: model === 'gem_seamless' ? null : 0.31 }));
    const token = await login(h.server(), h.world().emails.corporate);
    const reply = await call(h.server(), 'GET', '/weather/snow-summary?region=regina', { token });
    assert.equal(reply.body.data.snow.depth_cm, 31);
    assert.equal(weather.forecasts().length, 2);
    assert.equal(weather.forecasts()[1]!.get('models'), null);
  });

  it('caches per region, and serves the last answer marked stale when Open-Meteo fails', async () => {
    const token = await login(h.server(), h.world().emails.corporate);
    await call(h.server(), 'GET', '/weather/snow-summary?region=kingston', { token });
    await call(h.server(), 'GET', '/weather/snow-summary?region=kingston', { token });
    assert.equal(weather.forecasts().length, 1, 'the second came from the cache');

    // Nothing cached for Cranbrook yet: a failure is the service's, a 502.
    weather.failWith(503);
    const failed = await call(h.server(), 'GET', '/weather/snow-summary?region=cranbrook', { token });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error.code, 'upstream_unavailable');
  });

  it('serves a stale summary rather than nothing', async () => {
    const { snowSummary } = await import('../src/services/snowSummary');
    const fresh = await snowSummary('kingston');
    weather.failWith(503);
    const later = await snowSummary('kingston', Date.now() + 11 * 60_000);
    assert.equal(later.stale, true);
    assert.equal(later.fetched_at, fresh.fetched_at);
  });

  it('warns of freezing rain, and watches rain at the freezing mark', () => {
    const hour = (time: string, over: Partial<{ weather_code: number; rain_mm: number; temperature_c: number }>) => ({
      time,
      snowfall_cm: 0,
      precipitation_mm: over.rain_mm ?? 0,
      rain_mm: over.rain_mm ?? 0,
      temperature_c: over.temperature_c ?? -5,
      weather_code: over.weather_code ?? 3,
    });
    assert.deepEqual(iceRisk([hour('2026-12-10T02:00', { weather_code: 67 })]), {
      level: 'warning',
      summary: 'Freezing rain forecast',
      starts_at: '2026-12-10T02:00',
    });
    assert.equal(iceRisk([hour('2026-12-10T02:00', { rain_mm: 1.2, temperature_c: 0 })]).level, 'watch');
    // Rain well above zero, or a cold dry night: nothing to say.
    assert.equal(iceRisk([hour('2026-12-10T02:00', { rain_mm: 4, temperature_c: 6 })]).level, 'none');
    assert.equal(iceRisk([hour('2026-12-10T02:00', {})]).level, 'none');
  });
});

describe('the radar frames', () => {
  const h = harness();

  beforeEach(() => {
    weather.reset();
    resetWeatherCaches();
  });

  it('builds tile URLs on the configured host only, from well-formed paths', async () => {
    weather.radarIndex({
      generated: 1765300000,
      host: 'https://evil.example.test',
      radar: {
        past: [
          { time: 1765299400, path: '/v2/radar/abc123' },
          { time: 1765299000, path: '/v2/radar/abc122' },
          { time: 1765299600, path: '/../../steal?x=' },
        ],
        nowcast: [{ time: 1765300200, path: '/v2/radar/nowcast_def' }],
      },
    });
    const token = await login(h.server(), h.world().emails.operator);
    const reply = await call(h.server(), 'GET', '/weather/radar', { token });
    assert.equal(reply.status, 200);
    const { frames, max_zoom } = reply.body.data;
    assert.equal(max_zoom, 7);
    assert.deepEqual(
      frames.map((f: { time: number; kind: string }) => [f.time, f.kind]),
      [[1765299000, 'past'], [1765299400, 'past'], [1765300200, 'nowcast']],
    );
    for (const frame of frames) {
      assert.match(frame.tiles, /^https:\/\/tiles\.example\.test\/v2\/radar\/[A-Za-z0-9_]+\/256\/\{z\}\/\{x\}\/\{y\}\/2\/1_1\.png$/);
    }

    await call(h.server(), 'GET', '/weather/radar', { token });
    assert.equal(weather.radarRequests(), 1, 'cached');
  });

  it('is a 502 when RainViewer has nothing', async () => {
    const token = await login(h.server(), h.world().emails.operator);
    const reply = await call(h.server(), 'GET', '/weather/radar', { token });
    assert.equal(reply.status, 502);
  });
});

describe('the dispatch layer', () => {
  const h = harness();

  /** Noon in Kingston on 9 December. */
  const NOON = new Date('2026-12-09T17:00:00Z');
  const at = (iso: string) => new Date(iso);

  it('colours each property by today’s visit and puts working crews on the map', async () => {
    const w = h.world();
    const serviced = await makeContract(w.branches.kingston, w.users.corporate, { address_line1: '1 Done St' });
    const active = await makeContract(w.branches.kingston, w.users.corporate, { address_line1: '2 Busy St' });
    const pending = await makeContract(w.branches.kingston, w.users.corporate, { address_line1: '3 Later St' });
    const idle = await makeContract(w.branches.kingston, w.users.corporate, { address_line1: '4 Quiet St' });
    const tomorrow = await makeContract(w.branches.kingston, w.users.corporate, { address_line1: '5 Next St' });
    const nowhere = await makeContract(w.branches.kingston, w.users.corporate, { latitude: null, longitude: null });

    await makeWorkOrder(serviced, w.branches.kingston, {
      assigned_user_id: w.users.operator,
      status: 'completed',
      scheduled_for: at('2026-12-09T11:00:00Z'),
      completed_at: at('2026-12-09T12:00:00Z'),
    });
    await makeWorkOrder(active, w.branches.kingston, {
      assigned_user_id: w.users.operator,
      status: 'in_progress',
      scheduled_for: at('2026-12-09T13:00:00Z'),
      started_at: at('2026-12-09T16:30:00Z'),
    });
    // Booked for later today, and also visited yesterday: today's visit decides.
    await makeWorkOrder(pending, w.branches.kingston, { status: 'scheduled', scheduled_for: at('2026-12-09T21:00:00Z') });
    await makeWorkOrder(pending, w.branches.kingston, {
      status: 'completed',
      scheduled_for: at('2026-12-08T13:00:00Z'),
      completed_at: at('2026-12-08T14:00:00Z'),
    });
    // 7pm tomorrow UTC is still tomorrow in Kingston.
    await makeWorkOrder(tomorrow, w.branches.kingston, { scheduled_for: at('2026-12-10T19:00:00Z') });

    const map = await dispatchMap({ kind: 'all' }, NOON);
    const status = (property: string) =>
      map.properties.features.find((f) => f.properties.property_id === property)?.properties;

    assert.equal(status(serviced.property_id)?.status, 'serviced');
    assert.equal(status(serviced.property_id)?.crew_name, 'Otto Plows');
    assert.equal(status(active.property_id)?.status, 'active_route');
    assert.equal(status(pending.property_id)?.status, 'pending');
    assert.equal(status(idle.property_id)?.status, 'unscheduled');
    assert.equal(status(tomorrow.property_id)?.status, 'unscheduled');
    assert.equal(status(nowhere.property_id), undefined, 'no coordinates, not on the map');
    assert.equal(status(idle.property_id)?.trigger_cm, 3);
    assert.equal(status(idle.property_id)?.driveway_size_cars, 2);
    assert.deepEqual(map.properties.features[0]?.geometry.coordinates.length, 2);

    assert.equal(map.crews.features.length, 1);
    const crew = map.crews.features[0]!.properties;
    assert.equal(crew.crew_name, 'Otto Plows');
    assert.equal(crew.visit_status, 'in_progress');
    assert.equal(crew.address, '2 Busy St');
    assert.equal(crew.visits_done, 1);
    assert.equal(crew.visits_today, 2);
  });

  it('shows a branch only its own customers', async () => {
    const w = h.world();
    await makeContract(w.branches.kingston, w.users.corporate, { address_line1: '1 Kingston St' });
    await makeContract(w.branches.halifax, w.users.corporate, { address_line1: '1 Halifax St' });

    const operator = await login(h.server(), w.emails.halifaxOperator);
    const theirs = await call(h.server(), 'GET', '/weather/dispatch-map', { token: operator });
    assert.equal(theirs.status, 200);
    assert.deepEqual(
      theirs.body.data.properties.features.map((f: { properties: { address: string } }) => f.properties.address),
      ['1 Halifax St'],
    );

    const peek = await call(h.server(), 'GET', `/weather/dispatch-map?branch_id=${w.branches.kingston}`, {
      token: operator,
    });
    assert.equal(peek.status, 403);

    const corporate = await login(h.server(), w.emails.corporate);
    const all = await call(h.server(), 'GET', '/weather/dispatch-map', { token: corporate });
    assert.equal(all.body.data.properties.features.length, 2);

    // Customers no longer active are not on the run.
    await db('customers').update({ status: 'churned' });
    const none = await call(h.server(), 'GET', '/weather/dispatch-map', { token: corporate });
    assert.equal(none.body.data.properties.features.length, 0);
  });

  it('keeps the weather bot’s own screens corporate', async () => {
    const operator = await login(h.server(), h.world().emails.operator);
    const runs = await call(h.server(), 'GET', '/weather/runs', { token: operator });
    assert.equal(runs.status, 403);
  });
});
