/**
 * `GET /api/instruments/:id/telemetry?points=` — the CHART path.
 *
 * What this file exists to prove, and why every case below is here:
 *
 * Before 2026-08-27 the trend page asked for `limit=5000` and `getHistory`
 * silently answered with the newest 1000 rows ORDER BY ts DESC. A 7-day request
 * therefore came back holding about one day, the x-axis still claimed a week,
 * and the Min/Max/Avg strip was computed over that truncated slice. Nothing in
 * the response said so.
 *
 * The fix is NOT a bigger cap. The chart path reads every reading in the range,
 * downsamples by SELECTION (`lttb` — every plotted point is a stored reading),
 * and sources the summary strip from a SEPARATE SQL aggregate over the whole
 * range. `historySampled` discloses when points were dropped.
 *
 * The load-bearing assertion is `summaries.max is the TRUE maximum even when
 * that reading is not among the returned rows` — on a 21 CFR Part 11 record a
 * "Maximum" that understates an excursion because the sampler skipped it is a
 * misrepresentation, not a rounding artefact.
 *
 * Everything is asserted over HTTP through `app.inject`, never off a repository
 * function's return value: Fastify STRIPS any field missing from the route's
 * `response` schema, silently, and a server-side assertion would still pass.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { setFixtureMeasurements } from '../test-support/fixture-measurements.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
// The route's own decision about which number `historyTotal` reports.
import { chartRangeTotal } from '../modules/instruments/telemetry.repository.js';
import { mktCelsius } from '@digilog/shared';

let app: FastifyInstance;
let auth: Record<string, string>;
const s = Date.now();
const instruments: string[] = [];

let instId = '';
/** An instrument whose `temperature` key carries one NON-NUMERIC reading. */
let mixedInstId = '';
/** A second instrument, inside the operator's scope — the positive control. */
let visibleInstId = '';
let flId = '';
let roleId = '';
let rolePermsBefore: string[] = [];

/** Readings seeded on the main instrument's `temperature` key. */
const TOTAL = 2_500;
/** Every reading except the spike sits here, so the spike is unmistakable. */
const BASE = 20;
const SPIKE = 99.9;
const SPIKE_INDEX = Math.floor(TOTAL / 2);
const STEP_MS = 30_000;

/**
 * The limits seeded onto the main instrument, as ATTRIBUTES — the only place
 * this system stores an instrument's own limits.
 *
 * Chosen against the fixture: every base reading is 20.0-20.4, so nothing is
 * below 15 and nothing but the 99.9 spike is above 25. `aboveCount === 1` is
 * therefore an exact expectation, and `belowCount === 0` is a REAL zero — a
 * checked bound with no breach, which the report must distinguish from a bound
 * that was never set.
 */
const TEMP_HIGH = 25;
const TEMP_LOW = 15;

/**
 * The key mappings the breach counts depend on, PINNED for this file.
 *
 * Which key is a temperature and which attribute carries a bound live on the
 * instrument's PROFILE (since 2026-10-26; global `telemetry-slots` /
 * `alarm-limits` rows before that), and lists drift. Pinned on this file's own
 * fixture profile so these assertions test the code, not the database.
 */
const PINNED: Record<'TEMPERATURE' | 'HUMIDITY', { deviceKeys: string[]; high: string[]; low: string[] }> = {
  TEMPERATURE: { deviceKeys: ['temperature'], high: ['High Temperature Limit'], low: ['Low Temperature Limit'] },
  HUMIDITY: { deviceKeys: ['humidity'], high: ['High Humidity Limit'], low: ['Low Humidity Limit'] },
};

/**
 * Window start. 2,500 readings 30s apart span ~20.8h, so `to` lands about
 * three hours before now: recent enough that every row falls in an existing
 * partition of `instrument_telemetry_history`, and far enough back that a
 * deliberately out-of-window reading can be seeded AFTER it.
 */
const t0 = new Date(Date.now() - 24 * 3_600_000);
const tEnd = new Date(t0.getTime() + (TOTAL - 1) * STEP_MS);
const FROM = t0.toISOString();
const TO = tEnd.toISOString();

/**
 * ONE multi-row INSERT, not a loop — 2,500 sequential `$executeRaw` round trips
 * would dominate the suite's runtime for no benefit. Mirrors `writeBatch`.
 */
async function seed(instrumentId: string, key: string, rows: { ts: Date; value: unknown }[]) {
  const values = Prisma.join(rows.map((r) => Prisma.sql`(
    ${instrumentId}, ${key}, ${JSON.stringify(r.value)}::jsonb,
    ${typeof r.value === 'number' ? 'number' : 'string'}, ${r.ts})`));
  await prisma.$executeRaw`
    INSERT INTO instrument_telemetry_history (instrument_id, key, value, value_type, ts)
    VALUES ${values}
    ON CONFLICT (instrument_id, key, ts) DO NOTHING`;
}

