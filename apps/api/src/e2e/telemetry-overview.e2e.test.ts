import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

let app: FastifyInstance;
let auth: Record<string, string>;
const created: string[] = [];
const s = Date.now();

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});

afterAll(async () => {
  for (const id of created) await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  await app.close();
});

async function createInstrument(code: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: {
      name: code,
      code,
      profileId: await fixtureProfileId('fixture:telemetry-overview'),
      ...extra,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; token: string };
  created.push(body.id);
  return body;
}

async function ingest(deviceToken: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/api/ingest/v1/telemetry',
    headers: { authorization: `Bearer ${deviceToken}` },
    payload,
  });
}

async function overview(qs = '') {
  const res = await app.inject({
    method: 'GET', url: `/api/instruments/telemetry-overview${qs}`, headers: auth,
  });
  expect(res.statusCode).toBe(200);
  return res.json().data as Record<string, any>[];
}

const rowFor = (rows: Record<string, any>[], id: string) => rows.find((r) => r.instrumentId === id);

describe('GET /api/instruments/telemetry-overview', () => {
  it('returns an instrument that has never reported as NO_DATA with null slots', async () => {
    const inst = await createInstrument(`TOV-NEW-${s}`);
    const row = rowFor(await overview(), inst.id);
    expect(row).toBeDefined();
    expect(row!.temperature).toBeNull();
    expect(row!.humidity).toBeNull();
    expect(row!.room).toBeNull();
    // Never reported and no expected interval → falls outside the fallback
    // window, so it is STALE rather than NO_DATA. NO_DATA is for an instrument
    // that IS reporting but whose readings map to neither slot.
    expect(row!.reporting).toBe(false);
    expect(row!.status).toBe('STALE');
  });

  it('resolves temperature and humidity from the configured aliases', async () => {
    const inst = await createInstrument(`TOV-OK-${s}`);
    await ingest(inst.token, { temperature: 22.4, humidity: 45.2 });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.temperature).toMatchObject({ key: 'temperature', value: 22.4 });
    expect(row.humidity).toMatchObject({ key: 'humidity', value: 45.2 });
    expect(row.reporting).toBe(true);
    // No room, so no limits to breach.
    expect(row.status).toBe('OK');
  });

  it('resolves an alias key — a device sending temp/rh is not blank', async () => {
    const inst = await createInstrument(`TOV-ALIAS-${s}`);
    await ingest(inst.token, { temp: 21.0, rh: 44.0 });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.temperature).toMatchObject({ key: 'temp', value: 21.0 });
    expect(row.humidity).toMatchObject({ key: 'rh', value: 44.0 });
  });

  it('ignores telemetry keys that map to no slot', async () => {
    const inst = await createInstrument(`TOV-OTHER-${s}`);
    await ingest(inst.token, { pressure: 1013 });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.temperature).toBeNull();
    expect(row.humidity).toBeNull();
    // Reporting, but nothing maps to a slot — this is what NO_DATA means.
    expect(row.reporting).toBe(true);
    expect(row.status).toBe('NO_DATA');
  });

  it('ignores non-numeric values rather than emitting NaN', async () => {
    const inst = await createInstrument(`TOV-STR-${s}`);
    await ingest(inst.token, { temperature: 'warm' });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.temperature).toBeNull();
  });

  it('returns every instrument, including inactive ones', async () => {
    const inst = await createInstrument(`TOV-INACTIVE-${s}`, { isActive: false });
    const row = rowFor(await overview(), inst.id);
    expect(row).toBeDefined();
    expect(row!.isActive).toBe(false);
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instruments/telemetry-overview' });
    expect(res.statusCode).toBe(401);
  });

  it('does not shadow GET /api/instruments/:id', async () => {
    // The static path must match ahead of the uuid param route.
    const inst = await createInstrument(`TOV-ROUTE-${s}`);
    const res = await app.inject({
      method: 'GET', url: `/api/instruments/${inst.id}`, headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(inst.id);
  });
});
