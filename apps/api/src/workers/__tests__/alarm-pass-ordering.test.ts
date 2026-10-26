/**
 * Audit 2026-10-12 #2 — the defence INSIDE a pass, against the real database.
 *
 * The primary fix is that every alarm_evaluation job runs on one serial graphile
 * queue (pinned by the crontab test and enqueue-evaluation.test.ts). This file pins
 * the second line: within one pass, the open-alarm sets are read BEFORE the
 * overview. A pass that read the overview first, then the open set, could see an
 * alarm another pass raised AFTER its overview was taken and "clear" it against
 * the older, in-spec reading it was holding — a false "returned to spec" record,
 * email and hooter-off.
 *
 * The overview is wrapped so that, while it is being built, "another pass" opens
 * a limit alarm on the fixture. The reading the overview carries is in spec. The
 * alarm must survive.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';

let raceInstrumentId = '';
let raceArmed = false;

vi.mock('../../modules/instruments/telemetry-overview.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../modules/instruments/telemetry-overview.js')>();
  return {
    ...real,
    buildTelemetryOverview: async (...args: Parameters<typeof real.buildTelemetryOverview>) => {
      const rows = await real.buildTelemetryOverview(...args);
      if (raceArmed && raceInstrumentId) {
        // The concurrent pass: it saw a NEWER breaching reading (30) and raised.
        await prisma.alarm.create({
          data: {
            source: 'INSTRUMENT_LIMIT',
            limitKind: 'HIGH',
            metric: 'TEMPERATURE',
            instrumentId: raceInstrumentId,
            triggeredValue: 30,
            severity: 'MAJOR',
            state: 'ACTIVE',
            raisedAt: new Date(),
            ruleSnapshot: { description: 'race fixture' },
          },
        });
      }
      return rows;
    },
  };
});

import { evaluateAlarms } from '../alarm-evaluation.worker.js';
import { fixtureProfileId } from '../../test-support/fixture-profile.js';

const CODE = `PASS-ORDER-${Date.now()}`;

describe('alarm pass reads open alarms before the overview', () => {
  beforeAll(async () => {
    // Its OWN profile: key mappings are per profile since 2026-10-26, so "the
    // first profile in the database" may read temperature from any key at all.
    const profile = { id: await fixtureProfileId('fixture:alarm-pass-ordering') };
    const inst = await prisma.instrument.create({
      data: {
        code: CODE,
        name: 'pass ordering fixture',
        profileId: profile.id,
        lastSeenAt: new Date(),
        attributes: { create: [{ key: 'High Temperature Limit', value: '25' }] },
      },
    });
    raceInstrumentId = inst.id;
    // The STALE reading this pass holds: in spec.
    await prisma.instrumentTelemetryLatest.create({
      data: { instrumentId: inst.id, key: 'temperature', value: 20, valueType: 'number', ts: new Date() },
    });
  });

  afterAll(async () => {
    raceArmed = false;
    await prisma.alarm.deleteMany({ where: { instrumentId: raceInstrumentId } });
    await prisma.instrumentTelemetryLatest.deleteMany({ where: { instrumentId: raceInstrumentId } });
    await prisma.instrumentAttribute.deleteMany({ where: { instrumentId: raceInstrumentId } });
    await prisma.instrument.deleteMany({ where: { id: raceInstrumentId } });
  });

  it('does NOT clear an alarm another pass raised after this pass read its overview', async () => {
    raceArmed = true;
    await evaluateAlarms();
    raceArmed = false;

    const alarm = await prisma.alarm.findFirst({
      where: { instrumentId: raceInstrumentId, source: 'INSTRUMENT_LIMIT', metric: 'TEMPERATURE' },
    });
    expect(alarm).not.toBeNull();
    expect(alarm?.state).toBe('ACTIVE');
    expect(alarm?.clearedAt).toBeNull();
  });
});
