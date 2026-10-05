/**
 * `GET /api/instruments/telemetry-aggregate` — the dashboard trend card's feed.
 *
 * Driven through the seeded OPERATOR over HTTP, never through the module directly:
 * SUPER_ADMIN short-circuits `resolveVisibility` to unrestricted, so an
 * admin-driven version of these assertions would pass against an endpoint with no
 * scoping at all. Each restricted case is paired with a positive control.
 *
 * The load-bearing assertion is that an OUT-OF-SCOPE instrument contributes
 * nothing to `max`. It is seeded with a value so extreme that its inclusion could
 * not be mistaken for anything else — an aggregate leaks silently, as a number
 * that is merely wrong, with no row on screen to point at.
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
let operator: Record<string, string>;

const s = Date.now();
const instruments: string[] = [];
let blockId = '';
let areaId = '';
let otherBlockId = '';
let inAreaId = '';
let elsewhereId = '';
let roleId = '';
let rolePermsBefore: string[] = [];

/** Unmistakable if it ever leaks into an aggregate. */
const LEAK_VALUE = 999;
const IN_SCOPE_VALUES = [20, 22, 24];

const SLOTS = { temperatureKeys: 'temperature', humidityKeys: 'humidity' };
let slotsBefore: { value: unknown; existed: boolean } = { value: null, existed: false };

interface AggregateBody {
  instrumentCount: number;
  series: {
    temperature: { ts: string; min: number; mean: number; max: number; instrumentCount: number }[];
    humidity: unknown[];
  };
  limits: { temperature: { min: number | null; max: number | null } | null };
  limitsMixed: { temperature: boolean };
}

async function createInstrument(code: string, flId: string | null) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { name: code, code, profileId: await fixtureProfileId('fixture:aggregate') },
  });
  expect(res.statusCode).toBe(201);
  const { id } = res.json() as { id: string };
  instruments.push(id);
  if (flId) await prisma.instrument.update({ where: { id }, data: { functionalLocationId: flId } });
  return id;
}

async function seed(instrumentId: string, values: number[]) {
  const base = Date.now() - 10 * 60_000;
  const rows = Prisma.join(values.map((v, i) => Prisma.sql`(
    ${instrumentId}, 'temperature', ${JSON.stringify(v)}::jsonb, 'number', ${new Date(base + i * 60_000)})`));
  await prisma.$executeRaw`
    INSERT INTO instrument_telemetry_history (instrument_id, key, value, value_type, ts)
    VALUES ${rows} ON CONFLICT (instrument_id, key, ts) DO NOTHING`;
}

async function aggregate(qs: string, headers = operator) {
  const res = await app.inject({ method: 'GET', url: `/api/instruments/telemetry-aggregate${qs}`, headers });
  expect(res.statusCode).toBe(200);
  return res.json() as AggregateBody;
}

const maxOf = (b: AggregateBody) => Math.max(...b.series.temperature.map((p) => p.max));

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };

  const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'telemetry-slots' } });
  slotsBefore = { value: existing?.configValue ?? null, existed: Boolean(existing) };
  await prisma.systemConfig.upsert({
    where: { configKey: 'telemetry-slots' },
    create: { configKey: 'telemetry-slots', configValue: SLOTS, configType: 'object' },
    update: { configValue: SLOTS },
  });

  const block = await prisma.functionalLocation.create({ data: { name: `agg-block-${s}`, type: 'BLOCK' } });
  blockId = block.id;
  const area = await prisma.functionalLocation.create({ data: { name: `agg-area-${s}`, type: 'AREA', parentId: blockId } });
  areaId = area.id;
  const other = await prisma.functionalLocation.create({ data: { name: `agg-other-${s}`, type: 'BLOCK' } });
  otherBlockId = other.id;

  inAreaId = await createInstrument(`AGG-IN-${s}`, areaId);
  elsewhereId = await createInstrument(`AGG-OUT-${s}`, otherBlockId);
  await seed(inAreaId, IN_SCOPE_VALUES);
  await seed(elsewhereId, [LEAK_VALUE, LEAK_VALUE, LEAK_VALUE]);

  const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
  roleId = role.id;
  rolePermsBefore = role.permissions as string[];
  await prisma.role.update({
    where: { id: roleId },
    data: { permissions: [...new Set([...rolePermsBefore, 'INSTRUMENT_READ'])] },
  });
  invalidateRolePermsCache('OPERATOR');

  // Scoped to the Block that holds only the in-scope instrument.
  await prisma.roleConfig.upsert({
    where: { role: 'OPERATOR' },
    create: { role: 'OPERATOR', instrumentScope: { locationIds: [blockId], instrumentIds: [] } as never },
    update: { instrumentScope: { locationIds: [blockId], instrumentIds: [] } as never },
  });

  operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
});

