/**
 * Audit 2026-10-03, INGEST-4: the on-ingest evaluation pass and the cron pass
 * run under different graphile job keys on a worker with concurrency 10, so
 * both could read one alarm ACTIVE and both clear it — two notifications,
 * two hooter "off" posts, two delivery rows. `claimClear` is an atomic claim
 * (`updateMany … WHERE state = 'ACTIVE'`): exactly one caller gets the row,
 * every other gets null and announces nothing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { prisma } from '../lib/prisma.js';
import { claimClear } from '../workers/alarm-evaluation.worker.js';

let app: FastifyInstance;
let admin: Record<string, string>;
let instrumentId = '';

beforeAll(async () => {
  app = await buildApp();
  admin = { authorization: `Bearer ${await loginAs(app)}` };
  const code = `CLAIM-${Date.now()}`;
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: admin,
    payload: { name: code, code, profileId: await fixtureProfileId('fixture:claim-clear') },
  });
  expect(res.statusCode).toBe(201);
  instrumentId = res.json().id;
});

afterAll(async () => {
  await prisma.alarm.deleteMany({ where: { instrumentId } });
  await app.inject({ method: 'DELETE', url: `/api/instruments/${instrumentId}`, headers: admin });
  await app.close();
});

describe('claimClear', () => {
  it('lets exactly ONE of two concurrent clears win; the other gets null', async () => {
    const alarm = await prisma.alarm.create({
      data: {
        instrumentId, metric: 'TEMPERATURE', severity: 'CRITICAL', state: 'ACTIVE',
        source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH', triggeredValue: 30,
        ruleSnapshot: { description: 'e2e' },
      },
    });
    const now = new Date();
    const [a, b] = await Promise.all([
      claimClear(alarm.id, { state: 'CLEARED', clearedAt: now, clearedValue: 21 }),
      claimClear(alarm.id, { state: 'CLEARED', clearedAt: now, clearedValue: 21 }),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect([a, b].filter((r) => r === null)).toHaveLength(1);
    const row = await prisma.alarm.findUniqueOrThrow({ where: { id: alarm.id } });
    expect(row.state).toBe('CLEARED');
    expect(Number(row.clearedValue)).toBe(21);
  });

  it('returns null for an alarm that is not ACTIVE, without touching it', async () => {
    const alarm = await prisma.alarm.create({
      data: {
        instrumentId, metric: 'HUMIDITY', severity: 'CRITICAL', state: 'CLEARED',
        source: 'INSTRUMENT_LIMIT', limitKind: 'LOW', triggeredValue: 10, clearedValue: 45,
        clearedAt: new Date('2026-01-01T00:00:00Z'), ruleSnapshot: { description: 'e2e' },
      },
    });
    expect(await claimClear(alarm.id, { clearedValue: 99 })).toBeNull();
    const row = await prisma.alarm.findUniqueOrThrow({ where: { id: alarm.id } });
    expect(Number(row.clearedValue)).toBe(45);
  });

  // Audit 2026-11-07, S8-22: the claim was two statements — the UPDATE committed,
  // then a re-read fetched the row. A failed re-read left the alarm CLEARED while
  // the caller saw an error and announced nothing: no clear e-mail, no hooter
  // "off". The claim and the row it hands back are now ONE statement.
  it('a failing re-read cannot leave a cleared alarm unannounced', async () => {
    const alarm = await prisma.alarm.create({
      data: {
        instrumentId, metric: 'TEMPERATURE', severity: 'CRITICAL', state: 'ACTIVE',
        source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH', triggeredValue: 31,
        ruleSnapshot: { description: 'e2e' },
      },
    });
    // A spy on a Prisma model delegate does NOT call through (it returns
    // undefined), and `mockRestore` leaves the method undefined: the spy is given
    // the bound original as its implementation and handed back to it after.
    const original = prisma.alarm.findUniqueOrThrow.bind(prisma.alarm);
    const spy = vi.spyOn(prisma.alarm, 'findUniqueOrThrow')
      .mockImplementation(original as never)
      .mockRejectedValueOnce(new Error('connection lost after the claim'));
    try {
      const won = await claimClear(alarm.id, { state: 'CLEARED', clearedAt: new Date(), clearedValue: 22 });
      expect(won?.id).toBe(alarm.id);
      expect(won?.state).toBe('CLEARED');
      expect(Number(won?.clearedValue)).toBe(22);
    } finally {
      spy.mockReset();
      spy.mockImplementation(original as never);
    }
    const row = await prisma.alarm.findUniqueOrThrow({ where: { id: alarm.id } });
    expect(row.state).toBe('CLEARED');
  });
});
