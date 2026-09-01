import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { evaluateAlarms } from '../workers/alarm-evaluation.worker.js';

/**
 * End-to-end proof for instrument-limit alarms — the whole point of this feature: an
 * instrument's own attributes (not a configured rule) raise, hold, and clear an alarm,
 * and the historical record freezes the limit it actually fired against.
 *
 * Spec: docs/superpowers/specs/2026-08-17-instrument-limit-alarms-design.md
 */

let app: FastifyInstance;
let auth: Record<string, string>;
let token: string;
let instrumentId = '';

beforeAll(async () => {
  app = await buildApp();
  token = await loginAs(app);
  auth = { authorization: `Bearer ${token}` };

  const inst = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: {
      name: 'Limit e2e probe', code: `LIMIT-E2E-${Date.now()}`,
      profileId: await fixtureProfileId('fixture:instrument-limit-alarms'),
    },
  });
  expect(inst.statusCode).toBe(201);
  instrumentId = inst.json().id;

  await prisma.instrumentAttribute.createMany({
    data: [
      { instrumentId, key: 'High Temperature Limit', value: '25' },
      { instrumentId, key: 'Low Temperature Limit', value: '18' },
    ],
  });
});

afterAll(async () => {
  // Alarm and instrument-attribute rows are scoped to OUR OWN instrumentId only — this
  // suite runs against a shared test DB with other files' fixtures live at the same time.
  if (instrumentId) {
    await prisma.alarm.deleteMany({ where: { instrumentId } });
    // InstrumentAttribute cascades on instrument delete, but drop it explicitly first
    // for clarity and so a failed instrument delete doesn't strand the alarms' FK target.
    await prisma.instrumentAttribute.deleteMany({ where: { instrumentId } });
    await app.inject({ method: 'DELETE', url: `/api/instruments/${instrumentId}`, headers: auth });
  }
  await app.close();
});

/**
 * `instrumentTelemetryLatest`'s `value` column is Json and `valueType` is required —
 * omitting `valueType` fails the insert, and asNumber() downstream ignores a non-numeric
 * Json value. `instrumentId_key` is Prisma's default name for the `[instrumentId, key]`
 * compound id declared on the model.
 */
async function pushReading(value: number) {
  await prisma.instrumentTelemetryLatest.upsert({
    where: { instrumentId_key: { instrumentId, key: 'temperature' } },
    create: { instrumentId, key: 'temperature', value, valueType: 'number', ts: new Date() },
    update: { value, valueType: 'number', ts: new Date() },
  });
  await prisma.instrument.update({ where: { id: instrumentId }, data: { lastSeenAt: new Date() } });
}