afterAll(async () => {
  if (instruments.length) {
    await prisma.$executeRaw`
      DELETE FROM instrument_telemetry_history WHERE instrument_id = ANY(${instruments}::text[])`;
  }
  await prisma.roleConfig.updateMany({ where: { role: 'OPERATOR' }, data: { instrumentScope: Prisma.DbNull } });
  if (roleId) {
    await prisma.role.update({ where: { id: roleId }, data: { permissions: rolePermsBefore as never } });
    invalidateRolePermsCache('OPERATOR');
  }
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  for (const id of instruments) {
    await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  }
  await prisma.functionalLocation.deleteMany({ where: { id: { in: [areaId, blockId, otherBlockId].filter(Boolean) } } });
  if (slotsBefore.existed) {
    await prisma.systemConfig.update({ where: { configKey: 'telemetry-slots' }, data: { configValue: slotsBefore.value as never } });
  } else {
    await prisma.systemConfig.deleteMany({ where: { configKey: 'telemetry-slots' } });
  }
  await app.close();
});

describe('telemetry aggregate — visibility', () => {
  it('an out-of-scope instrument contributes NOTHING to the aggregate', async () => {
    const body = await aggregate('?window=1h');
    expect(body.series.temperature.length).toBeGreaterThan(0);
    // 999 would be unmistakable. An aggregate leaks as a wrong NUMBER, with no row
    // on screen to point at, which is why this is asserted on the extreme.
    expect(maxOf(body)).toBeLessThan(LEAK_VALUE);
    expect(maxOf(body)).toBe(Math.max(...IN_SCOPE_VALUES));
  });

  it('the same window DOES include it for an unrestricted caller', async () => {
    // The control. Without it, an endpoint returning nothing at all would look
    // correct above.
    const body = await aggregate('?window=1h', auth);
    expect(maxOf(body)).toBe(LEAK_VALUE);
  });
});

describe('telemetry aggregate — selection', () => {
  it('a BLOCK selection covers its Areas', async () => {
    const body = await aggregate(`?window=1h&functionalLocationId=${blockId}`);
    expect(body.instrumentCount).toBe(1);
    expect(maxOf(body)).toBe(Math.max(...IN_SCOPE_VALUES));
  });

  it('a direct-only BLOCK selection excludes its Areas', async () => {
    // The block itself holds no instruments; everything is in its Area.
    const body = await aggregate(`?window=1h&functionalLocationId=${blockId}&functionalLocationDirect=true`);
    expect(body.instrumentCount).toBe(0);
    expect(body.series.temperature).toEqual([]);
  });

  it('naming a location the caller cannot see returns nothing, not everything', async () => {
    // The inversion that matters: a selection filter must NARROW within the scope,
    // never escape it.
    const body = await aggregate(`?window=1h&functionalLocationId=${otherBlockId}`);
    expect(body.instrumentCount).toBe(0);
    expect(body.series.temperature).toEqual([]);
  });
});

describe('telemetry aggregate — the numbers', () => {
  it('reports min, mean and max distinctly, and counts the instruments per bucket', async () => {
    const body = await aggregate('?window=1h');
    const p = body.series.temperature[0];
    expect(p.min).toBeLessThanOrEqual(p.mean);
    expect(p.mean).toBeLessThanOrEqual(p.max);
    // A NUMBER, not a BigInt: Postgres count() returns BigInt and JSON.stringify
    // throws on it, which would be a 500 at serialisation rather than at query
    // time. Reaching this assertion at all proves the conversion happened.
    expect(typeof p.instrumentCount).toBe('number');
    expect(p.instrumentCount).toBe(1);
  });

  it('does not claim mixed limits when nothing in the selection has any', async () => {
    // These fixtures carry no limit attributes. "These instruments have different
    // limits" would be untrue — they are unbounded, which is a different fact.
    const body = await aggregate('?window=1h');
    expect(body.limits.temperature).toBeNull();
    expect(body.limitsMixed.temperature).toBe(false);
  });

  it('reports a shared bound when every instrument agrees, and mixed when they do not', async () => {
    await prisma.instrumentAttribute.createMany({
      data: [
        { instrumentId: inAreaId, key: 'High Temperature Limit', value: '25' },
        { instrumentId: inAreaId, key: 'Low Temperature Limit', value: '15' },
      ],
    });
    const agreed = await aggregate('?window=1h');
    expect(agreed.limits.temperature).toEqual({ min: 15, max: 25 });
    expect(agreed.limitsMixed.temperature).toBe(false);

    // Add a second, DIFFERENTLY bounded instrument to the same scope.
    const second = await createInstrument(`AGG-IN2-${s}`, areaId);
    await seed(second, [21]);
    await prisma.instrumentAttribute.createMany({
      data: [
        { instrumentId: second, key: 'High Temperature Limit', value: '30' },
        { instrumentId: second, key: 'Low Temperature Limit', value: '15' },
      ],
    });
    const mixed = await aggregate('?window=1h');
    // No bound is offered, because drawing 25 across an instrument bounded at 30
    // would be a false claim about that instrument.
    expect(mixed.limits.temperature).toBeNull();
    expect(mixed.limitsMixed.temperature).toBe(true);
  });

  // Audit 2026-10-03, INGEST-9: the plant's gateway firmware QUOTES every
  // reading, and this query counted `jsonb_typeof = 'number'` alone — so the
  // gateway-fed instruments were missing from the trend card while the table
  // beside it showed them. One SQL definition of a reading now
  // (`NUMERIC_READING`), the same the range summaries use.
  it('a QUOTED number is a reading — it moves the max; a word still does not', async () => {
    const ts = new Date(Date.now() - 2 * 60_000);
    await prisma.$executeRaw`
      INSERT INTO instrument_telemetry_history (instrument_id, key, value, value_type, ts)
      VALUES (${inAreaId}, 'temperature', '"26.5"'::jsonb, 'string', ${ts}),
             (${inAreaId}, 'temperature', '"hello"'::jsonb, 'string', ${new Date(ts.getTime() + 1000)})
      ON CONFLICT (instrument_id, key, ts) DO NOTHING`;
    const body = await aggregate('?window=1h');
    expect(maxOf(body)).toBe(26.5);
    // LAST, deliberately: the max it asserts would fail every test above that
    // pins the max at 24.
  });
});

