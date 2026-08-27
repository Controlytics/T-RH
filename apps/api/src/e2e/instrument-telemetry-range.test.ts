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

let app: FastifyInstance;
let auth: Record<string, string>;
const s = Date.now();
const instruments: string[] = [];

let instId = '';
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
    count: number; min: number; max: number; avg: number; first: string; last: string;
  }>;
}

const rowsFor = (b: ChartBody, key: string) => b.history.filter((r) => r.key === key);

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };

  instId = await createInstrument(`TRNG-A-${s}`);

  await seed(instId, 'temperature', Array.from({ length: TOTAL }, (_, i) => ({
    ts: new Date(t0.getTime() + i * STEP_MS),
    // A flat series apart from one spike in the exact middle of the range.
    value: i === SPIKE_INDEX ? SPIKE : BASE + (i % 5) * 0.1,
  })));

  // A small key: fewer readings than any `points` target, so nothing is sampled.
  await seed(instId, 'humidity', [0, 1, 2].map((i) => ({
    ts: new Date(t0.getTime() + i * STEP_MS), value: 45 + i,
  })));

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
