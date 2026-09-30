/*
 * The weather bot, against a stand-in Open-Meteo.
 *
 * The environment is set before anything imports the configuration, so the
 * bot really asks the stand-in, and the threshold and hours are the ones it
 * ships with.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { startWeatherApi, type FakeWeatherApi } from './helpers/weatherApi';

const weather: FakeWeatherApi = await startWeatherApi();
process.env.WEATHER_API_BASE = weather.url;
process.env.WEATHER_GEOCODING_API_BASE = weather.url;
process.env.WEATHER_SNOWFALL_THRESHOLD_CM = '3';
process.env.WEATHER_CHECK_HOUR = '18';
process.env.WEATHER_SERVICE_HOUR = '5';

const { db } = await import('./helpers/database');
const { makeCustomer } = await import('./helpers/fixtures');
const { harness } = await import('./helpers/harness');
const { call, login } = await import('./helpers/server');
const { MESSAGE_TEMPLATES } = await import('../src/db/appConfig');
const { checkBranch, regionOf, runWeatherAlerts, serviceWindow } = await import('../src/services/weather');

/** 8pm in Kingston on 9 December: the evening before a service morning. */
const EVENING = new Date('2026-12-10T01:00:00Z');
/** 2pm the same day: too early for the bot to act. */
const AFTERNOON = new Date('2026-12-09T19:00:00Z');

/** Half a centimetre an hour from 9pm to 3am: 3.5 cm before the crews go out. */
const overnightStorm = (_lat: number, _lng: number, hour: string): number =>
  hour >= '2026-12-09T21:00' && hour <= '2026-12-10T03:00' ? 0.5 : 0;

after(() => weather.close());

