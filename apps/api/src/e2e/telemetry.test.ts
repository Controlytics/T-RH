import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { writeBatch, writeDeadLetters } from '../modules/data-injection/telemetry.repository.js';

/**
 * Task 11 — telemetry + dead-letter API.
 *
 * Provisions its own users rather than the shared `admin` fixture — see
 * apps/api/CLAUDE.md's per-file authoring tip.
 */
const ADMIN_USERNAME = 'telemetry_admin';
const ADMIN_PASSWORD = 'Telemetry@Test1';
const VIEWER_USERNAME = 'telemetry_viewer';
const VIEWER_PASSWORD = 'TelemetryViewer@Test1';

let app: FastifyInstance;
let token = '';
let viewerToken = '';
let instrumentId = '';

// MUST be a function. A module-scope `const auth = { authorization: ... }` is
// evaluated before beforeAll assigns `token`, yielding "Bearer undefined".
const auth = () => ({ authorization: `Bearer ${token}` });
const viewerAuth = () => ({ authorization: `Bearer ${viewerToken}` });

const T1 = new Date('2026-08-10T00:00:00.000Z');
const T2 = new Date('2026-08-20T00:00:00.000Z');

beforeAll(async () => {
  app = await buildApp();

  for (const [username, password, role, fullName] of [
    [ADMIN_USERNAME, ADMIN_PASSWORD, 'SUPER_ADMIN', 'Telemetry Test Admin'],
    [VIEWER_USERNAME, VIEWER_PASSWORD, 'VIEWER', 'Telemetry Test Viewer'],
  ] as const) {
    const passwordHash = await hashPassword(password);
    const base = {
      passwordHash, fullName, role, status: 'ENABLED' as const,
      forcePasswordChange: false, isTemporaryPassword: false,
      failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null,
    };
    await prisma.user.upsert({
      where: { username },
      update: base,
      create: { username, email: `${username}@test.local`, ...base },
    });
  }

  token = await loginAs(app, ADMIN_USERNAME, ADMIN_PASSWORD);
  viewerToken = await loginAs(app, VIEWER_USERNAME, VIEWER_PASSWORD);

  // Fixture chain: hierarchy node → profile → gateway → instrument.
  const found = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM hierarchy_nodes WHERE slug = 'telemtest' AND parent_id IS NULL LIMIT 1`;
  const nodeId = found.length > 0 ? found[0].id : (await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO hierarchy_nodes
      (id, parent_id, level, name, slug, path, sort_order, is_active, created_at, updated_at)
    VALUES (gen_random_uuid(), NULL, 'COMPANY'::"HierarchyLevel", 'TelemTest', 'telemtest',
            'telemtest'::ltree, 0, true, now(), now())
    RETURNING id`)[0].id;

  const profile = await prisma.communicationProfile.upsert({
    where: { name: 'telem-profile' }, update: {},
    create: { name: 'telem-profile', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://x' } },
  });
  const gateway = await prisma.gateway.upsert({
    where: { code: 'TELEMGW' }, update: {},
    create: {
      name: 'Telem GW', code: 'TELEMGW', slug: 'telem-gw', gatewayType: 'edge',
      externalId: 'telem-gw', hierarchyNodeId: nodeId, communicationProfileId: profile.id,
    },
  });
  const instrument = await prisma.instrument.upsert({
    where: { code: 'TELEMINST' }, update: {},
    create: {
      name: 'Telem Inst', code: 'TELEMINST', slug: 'telem-inst', instrumentType: 'sensor',
      hierarchyNodeId: nodeId, gatewayId: gateway.id, deviceKey: 'teleminst',
    },
  });
  instrumentId = instrument.id;

  await prisma.$executeRawUnsafe(
    `DELETE FROM instrument_telemetry_latest WHERE instrument_id = '${instrumentId}'`);
  await prisma.$executeRawUnsafe(
    `DELETE FROM instrument_telemetry_history WHERE instrument_id = '${instrumentId}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM dead_letters WHERE topic LIKE 'telem/%'`);

  await writeBatch([{ instrumentId, readings: [{ key: 'temp', value: 1, valueType: 'int', ts: T1 }] }], T1);
  await writeBatch([{ instrumentId, readings: [
    { key: 'temp', value: 2, valueType: 'int', ts: T2 },
    { key: 'rh', value: 45.5, valueType: 'float', ts: T2 },
  ] }], T2);
});

