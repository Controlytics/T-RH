import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { evaluateAlarms } from '../workers/alarm-evaluation.worker.js';
import { buildTelemetryOverview } from '../modules/instruments/telemetry-overview.js';

/**
 * Sensor RANGE alarms, driven through the REAL evaluation pass.
 *
 * The claim this file exists to prove is not "an alarm is raised" — it is the
 * SUPPRESSION that comes with it. On this installation the temperature limits
 * are 25/0 and the range is 50/-40, so a reading of 60 breaches both. The
 * operator's decision (2026-08-31) is that an out-of-range reading is not a
 * measurement at all, so it must:
 *
 *   1. raise a SENSOR_RANGE alarm;
 *   2. raise NO instrument-limit alarm, even though 60 > 25;
 *   3. not CLEAR an open limit alarm either — absence never proves recovery,
 *      which is `limit-decide.ts`'s standing rule and the reason options 1 and 3
 *      of the operator's choice collapse into one behaviour;
 *   4. leave the numeric slot NULL on the overview, so nothing downstream plots
 *      or judges a number the sensor cannot stand behind.
 *
 * Points 2 and 3 are the ones a future refactor will quietly break.
 */

const STAMP = Date.now();
const CODE = `RANGE-E2E-${STAMP}`;

let instrumentId = '';
const KEY = 'sensor-range-alarms';
const LIMITS_KEY = 'alarm-limits';
const INACTIVITY_KEY = 'inactivity-alarms';
const RS485_KEY = 'rs485-alarms';
const SLOTS_KEY = 'telemetry-slots';
const before: Record<string, { value: unknown; existed: boolean }> = {};

async function setConfig(key: string, value: Record<string, unknown>) {
  await prisma.systemConfig.upsert({
    where: { configKey: key },
    create: { configKey: key, configValue: value, configType: 'object' },
    update: { configValue: value },
  });
}

async function reading(key: string, value: unknown) {
  const valueType = typeof value === 'number'
    ? (Number.isInteger(value) ? 'int' : 'float')
    : typeof value === 'string' ? 'string' : 'json';
  await prisma.$executeRawUnsafe(
    `INSERT INTO instrument_telemetry_latest (instrument_id, key, value, value_type, ts)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (instrument_id, key) DO UPDATE SET
       value = EXCLUDED.value, value_type = EXCLUDED.value_type, ts = EXCLUDED.ts`,
    instrumentId, key, JSON.stringify(value), valueType,
  );
  // Ingest stamps `last_seen_at` with every reading; the limit pass judges only a
  // reporting instrument since audit 2026-10-12 #8, so the fixture must too.
  await prisma.instrument.update({ where: { id: instrumentId }, data: { lastSeenAt: new Date() } });
}

const openRange = () => prisma.alarm.findMany({
  where: { instrumentId, source: 'SENSOR_RANGE', state: 'ACTIVE' }, orderBy: { metric: 'asc' },
});
const openLimit = () => prisma.alarm.findMany({
  where: { instrumentId, source: 'INSTRUMENT_LIMIT', state: 'ACTIVE' },
});
const allRange = () => prisma.alarm.findMany({
  where: { instrumentId, source: 'SENSOR_RANGE' }, orderBy: { raisedAt: 'asc' },
});
const snapshotOf = (a: { ruleSnapshot: unknown }) => a.ruleSnapshot as Record<string, unknown>;
const rowFor = async () =>
  (await buildTelemetryOverview()).find((r) => r.instrumentId === instrumentId)!;

beforeAll(async () => {
  for (const key of [KEY, LIMITS_KEY, INACTIVITY_KEY, RS485_KEY, SLOTS_KEY]) {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: key } });
    before[key] = { value: row?.configValue ?? null, existed: Boolean(row) };
  }
  // Limits stay ON here — this file's whole point is that they DEFER. Inactivity
  // and RS485 are off so neither can add alarms this file would have to explain.
  await setConfig(LIMITS_KEY, { ...(before[LIMITS_KEY].value as object ?? {}), enabled: true });
  await setConfig(INACTIVITY_KEY, { ...(before[INACTIVITY_KEY].value as object ?? {}), enabled: false });
  await setConfig(RS485_KEY, { ...(before[RS485_KEY].value as object ?? {}), enabled: false });
  await setConfig(SLOTS_KEY, {
    ...(before[SLOTS_KEY].value as object ?? {}),
    temperatureKeys: 'temperature', humidityKeys: 'humidity',
  });

  const inst = await prisma.instrument.create({
    data: { name: `range ${CODE}`, code: CODE, profileId: await fixtureProfileId('fixture:alarm-range') },
  });
  instrumentId = inst.id;
  // Both kinds of bound, exactly as this installation's instruments carry them.
  await prisma.instrumentAttribute.createMany({
    data: [
      { instrumentId, key: 'High Temperature Limit', value: '25' },
      { instrumentId, key: 'Low Temperature Limit', value: '0' },
      { instrumentId, key: 'High Temperature Range', value: '50' },
      { instrumentId, key: 'Low Temperature Range', value: '-40' },
      { instrumentId, key: 'High Humidity Range', value: '100' },
      { instrumentId, key: 'Low Humidity Range', value: '0' },
    ],
  });
});

