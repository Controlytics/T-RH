import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * Acknowledgement is a 21 CFR §11 e-signature, so what is asserted here is not just
 * "the field got set": the reason must reach the audit trail, and a SECOND
 * acknowledgement must be refused rather than silently replace the first signature.
 *
 * Spec: docs/superpowers/specs/2026-08-13-alarm-subsystem-design.md § Acknowledgement
 */

let app: FastifyInstance;
let auth: Record<string, string>;
let instrumentId = '';
const alarms: string[] = [];

// enforceReauth('ACKNOWLEDGE_ALARM') is policy-driven, so a password is not always
// demanded — sending one regardless keeps these tests independent of the live policy row.
const reauth = { 'x-reauth-password': 'Admin@123' };

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };

  const inst = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: {
      name: 'ack-e2e', code: `ACK-E2E-${Date.now()}`,
      profileId: await fixtureProfileId('fixture:alarm-acknowledge'),
    },
  });
  expect(inst.statusCode).toBe(201);
  instrumentId = inst.json().id;

});

afterAll(async () => {
  // A Restrict FK on the instrument, so the alarms must go first.
  if (alarms.length) await prisma.alarm.deleteMany({ where: { id: { in: alarms } } });
  if (instrumentId) await app.inject({ method: 'DELETE', url: `/api/instruments/${instrumentId}`, headers: { ...auth, ...reauth } });
  await app.close();
});

/**
 * Alarms are only ever created by the evaluator, so a test one is inserted
 * directly.
 *
 * Each call takes the NEXT (metric, bound) pair: `alarms_active_instrument_limit_unique`
 * permits one ACTIVE alarm per instrument per metric per bound, and this file
 * raises several. Cycling keeps every fixture row legal without an instrument each.
 */
const BOUNDS = [
  { metric: 'TEMPERATURE', limitKind: 'HIGH' },
  { metric: 'TEMPERATURE', limitKind: 'LOW' },
  { metric: 'HUMIDITY', limitKind: 'HIGH' },
  { metric: 'HUMIDITY', limitKind: 'LOW' },
] as const;
let nextBound = 0;

async function raise(state: 'ACTIVE' | 'CLEARED' = 'ACTIVE') {
  const bound = BOUNDS[nextBound++ % BOUNDS.length];
  const a = await prisma.alarm.create({
    data: {
      // An INSTRUMENT_LIMIT alarm — authored rules were removed 2026-08-31, and
      // acknowledgement is not source-specific anyway.
      instrumentId, source: 'INSTRUMENT_LIMIT',
      metric: bound.metric, limitKind: bound.limitKind, triggeredValue: 27.4,
      severity: 'MAJOR', state,
      ruleSnapshot: { description: 'temperature above 25' },
      clearedAt: state === 'CLEARED' ? new Date() : null,
    },
  });
  alarms.push(a.id);
  return a.id;
}

// Each test starts with no ACTIVE alarm on the fixture instrument, so the
// partial unique index (one per instrument/metric/bound while ACTIVE) cannot be
// hit by fixtures left behind by the test before.
beforeEach(async () => {
  if (alarms.length) await prisma.alarm.deleteMany({ where: { id: { in: alarms } } });
  alarms.length = 0;
  nextBound = 0;
});

const ack = (id: string, reason: string) =>
  app.inject({ method: 'POST', url: `/api/alarms/${id}/acknowledge`, headers: { ...auth, ...reauth }, payload: { reason } });

