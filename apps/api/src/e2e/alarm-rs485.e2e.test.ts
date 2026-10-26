import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { setFixtureMeasurements } from '../test-support/fixture-measurements.js';
import { evaluateAlarms } from '../workers/alarm-evaluation.worker.js';
import { buildTelemetryOverview } from '../modules/instruments/telemetry-overview.js';

/**
 * RS485 sensor-failure alarms, driven through the REAL evaluation pass against
 * the real database — not through `decideRs485` alone, which is unit-tested next
 * door.
 *
 * What this file exists to catch is the WIRING, and it is written against four
 * specific failures:
 *
 *  1. **The clear path, which inverts the inactivity rule.** Here silence must
 *     HOLD an alarm open — you cannot prove a probe was repaired from the fact
 *     that it stopped talking — while inactivity clears on exactly that signal.
 *     A pass written by copying the inactivity pass would clear every RS485
 *     alarm the moment the broken logger fell quiet, which is when the fault is
 *     least resolved.
 *  2. **Two independent alarms.** A logger with both probes dead must hold two
 *     open rows. A unique index keyed on the instrument alone (as the inactivity
 *     one is) would let the first failure block the second from ever being
 *     recorded, and the omission is invisible until it happens in the plant.
 *  3. **The bad value must reach the record.** `triggeredValue` is a Float and
 *     cannot hold `NA`, so the evidence lives on the snapshot. If it were
 *     dropped, the Alarms page would show a failure with nothing to say what the
 *     sensor sent.
 *  4. **It must not be mistaken for a limit breach.** These alarms carry metric
 *     TEMPERATURE / HUMIDITY, the same values a limit alarm carries, and are
 *     distinguished only by `source`.
 *
 * `alarm-limits` and `inactivity-alarms` are both turned OFF for the duration, so
 * neither can add alarms this file would then have to explain. The telemetry slot
 * aliases are PINNED for the same reason the inactivity file pins the activity
 * window: unpinned, this would test whatever key mapping the test database
 * happens to carry rather than testing the code.
 */

const STAMP = Date.now();
const CODE = `RS485-E2E-${STAMP}`;

let instrumentId = '';
const KEY = 'rs485-alarms';
const LIMITS_KEY = 'alarm-limits';
const INACTIVITY_KEY = 'inactivity-alarms';
const before: Record<string, { value: unknown; existed: boolean }> = {};

async function setConfig(key: string, value: Record<string, unknown>) {
  await prisma.systemConfig.upsert({
    where: { configKey: key },
    create: { configKey: key, configValue: value, configType: 'object' },
    update: { configValue: value },
  });
}

/**
 * Put a value on the wire the way ingest does — straight into
 * `instrument_telemetry_latest`, which is what the overview reads.
 *
 * `valueType` is set the way `classifyValue()` would, because the pass carries it
 * onto the frozen snapshot and a wrong one here would hide a wrong one there.
 */
async function reading(key: string, value: unknown) {
  const valueType = typeof value === 'number'
    ? (Number.isInteger(value) ? 'int' : 'float')
    : typeof value === 'string' ? 'string' : typeof value === 'boolean' ? 'boolean' : 'json';
  await prisma.$executeRawUnsafe(
    `INSERT INTO instrument_telemetry_latest (instrument_id, key, value, value_type, ts)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (instrument_id, key) DO UPDATE SET
       value = EXCLUDED.value, value_type = EXCLUDED.value_type, ts = EXCLUDED.ts`,
    instrumentId, key, JSON.stringify(value), valueType,
  );
}

/** Remove the slot entirely — silence, as opposed to a bad value. */
async function clearReading(key: string) {
  await prisma.$executeRawUnsafe(
    `DELETE FROM instrument_telemetry_latest WHERE instrument_id = $1 AND key = $2`,
    instrumentId, key,
  );
}

const openAlarms = () => prisma.alarm.findMany({
  where: { instrumentId, source: 'RS485_FAILURE', state: 'ACTIVE' },
  orderBy: { metric: 'asc' },
});

const allAlarms = () => prisma.alarm.findMany({
  where: { instrumentId, source: 'RS485_FAILURE' },
  orderBy: { raisedAt: 'asc' },
});

const snapshotOf = (a: { ruleSnapshot: unknown }) => a.ruleSnapshot as Record<string, unknown>;

