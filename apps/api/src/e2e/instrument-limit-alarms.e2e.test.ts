import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
    expect(alarms[0].ruleId).toBeNull();
    expect(alarms[0].triggeredValue).toBe(26.4);
    expect((alarms[0].ruleSnapshot as Record<string, unknown>).limit).toBe(25);
  });

  it('does not raise a second alarm while still breaching', async () => {
    await pushReading(27.0);
    await evaluateAlarms();
    expect(await prisma.alarm.count({ where: { instrumentId } })).toBe(1);
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