describe('POST /api/alarms/:id/acknowledge', () => {
  it('acknowledges an active alarm and records who, when, and why', async () => {
    const id = await raise();
    const res = await ack(id, 'Door left open during a material transfer');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.acknowledgedAt).toBeTruthy();
    expect(body.acknowledgeReason).toBe('Door left open during a material transfer');
    // Fastify strips response fields absent from the schema — this has cost this repo
    // twice, so the acknowledgement fields are asserted through the HTTP body.
    expect(body.acknowledgedBy).toBeTruthy();
  });

  it('leaves the alarm state alone — acknowledging is not clearing', async () => {
    const id = await raise();
    const res = await ack(id, 'Investigated, excursion is genuine');
    expect(res.json().state).toBe('ACTIVE');
    expect(res.json().clearedAt).toBeNull();
  });

  it('acknowledges an already-CLEARED alarm', async () => {
    // The overnight excursion nobody saw still has to be answered for in the morning.
    const id = await raise('CLEARED');
    expect((await ack(id, 'Reviewed the overnight excursion')).statusCode).toBe(200);
  });

  it('writes ALARM_ACKNOWLEDGED to the audit trail with the reason', async () => {
    const id = await raise();
    await ack(id, 'HVAC serviced, deviation raised as DEV-114');
    const row = await prisma.auditTrail.findFirst({
      where: { action: 'ALARM_ACKNOWLEDGED', targetId: id },
      orderBy: { timestamp: 'desc' },
    });
    expect(row).toBeTruthy();
    expect(row!.reason).toBe('HVAC serviced, deviation raised as DEV-114');
    expect(row!.signatureMeaning).toContain('DEV-114');
    // {targetName} in the audit template reads after_value.name — without it the
    // audit row renders as 'Alarm "" acknowledged by …'.
    expect((row!.afterValue as Record<string, unknown>).name).toContain('ACK-E2E');
  });

  it('refuses a second acknowledgement with 409 and keeps the first signature', async () => {
    const id = await raise();
    expect((await ack(id, 'First acceptance by the shift lead')).statusCode).toBe(200);
    const second = await ack(id, 'Second, different explanation entirely');
    expect(second.statusCode).toBe(409);
    expect(second.json().code ?? second.json().error).toBe('ALREADY_ACKNOWLEDGED');

    const after = await prisma.alarm.findUnique({ where: { id } });
    expect(after!.acknowledgeReason).toBe('First acceptance by the shift lead');
  });

  it('rejects a missing or too-short reason and does not acknowledge', async () => {
    const id = await raise();
    const noReason = await app.inject({
      method: 'POST', url: `/api/alarms/${id}/acknowledge`, headers: { ...auth, ...reauth }, payload: {},
    });
    expect(noReason.statusCode).toBe(400);
    expect((await ack(id, 'ok')).statusCode).toBe(400);
    expect((await prisma.alarm.findUnique({ where: { id } }))!.acknowledgedAt).toBeNull();
  });

  it('refuses an over-long reason BEFORE acknowledging anything', async () => {
    // audit_trail.signature_meaning is VARCHAR(255). If this were accepted, the alarm
    // would be acknowledged and the audit INSERT would then throw — an acknowledged
    // alarm with no audit row is the one §11 outcome that cannot be allowed.
    const id = await raise();
    expect((await ack(id, 'x'.repeat(501))).statusCode).toBe(400);
    expect((await prisma.alarm.findUnique({ where: { id } }))!.acknowledgedAt).toBeNull();
  });

  it('still writes the audit row for a long-but-allowed reason', async () => {
    const id = await raise();
    const reason = `Excursion investigated: ${'detail '.repeat(60)}`.slice(0, 500);
    expect((await ack(id, reason)).statusCode).toBe(200);
    const row = await prisma.auditTrail.findFirst({ where: { action: 'ALARM_ACKNOWLEDGED', targetId: id } });
    expect(row).toBeTruthy();
    // Clamped for the column, while the full reason survives in the TEXT columns.
    expect(row!.signatureMeaning!.length).toBeLessThanOrEqual(255);
    expect(row!.reason).toBe(reason.trim());
  });

  it('404s an unknown alarm', async () => {
    const res = await ack('00000000-0000-4000-8000-000000000000', 'Acknowledging a ghost');
    expect(res.statusCode).toBe(404);
  });
});
