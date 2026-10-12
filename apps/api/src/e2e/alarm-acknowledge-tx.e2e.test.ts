import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * Audit 2026-10-12 #10 and #12 (acknowledge half).
 *
 * #10 — the acknowledge CLAIM (the e-signature written onto the alarm) and its
 * ALARM_ACKNOWLEDGED audit row were two separate writes. If the audit insert
 * failed, the alarm stayed signed with no audit row: the one outcome §11 cannot
 * tolerate. They must commit or fail together.
 *
 * #12 — the ACKNOWLEDGED webhook named the alarm by `ruleSnapshot.name`, a field
 * only the removed RULE alarms carried, so every hooter payload said `ruleName: ""`
 * while the RAISED one for the same alarm carried the administered type name.
 */

// The audit writer fails for ALARM_ACKNOWLEDGED only while `failAck` is set.
let failAck = false;
vi.mock('../lib/audit.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/audit.js')>();
  return {
    ...real,
    auditLog: async (...args: Parameters<typeof real.auditLog>) => {
      if (failAck && args[0].action === 'ALARM_ACKNOWLEDGED') throw new Error('simulated audit failure');
      return real.auditLog(...args);
    },
  };
});

// Capture the webhook payload instead of queueing it.
const webhookCalls: { event: string; input: Record<string, unknown> }[] = [];
vi.mock('../modules/alarm-webhooks/enqueue.js', () => ({
  enqueueAlarmWebhook: async (event: string, input: Record<string, unknown>) => {
    webhookCalls.push({ event, input });
    return true;
  },
}));

import type { FastifyInstance } from 'fastify';
import { alarmTypeKeyFor, alarmTypeName } from '@digilog/shared';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { loadAlarmTypeNames } from '../modules/alarms/load-type-names.js';

let app: FastifyInstance;
let auth: Record<string, string>;
let instrumentId = '';
const reauth = { 'x-reauth-password': 'Admin@123' };

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  const inst = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { name: 'ack-tx-e2e', code: `ACK-TX-${Date.now()}`, profileId: await fixtureProfileId('fixture:alarm-acknowledge') },
  });
  expect(inst.statusCode).toBe(201);
  instrumentId = inst.json().id;
});

afterAll(async () => {
  failAck = false;
  await prisma.alarm.deleteMany({ where: { instrumentId } });
  if (instrumentId) await app.inject({ method: 'DELETE', url: `/api/instruments/${instrumentId}`, headers: { ...auth, ...reauth } });
  await app.close();
});

beforeEach(async () => {
  failAck = false;
  webhookCalls.length = 0;
  await prisma.alarm.deleteMany({ where: { instrumentId } });
});

const raise = () => prisma.alarm.create({
  data: {
    instrumentId, source: 'INSTRUMENT_LIMIT', metric: 'TEMPERATURE', limitKind: 'HIGH',
    triggeredValue: 27.4, severity: 'MAJOR', state: 'ACTIVE',
    ruleSnapshot: { source: 'INSTRUMENT_LIMIT', metric: 'TEMPERATURE', limitKind: 'HIGH', limit: 25, description: 'temperature above 25' },
  },
});

const ack = (id: string, reason: string) =>
  app.inject({ method: 'POST', url: `/api/alarms/${id}/acknowledge`, headers: { ...auth, ...reauth }, payload: { reason } });

describe('acknowledge — claim and audit are one transaction', () => {
  it('a failed audit write leaves the alarm UNSIGNED and fires no webhook', async () => {
    const a = await raise();
    failAck = true;
    const res = await ack(a.id, 'checked the probe');
    expect(res.statusCode).toBe(500);
    const after = await prisma.alarm.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.acknowledgedAt).toBeNull();
    expect(after.acknowledgedBy).toBeNull();
    expect(webhookCalls).toHaveLength(0);
  });

  it('positive control: with the audit write working the alarm is signed and audited', async () => {
    const a = await raise();
    const res = await ack(a.id, 'checked the probe');
    expect(res.statusCode).toBe(200);
    const after = await prisma.alarm.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.acknowledgedAt).not.toBeNull();
    const audit = await prisma.auditTrail.findFirst({ where: { action: 'ALARM_ACKNOWLEDGED', targetId: a.id } });
    expect(audit).not.toBeNull();
  });
});

describe('acknowledge — webhook names the alarm as the RAISED one did', () => {
  it('ruleName is the administered alarm-type name and condition is the frozen description', async () => {
    const a = await raise();
    const res = await ack(a.id, 'checked the probe');
    expect(res.statusCode).toBe(200);
    expect(webhookCalls).toHaveLength(1);
    const names = await loadAlarmTypeNames();
    const expected = alarmTypeName(names, alarmTypeKeyFor('INSTRUMENT_LIMIT', 'TEMPERATURE', 'HIGH')!);
    expect(expected).toBeTruthy();
    expect(webhookCalls[0].event).toBe('ACKNOWLEDGED');
    expect(webhookCalls[0].input.ruleName).toBe(expected);
    expect(webhookCalls[0].input.condition).toBeTruthy();
  });

  it('a non-limit alarm (inactivity) also carries its type name and frozen description', async () => {
    const a = await prisma.alarm.create({
      data: {
        instrumentId, source: 'INACTIVITY', metric: 'OFFLINE', triggeredValue: null,
        severity: 'MAJOR', state: 'ACTIVE',
        ruleSnapshot: { kind: 'INACTIVITY', description: 'no data for 15 minutes' },
      },
    });
    const res = await ack(a.id, 'site power cut');
    expect(res.statusCode).toBe(200);
    const names = await loadAlarmTypeNames();
    expect(webhookCalls[0].input.ruleName).toBe(alarmTypeName(names, 'inactivity'));
    expect(webhookCalls[0].input.condition).toBe('no data for 15 minutes');
  });
});