/**
 * `GET /api/alarms?functionalLocationId=` — the dashboard alarm widget's feed.
 *
 * Lives here rather than in its own file because it shares this file's fixtures:
 * one instrument the OPERATOR may see, one it may not, in different Blocks. The
 * inversion that matters is the same one — a selection filter must NARROW within
 * the caller's scope, never escape it.
 */
describe('alarms — location filter', () => {
  const alarms = async (qs: string, headers = operator) => {
    const res = await app.inject({ method: 'GET', url: `/api/alarms${qs}`, headers });
    expect(res.statusCode).toBe(200);
    return (res.json() as { data: { instrumentId: string }[] }).data;
  };

  beforeAll(async () => {
    const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
    await prisma.role.update({
      where: { id: role.id },
      data: { permissions: [...new Set([...(role.permissions as string[]), 'ALARM_READ'])] },
    });
    invalidateRolePermsCache('OPERATOR');

    // One alarm on each instrument, so "did the filter work" and "did the scope
    // hold" are distinguishable.
    for (const instrumentId of [inAreaId, elsewhereId]) {
      await prisma.alarm.create({
        data: {
          instrumentId, metric: 'TEMPERATURE', severity: 'CRITICAL', state: 'ACTIVE',
          source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH', triggeredValue: 99,
          // ruleSnapshot is NOT NULL and carries what the record was judged
          // against; the tag is how afterAll finds these rows again, since Alarm
          // has no free-text column.
          ruleSnapshot: { fixture: `agg-e2e-${s}` },
          raisedAt: new Date(),
        } as never,
      });
    }
  });

  afterAll(async () => {
    await prisma.alarm.deleteMany({
      where: { ruleSnapshot: { equals: { fixture: `agg-e2e-${s}` } } },
    });
  });

  it('narrows to the named location', async () => {
    const rows = await alarms(`?state=ACTIVE&functionalLocationId=${blockId}`);
    expect(rows.map((a) => a.instrumentId)).toContain(inAreaId);
    expect(rows.map((a) => a.instrumentId)).not.toContain(elsewhereId);
  });

  it('a BLOCK covers its Areas', async () => {
    // The instrument sits in the Area, not on the Block itself. Querying
    // functionalLocationId directly would silently return nothing.
    expect((await alarms(`?state=ACTIVE&functionalLocationId=${blockId}`)).length).toBeGreaterThan(0);
  });

  it('naming a location the caller cannot see returns nothing, not everything', async () => {
    const rows = await alarms(`?state=ACTIVE&functionalLocationId=${otherBlockId}`);
    expect(rows.map((a) => a.instrumentId)).not.toContain(elsewhereId);
    expect(rows).toEqual([]);
  });

  it('without the filter the caller still sees only their own scope', async () => {
    // The control on the other side: removing the filter must not remove the scope.
    const rows = await alarms('?state=ACTIVE');
    expect(rows.map((a) => a.instrumentId)).not.toContain(elsewhereId);
  });

  it('an unrestricted caller sees the out-of-scope alarm', async () => {
    // And the control that proves the fixture alarm exists at all.
    const rows = await alarms('?state=ACTIVE', auth);
    expect(rows.map((a) => a.instrumentId)).toContain(elsewhereId);
  });
});
