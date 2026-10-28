import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { coerceProfileMeasurements, ATTRIBUTE_LABELS_CONFIG_KEY, type DataKeyInfo } from '@digilog/shared';
import { prisma } from '../lib/prisma.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * Widget data keys, phase 1 (2026-10-28): the server lists every key a set of
 * instruments has SENT (telemetry) or CARRIES (attributes), with no configuration
 * step for a new key. Spec: docs/superpowers/specs/2026-10-28-widget-data-keys-design.md.
 *
 * Asserted over HTTP (`app.inject`): Fastify strips any response field the
 * schema does not declare, and several here are nested.
 *
 * Every seeded instant is near now — `instrument_telemetry_history` is
 * partitioned by `ts` and the test database only carries partitions around now.
 */

let app: FastifyInstance;
let auth: Record<string, string>;
let profileId: string;
/** The fixture profile's own temperature offset / limit attribute keys — read, never hardcoded. */
let offsetKey: string;
let highKey: string;
let lowKey: string;
let temperatureType: { name: string; unit: string };
let labelsBefore: Prisma.JsonValue | null = null;
let labelsExisted = false;
const createdInstruments: string[] = [];
const createdLocations: string[] = [];
const s = Date.now();
const t0 = Date.now() - 2 * 3_600_000;
const at = (min: number) => new Date(t0 + min * 60_000);

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  profileId = await fixtureProfileId('fixture:data-keys');
  const profile = await prisma.instrumentProfile.findUniqueOrThrow({ where: { id: profileId } });
  const temp = coerceProfileMeasurements(profile.measurements).find((m) => m.code === 'TEMPERATURE')!;
  offsetKey = temp.offsetKeys[0];
  highKey = temp.high.limitKeys[0];
  lowKey = temp.low.limitKeys[0];
  temperatureType = await prisma.measurementType.findUniqueOrThrow({
    where: { code: 'TEMPERATURE' }, select: { name: true, unit: true },
  });
  const labels = await prisma.systemConfig.findUnique({ where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY } });
  labelsExisted = labels !== null;
  labelsBefore = labels?.configValue ?? null;
});

afterAll(async () => {
  // The shared config row FIRST, each step guarded on its own: a suite must
  // hand back what it touched even while it is failing.
  try {
    if (labelsExisted) {
      await prisma.systemConfig.update({
        where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY },
        data: { configValue: labelsBefore as Prisma.InputJsonValue },
      });
    } else {
      await prisma.systemConfig.deleteMany({ where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY } });
    }
  } catch { /* reported by the assertions that depended on it */ }
  for (const id of createdInstruments) {
    try { await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth }); } catch { /* next */ }
  }
  try {
    await prisma.$executeRaw`DELETE FROM instrument_telemetry_latest WHERE instrument_id IN (${Prisma.join(createdInstruments.length ? createdInstruments : ['-'])})`;
  } catch { /* next */ }
  for (const id of [...createdLocations].reverse()) {
    try { await prisma.functionalLocation.delete({ where: { id } }); } catch { /* next */ }
  }
  await app.close();
});

async function createInstrument(code: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { name: code, code, profileId },
  });
  expect(res.statusCode).toBe(201);
  const { id } = res.json() as { id: string };
  createdInstruments.push(id);
  return id;
}

/** One reading into BOTH tables, as ingest leaves them. */
async function reading(instrumentId: string, key: string, value: unknown, ts: Date) {
  const valueType = typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : typeof value === 'boolean' ? 'boolean' : 'string';
  await prisma.$executeRaw`
    INSERT INTO instrument_telemetry_history (instrument_id, key, value, value_type, ts)
    VALUES (${instrumentId}, ${key}, ${JSON.stringify(value)}::jsonb, ${valueType}, ${ts})
    ON CONFLICT (instrument_id, key, ts) DO NOTHING`;
  await prisma.$executeRaw`
    INSERT INTO instrument_telemetry_latest (instrument_id, key, value, value_type, ts)
    VALUES (${instrumentId}, ${key}, ${JSON.stringify(value)}::jsonb, ${valueType}, ${ts})
    ON CONFLICT (instrument_id, key) DO UPDATE SET value = EXCLUDED.value, value_type = EXCLUDED.value_type, ts = EXCLUDED.ts`;
}

