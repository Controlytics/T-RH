import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * The rule CRUD the Alarm Rules config page drives.
 *
 * Written because the page calls PUT and DELETE that nothing had ever exercised: `tsc`
 * cannot check a URL string, and the update path merges the STORED row with a partial
 * body before validating (`draftFrom({ ...current, ...body })`). If that merge produced
 * an invalid draft, the Activate / Deactivate button on every row would 400.
 */

let app: FastifyInstance;
let auth: Record<string, string>;
let instrumentId = '';
const rules: string[] = [];
const alarms: string[] = [];

const reauth = { 'x-reauth-password': 'Admin@123' };
const headers = () => ({ ...auth, ...reauth });

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  const inst = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { name: 'rule-e2e', code: `RULE-E2E-${Date.now()}`, profileId: await fixtureProfileId('fixture:alarm-rules') },
  });
  expect(inst.statusCode).toBe(201);
  instrumentId = inst.json().id;
});

afterAll(async () => {
  if (alarms.length) await prisma.alarm.deleteMany({ where: { id: { in: alarms } } });
  for (const id of rules) await prisma.alarmRule.delete({ where: { id } }).catch(() => {});
  if (instrumentId) await app.inject({ method: 'DELETE', url: `/api/instruments/${instrumentId}`, headers: headers() });
  await app.close();
});

async function newRule(over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/alarms/rules', headers: headers(),
    payload: {
      name: `rule-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      instrumentId, metric: 'TEMPERATURE', comparison: 'ABOVE', thresholdHigh: 25, delaySeconds: 0,
      ...over,
    },
  });
  if (res.statusCode === 201) rules.push(res.json().id);
  return res;
}

describe('alarm rule CRUD', () => {
  it('creates a rule and renders its condition server-side', async () => {
    const res = await newRule();
    expect(res.statusCode).toBe(201);
    // The page shows this string rather than re-deriving the phrasing, so it must be present.
    expect(res.json().description).toBeTruthy();
    expect(res.json().isActive).toBe(true);
  });

  it('deactivates with a PARTIAL body — the Activate/Deactivate button sends only isActive', async () => {
    // This is the merge the update path performs: draftFrom({ ...storedRow, ...body }).
    // If the stored row did not survive that round trip, every row's toggle would 400.
    const created = await newRule();
    const id = created.json().id;
    const res = await app.inject({
      method: 'PUT', url: `/api/alarms/rules/${id}`, headers: headers(), payload: { isActive: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
    // The condition must be untouched by a toggle.
    expect(res.json().thresholdHigh).toBe(25);
    expect(res.json().metric).toBe('TEMPERATURE');
  });

  it('reactivates the same way', async () => {
    const id = (await newRule()).json().id;
    await app.inject({ method: 'PUT', url: `/api/alarms/rules/${id}`, headers: headers(), payload: { isActive: false } });
    const res = await app.inject({ method: 'PUT', url: `/api/alarms/rules/${id}`, headers: headers(), payload: { isActive: true } });
    expect(res.json().isActive).toBe(true);
  });

  it('edits the condition and keeps the rule active', async () => {
    const id = (await newRule()).json().id;
    const res = await app.inject({
      method: 'PUT', url: `/api/alarms/rules/${id}`, headers: headers(),
      payload: { name: 'renamed by e2e', comparison: 'OUTSIDE_RANGE', thresholdLow: 18, thresholdHigh: 24, delaySeconds: 120 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('renamed by e2e');
    expect(res.json().delaySeconds).toBe(120);
    expect(res.json().isActive).toBe(true);
  });

  it('switching to a stopped-reporting rule requires the thresholds to be cleared', async () => {
    // The dialog clears them on the metric change; the server refuses if they linger,
    // because stored thresholds would be silently ignored by the evaluator.
    const id = (await newRule()).json().id;
    const kept = await app.inject({
      method: 'PUT', url: `/api/alarms/rules/${id}`, headers: headers(), payload: { metric: 'OFFLINE' },
    });
    expect(kept.statusCode).toBe(400);
    const cleared = await app.inject({
      method: 'PUT', url: `/api/alarms/rules/${id}`, headers: headers(),
      payload: { metric: 'OFFLINE', thresholdLow: null, thresholdHigh: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().metric).toBe('OFFLINE');
  });

  it('rejects an edit that would leave the rule unable to ever fire', async () => {
    const id = (await newRule()).json().id;
    const res = await app.inject({
      method: 'PUT', url: `/api/alarms/rules/${id}`, headers: headers(), payload: { thresholdHigh: null },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('thresholdHigh');
  });

  it('deletes a rule that has raised nothing', async () => {
    const id = (await newRule()).json().id;
    const res = await app.inject({ method: 'DELETE', url: `/api/alarms/rules/${id}`, headers: headers() });
    expect(res.statusCode).toBe(204);
    expect(await prisma.alarmRule.findUnique({ where: { id } })).toBeNull();
  });

  it('refuses to delete a rule that has raised alarms, and says how many', async () => {
    // Alarms are regulated records with a RESTRICT FK. The refusal has to be actionable,
    // which is why it names the count and points at deactivation.
    const id = (await newRule()).json().id;
    const alarm = await prisma.alarm.create({
      data: {
        ruleId: id, instrumentId, metric: 'TEMPERATURE', triggeredValue: 27,
        severity: 'MAJOR', state: 'ACTIVE', ruleSnapshot: { description: 'temperature above 25' },
      },
    });
    alarms.push(alarm.id);

    const res = await app.inject({ method: 'DELETE', url: `/api/alarms/rules/${id}`, headers: headers() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('HAS_ALARMS');
    expect(res.json().message).toContain('1 alarm');
    expect(await prisma.alarmRule.findUnique({ where: { id } })).not.toBeNull();
  });

  it('404s an unknown rule on update and delete', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect((await app.inject({ method: 'PUT', url: `/api/alarms/rules/${ghost}`, headers: headers(), payload: { isActive: false } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/alarms/rules/${ghost}`, headers: headers() })).statusCode).toBe(404);
  });

  it('lists rules with the alarm count the page shows', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/alarms/rules', headers: auth });
    expect(res.statusCode).toBe(200);
    const mine = res.json().data.filter((r: { id: string }) => rules.includes(r.id));
    expect(mine.length).toBeGreaterThan(0);
    for (const r of mine) expect(typeof r.alarmCount).toBe('number');
  });
});
