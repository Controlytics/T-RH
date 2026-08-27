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
import { invalidateRolePermsCache } from '../plugins/rbac.js';
// The route's own decision about which number `historyTotal` reports.
import { chartRangeTotal } from '../modules/instruments/telemetry.repository.js';

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
 * The two administered configs the breach counts depend on, PINNED for this file.
 *
 * `loadAliases` (which key is a temperature) and `loadLimitConfig` (which
 * attribute name carries a bound) both read `system_config` live, and this
 * install's lists have already drifted from the shipped defaults. Without
 * pinning, these assertions would be testing this machine's configuration
 * rather than the code. Restored verbatim in afterAll — the suite shares
 * `compliance_core_db_test`.
 */
const PINNED_CONFIG: Record<string, Record<string, string>> = {
  'telemetry-slots': { temperatureKeys: 'temperature', humidityKeys: 'humidity' },
  'alarm-limits': {
    temperatureHighKeys: 'High Temperature Limit',
    temperatureLowKeys: 'Low Temperature Limit',
    humidityHighKeys: 'High Humidity Limit',
    humidityLowKeys: 'Low Humidity Limit',
  },
};
const configBefore = new Map<string, { value: unknown; existed: boolean }>();

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
  }>;
}

const rowsFor = (b: ChartBody, key: string) => b.history.filter((r) => r.key === key);

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };

  for (const [key, value] of Object.entries(PINNED_CONFIG)) {
    const existing = await prisma.systemConfig.findUnique({ where: { configKey: key } });
    configBefore.set(key, { value: existing?.configValue ?? null, existed: Boolean(existing) });
    await prisma.systemConfig.upsert({
      where: { configKey: key },
      create: { configKey: key, configValue: value, configType: 'object' },
      update: { configValue: value },
    });
  }

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
  for (const [key, prev] of configBefore) {
    if (prev.existed) {
      await prisma.systemConfig.update({
        where: { configKey: key }, data: { configValue: prev.value as never },
      });
    } else {
      await prisma.systemConfig.deleteMany({ where: { configKey: key } });
    }
  }
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