async function keys(qs: string, headers = auth) {
  return app.inject({ method: 'GET', url: `/api/instruments/data-keys?${qs}`, headers });
}

const entry = (body: { data: DataKeyInfo[] }, source: string, key: string) =>
  body.data.find((e) => e.source === source && e.key === key);

/**
 * Run `fn` as the seeded OPERATOR, granted INSTRUMENT_READ and scoped to the
 * named instruments — and put the role back exactly as it was, whatever `fn` does.
 */
async function asScopedOperator(instrumentIds: string[], fn: (headers: Record<string, string>) => Promise<void>) {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
  const permsBefore = role.permissions as string[];
  const cfgBefore = await prisma.roleConfig.findUnique({ where: { role: 'OPERATOR' }, select: { instrumentScope: true } });
  await prisma.role.update({ where: { id: role.id }, data: { permissions: [...new Set([...permsBefore, 'INSTRUMENT_READ'])] } });
  invalidateRolePermsCache('OPERATOR');
  const scope = { locationIds: [] as string[], instrumentIds };
  await prisma.roleConfig.upsert({
    where: { role: 'OPERATOR' },
    create: { role: 'OPERATOR', instrumentScope: scope as never },
    update: { instrumentScope: scope as never },
  });
  try {
    await fn({ authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` });
  } finally {
    await prisma.roleConfig.updateMany({
      where: { role: 'OPERATOR' },
      data: { instrumentScope: (cfgBefore?.instrumentScope ?? Prisma.DbNull) as never },
    });
    await prisma.role.update({ where: { id: role.id }, data: { permissions: permsBefore as never } });
    invalidateRolePermsCache('OPERATOR');
  }
}

describe('GET /api/instruments/data-keys', () => {
  let a: string;
  let b: string;

  beforeAll(async () => {
    a = await createInstrument(`DK-A-${s}`);
    b = await createInstrument(`DK-B-${s}`);
    await reading(a, 'p', 101.3, at(0));
    await reading(a, 'p2', '21.5', at(1));
    await reading(a, 'state', 'RUN', at(2));
    await reading(a, 't', 21.5, at(3));
    await reading(b, 'p', 99.1, at(5));
    await reading(b, 'onlyB', 7, at(5));
    await prisma.instrumentAttribute.createMany({
      data: [
        { instrumentId: a, key: 'Firmware', value: '1.2' },
        { instrumentId: a, key: 'Blank', value: '  ' },
        { instrumentId: a, key: offsetKey, value: '0.5' },
      ],
    });
  });

  it('a key nobody configured appears with no config write', async () => {
    const res = await keys(`instrumentIds=${a}`);
    expect(res.statusCode).toBe(200);
    const p = entry(res.json(), 'telemetry', 'p');
    expect(p).toEqual({
      source: 'telemetry', key: 'p', label: 'p', numeric: true, instruments: 1,
      lastSeen: at(0).toISOString(), measurement: null,
    });
  });

  it('quoted numbers are numeric, words are not', async () => {
    const body = (await keys(`instrumentIds=${a}`)).json();
    expect(entry(body, 'telemetry', 'p2')!.numeric).toBe(true);
    expect(entry(body, 'telemetry', 'state')!.numeric).toBe(false);
  });

  it('a measured key is labelled by its measurement', async () => {
    const t = entry((await keys(`instrumentIds=${a}`)).json(), 'telemetry', 't')!;
    expect(t.measurement).toEqual({ code: 'TEMPERATURE', name: temperatureType.name, unit: temperatureType.unit });
    expect(t.label).toBe(temperatureType.name);
  });

  it('counts the instruments that carry each key', async () => {
    const body = (await keys(`instrumentIds=${a},${b}`)).json();
    expect(entry(body, 'telemetry', 'p')!.instruments).toBe(2);
    expect(entry(body, 'telemetry', 'p')!.lastSeen).toBe(at(5).toISOString());
    expect(entry(body, 'telemetry', 'onlyB')!.instruments).toBe(1);
  });

  it('attribute keys are listed under their display name; a blank one is not listed', async () => {
    await prisma.systemConfig.upsert({
      where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY },
      create: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY, configValue: { labels: { firmware: 'Firmware version' } }, configType: 'display' },
      update: { configValue: { ...((labelsBefore as object | null) ?? {}), labels: { firmware: 'Firmware version' } } },
    });
    const body = (await keys(`instrumentIds=${a}`)).json();
    expect(entry(body, 'attribute', 'Firmware')).toMatchObject({
      source: 'attribute', key: 'Firmware', label: 'Firmware version', numeric: false, instruments: 1, measurement: null,
    });
    expect(entry(body, 'attribute', 'Firmware')!.lastSeen).toEqual(expect.any(String));
    expect(entry(body, 'attribute', 'Blank')).toBeUndefined();
  });

  it('offset keys are listed for a super admin and absent for anyone else', async () => {
    expect(entry((await keys(`instrumentIds=${a}`)).json(), 'attribute', offsetKey)).toBeDefined();
    await asScopedOperator([a], async (operator) => {
      const res = await keys(`instrumentIds=${a}`, operator);
      expect(res.statusCode).toBe(200);
      expect(entry(res.json(), 'attribute', offsetKey)).toBeUndefined();
      expect(entry(res.json(), 'attribute', 'Firmware')).toBeDefined();
    });
  });

  it('an out-of-scope instrument is absent, never 403', async () => {
    await asScopedOperator([a], async (operator) => {
      const both = await keys(`instrumentIds=${a},${b}`, operator);
      expect(both.statusCode).toBe(200);
      expect(entry(both.json(), 'telemetry', 'onlyB')).toBeUndefined();
      expect(entry(both.json(), 'telemetry', 'p')!.instruments).toBe(1);
      const onlyHidden = await keys(`instrumentIds=${b}`, operator);
      expect(onlyHidden.statusCode).toBe(200);
      expect(onlyHidden.json()).toEqual({ data: [] });
    });
    // The positive control: the withholding is the scope's.
    expect(entry((await keys(`instrumentIds=${a},${b}`)).json(), 'telemetry', 'onlyB')).toBeDefined();
  });

  it('exactly one selector is required, and it is validated', async () => {
    // The route's OWN refusal, not the `/:id` route's uuid check a missing
    // route would fall into.
    const none = await keys('');
    expect(none.statusCode).toBe(400);
    expect(none.json().message).toMatch(/exactly one of/i);
    const two = await keys(`instrumentIds=${a}&profileId=${profileId}`);
    expect(two.statusCode).toBe(400);
    expect(two.json().message).toMatch(/exactly one of/i);
    expect((await keys('instrumentIds=not-a-uuid')).statusCode).toBe(400);
    // 201 DISTINCT ids — the route de-duplicates, so one id repeated is one id.
    const many = Array.from({ length: 201 }, () => randomUUID()).join(',');
    expect((await keys(`instrumentIds=${many}`)).statusCode).toBe(400);
  });

  it('a Block selects its Areas\' instruments; a profile selects the profile\'s', async () => {
    const block = await prisma.functionalLocation.create({ data: { name: `DK Block ${s}`, type: 'BLOCK' } });
    createdLocations.push(block.id);
    const area = await prisma.functionalLocation.create({ data: { name: `DK Area ${s}`, type: 'AREA', parentId: block.id } });
    createdLocations.push(area.id);
    await prisma.instrument.update({ where: { id: b }, data: { functionalLocationId: area.id } });
    const viaBlock = (await keys(`functionalLocationId=${block.id}`)).json();
    expect(entry(viaBlock, 'telemetry', 'onlyB')).toBeDefined();
    expect(entry(viaBlock, 'telemetry', 'state')).toBeUndefined();
    const viaProfile = (await keys(`profileId=${profileId}`)).json();
    expect(entry(viaProfile, 'telemetry', 'state')).toBeDefined();
    expect(entry(viaProfile, 'telemetry', 'onlyB')).toBeDefined();
    await prisma.instrument.update({ where: { id: b }, data: { functionalLocationId: null } });
  });

  it('GET /:id/telemetry-keys gains numeric and measurement', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/instruments/${a}/telemetry-keys`, headers: auth });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as { key: string; slot: string | null; numeric: boolean; measurement: { code: string } | null }[];
    expect(rows.find((r) => r.key === 'p')).toMatchObject({ slot: null, numeric: true, measurement: null });
    expect(rows.find((r) => r.key === 'state')).toMatchObject({ numeric: false });
    expect(rows.find((r) => r.key === 't')).toMatchObject({ slot: 'temperature', measurement: { code: 'TEMPERATURE' } });
  });
});

// Used by the latest-values block (Task 3).
void highKey; void lowKey;
