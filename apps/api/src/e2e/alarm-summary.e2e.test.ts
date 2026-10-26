/**
 * Audit 2026-10-03, API-19.
 *
 * `GET /api/alarms/summary` loaded EVERY attribute of every visible instrument
 * to count the ones with no usable limit. It now selects only the attributes
 * whose key is in the administered limit alias lists — and that select must
 * fold case, because `resolveLimit` does: an instrument whose key is `T_HL`
 * against an alias `t_hl` is watched by the evaluator, and the summary must
 * not report it as unwatched.
 *
 * Measured as a DELTA against the shared test database rather than an
 * absolute count: other suites leave instruments behind.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { prisma } from '../lib/prisma.js';
import { slotConfigForProfile } from '../modules/instruments/profile-measurements.js';

/** The limit keys are the instrument PROFILE's since 2026-10-26 — read this file's own. */
const loadLimitConfig = async () => ({
  keys: (await slotConfigForProfile(await fixtureProfileId('fixture:alarm-summary'))).limitKeys,
});

let app: FastifyInstance;
let auth: Record<string, string>;
const s = Date.now();
const made: string[] = [];

async function createInstrument(code: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { name: code, code, profileId: await fixtureProfileId('fixture:alarm-summary') },
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  made.push(id);
  return id;
}

const summary = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/alarms/summary', headers: auth });
  expect(res.statusCode).toBe(200);
  return res.json() as { instrumentsWithoutLimits: number; instrumentsWithoutLimitsCodes: string[]; limitAlarmsEnabled: boolean };
};

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});

afterAll(async () => {
  await prisma.instrument.deleteMany({ where: { id: { in: made } } });
  await app.close();
});

describe('GET /api/alarms/summary — instruments without limits', () => {
  it('counts an instrument with no limit attribute, and not one whose limit key differs only by CASE', async () => {
    const cfg = await loadLimitConfig();
    const alias = cfg.keys.temperatureHigh[0];
    expect(alias).toBeTruthy();

    const before = await summary();

    const unwatched = await createInstrument(`SUM-${s}-NONE`);
    // Carries attributes, none of them a limit — the whole-attribute load this
    // replaced would have read them all for nothing.
    await prisma.instrumentAttribute.createMany({ data: [
      { instrumentId: unwatched, key: 'Location', value: 'Room 1' },
      { instrumentId: unwatched, key: 'Building', value: 'CWH' },
    ] });

    const watched = await createInstrument(`SUM-${s}-UPPER`);
    // The alias upper-cased: `resolveLimit` folds case, so the evaluator
    // watches this instrument; the summary's SQL match must agree.
    await prisma.instrumentAttribute.create({ data: { instrumentId: watched, key: alias.toUpperCase(), value: '25' } });

    const after = await summary();
    expect(after.instrumentsWithoutLimits).toBe(before.instrumentsWithoutLimits + 1);
    if (after.instrumentsWithoutLimitsCodes.length < 50) {
      expect(after.instrumentsWithoutLimitsCodes).toContain(`SUM-${s}-NONE`);
      expect(after.instrumentsWithoutLimitsCodes).not.toContain(`SUM-${s}-UPPER`);
    }
    expect(typeof after.limitAlarmsEnabled).toBe('boolean');
  });

  it('an unparseable limit value still counts as unwatched', async () => {
    const cfg = await loadLimitConfig();
    const alias = cfg.keys.temperatureHigh[0];
    const before = await summary();
    const id = await createInstrument(`SUM-${s}-NA`);
    await prisma.instrumentAttribute.create({ data: { instrumentId: id, key: alias, value: 'NA' } });
    const after = await summary();
    expect(after.instrumentsWithoutLimits).toBe(before.instrumentsWithoutLimits + 1);
  });
});