afterAll(async () => {
  // Config restore FIRST and each step guarded — see the note in
  // alarm-rs485.e2e.test.ts: an aborted teardown here once left `alarm-limits`
  // disabled for the whole shared test database.
  for (const [key, prev] of Object.entries(before)) {
    try {
      if (prev.existed) {
        await prisma.systemConfig.update({ where: { configKey: key }, data: { configValue: prev.value as never } });
      } else {
        await prisma.systemConfig.deleteMany({ where: { configKey: key } });
      }
    } catch (e) {
      console.error(`[alarm-sensor-range.e2e] FAILED to restore ${key}:`, e);
    }
  }
  await prisma.alarm.deleteMany({ where: { instrumentId } }).catch(() => {});
  if (instrumentId) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM instrument_telemetry_latest WHERE instrument_id = $1`, instrumentId,
    ).catch(() => {});
    await prisma.instrumentAttribute.deleteMany({ where: { instrumentId } }).catch(() => {});
    await prisma.instrument.delete({ where: { id: instrumentId } }).catch(() => {});
  }
});

beforeEach(async () => {
  await prisma.alarm.deleteMany({ where: { instrumentId } });
  await prisma.$executeRawUnsafe(
    `DELETE FROM instrument_telemetry_latest WHERE instrument_id = $1`, instrumentId);
  await setConfig(KEY, { enabled: true, severity: 'MAJOR', rangeText: 'OL' });
});

describe('the switch', () => {
  it('raises nothing while the feature is off — and the limit alarm comes back', async () => {
    // Switching this off does not merely stop the range alarm: the reading stops
    // being withheld, so 60 is judged against the 25 limit again. Worth pinning,
    // because it is the clearest statement of what the feature actually does.
    await setConfig(KEY, { enabled: false, severity: 'MAJOR', rangeText: 'OL' });
    await reading('temperature', 60);
    const result = await evaluateAlarms();
    expect(await openRange()).toHaveLength(0);
    expect(result.rangeEvaluated).toBe(0);
    expect(await openLimit()).toHaveLength(1);
  });
});

describe('raising, and the limit alarm that must NOT fire with it', () => {
  it('raises ONE range alarm and NO limit alarm for a reading above the span', async () => {
    await reading('temperature', 60);
    await evaluateAlarms();

    const range = await openRange();
    expect(range).toHaveLength(1);
    expect(range[0].metric).toBe('TEMPERATURE');
    expect(Number(range[0].triggeredValue)).toBe(60);

    // 60 > 25. The limit pass saw nothing, because the overview withheld the
    // reading. This is the assertion the operator chose.
    expect(await openLimit()).toHaveLength(0);
  });

  // Audit 2026-10-03, INGEST-3: the plant firmware sends quoted numbers, and the
  // range pass judged the raw TYPE while the dashboard coerced — so a range
  // fault on any gateway-fed instrument neither raised nor cleared.
  it('raises for a QUOTED reading above the span, and clears on a quoted reading back in range', async () => {
    await reading('temperature', '60');
    await evaluateAlarms();
    const range = await openRange();
    expect(range).toHaveLength(1);
    expect(Number(range[0].triggeredValue)).toBe(60);

    await reading('temperature', '22.5');
    await evaluateAlarms();
    expect(await openRange()).toHaveLength(0);
    const closed = await prisma.alarm.findFirst({ where: { instrumentId, source: 'SENSOR_RANGE', state: 'CLEARED' }, orderBy: { clearedAt: 'desc' } });
    expect(Number(closed!.clearedValue)).toBe(22.5);
  });

  it('still raises a LIMIT alarm for a genuine excursion inside the span', async () => {
    // 30 breaches the 25 spec but is well inside the 50 range: a real excursion
    // measured by a healthy probe. Suppression must not swallow it.
    await reading('temperature', 30);
    await evaluateAlarms();
    expect(await openRange()).toHaveLength(0);
    expect(await openLimit()).toHaveLength(1);
  });

  it('raises for a reading below the low range', async () => {
    await reading('temperature', -60);
    await evaluateAlarms();
    expect(await openRange()).toHaveLength(1);
    expect(await openLimit()).toHaveLength(0);
  });

  it('treats the boundary as in range', async () => {
    await reading('temperature', 50);
    await evaluateAlarms();
    expect(await openRange()).toHaveLength(0);
  });

  it('raises humidity and temperature independently', async () => {
    await reading('temperature', 60);
    await reading('humidity', 150);
    await evaluateAlarms();
    const open = await openRange();
    expect(open).toHaveLength(2);
    expect(open.map((a) => a.metric).sort()).toEqual(['HUMIDITY', 'TEMPERATURE']);
  });

  it('does not raise twice for one continuing fault', async () => {
    await reading('temperature', 60);
    await evaluateAlarms();
    await evaluateAlarms();
    expect(await allRange()).toHaveLength(1);
  });
});

describe('an open limit alarm is HELD, never cleared, by an out-of-range reading', () => {
  it('holds it open', async () => {
    // Raise a real limit alarm first with a trustworthy reading...
    await reading('temperature', 30);
    await evaluateAlarms();
    expect(await openLimit()).toHaveLength(1);

    // ...then the probe saturates. The excursion is NOT resolved; nobody knows
    // what the room is doing. Clearing here would file a false "excursion ended".
    await reading('temperature', 60);
    await evaluateAlarms();
    expect(await openLimit()).toHaveLength(1);
    expect(await openRange()).toHaveLength(1);
  });
});

describe('the record it writes', () => {
  it('freezes the reading, the span and the attribute keys it fired against', async () => {
    await reading('temperature', 60);
    await evaluateAlarms();
    const [a] = await openRange();
    const snap = snapshotOf(a);
    expect(snap.kind).toBe('SENSOR_RANGE');
    expect(snap.reading).toBe(60);
    expect(snap.rangeHigh).toBe(50);
    expect(snap.rangeLow).toBe(-40);
    // So "it fired against `High Temperature Range` = 50" survives a rename.
    expect(snap.highKey).toBe('High Temperature Range');
    expect(snap.description).toContain('outside the sensor range');
  });

  it('records itself as SENSOR_RANGE with no limitKind', async () => {
    await reading('temperature', 60);
    await evaluateAlarms();
    const [a] = await openRange();
    expect(a.source).toBe('SENSOR_RANGE');
    expect(a.limitKind).toBeNull();
  });
});

describe('what the dashboard is told', () => {
  it('withholds the numeric slot and flags the range error', async () => {
    await reading('temperature', 60);
    const row = await rowFor();
    // Null, so nothing downstream plots or judges it...
    expect(row.temperature).toBeNull();
    // ...and flagged, so the cell says OL rather than NA, which would hide a
    // hardware fault behind "no data".
    expect(row.rangeError.temperature).toBe(true);
    expect(row.sensorError.temperature).toBe(false);
    expect(row.rangeBounds.temperatureHigh).toBe(50);
  });

  it('leaves a healthy reading alone', async () => {
    await reading('temperature', 21.5);
    const row = await rowFor();
    expect(row.temperature?.value).toBe(21.5);
    expect(row.rangeError.temperature).toBe(false);
  });
});

describe('clearing', () => {
  it('clears when an in-range reading returns, recording it', async () => {
    await reading('temperature', 60);
    await evaluateAlarms();
    await reading('temperature', 21.5);
    await evaluateAlarms();
    expect(await openRange()).toHaveLength(0);
    const [closed] = await allRange();
    expect(closed.state).toBe('CLEARED');
    expect(Number(closed.clearedValue)).toBe(21.5);
  });

  it('HOLDS the alarm open when the instrument goes silent', async () => {
    await reading('temperature', 60);
    await evaluateAlarms();
    await prisma.$executeRawUnsafe(
      `DELETE FROM instrument_telemetry_latest WHERE instrument_id = $1`, instrumentId);
    await evaluateAlarms();
    expect(await openRange()).toHaveLength(1);
  });

  it('counts instrument/metric pairs, so the pass is visibly alive', async () => {
    const result = await evaluateAlarms();
    expect(result.rangeEvaluated).toBeGreaterThan(0);
    expect(result.rangeEvaluated % 2).toBe(0);
  });
});