async function createInstrument(code: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { name: code, code, profileId: await fixtureProfileId('fixture:telemetry-range') },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string };
  instruments.push(body.id);
  return body.id;
}

async function telemetry(id: string, qs: string, headers = auth) {
  return app.inject({ method: 'GET', url: `/api/instruments/${id}/telemetry${qs}`, headers });
}

/** The chart-path response, as it comes off the wire. */
interface ChartBody {
  latest: { key: string }[];
  history: { key: string; value: unknown; ts: string }[];
  historyTotal: number;
  historySampled?: boolean;
  summaries?: Record<string, {
    count: number; numericCount: number; min: number; max: number; avg: number;
    first: string; last: string;
    belowCount: number | null; aboveCount: number | null; outOfSpecCount: number | null;
    limitMin: number | null; limitMax: number | null;
    limitMinText?: string | null; limitMaxText?: string | null;
    mkt?: number | null;
  }>;
}

const rowsFor = (b: ChartBody, key: string) => b.history.filter((r) => r.key === key);

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };

  await setFixtureMeasurements(await fixtureProfileId('fixture:telemetry-range'), (ms) => ms.map((m) => {
    const pin = PINNED[m.code as keyof typeof PINNED];
    return pin
      ? { ...m, deviceKeys: pin.deviceKeys, high: { ...m.high, limitKeys: pin.high }, low: { ...m.low, limitKeys: pin.low } }
      : m;
  }));

  instId = await createInstrument(`TRNG-A-${s}`);

  // Written straight to the table rather than through the attribute endpoint:
  // that route is a governed §11 surface (reauth + remarks) and this file is
  // testing telemetry, not attribute governance.
  await prisma.instrumentAttribute.createMany({
    data: [
      { instrumentId: instId, key: 'High Temperature Limit', value: String(TEMP_HIGH) },
      { instrumentId: instId, key: 'Low Temperature Limit', value: String(TEMP_LOW) },
      // DELIBERATELY no humidity limits: the humidity summary must come back
      // with null counts, not zeros.
    ],
  });

  await seed(instId, 'temperature', Array.from({ length: TOTAL }, (_, i) => ({
    ts: new Date(t0.getTime() + i * STEP_MS),
    // A flat series apart from one spike in the exact middle of the range.
    value: i === SPIKE_INDEX ? SPIKE : BASE + (i % 5) * 0.1,
  })));

  // A small key: fewer readings than any `points` target, so nothing is sampled.
  await seed(instId, 'humidity', [0, 1, 2].map((i) => ({
    ts: new Date(t0.getTime() + i * STEP_MS), value: 45 + i,
  })));

  // A separate instrument whose temperature series holds a STRING. The breach
  // counts cast jsonb inside a CASE for exactly this row; a bare `::float8`
  // would make the whole request 500 under a plan that projects before it
  // filters, and this database really does hold such a value.
  mixedInstId = await createInstrument(`TRNG-MIX-${s}`);
  await prisma.instrumentAttribute.createMany({
    data: [
      { instrumentId: mixedInstId, key: 'High Temperature Limit', value: String(TEMP_HIGH) },
      { instrumentId: mixedInstId, key: 'Low Temperature Limit', value: String(TEMP_LOW) },
    ],
  });
  await seed(mixedInstId, 'temperature', [
    { ts: new Date(t0.getTime()), value: 20 },
    { ts: new Date(t0.getTime() + STEP_MS), value: 'hello' },
    { ts: new Date(t0.getTime() + 2 * STEP_MS), value: 21 },
    { ts: new Date(t0.getTime() + 3 * STEP_MS), value: 99.9 },
  ]);

  // Readings that exist but sit OUTSIDE [FROM, TO] — a key with nothing in the
  // range must contribute no rows and no summary entry.
  await seed(instId, 'pressure', [
    { ts: new Date(Date.now() - 3_600_000), value: 1013 },
    { ts: new Date(Date.now() - 3_500_000), value: 1014 },
  ]);
});

afterAll(async () => {
  if (instruments.length) {
    await prisma.$executeRaw`
      DELETE FROM instrument_telemetry_history WHERE instrument_id = ANY(${instruments}::text[])`;
  }
  await prisma.roleConfig.updateMany({
    where: { role: 'OPERATOR' }, data: { instrumentScope: Prisma.DbNull },
  });
  if (roleId) {
    await prisma.role.update({ where: { id: roleId }, data: { permissions: rolePermsBefore as never } });
    invalidateRolePermsCache('OPERATOR');
  }
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  for (const id of instruments) {
    await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  }
  if (flId) await prisma.functionalLocation.deleteMany({ where: { id: flId } });
  await app.close();
});