describe('instrument-limit alarms (e2e)', () => {
  it('raises exactly one HIGH alarm with the frozen limit', async () => {
    await pushReading(26.4);
    await evaluateAlarms();

    const alarms = await prisma.alarm.findMany({ where: { instrumentId } });
    expect(alarms).toHaveLength(1);
    expect(alarms[0].source).toBe('INSTRUMENT_LIMIT');
    expect(alarms[0].limitKind).toBe('HIGH');
    expect(alarms[0].triggeredValue).toBe(26.4);
    expect((alarms[0].ruleSnapshot as Record<string, unknown>).limit).toBe(25);
  });

  it('does not raise a second alarm while still breaching', async () => {
    await pushReading(27.0);
    await evaluateAlarms();
    expect(await prisma.alarm.count({ where: { instrumentId } })).toBe(1);
  });

  it('freezes the limit on an alarm that is still ACTIVE and still breaching', async () => {
    // The alarm raised in test 1 is still ACTIVE and still breaching (the most recent
    // reading is 27.0 from the previous test, against a limit of 25). Lower the limit
    // to 20 -- the reading STILL breaches the new limit, so this is the combination the
    // worker's own logic gives no write path for: raise needs `!existingId` (there IS
    // one), clear needs `!breaching` (it's still breaching). Neither branch fires. This
    // is the exact scenario the previous version of this test skipped past, by only
    // ever changing the limit after the alarm had already CLEARED -- the inspector's
    // real question is "why does this OPEN alarm still say 25 when the config now says
    // 20?", not "does a cleared row stay put".
    await prisma.instrumentAttribute.updateMany({
      where: { instrumentId, key: 'High Temperature Limit' },
      data: { value: '20' },
    });
    await evaluateAlarms();

    expect(await prisma.alarm.count({ where: { instrumentId } })).toBe(1);
    const alarm = await prisma.alarm.findFirstOrThrow({ where: { instrumentId } });
    expect(alarm.state).toBe('ACTIVE');

    const res = await app.inject({
      method: 'GET',
      url: `/api/alarms?instrumentId=${instrumentId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().data[0];
    // Frozen at raise time, against the limit that was live then -- not the 20 that's
    // live now.
    expect(row.ruleSnapshot.limit).toBe(25);
    expect(row.limitKind).toBe('HIGH');
    expect(row.state).toBe('ACTIVE');

    // Restore, so the next test's clear scenario (a reading of 22.0) isn't still
    // breaching against a limit of 20.
    await prisma.instrumentAttribute.updateMany({
      where: { instrumentId, key: 'High Temperature Limit' },
      data: { value: '25' },
    });
  });

  it('clears with the value that brought it back in spec, leaving acknowledgement alone', async () => {
    await pushReading(22.0);
    await evaluateAlarms();

    const alarm = await prisma.alarm.findFirstOrThrow({ where: { instrumentId } });
    expect(alarm.state).toBe('CLEARED');
    expect(alarm.clearedValue).toBe(22.0);
    expect(alarm.acknowledgedAt).toBeNull();
  });

  it('reports the frozen limit through the API even after the attribute changes', async () => {
    // Raise the limit to 99 — 26.4 breached the OLD limit (25) but is in spec under
    // the new one. Then feed a reading that would have breached the old limit but not
    // the new one, and run a REAL evaluation pass against it. Without a pass in between,
    // this test would only prove a JSONB column doesn't spontaneously mutate on an
    // unrelated UPDATE — asserting nothing about the freezing behaviour itself.
    await prisma.instrumentAttribute.updateMany({
      where: { instrumentId, key: 'High Temperature Limit' },
      data: { value: '99' },
    });
    await pushReading(26.4);
    await evaluateAlarms();

    // Nothing should raise: 26.4 is in spec against the new 99 limit. A new row here
    // would mean the pass re-evaluated against a limit this alarm never actually saw.
    expect(await prisma.alarm.count({ where: { instrumentId } })).toBe(1);

    const res = await app.inject({
      method: 'GET',
      url: `/api/alarms?instrumentId=${instrumentId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().data[0];
    // The snapshot answers "why did this fire at 25?", not the live attribute — this is
    // the exact question a 21 CFR inspector asks about a historical excursion.
    expect(row.ruleSnapshot.limit).toBe(25);
    expect(row.ruleSnapshot.attributeKey).toBe('High Temperature Limit');
    expect(row.limitKind).toBe('HIGH');
    expect(row.clearedValue).toBe(22.0);
  });

  // A null reading HOLDING an open alarm (rather than clearing it) is already covered by
  // apps/api/src/workers/__tests__/alarm-limit-hold.test.ts at the worker level — not
  // repeated here, since it would not discriminate anything this file doesn't already.
});

/**
 * Per-bound enable flags — `Enable_Temp_NMT` and friends.
 *
 * The behaviour these pin was worth a feature on its own: an instrument here can
 * carry `High Humidity Limit = 0` meaning "humidity is not judged", and a 0 is a
 * REAL bound to this system. When this was written, 17 CRITICAL alarms were open
 * at 44-50 %RH against exactly that, on instruments whose own
 * `Enable_Humid_NMT = 0` already said the bound was not in force. Nothing read
 * the flag.
 *
 * NMT = "not more than" (the high bound), NLT = "not less than" (the low one) —
 * the plant's vocabulary, not ours. Mapping them the wrong way round would
 * disable the opposite bound silently, which is why the mapping is asserted in
 * `alarm-limits.test.ts` as well.
 */
describe('per-bound enable flags', () => {
  const setFlag = async (key: string, value: string) => {
    await prisma.instrumentAttribute.upsert({
      where: { instrumentId_key: { instrumentId, key } },
      create: { instrumentId, key, value },
      update: { value },
    });
  };
  const dropFlag = (key: string) =>
    prisma.instrumentAttribute.deleteMany({ where: { instrumentId, key } });

  const openHigh = () => prisma.alarm.findMany({
    where: { instrumentId, source: 'INSTRUMENT_LIMIT', metric: 'TEMPERATURE', limitKind: 'HIGH', state: 'ACTIVE' },
  });

  beforeEach(async () => {
    await prisma.alarm.deleteMany({ where: { instrumentId } });
    await dropFlag('Enable_Temp_NMT');
    await dropFlag('Enable_Temp_NLT');
    // Pin the BOUNDS as well as the flags. The test above this one leaves
    // `High Temperature Limit` at 99 to prove the frozen-snapshot behaviour, and
    // a block that inherited it would silently test nothing — every reading
    // would be in spec and every "raises" assertion would fail for the wrong
    // reason. Depending on file order is how a suite starts passing vacuously.
    await prisma.instrumentAttribute.updateMany({
      where: { instrumentId, key: 'High Temperature Limit' }, data: { value: '25' },
    });
    await prisma.instrumentAttribute.updateMany({
      where: { instrumentId, key: 'Low Temperature Limit' }, data: { value: '18' },
    });
  });

  it('raises nothing on a bound whose flag is 0, however far it is crossed', async () => {
    await setFlag('Enable_Temp_NMT', '0');
    await pushReading(99);
    await evaluateAlarms();
    expect(await openHigh()).toHaveLength(0);
  });

  it('still raises when the flag is 1', async () => {
    await setFlag('Enable_Temp_NMT', '1');
    await pushReading(26.4);
    await evaluateAlarms();
    expect(await openHigh()).toHaveLength(1);
  });

  it('accepts the word form the live data also holds', async () => {
    await setFlag('Enable_Temp_NMT', 'True');
    await pushReading(26.4);
    await evaluateAlarms();
    expect(await openHigh()).toHaveLength(1);
  });

  it('treats an ABSENT flag as enabled', async () => {
    // A monitoring system fails toward alarming, and this keeps every instrument
    // that predates the flags behaving exactly as it did.
    await pushReading(26.4);
    await evaluateAlarms();
    expect(await openHigh()).toHaveLength(1);
  });

  it('treats an unreadable flag as enabled', async () => {
    await setFlag('Enable_Temp_NMT', 'perhaps');
    await pushReading(26.4);
    await evaluateAlarms();
    expect(await openHigh()).toHaveLength(1);
  });

  it('gates each bound INDEPENDENTLY — disabling high leaves low alarming', async () => {
    await setFlag('Enable_Temp_NMT', '0');
    await setFlag('Enable_Temp_NLT', '1');
    await pushReading(5); // below the 18 low limit, above nothing
    await evaluateAlarms();
    const low = await prisma.alarm.findMany({
      where: { instrumentId, source: 'INSTRUMENT_LIMIT', limitKind: 'LOW', state: 'ACTIVE' },
    });
    expect(low).toHaveLength(1);
    expect(await openHigh()).toHaveLength(0);
  });

  it('CLEARS an alarm already open on a bound that is switched off', async () => {
    // The operator's decision, 2026-08-31, and a deliberate departure from the
    // rule that a config change never closes a regulated record. Those 17
    // humidity alarms could never clear on their own — the reading they waited
    // for (below 0 %RH) cannot occur — so leaving them open asserts an ongoing
    // excursion that is not real and keeps the page permanently red.
    await setFlag('Enable_Temp_NMT', '1');
    await pushReading(26.4);
    await evaluateAlarms();
    expect(await openHigh()).toHaveLength(1);

    await setFlag('Enable_Temp_NMT', '0');
    await evaluateAlarms();
    expect(await openHigh()).toHaveLength(0);

    const [closed] = await prisma.alarm.findMany({
      where: { instrumentId, source: 'INSTRUMENT_LIMIT', metric: 'TEMPERATURE', limitKind: 'HIGH' },
      orderBy: { raisedAt: 'desc' }, take: 1,
    });
    expect(closed.state).toBe('CLEARED');
    expect(closed.clearedAt).not.toBeNull();
    // History closed, not erased: what it fired at is still on the record.
    expect(Number(closed.triggeredValue)).toBeCloseTo(26.4, 5);
    // And the signature is still owed — clearing never signs for anything.
    expect(closed.acknowledgedAt).toBeNull();
  });

  it('clears a disabled bound even while the reading is still breaching', async () => {
    // The clear is not "returned to spec" — the reading has not moved. The bound
    // simply is not being enforced any more.
    await setFlag('Enable_Temp_NMT', '1');
    await pushReading(99);
    await evaluateAlarms();
    expect(await openHigh()).toHaveLength(1);

    await setFlag('Enable_Temp_NMT', '0');
    await evaluateAlarms();
    expect(await openHigh()).toHaveLength(0);
  });

  it('re-raises if the bound is switched back on and still breaching', async () => {
    await setFlag('Enable_Temp_NMT', '0');
    await pushReading(99);
    await evaluateAlarms();
    expect(await openHigh()).toHaveLength(0);

    await setFlag('Enable_Temp_NMT', '1');
    await evaluateAlarms();
    expect(await openHigh()).toHaveLength(1);
  });
});
