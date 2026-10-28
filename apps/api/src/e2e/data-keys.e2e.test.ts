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

describe('POST /api/instruments/latest-values', () => {
  let a: string;
  let b: string;
  let c: string;
  let d: string;
  let e: string;
  let f: string;
  /** The overview's own precision for C's temperature — the number the route must echo. */
  let cDecimals: number;

  beforeAll(async () => {
    a = await createInstrument(`LV-A-${s}`);
    b = await createInstrument(`LV-B-${s}`);
    c = await createInstrument(`LV-C-${s}`);
    d = await createInstrument(`LV-D-${s}`);
    e = await createInstrument(`LV-E-${s}`);
    f = await createInstrument(`LV-F-${s}`);
    await reading(a, 'p', 101.333, at(0));
    await reading(b, 'p', 5, at(0));
    await reading(c, 't', 21.5, at(1));
    await reading(d, 't', 'NA', at(1));
    await reading(e, 'T', 20, at(1));
    await reading(f, 't', 1, at(1));
    await reading(f, 'temperature', 2, at(1));
    await prisma.instrumentAttribute.createMany({
      data: [
        { instrumentId: a, key: 'Firmware', value: '1.2' },
        { instrumentId: a, key: offsetKey, value: '0.5' },
        { instrumentId: c, key: highKey, value: '27' },
        { instrumentId: c, key: lowKey, value: '18' },
      ],
    });
    const ov = await app.inject({ method: 'GET', url: '/api/instruments/telemetry-overview', headers: auth });
    const row = (ov.json().data as { instrumentId: string; decimals: { temperature: number } }[])
      .find((r) => r.instrumentId === c)!;
    cDecimals = row.decimals.temperature;
  });

  async function latest(body: unknown, headers = auth) {
    return app.inject({ method: 'POST', url: '/api/instruments/latest-values', headers, payload: body as object });
  }
  const tel = (key: string) => ({ source: 'telemetry' as const, key });
  const attr = (key: string) => ({ source: 'attribute' as const, key });
  const valueOf = (body: { data: any[] }, id: string, key: string) =>
    body.data.find((r) => r.instrumentId === id)!.values.find((v: any) => v.key === key);

  it('a raw key returns its value as stored and is not judged', async () => {
    const res = await latest({ instrumentIds: [a], keys: [tel('p')] });
    expect(res.statusCode).toBe(200);
    const row = res.json().data[0];
    expect(row).toMatchObject({
      instrumentId: a, code: `LV-A-${s}`, name: `LV-A-${s}`,
      functionalLocationName: null, locationAttribute: null, reporting: expect.any(Boolean),
    });
    expect(row.values).toEqual([{
      source: 'telemetry', key: 'p', value: 101.333, ts: at(0).toISOString(),
      unit: null, decimals: null, display: null, judged: null,
    }]);
  });

  it('a measured key returns the server\'s precision, unit and bounds', async () => {
    const v = valueOf((await latest({ instrumentIds: [c], keys: [tel('t')] })).json(), c, 't');
    expect(v).toEqual({
      source: 'telemetry', key: 't', value: 21.5, ts: at(1).toISOString(),
      unit: temperatureType.unit, decimals: cDecimals, display: null,
      judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false },
    });
  });

  it('a sensor fault is flagged, not hidden', async () => {
    const v = valueOf((await latest({ instrumentIds: [d], keys: [tel('t')] })).json(), d, 't');
    expect(v.value).toBe('NA');
    expect(v.judged.sensorError).toBe(true);
  });

  it('alias match folds case', async () => {
    const v = valueOf((await latest({ instrumentIds: [e], keys: [tel('T')] })).json(), e, 'T');
    expect(v.value).toBe(20);
    expect(v.judged).not.toBeNull();
  });

  it('only the resolved alias is judged', async () => {
    // Default alias order is `temperature, temp, t` — `temperature` wins.
    const body = (await latest({ instrumentIds: [f], keys: [tel('t'), tel('temperature')] })).json();
    expect(valueOf(body, f, 'temperature').judged).not.toBeNull();
    expect(valueOf(body, f, 't').judged).toBeNull();
    expect(valueOf(body, f, 't').decimals).toBeNull();
  });

  it('a key never sent returns null, and values keep the requested order', async () => {
    const values = (await latest({ instrumentIds: [a], keys: [tel('nope'), tel('p')] })).json().data[0].values;
    expect(values.map((v: any) => v.key)).toEqual(['nope', 'p']);
    expect(values[0]).toMatchObject({ value: null, ts: null, judged: null });
  });

  it('attributes return their value and the server\'s display', async () => {
    const body = (await latest({ instrumentIds: [a, c], keys: [attr('firmware'), attr(highKey)] })).json();
    expect(valueOf(body, a, 'firmware')).toMatchObject({
      source: 'attribute', value: '1.2', display: null, judged: null, unit: null, decimals: null,
    });
    expect(valueOf(body, a, 'firmware').ts).toEqual(expect.any(String));
    // A limit is shown at the precision of the reading it bounds.
    expect(valueOf(body, c, highKey).display).toBe((27).toFixed(cDecimals));
  });

  it('offset keys are absent for a non-super-admin', async () => {
    expect(valueOf((await latest({ instrumentIds: [a], keys: [attr(offsetKey)] })).json(), a, offsetKey).value).toBe('0.5');
    await asScopedOperator([a], async (operator) => {
      const v = valueOf((await latest({ instrumentIds: [a], keys: [attr(offsetKey)] }, operator)).json(), a, offsetKey);
      expect(v).toMatchObject({ value: null, ts: null });
    });
  });

  it('an out-of-scope instrument is absent, never 403', async () => {
    await asScopedOperator([a], async (operator) => {
      const both = await latest({ instrumentIds: [a, b], keys: [tel('p')] }, operator);
      expect(both.statusCode).toBe(200);
      expect(both.json().data.map((r: any) => r.instrumentId)).toEqual([a]);
      const hidden = await latest({ instrumentIds: [b], keys: [tel('p')] }, operator);
      expect(hidden.statusCode).toBe(200);
      expect(hidden.json()).toEqual({ data: [] });
    });
    expect((await latest({ instrumentIds: [a, b], keys: [tel('p')] })).json().data).toHaveLength(2);
  });

  it('the body is validated', async () => {
    expect((await latest({ instrumentIds: [], keys: [tel('p')] })).statusCode).toBe(400);
    expect((await latest({ instrumentIds: [a], keys: Array(21).fill(tel('p')) })).statusCode).toBe(400);
    expect((await latest({ instrumentIds: [a], keys: [{ source: 'other', key: 'p' }] })).statusCode).toBe(400);
  });
});