describe('GET /api/instruments/:id/telemetry — chart path (points=)', () => {
  it('is unchanged when `points` is omitted — the paged table path still answers', async () => {
    const res = await telemetry(instId, `?key=temperature&limit=10&from=${FROM}&to=${TO}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ChartBody;
    expect(body.history).toHaveLength(10);
    // The true count across the range, which is what pages the table.
    expect(body.historyTotal).toBe(TOTAL);
    // The chart-only fields must NOT appear: existing callers see today's shape.
    expect(body.historySampled).toBeUndefined();
    expect(body.summaries).toBeUndefined();
  });

  it('returns every reading and reports no sampling when `points` exceeds the range', async () => {
    const res = await telemetry(instId, `?key=humidity&points=100&from=${FROM}&to=${TO}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ChartBody;
    expect(rowsFor(body, 'humidity')).toHaveLength(3);
    expect(body.historySampled).toBe(false);
    expect(body.historyTotal).toBe(3);
    expect(Object.keys(body.summaries!)).toContain('humidity');
    expect(body.summaries!.humidity).toMatchObject({ count: 3, min: 45, max: 47 });
  });

  it('returns exactly `points` rows and says so when the range holds more', async () => {
    const res = await telemetry(instId, `?key=temperature&points=50&from=${FROM}&to=${TO}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ChartBody;
    expect(rowsFor(body, 'temperature')).toHaveLength(50);
    expect(body.historySampled).toBe(true);
    // NOT 50: the count describes the window that was asked for, which is the
    // whole defect this endpoint exists to fix.
    expect(body.historyTotal).toBe(TOTAL);
  });

  it('reports the TRUE maximum even when that reading is not among the returned rows', async () => {
    // `points=2` takes `lttb`'s `target <= 2` branch, which returns [first, last]
    // verbatim. The spike sits in the middle of the series, so its absence from
    // `history` is guaranteed rather than probable — LTTB is spike-preserving by
    // design and would very likely SELECT it at any larger target, which would
    // make this test pass without proving anything.
    const res = await telemetry(instId, `?key=temperature&points=2&from=${FROM}&to=${TO}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ChartBody;
    const rows = rowsFor(body, 'temperature');
    expect(rows).toHaveLength(2);

    // Half one: the spike really is absent from what the chart would draw.
    expect(rows.some((r) => r.value === SPIKE)).toBe(false);
    // Half two: "Maximum" is still the truth. Sourced from SQL over the whole
    // range, never from the points above.
    expect(body.summaries!.temperature.max).toBe(SPIKE);
    expect(body.summaries!.temperature.min).toBe(BASE);
    expect(body.summaries!.temperature.count).toBe(TOTAL);
    expect(body.summaries!.temperature.first).toBe(t0.toISOString());
    expect(body.summaries!.temperature.last).toBe(tEnd.toISOString());
    // The average must be pulled up by the spike — a mean over two endpoints
    // would land on 20-something and this would fail.
    const expectedAvg = ((TOTAL - 1) * (BASE + 0.2) + SPIKE) / TOTAL;
    expect(body.summaries!.temperature.avg).toBeCloseTo(expectedAvg, 1);
    expect(body.summaries!.temperature.avg).toBeGreaterThan(BASE);
  });

  it('summarises every key when none is named, and endpoints anchor the axis', async () => {
    const res = await telemetry(instId, `?points=100&from=${FROM}&to=${TO}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ChartBody;
    const keys = Object.keys(body.summaries!);
    expect(keys).toContain('temperature');
    expect(keys).toContain('humidity');
    const temps = rowsFor(body, 'temperature');
    // The chart path is chronological, and the range endpoints are preserved —
    // the x-axis is drawn from them.
    expect(temps[0].ts).toBe(t0.toISOString());
    expect(temps[temps.length - 1].ts).toBe(tEnd.toISOString());
    expect(body.historyTotal).toBe(TOTAL + 3);
  });

  it('omits a key that has no readings inside the range', async () => {
    // `pressure` HAS readings — just none between FROM and TO. An entry here
    // would mean the summary was computed over the wrong window.
    const res = await telemetry(instId, `?key=pressure&points=50&from=${FROM}&to=${TO}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ChartBody;
    expect(rowsFor(body, 'pressure')).toHaveLength(0);
    expect(body.summaries!.pressure).toBeUndefined();
    expect(body.historyTotal).toBe(0);
    expect(body.historySampled).toBe(false);
  });

  it('rejects an out-of-bounds `points` rather than clamping it', async () => {
    // A clamp would answer 200 with a quietly different resolution than asked
    // for — the same class of silence this whole task removes.
    const res = await telemetry(instId, `?key=temperature&points=5001&from=${FROM}&to=${TO}`);
    expect(res.statusCode).toBe(400);
    const zero = await telemetry(instId, `?key=temperature&points=0&from=${FROM}&to=${TO}`);
    expect(zero.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/instruments/${instId}/telemetry?points=10` });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * The OUT-OF-LIMIT counts, which the signed trend report prints.
 *
 * Same reason as the `summaries.max` case above: the report says "N readings
 * out of limit over this period", and an N counted over the rows the sampler
 * happened to draw understates an excursion it skipped. The counts are computed
 * in SQL over every reading in the range, against the limits `limitsFor()`
 * resolves — the evaluator's own answer, never re-derived from attribute names
 * here or in the browser.
 */
describe('chart path — true out-of-limit counts over the range', () => {
  it('counts a breach that is NOT among the returned rows', async () => {
    // `points=2` returns [first, last] verbatim, so the 99.9 spike in the middle
    // is guaranteed absent from `history` — a count taken over those rows would
    // be 0, and the report would print "0 readings out of limit" for a period
    // holding a 99.9 °C excursion.
    const res = await telemetry(instId, `?key=temperature&points=2&from=${FROM}&to=${TO}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ChartBody;
    const rows = rowsFor(body, 'temperature');
    expect(rows.some((r) => r.value === SPIKE)).toBe(false);

    const t = body.summaries!.temperature;
    expect(t.aboveCount).toBe(1);
    // A REAL zero: the low limit was set and checked, and nothing breached it.
    // Distinguishable from null, which is what an unset bound gives.
    expect(t.belowCount).toBe(0);
    expect(t.outOfSpecCount).toBe(1);
    // The bounds the counts were taken against ride on the same payload, so the
    // report cannot print a count from one resolution and a limit from another.
    expect(t.limitMin).toBe(TEMP_LOW);
    expect(t.limitMax).toBe(TEMP_HIGH);
    // The denominator a percentage is printed against: every NUMERIC reading in
    // the range, not the two rows returned.
    expect(t.numericCount).toBe(TOTAL);
    expect(t.count).toBe(TOTAL);
  });

  it('reports NULL, never 0, for a slot with no limits set', async () => {
    // This instrument declares temperature limits and no humidity ones. A zero
    // here would read as "humidity was assessed and was in limit" for a period
    // nothing checked at all.
    const res = await telemetry(instId, `?key=humidity&points=100&from=${FROM}&to=${TO}`);
    expect(res.statusCode).toBe(200);
    const h = (res.json() as ChartBody).summaries!.humidity;
    expect(h.belowCount).toBeNull();
    expect(h.aboveCount).toBeNull();
    expect(h.outOfSpecCount).toBeNull();
    expect(h.limitMin).toBeNull();
    expect(h.limitMax).toBeNull();
    // The other aggregates are unaffected — nothing about an absent limit stops
    // min/max/avg being computed.
    expect(h.max).toBe(47);
  });

  it('counts around a non-numeric reading rather than failing on it', async () => {
    const res = await telemetry(mixedInstId, `?key=temperature&points=100&from=${FROM}&to=${TO}`);
    expect(res.statusCode).toBe(200);
    const t = (res.json() as ChartBody).summaries!.temperature;
    // Four stored values, three of them numbers.
    expect(t.count).toBe(4);
    expect(t.numericCount).toBe(3);
    expect(t.aboveCount).toBe(1);
    expect(t.belowCount).toBe(0);
    expect(t.max).toBe(99.9);
  });

  it('reports `historyTotal` from the range COUNT, never from the sliced rows', async () => {
    // `getRangeRows` returns at most `CHART_HARD_CAP` rows, so its length is a
    // POST-SLICE number. `historyTotal` is an on-screen and printed §11
    // statement ("Showing 5,000 of N readings"), so it must describe the window
    // that was asked for.
    //
    // WHAT THIS HALF CAN AND CANNOT SHOW: the cap is 200,000 and seeding past
    // it is not viable here, so over HTTP the two are equal by construction —
    // what is asserted is the INVARIANT that ties them, per key, including the
    // key carrying a non-numeric reading (both are `count(*)`, unguarded).
    // The truncating case is proved on the pure decision below.
    const res = await telemetry(mixedInstId, `?points=100&from=${FROM}&to=${TO}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ChartBody;
    const summed = Object.values(body.summaries!).reduce((n, k) => n + k.count, 0);
    expect(body.historyTotal).toBe(summed);
    // Four stored temperature values, one of them the string reading — the
    // total counts it, exactly as `summaries.temperature.count` does.
    expect(body.summaries!.temperature.count).toBe(4);
  });

  it('and the decision itself prefers the count when the row read was truncated', () => {
    // The discriminating half, on the pure function the route uses. At the cap
    // the sliced read holds 200,000 rows for a range holding 250,000; reporting
    // the slice would understate the denominator by 50,000 readings.
    expect(chartRangeTotal({ count: 250_000 }, 200_000)).toBe(250_000);
    // Equal on every non-truncating call, which is why this is a zero-risk swap.
    expect(chartRangeTotal({ count: 2_500 }, 2_500)).toBe(2_500);
    // No summary means an empty range; the row count is 0 there too.
    expect(chartRangeTotal(null, 0)).toBe(0);
  });

  it('does not add the new fields to the paged table path', async () => {
    // Fastify strips undeclared fields, so this also guards the reverse: the
    // table path's response shape is untouched by any of the above.
    const res = await telemetry(instId, `?key=temperature&limit=5&from=${FROM}&to=${TO}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as ChartBody).summaries).toBeUndefined();
  });
});

/**
 * Instrument visibility must not regress on the new path.
 *
 * Driven through the seeded OPERATOR, not `admin`: SUPER_ADMIN short-circuits
 * `resolveVisibility` to unrestricted, so these assertions would pass against a
 * completely unscoped route. The IN-SCOPE case is the control — without it a
 * route that 404s everything would look correct here.
 */
describe('chart path — instrument visibility', () => {
  let operator: Record<string, string>;

  beforeAll(async () => {
    const fl = await prisma.functionalLocation.create({
      data: { name: `trng-e2e-fl-${s}`, type: 'BLOCK' },
    });
    flId = fl.id;

    const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
    roleId = role.id;
    rolePermsBefore = role.permissions as string[];
    await prisma.role.update({
      where: { id: roleId },
      data: { permissions: [...rolePermsBefore, 'INSTRUMENT_READ'] },
    });
    invalidateRolePermsCache('OPERATOR');
    await prisma.roleConfig.upsert({
      where: { role: 'OPERATOR' },
      create: { role: 'OPERATOR', instrumentScope: [flId] },
      update: { instrumentScope: [flId] },
    });

    visibleInstId = await createInstrument(`TRNG-VIS-${s}`);
    await prisma.instrument.update({
      where: { id: visibleInstId }, data: { functionalLocationId: flId },
    });
    await seed(visibleInstId, 'temperature', [{ ts: new Date(t0.getTime()), value: 21 }]);

    operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
  });

  it('404s — never 403 — for an instrument outside the caller\'s scope', async () => {
    // A 403 would confirm the instrument exists, which is exactly what project
    // D's visibility rules withhold.
    const res = await telemetry(instId, `?key=temperature&points=50&from=${FROM}&to=${TO}`, operator);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');
  });

  it('serves an in-scope instrument to the same caller', async () => {
    const res = await telemetry(visibleInstId, `?key=temperature&points=50&from=${FROM}&to=${TO}`, operator);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ChartBody;
    expect(rowsFor(body, 'temperature')).toHaveLength(1);
    expect(body.summaries!.temperature.max).toBe(21);
  });
});

/**
 * A bound the instrument has switched OFF must not be reported, and must not be
 * counted against.
 *
 * `Enable_Temp_NMT` / `_NLT` (NMT is the HIGH bound, NLT the LOW one) gate the
 * four limits. `buildTelemetryOverview` has applied them since 2026-08-31, so
 * the chart's limit LINE — which comes from the overview — disappeared
 * correctly. This route resolved the SAME limits through the SAME helper and
 * then did not apply the flags, so the summary strip beside that vanished line
 * kept printing the bound AND counting breaches against it in SQL.
 *
 * That is not hypothetical here: an instrument carrying `High Humidity Limit =
 * 0` with `Enable_Humid_NMT = 0` reported every reading as above limit, in a
 * §11 report, against a bound no alarm on this system can raise.
 *
 * The distinction these cases turn on: a disabled bound must come back NULL —
 * "not judged" — never `0`, which is the honest answer for a bound that IS in
 * force and was never breached. The route already had to keep those apart.
 */
describe('a disabled bound is not a bound', () => {
  let offId: string;

  beforeAll(async () => {
    offId = await createInstrument(`TRNG-OFF-${s}`);
    await prisma.instrumentAttribute.createMany({
      data: [
        { instrumentId: offId, key: 'High Temperature Limit', value: String(TEMP_HIGH) },
        { instrumentId: offId, key: 'Low Temperature Limit', value: String(TEMP_LOW) },
        // The HIGH bound is switched off; the LOW one is left alone.
        { instrumentId: offId, key: 'Enable_Temp_NMT', value: '0' },
      ],
    });
    // One reading well above the (disabled) high bound and inside the low one.
    await seed(offId, 'temperature', [
      { ts: new Date(t0.getTime()), value: 20 },
      { ts: new Date(t0.getTime() + STEP_MS), value: 99.9 },
    ]);
  });

  const summary = async () => {
    const res = await telemetry(offId, `?from=${FROM}&to=${TO}&points=100`);
    expect(res.statusCode).toBe(200);
    return (res.json() as ChartBody).summaries!.temperature;
  };

  it('does not report the disabled bound', async () => {
    expect((await summary()).limitMax).toBeNull();
  });

  it('does not count breaches against it — null, not zero', async () => {
    // NULL means "no bound was resolved". A 0 would be the claim "this bound
    // was checked and never breached", which is false: it was not checked.
    expect((await summary()).aboveCount).toBeNull();
  });

  it('but the COMBINED count stays a real zero while one bound survives', async () => {
    // Deliberately not null. `outOfSpecCount` answers "did this leave the band
    // that is in force?", and the low bound IS in force and was not breached.
    // Nulling it because its sibling is disabled would report "not judged" for
    // a range that was judged — the mirror of the defect above, and worse,
    // because it hides a bound that IS enforced.
    expect((await summary()).outOfSpecCount).toBe(0);
  });

  it('leaves the bound that is still ENABLED reporting and counting', async () => {
    // The gate must be per-bound. Disabling the high one and losing the low one
    // with it would hide a real excursion.
    const s2 = await summary();
    expect(s2.limitMin).toBe(TEMP_LOW);
    expect(s2.belowCount).toBe(0);
  });

  it('still returns the readings themselves', async () => {
    // The bound is not judged; the data is not withheld. The 99.9 reading is
    // still a stored reading and still has to appear on the chart.
    const res = await telemetry(offId, `?from=${FROM}&to=${TO}&points=100`);
    const body = res.json() as ChartBody;
    expect(rowsFor(body, 'temperature')).toHaveLength(2);
    expect(body.summaries!.temperature.max).toBe(99.9);
  });
});

/**
 * Both bounds off — the shape this installation actually carries.
 *
 * Sixteen instruments here hold `Enable_Humid_NMT = 0` beside a `High Humidity
 * Limit` of 0, and a 0 IS a real bound (that combination is what put 17 CRITICAL
 * alarms on screen at 44-50 %RH before the alarm path was gated). With every
 * bound disabled the summary must say NOTHING was judged, not that nothing was
 * breached.
 */
describe('every bound disabled', () => {
  let noneId: string;

  beforeAll(async () => {
    noneId = await createInstrument(`TRNG-NONE-${s}`);
    await prisma.instrumentAttribute.createMany({
      data: [
        { instrumentId: noneId, key: 'High Humidity Limit', value: '0' },
        { instrumentId: noneId, key: 'Low Humidity Limit', value: '0' },
        { instrumentId: noneId, key: 'Enable_Humid_NMT', value: '0' },
        { instrumentId: noneId, key: 'Enable_Humid_NLT', value: 'False' },
      ],
    });
    await seed(noneId, 'humidity', [
      { ts: new Date(t0.getTime()), value: 47 },
      { ts: new Date(t0.getTime() + STEP_MS), value: 50 },
    ]);
  });

  it('reports no bounds and judges nothing', async () => {
    const res = await telemetry(noneId, `?from=${FROM}&to=${TO}&points=100`);
    const h = (res.json() as ChartBody).summaries!.humidity;
    expect(h.limitMin).toBeNull();
    expect(h.limitMax).toBeNull();
    expect(h.aboveCount).toBeNull();
    expect(h.belowCount).toBeNull();
    expect(h.outOfSpecCount).toBeNull();
  });

  it('accepts `False` as well as `0` — the live data holds both', async () => {
    // `Enable_Humid_NLT` above is the word, not the digit. If only one spelling
    // were honoured the low bound would still be judged here.
    const res = await telemetry(noneId, `?from=${FROM}&to=${TO}&points=100`);
    expect((res.json() as ChartBody).summaries!.humidity.belowCount).toBeNull();
  });

  it('still returns every reading', async () => {
    const res = await telemetry(noneId, `?from=${FROM}&to=${TO}&points=100`);
    expect(rowsFor(res.json() as ChartBody, 'humidity')).toHaveLength(2);
  });
});

/**
 * ONE test that makes the two server resolvers agree, rather than two that each
 * check one.
 *
 * "A bound the instrument switches off is not enforced" was implemented three
 * times on 2026-08-31 — in `buildTelemetryOverview` (which feeds the cards, the
 * dashboard table, the floorplan tiles and the chart's limit LINE), in this
 * route's `boundsFor` (which feeds the summary strip, the breach counts and the
 * signed PDF), and in the trend card's own status fall-through. Each was written
 * by someone who had verified their own and assumed the others were covered, and
 * all three were separately wrong at some point in the same day.
 *
 * Two of those three are server-side and answer the SAME question about the SAME
 * instrument from the SAME attributes, so they can be asserted together. That is
 * the point of this block: N tests each pinning one resolver cannot catch two
 * resolvers disagreeing, which is the only failure that actually reaches a
 * screen — a limit line that has vanished sitting above a strip still counting
 * breaches against the bound it stopped drawing.
 *
 * If a third server-side consumer of these bounds is ever added, add it here.
 */
describe('every server resolver agrees about a disabled bound', () => {
  let agreeId: string;

  beforeAll(async () => {
    agreeId = await createInstrument(`TRNG-AGREE-${s}`);
    await prisma.instrumentAttribute.createMany({
      data: [
        { instrumentId: agreeId, key: 'High Temperature Limit', value: '27' },
        { instrumentId: agreeId, key: 'Low Temperature Limit', value: '18' },
        { instrumentId: agreeId, key: 'Enable_Temp_NMT', value: '0' },
      ],
    });
    await seed(agreeId, 'temperature', [
      { ts: new Date(t0.getTime()), value: 24.5 },
      { ts: new Date(t0.getTime() + STEP_MS), value: 99.9 },
    ]);
  });

  it('the overview and the chart summary report the SAME bounds', async () => {
    const ov = await app.inject({
      method: 'GET', url: '/api/instruments/telemetry-overview', headers: auth,
    });
    expect(ov.statusCode).toBe(200);
    // `instrumentId`, not `id` — the overview row is keyed by the instrument it
    // describes, not by a row identity of its own.
    const row = (ov.json().data as {
      instrumentId: string; limits: { tempMin: number | null; tempMax: number | null } | null;
    }[]).find((r) => r.instrumentId === agreeId)!;
    expect(row, 'instrument missing from the overview').toBeDefined();

    const res = await telemetry(agreeId, `?from=${FROM}&to=${TO}&points=100`);
    const sum = (res.json() as ChartBody).summaries!.temperature;

    // The assertion that matters: not that each is null, but that they MATCH.
    // A future change to one resolver alone fails here even if that change is
    // internally consistent and its own tests still pass.
    expect(
      { min: sum.limitMin, max: sum.limitMax },
      'the chart summary and the overview disagree about this instrument\'s bounds',
    ).toEqual({ min: row.limits!.tempMin, max: row.limits!.tempMax });
  });

  it('latest-values reports the SAME bounds as the overview', async () => {
    const ov = await app.inject({ method: 'GET', url: '/api/instruments/telemetry-overview', headers: auth });
    const row = (ov.json().data as {
      instrumentId: string; limits: { tempMin: number | null; tempMax: number | null } | null;
    }[]).find((r) => r.instrumentId === agreeId)!;
    const res = await app.inject({
      method: 'POST', url: '/api/instruments/latest-values', headers: auth,
      payload: { instrumentIds: [agreeId], keys: [{ source: 'telemetry', key: 'temperature' }] },
    });
    expect(res.statusCode).toBe(200);
    const judged = res.json().data[0].values[0].judged as { limitMin: number | null; limitMax: number | null };
    expect(
      { min: judged.limitMin, max: judged.limitMax },
      'latest-values and the overview disagree about this instrument\'s bounds',
    ).toEqual({ min: row.limits!.tempMin, max: row.limits!.tempMax });
  });

  it('and both say the disabled bound is absent, not merely unbreached', async () => {
    const res = await telemetry(agreeId, `?from=${FROM}&to=${TO}&points=100`);
    const sum = (res.json() as ChartBody).summaries!.temperature;
    expect(sum.limitMax).toBeNull();
    // 99.9 is above 27. If the gate were lost this would be 1, and the strip
    // would print a breach the chart above it draws no line for.
    expect(sum.aboveCount).toBeNull();
  });
});

/**
 * A limit attribute carrying TEXT beside its number (`60 (For Reference)`,
 * operator 2026-10-03): the NUMBER is the bound the breach counts are taken
 * against, and the TEXT rides on the summary beside it so the report's
 * printed bound and its count come from one answer. Over the wire, because
 * Fastify strips an undeclared summary key silently.
 */
describe('a limit carrying text, on the chart summary', () => {
  let textId: string;

  beforeAll(async () => {
    textId = await createInstrument(`TRNG-TEXT-${s}`);
    await prisma.instrumentAttribute.createMany({
      data: [
        { instrumentId: textId, key: 'High Temperature Limit', value: '27 (For Reference)' },
        { instrumentId: textId, key: 'Low Temperature Limit', value: '18' },
      ],
    });
    await seed(textId, 'temperature', [
      { ts: new Date(t0.getTime()), value: 24.5 },
      { ts: new Date(t0.getTime() + STEP_MS), value: 30 },
    ]);
  });

  it('counts breaches against the NUMBER and sends the TEXT beside it', async () => {
    const res = await telemetry(textId, `?from=${FROM}&to=${TO}&points=100`);
    const sum = (res.json() as ChartBody).summaries!.temperature;
    expect(sum.limitMax).toBe(27);
    expect(sum.aboveCount).toBe(1);
    expect(sum.limitMaxText).toBe('27 (For Reference)');
    // A bare number carries no text — the report prints it at the precision.
    expect(sum.limitMin).toBe(18);
    expect(sum.limitMinText).toBeNull();
  });
});

/**
 * Mean Kinetic Temperature on the chart summary (operator, 2026-10-03: "in
 * attributes isMktcalculationenabled attributes is true then in data report
 * mkt value should come, if false then mkt value should not come"). The SERVER
 * decides from the attribute and computes it in SQL over EVERY reading in the
 * range; the Data Report prints the row iff `mkt` is a number. Over the wire,
 * because Fastify strips an undeclared summary key silently.
 */
describe('Mean Kinetic Temperature on the chart summary', () => {
  const readings = [20, 30, 25, 22.5];
  let onId: string;
  let offId: string;
  let absentId: string;

  beforeAll(async () => {
    onId = await createInstrument(`TRNG-MKT-ON-${s}`);
    offId = await createInstrument(`TRNG-MKT-OFF-${s}`);
    absentId = await createInstrument(`TRNG-MKT-ABS-${s}`);
    await prisma.instrumentAttribute.createMany({
      data: [
        { instrumentId: onId, key: 'isMktCalculationEnabled', value: 'True' },
        { instrumentId: offId, key: 'isMktCalculationEnabled', value: '0' },
      ],
    });
    for (const id of [onId, offId, absentId]) {
      await seed(id, 'temperature', readings.map((value, i) => ({ ts: new Date(t0.getTime() + i * STEP_MS), value })));
      await seed(id, 'humidity', [{ ts: new Date(t0.getTime()), value: 45 }]);
    }
  });

  it('is the ICH figure over every reading when the attribute is on — temperature slot only', async () => {
    const res = await telemetry(onId, `?from=${FROM}&to=${TO}&points=100`);
    const sums = (res.json() as ChartBody).summaries!;
    expect(sums.temperature.mkt).toBeCloseTo(mktCelsius(readings)!, 6);
    // Hotter readings weigh more: above the plain mean of 24.375.
    expect(sums.temperature.mkt!).toBeGreaterThan(sums.temperature.avg);
    expect(sums.humidity.mkt).toBeNull();
  });

  it('is null when the attribute is off, and when it is absent', async () => {
    const off = (await telemetry(offId, `?from=${FROM}&to=${TO}&points=100`)).json() as ChartBody;
    expect(off.summaries!.temperature.mkt).toBeNull();
    const abs = (await telemetry(absentId, `?from=${FROM}&to=${TO}&points=100`)).json() as ChartBody;
    expect(abs.summaries!.temperature.mkt).toBeNull();
  });

  // Audit 2026-10-12 #8: a sensor-fault value between absolute zero and about
  // -259 °C reached exp(-10000 / T) and Postgres raised "value out of range:
  // underflow" (measured: exp(-10000/8.15)) — a 500 for every range summary of
  // that key, whether MKT was switched on or not. The term is ~0 there; the
  // SQL now says so instead of computing it, matching the pure `mktCelsius`.
  it('a sensor-fault reading near absolute zero does not 500 the summary, and counts like the reference', async () => {
    const faultId = await createInstrument(`TRNG-MKT-FAULT-${s}`);
    await prisma.instrumentAttribute.create({ data: { instrumentId: faultId, key: 'isMktCalculationEnabled', value: 'True' } });
    const withFault = [...readings, -265];
    await seed(faultId, 'temperature', withFault.map((value, i) => ({ ts: new Date(t0.getTime() + i * STEP_MS), value })));
    const res = await telemetry(faultId, `?from=${FROM}&to=${TO}&points=100`);
    expect(res.statusCode).toBe(200);
    const sums = (res.json() as ChartBody).summaries!;
    expect(sums.temperature.min).toBe(-265);
    expect(sums.temperature.mkt).toBeCloseTo(mktCelsius(withFault)!, 6);
  });
});