afterAll(async () => { await app.close(); });

describe('GET /api/instruments/:id/telemetry/latest', () => {
  it('returns the latest value per key', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/instruments/${instrumentId}/telemetry/latest`, headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const byKey = Object.fromEntries(body.readings.map((r: { key: string }) => [r.key, r]));
    expect(byKey.temp.value).toBe(2);          // the later write won
    expect(byKey.rh.value).toBe(45.5);
    expect(byKey.rh.valueType).toBe('float');
  });

  it('404s for an unknown instrument', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/instruments/00000000-0000-0000-0000-000000000000/telemetry/latest',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('401s without a token', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/instruments/${instrumentId}/telemetry/latest`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('403s for a role without INSTRUMENT_VIEW', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/instruments/${instrumentId}/telemetry/latest`, headers: viewerAuth(),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/instruments/:id/telemetry/history', () => {
  it('returns every reading with a total', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/instruments/${instrumentId}/telemetry/history`, headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(3);
  });

  it('filters by key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/instruments/${instrumentId}/telemetry/history?key=temp`, headers: auth(),
    });
    expect(res.json().total).toBe(2);
  });

  it('filters by time window', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/instruments/${instrumentId}/telemetry/history?key=temp&from=2026-08-15T00:00:00.000Z`,
      headers: auth(),
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.rows[0].value).toBe(2);
  });

  it('rejects a malformed date rather than querying an Invalid Date', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/instruments/${instrumentId}/telemetry/history?from=not-a-date`, headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a reversed window', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/instruments/${instrumentId}/telemetry/history`
         + '?from=2026-09-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z',
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/data-injection/health', () => {
  it('reports connections and queue stats', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/data-injection/health', headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('connections');
    expect(body.queue).toHaveProperty('depth');
    expect(body.queue).toHaveProperty('dropped');
    expect(body.queue).toHaveProperty('flushed');
  });
});

describe('dead letters', () => {
  it('lists them and resolves one, writing an audit row', async () => {
    await writeDeadLetters([{
      protocolKey: 'mqtt', topic: 'telem/dl/1', payload: '{}',
      reason: 'UNKNOWN_DEVICE_KEY', detail: 'ghost',
    }]);

    const list = await app.inject({
      method: 'GET', url: '/api/data-injection/dead-letters?resolved=false', headers: auth(),
    });
    expect(list.statusCode).toBe(200);
    const row = list.json().rows.find((r: { topic: string }) => r.topic === 'telem/dl/1');
    expect(row).toBeDefined();
    expect(row.resolvedAt).toBeNull();

    const res = await app.inject({
      method: 'POST', url: `/api/data-injection/dead-letters/${row.id}/resolve`,
      headers: auth(), payload: { note: 'investigated' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resolvedAt).not.toBeNull();

    // Resolving is an operator judgement about a record, so it IS audited even
    // though telemetry itself is not.
    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'DEAD_LETTER_RESOLVED', targetId: row.id },
    });
    expect(audit).not.toBeNull();
  });

  it('refuses to resolve the same dead letter twice', async () => {
    await writeDeadLetters([{
      protocolKey: 'mqtt', topic: 'telem/dl/2', payload: '{}', reason: 'NO_READINGS',
    }]);
    const list = await app.inject({
      method: 'GET', url: '/api/data-injection/dead-letters?resolved=false', headers: auth(),
    });
    const row = list.json().rows.find((r: { topic: string }) => r.topic === 'telem/dl/2');

    const first = await app.inject({
      method: 'POST', url: `/api/data-injection/dead-letters/${row.id}/resolve`, headers: auth(),
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST', url: `/api/data-injection/dead-letters/${row.id}/resolve`, headers: auth(),
    });
    expect(second.statusCode).toBe(400);
  });

  it('404s when resolving an unknown dead letter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/data-injection/dead-letters/00000000-0000-0000-0000-000000000000/resolve',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});
