import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { ensurePartitions } from '../workers/telemetry-partition.worker.js';

/**
 * GET /api/instruments/telemetry-buckets — the bar chart's data (dashboard builder
 * phase 2, task 3). Every bucket edge is LOCAL to the `datetime` config's
 * timezone; every value is DERIVED.
 *
 * Fixture: Block K holds Area X (instrument A) and Area Y (instrument B). The
 * OPERATOR is scoped to Area X, so a leak shows up as B's readings.
 *
 * Every reading is seeded at a FIXED instant in October 2026, never the clock.
 * `ensurePartitions` (the worker's own idempotent helper) makes sure October's
 * partition exists, so retention dropping it later cannot break this file.
 *
 * The zone is set per describe by writing `system_config` directly: the
 * `PUT /api/config/datetime` route's schema only admits `Asia/Kolkata`, and the
 * fallback cases need a stored value it would refuse. The original row is
 * restored FIRST in `afterAll`, on its own guard.
 *
 * WHY THERE IS A UTC CASE AS WELL AS THE KOLKATA ONE. This database's session
 * TimeZone is Asia/Calcutta. A broken query that bins the raw `ts` against a
 * `TIMESTAMP` origin (cast in the SESSION zone) produces Kolkata edges here by
 * accident, so a Kolkata-only test cannot catch it; the UTC case does. A query
 * that bins against a UTC origin is caught by the Kolkata cases.
 */

const S = Date.now();
const PW = 'Tbk@Pass1234';
const SA = `tbk_sa_${S}`;
const OP = `tbk_op_${S}`;
const ROLE = `TBK_OP_${S}`;

let app: FastifyInstance;
let sa: Record<string, string>;
let operator: Record<string, string>;
let blockK = '', areaX = '', areaY = '';
let profile = '';
let A = '', B = '';
const userIds: string[] = [];

/** The `datetime` row as it was before this file touched it; `null` = there was none. */
let datetimeBefore: { configValue: Prisma.JsonValue } | null = null;
let datetimeTouched = false;

async function setZone(timezone: string) {
  datetimeTouched = true;
  const base = (datetimeBefore?.configValue as Record<string, unknown> | null) ?? {};
  await prisma.systemConfig.upsert({
    where: { configKey: 'datetime' },
    update: { configValue: { ...base, timezone } as Prisma.InputJsonValue },
    create: { configKey: 'datetime', configValue: { ...base, timezone } as Prisma.InputJsonValue, configType: 'display' },
  });
}

async function seed(instrumentId: string, rows: { key: string; value: unknown; ts: string }[]) {
  const values = Prisma.join(rows.map((r) => Prisma.sql`(
    ${instrumentId}, ${r.key}, ${JSON.stringify(r.value)}::jsonb,
    ${typeof r.value === 'number' ? 'number' : 'string'}, ${new Date(r.ts)})`));
  await prisma.$executeRaw`
    INSERT INTO instrument_telemetry_history (instrument_id, key, value, value_type, ts)
    VALUES ${values}
    ON CONFLICT (instrument_id, key, ts) DO NOTHING`;
}

async function instrument(code: string, functionalLocationId: string) {
  return (await prisma.instrument.create({
    data: { name: `tbk ${code}`, code, profileId: profile, functionalLocationId },
  })).id;
}