describe('keys on the history routes', () => {
  let a: string;

  beforeAll(async () => {
    a = await createInstrument(`HK-A-${s}`);
    await reading(a, 't', 21.5, at(0));
    await reading(a, 'h', 50, at(0));
    await reading(a, 'p', 101, at(0));
    await reading(a, 'p', 'NA', at(1));
    await reading(a, 'p', 102, at(2));
  });

  const range = `from=${at(-10).toISOString()}&to=${at(30).toISOString()}`;

  it('telemetry-history filters by keys', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/instruments/telemetry-history?instrumentIds=${a}&keys=t&${range}`, headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { ts: string; values: Record<string, unknown> }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].values).toEqual({ t: 21.5 });
  });

  it('/:id/telemetry chart path charts only the asked keys', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/instruments/${a}/telemetry?keys=p,t&points=100&${range}`, headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      summaries: Record<string, { count: number; numericCount: number; limitMin: number | null; belowCount: number | null }>;
      history: { key: string }[];
    };
    expect(Object.keys(body.summaries).sort()).toEqual(['p', 't']);
    expect(body.summaries.p.limitMin).toBeNull();
    expect(body.summaries.p.belowCount).toBeNull();
    // "N text readings not plotted" is count - numericCount.
    expect(body.summaries.p.count - body.summaries.p.numericCount).toBe(1);
    expect(new Set(body.history.map((r) => r.key))).toEqual(new Set(['p', 't']));
  });

  it('/:id/telemetry table path filters by keys', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/instruments/${a}/telemetry?keys=p&${range}`, headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { history: { key: string }[]; historyTotal: number };
    expect(body.historyTotal).toBe(3);
    expect(body.history.every((r) => r.key === 'p')).toBe(true);
  });

  it('key and keys together is a 400, and so is a bad keys list', async () => {
    const both = await app.inject({ method: 'GET', url: `/api/instruments/${a}/telemetry?key=p&keys=t`, headers: auth });
    expect(both.statusCode).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => `k${i}`).join(',');
    const tooMany = await app.inject({ method: 'GET', url: `/api/instruments/${a}/telemetry?keys=${many}`, headers: auth });
    expect(tooMany.statusCode).toBe(400);
    const multi = await app.inject({
      method: 'GET', url: `/api/instruments/telemetry-history?instrumentIds=${a}&keys=${many}`, headers: auth,
    });
    expect(multi.statusCode).toBe(400);
  });
});
