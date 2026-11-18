/**
 * Performance audit 2026-11-17, G1-01 — GET /api/instruments/:id/telemetry-report-rows
 * returns exactly the readings an interval Data Report prints.
 *
 * The ORACLE is the browser's own rule, ported here verbatim in intent
 * (`toTableRowsWithErrors` + `scheduleRows` in apps/web): pivot the slot keys'
 * readings by their millisecond ISO timestamp, anchor on the first instant, keep the
 * first instant of each `intervalMs` slot. It runs over the WHOLE period from the
 * table path, and the route must return exactly the readings at the kept instants.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

let app: FastifyInstance;
let auth: Record<string, string>;
let instrumentId = '';
const t0 = Date.now() - 12 * 3_600_000;
const iso = (min: number, extra = '') => new Date(t0 + min * 60_000).toISOString().replace('Z', `${extra}Z`);
const FROM = new Date(t0 - 60_000).toISOString();
const TO = new Date(t0 + 8 * 3_600_000).toISOString();
const KEYS = ['t', 'h'];

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { name: `RR-${t0}`, code: `RR-${t0}`, profileId: await fixtureProfileId('fixture:report-rows') },
  });
  expect(res.statusCode).toBe(201);
  instrumentId = (res.json() as { id: string }).id;

  const rows: { key: string; value: unknown; ts: string }[] = [];
  // Every 2 minutes for 3 hours: t and h together...
  for (let m = 0; m < 180; m += 2) {
    rows.push({ key: 't', value: 20 + (m % 7) / 10, ts: iso(m) }, { key: 'h', value: 50 + (m % 5), ts: iso(m) });
  }
  // ... then a SILENT hour (180..240), then 3 more hours where t and h arrive 30 s apart,
  // a failure word, a pressure-only instant, and two readings MICROSECONDS apart.
  for (let m = 240; m < 420; m += 3) {
    rows.push({ key: 't', value: m === 300 ? 'NA' : 21 + (m % 3) / 10, ts: iso(m) });
    rows.push({ key: 'h', value: 55, ts: iso(m + 0.5) });
  }
  rows.push({ key: 'p', value: 101.3, ts: iso(242) });
  rows.push({ key: 't', value: 22.2, ts: iso(421, '.000123'.slice(4)) }); // .xxx123 → 3 µs digits after the ms
  rows.push({ key: 'h', value: 56, ts: iso(421, '.000456'.slice(4)) });
  const values = Prisma.join(rows.map((r) => Prisma.sql`(
    ${instrumentId}, ${r.key}, ${JSON.stringify(r.value)}::jsonb,
    ${typeof r.value === 'number' ? 'number' : 'string'}, ${r.ts}::timestamptz)`));
  await prisma.$executeRaw`
    INSERT INTO instrument_telemetry_history (instrument_id, key, value, value_type, ts)
    VALUES ${values} ON CONFLICT (instrument_id, key, ts) DO NOTHING`;
});

afterAll(async () => {
  await app.inject({ method: 'DELETE', url: `/api/instruments/${instrumentId}`, headers: auth });
  await app.close();
});

type Reading = { key: string; value: unknown; ts: string };

/** The browser's rule over the whole period (see the file comment). */
function oracle(all: Reading[], intervalMs: number): Set<string> {
  const instants = [...new Set(all.filter((r) => KEYS.includes(r.key)).map((r) => r.ts))].sort();
  const anchor = new Date(instants[0]!).getTime();
  const first = new Map<number, string>();
  for (const ts of instants) {
    const slot = Math.floor((new Date(ts).getTime() - anchor) / intervalMs);
    if (!first.has(slot)) first.set(slot, ts);
  }
  const kept = new Set(first.values());
  return new Set(all.filter((r) => KEYS.includes(r.key) && kept.has(r.ts)).map((r) => `${r.key}|${r.ts}|${JSON.stringify(r.value)}`));
}

async function reportRows(intervalMs: number) {
  return app.inject({
    method: 'GET', headers: auth,
    url: `/api/instruments/${instrumentId}/telemetry-report-rows?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&intervalMs=${intervalMs}&keys=t,h`,
  });
}

describe('G1-01: the interval Data Report rows come from the server', () => {
  it.each([7, 15, 60])('at %i minutes, exactly the readings the browser\'s rule keeps', async (minutes) => {
    const whole = await app.inject({
      method: 'GET', headers: auth,
      url: `/api/instruments/${instrumentId}/telemetry?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=100000`,
    });
    expect(whole.statusCode).toBe(200);
    const all = (whole.json() as { history: Reading[] }).history;
    expect(all.length).toBe(303); // 90 x 2 + 60 x 2 + the pressure-only instant + the two microsecond readings

    const res = await reportRows(minutes * 60_000);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { history: Reading[]; historyTotal: number };
    const got = new Set(body.history.map((r) => `${r.key}|${r.ts}|${JSON.stringify(r.value)}`));
    expect(got).toEqual(oracle(all, minutes * 60_000));
    expect(body.history.length).toBeLessThan(all.length);
    // The old whole-period fetch's `historyTotal`: every reading in the period, every key.
    expect(body.historyTotal).toBe(all.length);
  });

  it('keeps the failure word and never returns a key the report does not print', async () => {
    const body = (await reportRows(60_000)).json() as { history: Reading[] };
    expect(body.history.some((r) => r.value === 'NA')).toBe(true);
    expect(body.history.every((r) => KEYS.includes(r.key))).toBe(true);
  });

  it('refuses a reversed period and an unknown instrument', async () => {
    const reversed = await app.inject({
      method: 'GET', headers: auth,
      url: `/api/instruments/${instrumentId}/telemetry-report-rows?from=${encodeURIComponent(TO)}&to=${encodeURIComponent(FROM)}&intervalMs=60000&keys=t`,
    });
    expect(reversed.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'GET', headers: auth,
      url: `/api/instruments/00000000-0000-4000-8000-000000000000/telemetry-report-rows?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&intervalMs=60000&keys=t`,
    });
    expect(unknown.statusCode).toBe(404);
  });
});