beforeAll(async () => {
  app = await buildApp();
  datetimeBefore = await prisma.systemConfig.findUnique({
    where: { configKey: 'datetime' }, select: { configValue: true },
  });
  await ensurePartitions(0, new Date('2026-10-15T00:00:00.000Z'));

  blockK = (await prisma.functionalLocation.create({ data: { name: `TBK K ${S}`, type: 'BLOCK' } })).id;
  areaX = (await prisma.functionalLocation.create({ data: { name: `TBK X ${S}`, type: 'AREA', parentId: blockK } })).id;
  areaY = (await prisma.functionalLocation.create({ data: { name: `TBK Y ${S}`, type: 'AREA', parentId: blockK } })).id;
  profile = (await prisma.instrumentProfile.create({ data: { name: `tbk-${S}`, description: 'tbk fixture' } })).id;
  A = await instrument(`TBK-A-${S}`, areaX);
  B = await instrument(`TBK-B-${S}`, areaY);

  // Local hour 10:00-11:00 IST on 10 Oct = 04:30Z-05:30Z.
  await seed(A, [
    { key: 'temperature', value: 20, ts: '2026-10-10T04:35:00.000Z' },
    { key: 'temperature', value: 22, ts: '2026-10-10T04:50:00.000Z' },
    { key: 'temperature', value: 25, ts: '2026-10-10T05:35:00.000Z' },
    // Keys match EXACTLY: `Temperature` is another key, never `temperature`.
    { key: 'Temperature', value: 999, ts: '2026-10-10T04:45:00.000Z' },
    { key: 'humidity', value: 50, ts: '2026-10-10T04:36:00.000Z' },
    // The time-zone probes.
    { key: 'tz_probe', value: 10, ts: '2026-10-01T17:00:00.000Z' }, // local 1 Oct 22:30
    { key: 'tz_probe', value: 20, ts: '2026-10-01T23:00:00.000Z' }, // local 2 Oct 04:30
    { key: 'tz_hour', value: 1, ts: '2026-10-01T18:45:00.000Z' }, // local 2 Oct 00:15
    { key: 'tz_week', value: 1, ts: '2026-10-04T18:00:00.000Z' }, // local Sun 4 Oct 23:30
    { key: 'tz_week', value: 3, ts: '2026-10-04T18:45:00.000Z' }, // local Mon 5 Oct 00:15
  ]);
  await seed(B, [
    { key: 'temperature', value: 30, ts: '2026-10-10T04:40:00.000Z' },
    { key: 'temperature', value: '21.5', ts: '2026-10-10T05:20:00.000Z' },
    { key: 'temperature', value: 'NA', ts: '2026-10-10T05:10:00.000Z' },
  ]);

  await prisma.role.create({
    data: { name: ROLE, displayName: `TBK ${S}`, hierarchyLevel: 2, isSystem: false, permissions: ['INSTRUMENT_READ'] },
  });
  await prisma.roleConfig.create({
    data: { role: ROLE, instrumentScope: { locationIds: [areaX], instrumentIds: [] } as never },
  });
  invalidateRolePermsCache(ROLE);

  for (const [username, role] of [[SA, 'SUPER_ADMIN'], [OP, ROLE]] as const) {
    const u = await prisma.user.create({
      data: {
        username, fullName: username, role, passwordHash: await hashPassword(PW),
        passwordChangedAt: new Date(), forcePasswordChange: false, isTemporaryPassword: false,
      },
    });
    userIds.push(u.id);
  }
  sa = { authorization: `Bearer ${await loginAs(app, SA, PW)}` };
  operator = { authorization: `Bearer ${await loginAs(app, OP, PW)}` };
});

afterAll(async () => {
  // FIRST, on its own guard: hand back the config even while failing. A failed
  // restore is COLLECTED, the rest of the teardown still runs, and then it is
  // rethrown so the run fails: a restore that only logged would exit 0 and leave
  // the shared test DB holding a zone this file wrote, which the next run would
  // snapshot as its "before" (the 2026-08-31 ratchet in apps/api/CLAUDE.md).
  let restoreError: unknown = null;
  try {
    if (datetimeTouched) {
      if (datetimeBefore) {
        await prisma.systemConfig.update({
          where: { configKey: 'datetime' },
          data: { configValue: datetimeBefore.configValue as Prisma.InputJsonValue },
        });
      } else {
        await prisma.systemConfig.deleteMany({ where: { configKey: 'datetime' } });
      }
    }
  } catch (err) {
    restoreError = err;
  }
  const ids = [A, B].filter(Boolean);
  await prisma.$executeRaw`DELETE FROM instrument_telemetry_history WHERE instrument_id = ANY(${ids}::text[])`.catch(() => {});
  await prisma.instrument.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.functionalLocation.deleteMany({ where: { id: { in: [areaX, areaY].filter(Boolean) } } }).catch(() => {});
  await prisma.functionalLocation.deleteMany({ where: { id: blockK } }).catch(() => {});
  await prisma.instrumentProfile.deleteMany({ where: { id: profile } }).catch(() => {});
  await prisma.roleConfig.deleteMany({ where: { role: ROLE } }).catch(() => {});
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.passwordHistory.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await prisma.role.deleteMany({ where: { name: ROLE } }).catch(() => {});
  invalidateRolePermsCache(ROLE);
  try {
    await app.close();
  } finally {
    if (restoreError) {
      throw new Error(
        'telemetry-buckets: could NOT restore the `datetime` config in compliance_core_db_test — '
        + 'it may still hold a zone this file wrote; restore it by hand before the next run',
        { cause: restoreError },
      );
    }
  }
});