beforeAll(async () => {
  for (const key of [KEY, LIMITS_KEY, INACTIVITY_KEY]) {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: key } });
    before[key] = { value: row?.configValue ?? null, existed: Boolean(row) };
  }
  // This suite shares compliance_core_db_test; every key is restored verbatim in
  // afterAll.
  await setConfig(LIMITS_KEY, { ...(before[LIMITS_KEY].value as object ?? {}), enabled: false });
  await setConfig(INACTIVITY_KEY, { ...(before[INACTIVITY_KEY].value as object ?? {}), enabled: false });
  // The device keys live on the instrument's PROFILE since 2026-10-26 — this
  // file's own fixture profile, so nothing shared is touched.
  const profileId = await fixtureProfileId('fixture:alarm-rs485');
  await setFixtureMeasurements(profileId, (ms) => ms.map((m) => (
    m.code === 'TEMPERATURE' ? { ...m, deviceKeys: ['temperature', 'temp'] }
      : m.code === 'HUMIDITY' ? { ...m, deviceKeys: ['humidity', 'rh'] } : m)));

  const inst = await prisma.instrument.create({
    data: {
      name: `rs485 ${CODE}`,
      code: CODE,
      profileId,
    },
  });
  instrumentId = inst.id;
});

afterAll(async () => {
  // THE CONFIG RESTORE COMES FIRST, AND EVERY STEP IS INDEPENDENTLY GUARDED.
  //
  // This is not defensive habit — it is the fix for a real incident caused by
  // the first version of this file. Its fixture cleanup threw (a bad `::uuid`
  // cast on a text column), which aborted `afterAll` BEFORE the restore loop, so
  // `alarm-limits` was left disabled in the shared `compliance_core_db_test`.
  // Two unrelated suites then failed, and every subsequent run of this file read
  // the disabled value as its own "before" and faithfully restored it — the
  // corruption ratcheted itself in.
  //
  // The repo has been here before: `apps/api/CLAUDE.md` records a suite that
  // restored 2 of the 4 keys it wrote and silently broke three tests in
  // `user.service.test.ts`. Config a suite touches must be handed back even when
  // the suite itself is failing.
  for (const [key, prev] of Object.entries(before)) {
    try {
      if (prev.existed) {
        await prisma.systemConfig.update({
          where: { configKey: key },
          data: { configValue: prev.value as never },
        });
      } else {
        await prisma.systemConfig.deleteMany({ where: { configKey: key } });
      }
    } catch (e) {
      // Say so loudly rather than leaving the next suite to discover it.
      console.error(`[alarm-rs485.e2e] FAILED to restore ${key}:`, e);
    }
  }

  await prisma.alarm.deleteMany({ where: { instrumentId } }).catch(() => {});
  if (instrumentId) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM instrument_telemetry_latest WHERE instrument_id = $1`, instrumentId,
    ).catch(() => {});
    await prisma.instrument.delete({ where: { id: instrumentId } }).catch(() => {});
  }
});

beforeEach(async () => {
  await prisma.alarm.deleteMany({ where: { instrumentId } });
  // EVERY key, not just the two primary aliases. Clearing `temperature` and
  // `humidity` by name left the SECOND alias (`temp`, written by the alias test)
  // in the table, so the slot still resolved and the "goes silent" test was not
  // testing silence — it passed with the clear rule INVERTED. Found by mutation,
  // and the reason this is a wholesale delete.
  await prisma.$executeRawUnsafe(
    `DELETE FROM instrument_telemetry_latest WHERE instrument_id = $1`, instrumentId,
  );
  await setConfig(KEY, { enabled: true, severity: 'MAJOR' });
});

describe('the switch', () => {
  it('raises nothing while the feature is off', async () => {
    await setConfig(KEY, { enabled: false, severity: 'MAJOR' });
    await reading('temperature', 'NA');
    const result = await evaluateAlarms();
    expect(await openAlarms()).toHaveLength(0);
    expect(result.rs485Evaluated).toBe(0);
  });

  it('treats a config row that has never been written as ON', async () => {
    // The OPPOSITE of `inactivity-alarms`, and deliberately so: that one fails
    // closed because switching it on raises an alarm per silent instrument,
    // while this one only ever fires for a sensor actively reporting rubbish —
    // measured at zero instruments on this installation. A fault detector that
    // quietly defaults to off detects nothing.
    await prisma.systemConfig.deleteMany({ where: { configKey: KEY } });
    await reading('temperature', 'NA');
    await evaluateAlarms();
    expect(await openAlarms()).toHaveLength(1);
  });
});

describe('raising', () => {
  it('raises on a non-numeric temperature', async () => {
    await reading('temperature', 'NA');
    await evaluateAlarms();
    const open = await openAlarms();
    expect(open).toHaveLength(1);
    expect(open[0].metric).toBe('TEMPERATURE');
    expect(open[0].severity).toBe('MAJOR');
    // The column is a Float; the value that tripped this is not a number.
    expect(open[0].triggeredValue).toBeNull();
  });

  it('raises on a non-numeric humidity', async () => {
    await reading('humidity', 'NA');
    await evaluateAlarms();
    const open = await openAlarms();
    expect(open).toHaveLength(1);
    expect(open[0].metric).toBe('HUMIDITY');
  });

  it('raises TWO alarms when both probes have failed', async () => {
    // The behaviour this feature was asked for, and the reason the unique index
    // is keyed on (instrument_id, metric) rather than on the instrument alone.
    await reading('temperature', 'NA');
    await reading('humidity', 'NA');
    await evaluateAlarms();
    const open = await openAlarms();
    expect(open).toHaveLength(2);
    expect(open.map((a) => a.metric).sort()).toEqual(['HUMIDITY', 'TEMPERATURE']);
  });

  it('does NOT raise for a quoted number — it is a reading', async () => {
    // Reversed on operator instruction, 2026-08-31. The dashboard plots it and
    // the limits judge it, so raising a sensor fault for it would contradict
    // both. `coerceReading` is the one definition all three share.
    await reading('temperature', '23.5');
    await evaluateAlarms();
    expect(await openAlarms()).toHaveLength(0);
  });

  it('still raises for an empty string', async () => {
    await reading('temperature', '');
    await evaluateAlarms();
    expect(await openAlarms()).toHaveLength(1);
  });

  it('does not raise on a good reading, and 0 is a good reading', async () => {
    await reading('temperature', 21.5);
    await reading('humidity', 0);
    await evaluateAlarms();
    expect(await openAlarms()).toHaveLength(0);
  });

  it('does not raise for a slot the instrument never reports', async () => {
    // A temperature-only logger has no humidity key. Raising here would alarm
    // every such instrument for a probe it does not have.
    await reading('temperature', 21.5);
    await evaluateAlarms();
    expect(await openAlarms()).toHaveLength(0);
  });

  it('does not raise twice for one continuing fault', async () => {
    await reading('temperature', 'NA');
    await evaluateAlarms();
    await evaluateAlarms();
    await evaluateAlarms();
    expect(await allAlarms()).toHaveLength(1);
  });

  it('does not raise for a decommissioned instrument', async () => {
    await prisma.instrument.update({ where: { id: instrumentId }, data: { isActive: false } });
    try {
      await reading('temperature', 'NA');
      await evaluateAlarms();
      expect(await openAlarms()).toHaveLength(0);
    } finally {
      await prisma.instrument.update({ where: { id: instrumentId }, data: { isActive: true } });
    }
  });
});

describe('the record it writes', () => {
  it('freezes the offending value, its key and its type onto the snapshot', async () => {
    await reading('temperature', 'NA');
    await evaluateAlarms();
    const [a] = await openAlarms();
    const snap = snapshotOf(a);
    expect(snap.kind).toBe('RS485');
    expect(snap.metric).toBe('TEMPERATURE');
    expect(snap.rawValue).toBe('NA');
    expect(snap.valueType).toBe('string');
    expect(snap.key).toBe('temperature');
    expect(snap.description).toBe('temperature reported NA instead of a number');
  });

  it('sets the sensorError flag on the overview, which is what the dashboard renders', async () => {
    // The dashboard must not decide this for itself: `temperature` is null both
    // for a broken probe and for a slot with no reading, and the browser cannot
    // tell them apart. The server decides with the SAME predicate that raises
    // the alarm, so a cell can never contradict the alarm beside it.
    await reading('temperature', 'NA');
    const overview = await buildTelemetryOverview();
    const row = overview.find((r) => r.instrumentId === instrumentId)!;
    expect(row.sensorError.temperature).toBe(true);
    expect(row.sensorError.humidity).toBe(false);
    // And the numeric slot stays null, so nothing downstream plots a word.
    expect(row.temperature).toBeNull();
  });

  it('does NOT flag a slot that simply has no reading', async () => {
    // Silence is not a sensor failure; it keeps rendering NA on the dashboard.
    const overview = await buildTelemetryOverview();
    const row = overview.find((r) => r.instrumentId === instrumentId)!;
    expect(row.sensorError.temperature).toBe(false);
    expect(row.sensorError.humidity).toBe(false);
  });

  it('records the value from the alias that actually carried it', async () => {
    // `temp` is the second configured alias. The snapshot must name the key the
    // reading arrived on, or an engineer cannot find it on the device.
    await reading('temp', 'ERR');
    await evaluateAlarms();
    const [a] = await openAlarms();
    expect(snapshotOf(a).key).toBe('temp');
    expect(snapshotOf(a).rawValue).toBe('ERR');
  });

  it('keeps a non-string legible rather than writing [object Object]', async () => {
    await reading('temperature', { fault: 'bus' });
    await evaluateAlarms();
    const [a] = await openAlarms();
    expect(snapshotOf(a).rawValue).toBe('{"fault":"bus"}');
    expect(snapshotOf(a).valueType).toBe('json');
  });
});

describe('clearing — silence must NOT clear it', () => {
  it('clears when a number arrives again, recording that reading', async () => {
    await reading('temperature', 'NA');
    await evaluateAlarms();
    expect(await openAlarms()).toHaveLength(1);

    await reading('temperature', 21.46);
    await evaluateAlarms();
    expect(await openAlarms()).toHaveLength(0);
    const [closed] = await allAlarms();
    expect(closed.state).toBe('CLEARED');
    expect(closed.clearedAt).not.toBeNull();
    // Unlike an inactivity alarm, this one clears on a real measurement.
    expect(Number(closed.clearedValue)).toBeCloseTo(21.46, 5);
  });

  it('HOLDS the alarm open when the instrument goes silent', async () => {
    // The single most important assertion in this file. An inactivity-shaped
    // pass clears here, stranding nothing — it would instead declare a dead
    // probe repaired at the exact moment it stopped reporting at all.
    await reading('temperature', 'NA');
    await evaluateAlarms();
    await clearReading('temperature');
    await evaluateAlarms();
    expect(await openAlarms()).toHaveLength(1);
  });

  it('HOLDS the alarm open while the sensor keeps reporting rubbish', async () => {
    await reading('temperature', 'NA');
    await evaluateAlarms();
    await reading('temperature', 'ERR');
    await evaluateAlarms();
    const open = await openAlarms();
    expect(open).toHaveLength(1);
    // Still the ORIGINAL evidence: a §11 record states what was found when it
    // was raised, not the latest symptom.
    expect(snapshotOf(open[0]).rawValue).toBe('NA');
  });

  it('clears the two probes independently', async () => {
    await reading('temperature', 'NA');
    await reading('humidity', 'NA');
    await evaluateAlarms();
    expect(await openAlarms()).toHaveLength(2);

    await reading('temperature', 21.5);
    await evaluateAlarms();
    const open = await openAlarms();
    expect(open).toHaveLength(1);
    expect(open[0].metric).toBe('HUMIDITY');
  });

  it('re-raises a NEW alarm when the fault returns', async () => {
    await reading('temperature', 'NA');
    await evaluateAlarms();
    await reading('temperature', 21.5);
    await evaluateAlarms();
    await reading('temperature', 'NA');
    await evaluateAlarms();

    const all = await allAlarms();
    expect(all).toHaveLength(2);
    expect(all[0].state).toBe('CLEARED');
    expect(all[1].state).toBe('ACTIVE');
  });

  it('leaves acknowledgement alone when it clears', async () => {
    // A fault that ended without a signature is still owed an answer.
    await reading('temperature', 'NA');
    await evaluateAlarms();
    await reading('temperature', 21.5);
    await evaluateAlarms();
    const [closed] = await allAlarms();
    expect(closed.acknowledgedAt).toBeNull();
    expect(closed.acknowledgedBy).toBeNull();
  });
});

describe('it does not disturb the other sources', () => {
  it('records itself as RS485_FAILURE with no limitKind', async () => {
    // `source` is the ONLY column separating this from an instrument-limit alarm
    // on the same metric — the Type column and the type filter both key on it.
    await reading('temperature', 'NA');
    await evaluateAlarms();
    const [a] = await openAlarms();
    expect(a.source).toBe('RS485_FAILURE');
    expect(a.limitKind).toBeNull();
  });

  it('counts instrument/metric PAIRS, so the pass is visibly alive', async () => {
    const result = await evaluateAlarms();
    // Two per instrument in the estate — the count exists so a run that raised
    // nothing is distinguishable from a pass that never executed.
    expect(result.rs485Evaluated).toBeGreaterThan(0);
    expect(result.rs485Evaluated % 2).toBe(0);
  });
});