describe('the weather bot', () => {
  const h = harness();

  beforeEach(() => {
    weather.reset();
    weather.startDate('2026-12-09');
  });

  async function kingston() {
    return (await db('branches').where({ id: h.world().branches.kingston }).first())!;
  }

  async function notices() {
    return db('message_log')
      .where({ template_code: 'snowfall_notice' })
      .orderBy(['channel', 'recipient'])
      .select('channel', 'recipient', 'customer_id');
  }

  /** A customer somewhere else in Kingston, in another postal region. */
  async function customerIn(postalCode: string, overrides: Parameters<typeof makeCustomer>[2] = {}) {
    const made = await makeCustomer(h.world().branches.kingston, h.world().users.corporate, overrides);
    await db('properties').where({ id: made.property_id }).update({ postal_code: postalCode });
    return made;
  }

  it('sends the owner’s own wording', () => {
    const sms = MESSAGE_TEMPLATES.find((t) => t.code === 'snowfall_notice' && t.channel === 'sms');
    assert.equal(
      sms?.body,
      'Snowfall notice: Our team is scheduled to service your drive tomorrow morning. ' +
        'Please park all vehicles outside the driveway tonight so we can perform a full clearance.',
    );
    assert.ok(MESSAGE_TEMPLATES.find((t) => t.code === 'snowfall_notice' && t.channel === 'email'));
  });

  it('works out postal regions and the service window', () => {
    assert.equal(regionOf('k7l 1y4'), 'K7L');
    assert.equal(regionOf('B3H-4R2'), 'B3H');
    assert.equal(regionOf('14201-1234'), '14201');
    assert.equal(regionOf('nowhere'), null);

    assert.deepEqual(serviceWindow(EVENING, 'America/Toronto'), {
      service_date: '2026-12-10',
      from: '2026-12-09T18:00',
      to: '2026-12-10T05:00',
    });
    // In the small hours the next service morning is this one.
    assert.equal(serviceWindow(new Date('2026-12-10T07:00:00Z'), 'America/Toronto').service_date, '2026-12-10');
  });

  it('alerts every active customer when more than 3 cm is coming', async () => {
    const harold = await makeCustomer(h.world().branches.kingston, h.world().users.corporate);
    // Not yet a customer, and a former one: neither is on the roster.
    const lead = await makeCustomer(h.world().branches.kingston, h.world().users.corporate, { email: 'lead@example.test' });
    await db('customers').where({ id: lead.customer_id }).update({ status: 'lead' });
    weather.snow(overnightStorm);

    const summary = await runWeatherAlerts(EVENING);
    assert.equal(summary.customers_notified, 1);

    assert.deepEqual(await notices(), [
      { channel: 'email', recipient: 'harold@example.test', customer_id: harold.customer_id },
      { channel: 'sms', recipient: '613-555-0201', customer_id: harold.customer_id },
    ], 'both channels, as Harold asked');

    const run = await db('weather_alert_runs').where({ region: 'K7L' }).first();
    assert.equal(run.triggered, true);
    assert.equal(run.snowfall_cm, '3.50');
    assert.equal(run.service_date, '2026-12-10');
    assert.equal(run.notified, 1);

    const asked = weather.forecasts()[0]!;
    assert.equal(asked.get('timezone'), 'America/Toronto');
    assert.equal(Number(asked.get('latitude')).toFixed(2), '44.23', 'at the customers’ own houses');
  });

  it('never alerts a region twice for the same morning', async () => {
    await makeCustomer(h.world().branches.kingston, h.world().users.corporate);
    weather.snow(overnightStorm);

    await runWeatherAlerts(EVENING);
    await runWeatherAlerts(new Date(EVENING.getTime() + 3_600_000));
    await checkBranch(await kingston(), { now: new Date(EVENING.getTime() + 7_200_000) });

    assert.equal((await notices()).length, 2, 'one text and one email, once');
    assert.equal(weather.forecasts().length, 1, 'an alerted region is not even looked up again');
  });

  it('counts only the snow before the crews go out, and exactly 3 cm is not enough', async () => {
    await makeCustomer(h.world().branches.kingston, h.world().users.corporate);
    weather.snow((_lat, _lng, hour) => {
      if (hour >= '2026-12-09T21:00' && hour <= '2026-12-10T02:00') return 0.5; // 3.0 cm in the window
      if (hour === '2026-12-10T08:00') return 10; // after the crews are out
      if (hour === '2026-12-09T17:00') return 10; // before the evening window
      return 0;
    });

    await runWeatherAlerts(EVENING);
    assert.deepEqual(await notices(), []);
    const run = await db('weather_alert_runs').where({ region: 'K7L' }).first();
    assert.equal(run.snowfall_cm, '3.00');
    assert.equal(run.triggered, false);

    // The 10pm forecast is worse: a region below the line is looked at again.
    weather.snow(overnightStorm);
    await runWeatherAlerts(new Date(EVENING.getTime() + 2 * 3_600_000));
    assert.equal((await notices()).length, 2);
    assert.equal((await db('weather_alert_runs').where({ region: 'K7L' }).first()).triggered, true);
  });

  it('waits for the evening', async () => {
    await makeCustomer(h.world().branches.kingston, h.world().users.corporate);
    weather.snow(overnightStorm);

    const summary = await runWeatherAlerts(AFTERNOON);
    assert.equal(summary.branches_checked, 0);
    assert.equal(weather.forecasts().length, 0);
  });

  it('forecasts each postal region separately', async () => {
    await makeCustomer(h.world().branches.kingston, h.world().users.corporate, { email: 'west@example.test', phone: null, preferred_contact: 'email' });
    // Across town, and with no coordinates: placed by the geocoder.
    const east = await customerIn('K7K 2A1', {
      email: 'east@example.test',
      phone: '613-555-0999',
      preferred_contact: 'sms',
      latitude: null,
      longitude: null,
    });
    weather.place('K7K', 44.26, -76.45);
    weather.snow((lat, lng, hour) => (lat > 44.25 ? overnightStorm(lat, lng, hour) : 0));

    await runWeatherAlerts(EVENING);

    assert.deepEqual(await notices(), [
      { channel: 'sms', recipient: '613-555-0999', customer_id: east.customer_id },
    ], 'only the region where the snow falls, by text as they asked');
    const runs = await db('weather_alert_runs').orderBy('region').select('region', 'triggered');
    assert.deepEqual(runs, [
      { region: 'K7K', triggered: true },
      { region: 'K7L', triggered: false },
    ]);
  });

  it('keeps going when the forecast is down, and tries again next hour', async () => {
    await makeCustomer(h.world().branches.kingston, h.world().users.corporate);
    weather.snow(overnightStorm);
    weather.failWith(503);

    const check = await checkBranch(await kingston(), { now: EVENING });
    assert.match(check.regions[0]!.error ?? '', /503/);
    assert.equal(await db('weather_alert_runs').first(), undefined, 'nothing decided on no forecast');

    weather.failWith(null);
    await runWeatherAlerts(new Date(EVENING.getTime() + 3_600_000));
    assert.equal((await notices()).length, 2);
  });

  it('lets the office look at tonight’s forecast without sending anything', async () => {
    await makeCustomer(h.world().branches.kingston, h.world().users.corporate);
    weather.snow(overnightStorm);
    const token = await login(h.server(), h.world().emails.corporate);

    const look = await call(h.server(), 'POST', '/weather/check', {
      token,
      body: { branch_id: h.world().branches.kingston },
    });
    assert.equal(look.status, 200, JSON.stringify(look.body));
    assert.equal(look.body.data.regions[0].region, 'K7L');
    assert.equal(look.body.data.sent, false);
    assert.equal(await db('weather_alert_runs').first(), undefined, 'looking writes nothing');

    const settings = await call(h.server(), 'GET', '/weather/settings', { token });
    assert.equal(settings.body.data.threshold_cm, 3);

    const sales = await login(h.server(), h.world().emails.sales);
    const refused = await call(h.server(), 'POST', '/weather/check', {
      token: sales,
      body: { branch_id: h.world().branches.kingston },
    });
    assert.equal(refused.status, 403);
  });
});