const buckets = (qs: string, headers = sa) =>
  app.inject({ method: 'GET', url: `/api/instruments/telemetry-buckets?${qs}`, headers });

type Point = { ts: string; value: number; readings: number; instruments: number };
type Series = { instrumentId: string | null; key: string; points: Point[] };

/** The 10 Oct window: local 10:00-12:00 IST. */
const HOUR_WINDOW = 'from=2026-10-10T04:30:00.000Z&to=2026-10-10T06:30:00.000Z';
/** The 1-2 Oct window for the day / hour probes. */
const DAY_WINDOW = 'from=2026-10-01T00:00:00.000Z&to=2026-10-03T00:00:00.000Z';
/** Two weeks around the 4/5 Oct boundary. */
const WEEK_WINDOW = 'from=2026-09-28T00:00:00.000Z&to=2026-10-12T00:00:00.000Z';

describe('telemetry-buckets: aggregates per local hour (Asia/Kolkata)', () => {
  beforeAll(async () => { await setZone('Asia/Kolkata'); });

  it('groupBy=all: one series per key across instruments, every field declared', async () => {
    const res = await buckets(`instrumentIds=${A},${B}&keys=temperature&${HOUR_WINDOW}&bucket=hour&agg=avg&groupBy=all`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      from: '2026-10-10T04:30:00.000Z',
      to: '2026-10-10T06:30:00.000Z',
      bucket: 'hour',
      agg: 'avg',
      timezone: 'Asia/Kolkata',
      bucketSeconds: 3600,
      series: [{
        instrumentId: null,
        key: 'temperature',
        points: [
          // A 20, 22 + B 30, "21.5" — the quoted number counts, "NA" does not.
          { ts: '2026-10-10T04:30:00.000Z', value: 23.375, readings: 4, instruments: 2 },
          { ts: '2026-10-10T05:30:00.000Z', value: 25, readings: 1, instruments: 1 },
        ],
      }],
    });
  });

  it('min, max and count over the same rows', async () => {
    const values = async (agg: string) => {
      const res = await buckets(`instrumentIds=${A},${B}&keys=temperature&${HOUR_WINDOW}&bucket=hour&agg=${agg}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().agg).toBe(agg);
      return (res.json().series as Series[])[0].points.map((p) => [p.ts, p.value, p.readings]);
    };
    expect(await values('min')).toEqual([['2026-10-10T04:30:00.000Z', 20, 4], ['2026-10-10T05:30:00.000Z', 25, 1]]);
    expect(await values('max')).toEqual([['2026-10-10T04:30:00.000Z', 30, 4], ['2026-10-10T05:30:00.000Z', 25, 1]]);
    expect(await values('count')).toEqual([['2026-10-10T04:30:00.000Z', 4, 4], ['2026-10-10T05:30:00.000Z', 1, 1]]);
  });

  it('defaults: bucket=hour, agg=avg, groupBy=all', async () => {
    const res = await buckets(`instrumentIds=${A},${B}&keys=temperature&${HOUR_WINDOW}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ bucket: 'hour', agg: 'avg', bucketSeconds: 3600 });
    expect((res.json().series as Series[]).map((s) => s.instrumentId)).toEqual([null]);
  });

  it('groupBy=instrument: one series per instrument x key with readings, in the order asked', async () => {
    const res = await buckets(`instrumentIds=${A},${B}&keys=temperature,humidity&${HOUR_WINDOW}&groupBy=instrument`);
    expect(res.statusCode).toBe(200);
    expect(res.json().series).toEqual([
      { instrumentId: A, key: 'temperature', points: [
        { ts: '2026-10-10T04:30:00.000Z', value: 21, readings: 2, instruments: 1 },
        { ts: '2026-10-10T05:30:00.000Z', value: 25, readings: 1, instruments: 1 },
      ] },
      { instrumentId: A, key: 'humidity', points: [
        { ts: '2026-10-10T04:30:00.000Z', value: 50, readings: 1, instruments: 1 },
      ] },
      // B has no humidity: no series for it, and no empty one.
      { instrumentId: B, key: 'temperature', points: [
        { ts: '2026-10-10T04:30:00.000Z', value: 25.75, readings: 2, instruments: 1 },
      ] },
    ]);
  });

  it('groupBy=instrument: min, max and count per instrument, two instruments', async () => {
    const values = async (agg: string) => {
      const res = await buckets(`instrumentIds=${A},${B}&keys=temperature&${HOUR_WINDOW}&groupBy=instrument&agg=${agg}`);
      expect(res.statusCode).toBe(200);
      return (res.json().series as Series[]).map((s) => [s.instrumentId, s.points.map((p) => [p.ts, p.value, p.readings])]);
    };
    const H1 = '2026-10-10T04:30:00.000Z';
    const H2 = '2026-10-10T05:30:00.000Z';
    expect(await values('min')).toEqual([[A, [[H1, 20, 2], [H2, 25, 1]]], [B, [[H1, 21.5, 2]]]]);
    expect(await values('max')).toEqual([[A, [[H1, 22, 2], [H2, 25, 1]]], [B, [[H1, 30, 2]]]]);
    expect(await values('count')).toEqual([[A, [[H1, 2, 2], [H2, 1, 1]]], [B, [[H1, 2, 2]]]]);
  });

  it('count per instrument: "21.5" counts, "NA" does not', async () => {
    const res = await buckets(`instrumentIds=${B}&keys=temperature&${HOUR_WINDOW}&groupBy=instrument&agg=count`);
    expect(res.json().series).toEqual([{ instrumentId: B, key: 'temperature', points: [
      { ts: '2026-10-10T04:30:00.000Z', value: 2, readings: 2, instruments: 1 },
    ] }]);
  });

  it('keys match exactly: `Temperature` is not `temperature`', async () => {
    const res = await buckets(`instrumentIds=${A}&keys=Temperature&${HOUR_WINDOW}`);
    expect(res.json().series).toEqual([{ instrumentId: null, key: 'Temperature', points: [
      { ts: '2026-10-10T04:30:00.000Z', value: 999, readings: 1, instruments: 1 },
    ] }]);
  });

  it('a key with no readings in the window has no series, in either mode', async () => {
    for (const groupBy of ['all', 'instrument']) {
      const res = await buckets(`instrumentIds=${A},${B}&keys=nothing_here&${HOUR_WINDOW}&groupBy=${groupBy}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().series).toEqual([]);
    }
  });
});

describe('telemetry-buckets: local edges (Review Focus 2)', () => {
  beforeAll(async () => { await setZone('Asia/Kolkata'); });

  it('day: 23:00Z lands in the NEXT local day, which starts at 18:30Z', async () => {
    const res = await buckets(`instrumentIds=${A}&keys=tz_probe&${DAY_WINDOW}&bucket=day`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ timezone: 'Asia/Kolkata', bucket: 'day', bucketSeconds: 86400 });
    expect((res.json().series as Series[])[0].points).toEqual([
      { ts: '2026-09-30T18:30:00.000Z', value: 10, readings: 1, instruments: 1 }, // local 1 Oct
      { ts: '2026-10-01T18:30:00.000Z', value: 20, readings: 1, instruments: 1 }, // local 2 Oct
    ]);
  });

  it('hour: the edge falls on the local hour (18:30Z), not 18:00Z', async () => {
    const res = await buckets(`instrumentIds=${A}&keys=tz_hour,tz_probe&${DAY_WINDOW}&bucket=hour`);
    const byKey = Object.fromEntries((res.json().series as Series[]).map((s) => [s.key, s.points.map((p) => p.ts)]));
    expect(byKey.tz_hour).toEqual(['2026-10-01T18:30:00.000Z']);
    expect(byKey.tz_probe).toEqual(['2026-10-01T16:30:00.000Z', '2026-10-01T22:30:00.000Z']);
  });

  it('week: starts on a local Monday 00:00 — Sunday 23:30 and Monday 00:15 are two weeks', async () => {
    const res = await buckets(`instrumentIds=${A}&keys=tz_week&${WEEK_WINDOW}&bucket=week&agg=max`);
    expect(res.statusCode).toBe(200);
    expect(res.json().bucketSeconds).toBe(604800);
    const points = (res.json().series as Series[])[0].points;
    expect(points).toEqual([
      { ts: '2026-09-27T18:30:00.000Z', value: 1, readings: 1, instruments: 1 },
      { ts: '2026-10-04T18:30:00.000Z', value: 3, readings: 1, instruments: 1 },
    ]);
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    for (const p of points) expect(local.format(new Date(p.ts))).toBe('Mon 00:00');
  });
});

describe('telemetry-buckets: another zone, and an unknown one', () => {
  it('UTC: the same readings bin on UTC midnight and a UTC Monday', async () => {
    await setZone('UTC');
    const day = await buckets(`instrumentIds=${A}&keys=tz_probe&${DAY_WINDOW}&bucket=day`);
    expect(day.json().timezone).toBe('UTC');
    expect((day.json().series as Series[])[0].points).toEqual([
      { ts: '2026-10-01T00:00:00.000Z', value: 15, readings: 2, instruments: 1 },
    ]);
    const week = await buckets(`instrumentIds=${A}&keys=tz_week&${WEEK_WINDOW}&bucket=week&agg=max`);
    expect((week.json().series as Series[])[0].points).toEqual([
      { ts: '2026-09-28T00:00:00.000Z', value: 3, readings: 2, instruments: 1 },
    ]);
  });

  for (const bad of ['Mars/Phobos', '+05:30']) {
    it(`an unknown zone (${bad}) falls back to UTC and says so`, async () => {
      await setZone(bad);
      const res = await buckets(`instrumentIds=${A}&keys=tz_probe&${DAY_WINDOW}&bucket=day`);
      expect(res.statusCode).toBe(200);
      expect(res.json().timezone).toBe('UTC');
      expect((res.json().series as Series[])[0].points.map((p) => p.ts)).toEqual(['2026-10-01T00:00:00.000Z']);
    });
  }
});

describe('telemetry-buckets: scope', () => {
  beforeAll(async () => { await setZone('Asia/Kolkata'); });

  it('groupBy=instrument: an out-of-scope id is silently absent; the in-scope one is there', async () => {
    const res = await buckets(`instrumentIds=${A},${B}&keys=temperature&${HOUR_WINDOW}&groupBy=instrument`, operator);
    expect(res.statusCode).toBe(200);
    expect((res.json().series as Series[]).map((s) => s.instrumentId)).toEqual([A]);
  });

  it('groupBy=all: the out-of-scope readings move nothing', async () => {
    const res = await buckets(`instrumentIds=${A},${B}&keys=temperature&${HOUR_WINDOW}`, operator);
    expect(res.statusCode).toBe(200);
    expect((res.json().series as Series[])[0].points[0]).toEqual(
      { ts: '2026-10-10T04:30:00.000Z', value: 21, readings: 2, instruments: 1 },
    );
  });

  it('only out-of-scope ids → 200 with no series', async () => {
    const res = await buckets(`instrumentIds=${B}&keys=temperature&${HOUR_WINDOW}`, operator);
    expect(res.statusCode).toBe(200);
    expect(res.json().series).toEqual([]);
  });
});

describe('telemetry-buckets: caps and bad input', () => {
  beforeAll(async () => { await setZone('Asia/Kolkata'); });

  const errorOf = async (qs: string) => {
    const res = await buckets(qs);
    return { status: res.statusCode, message: res.json().message as string };
  };

  it('an empty instrumentIds is a 200 with no series', async () => {
    const res = await buckets(`instrumentIds=&keys=temperature&${HOUR_WINDOW}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ series: [], timezone: 'Asia/Kolkata', bucketSeconds: 3600 });
  });

  it('more than 50 instruments, or a bad id, is a 400', async () => {
    const many = Array.from({ length: 51 }, () => randomUUID()).join(',');
    expect((await errorOf(`instrumentIds=${many}&keys=temperature&${HOUR_WINDOW}`)).status).toBe(400);
    expect((await errorOf(`instrumentIds=nope&keys=temperature&${HOUR_WINDOW}`)).status).toBe(400);
    const fifty = Array.from({ length: 50 }, () => randomUUID()).join(',');
    expect((await errorOf(`instrumentIds=${fifty}&keys=temperature&${HOUR_WINDOW}`)).status).toBe(200);
  });

  it('more than 20 keys, a blank key list, or no keys is a 400', async () => {
    const keys = Array.from({ length: 21 }, (_, i) => `k${i}`).join(',');
    expect((await errorOf(`instrumentIds=${A}&keys=${keys}&${HOUR_WINDOW}`)).status).toBe(400);
    expect((await errorOf(`instrumentIds=${A}&keys=,&${HOUR_WINDOW}`)).status).toBe(400);
    expect((await errorOf(`instrumentIds=${A}&${HOUR_WINDOW}`)).status).toBe(400);
  });

  it('from must be before to', async () => {
    const same = await errorOf(`instrumentIds=${A}&keys=temperature&from=2026-10-10T04:30:00.000Z&to=2026-10-10T04:30:00.000Z`);
    expect(same.status).toBe(400);
    const reversed = await errorOf(`instrumentIds=${A}&keys=temperature&from=2026-10-10T06:30:00.000Z&to=2026-10-10T04:30:00.000Z`);
    expect(reversed.status).toBe(400);
    expect((await errorOf(`instrumentIds=${A}&keys=temperature&to=2026-10-10T04:30:00.000Z`)).status).toBe(400);
  });

  it('more than 1,000 buckets is a 400 naming the bucket unit; exactly 1,000 is fine', async () => {
    const from = Date.parse('2026-10-01T00:00:00.000Z');
    const window = (seconds: number) =>
      `from=${new Date(from).toISOString()}&to=${new Date(from + seconds * 1000).toISOString()}`;
    const cases: [string, number, string][] = [['hour', 3600, 'hours'], ['day', 86400, 'days'], ['week', 604800, 'weeks']];
    for (const [bucket, sec, unit] of cases) {
      const over = await errorOf(`instrumentIds=${A}&keys=temperature&bucket=${bucket}&${window(1000 * sec + 1)}`);
      expect(over).toEqual({
        status: 400,
        message: `That window holds more than 1,000 ${unit}; choose a larger bucket or a shorter window`,
      });
      expect((await errorOf(`instrumentIds=${A}&keys=temperature&bucket=${bucket}&${window(1000 * sec)}`)).status).toBe(200);
    }
  });

  it('an unknown bucket, agg or groupBy is a 400', async () => {
    for (const bad of ['bucket=month', 'agg=sum', 'groupBy=room']) {
      expect((await errorOf(`instrumentIds=${A}&keys=temperature&${HOUR_WINDOW}&${bad}`)).status).toBe(400);
    }
  });

  it('is not captured by /:id', async () => {
    const res = await buckets(`instrumentIds=${A}&keys=temperature&${HOUR_WINDOW}`);
    expect(res.json()).toHaveProperty('series');
  });
});
