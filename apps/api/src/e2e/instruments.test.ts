import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';

/**
 * Task 11 — instruments routes + resolved-topics endpoint. Provisions its
 * own user (`instrument_admin`) rather than the shared `admin` fixture —
 * see apps/api/CLAUDE.md's "per-file authoring tip".
 */
const ADMIN_USERNAME = 'instrument_admin';
const ADMIN_PASSWORD = 'InstrumentAdmin@Test1';
const VIEWER_USERNAME = 'instrument_viewer';
const VIEWER_PASSWORD = 'InstrumentViewer@Test1';

let app: FastifyInstance;
let token: string;
let areaId: string;
let gatewayId: string;
let profileId: string;

// Unique per run — hierarchy_nodes.slug is globally unique (raw ltree SQL),
// communication_profiles.name is @unique, gateways.code / instruments.code
// are both @unique. Every fixture name/code below is suffixed so this file
// is re-runnable without manual cleanup between runs.
const runSuffix = Date.now();

beforeAll(async () => {
  app = await buildApp();

  const adminHash = await hashPassword(ADMIN_PASSWORD);
  await prisma.user.upsert({
    where: { username: ADMIN_USERNAME },
    update: {
      passwordHash: adminHash,
      fullName: 'Instrument Test Admin',
      role: 'SUPER_ADMIN',
      status: 'ENABLED',
      forcePasswordChange: false,
      isTemporaryPassword: false,
      failedLoginAttempts: 0,
      lockedAt: null,
      lockoutUntil: null,
    },
    create: {
      username: ADMIN_USERNAME,
      passwordHash: adminHash,
      fullName: 'Instrument Test Admin',
      email: 'instrument-test-admin@example.test',
      role: 'SUPER_ADMIN',
      status: 'ENABLED',
      forcePasswordChange: false,
      isTemporaryPassword: false,
    },
  });
  token = await loginAs(app, ADMIN_USERNAME, ADMIN_PASSWORD);

  const co = await app.inject({
    method: 'POST', url: '/api/hierarchy', headers: auth(),
    payload: { parentId: null, level: 'COMPANY', name: `InstCo${runSuffix}` },
  });
  expect(co.statusCode).toBe(200);

  const area = await app.inject({
    method: 'POST', url: '/api/hierarchy', headers: auth(),
    payload: { parentId: co.json().id, level: 'AREA', name: `Area02-${runSuffix}` },
  });
  expect(area.statusCode).toBe(200);
  areaId = area.json().id;

  const profile = await app.inject({
    method: 'POST', url: '/api/communication-profiles', headers: auth(),
    payload: { name: `Inst MQTT ${runSuffix}`, protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://b:1883' } },
  });
  expect(profile.statusCode).toBe(200);
  profileId = profile.json().id;

  const gw = await app.inject({
    method: 'POST', url: '/api/gateways', headers: auth(),
    payload: {
      name: 'GW 001', code: `IGW001-${runSuffix}`, gatewayType: 'edge', externalId: 'igw-001',
      hierarchyNodeId: areaId, communicationProfileId: profileId,
    },
  });
  expect(gw.statusCode).toBe(200);
  gatewayId = gw.json().id;
});

afterAll(async () => { await app.close(); });

// `auth` must read `token` at CALL time, not at module-load time — `token`
// is only assigned inside `beforeAll`.
const auth = () => ({ authorization: `Bearer ${token}` });

describe('instruments routes', () => {
  it('creates a gateway-attached instrument, derives 13 topics, and writes an audit row', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: {
        name: 'TEMP001', code: `TEMP001-${runSuffix}`, instrumentType: 'temperature-sensor',
        hierarchyNodeId: areaId, gatewayId, deviceKey: 'temp001',
      },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().id;

    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'INSTRUMENT_CREATED', targetId: id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBe(ADMIN_USERNAME);

    const topics = await app.inject({
      method: 'GET', url: `/api/instruments/${id}/topics`, headers: auth(),
    });
    expect(topics.statusCode).toBe(200);
    const body = topics.json();
    expect(Object.keys(body)).toHaveLength(13);
    expect(body.TELEMETRY).toBe(`instco${runSuffix}/area02-${runSuffix}/gw-001/temp001/telemetry`);
  });

  /*
   * P3 Task 13. `expectedIntervalSec` was absent from BOTH body schemas, which
   * declare `additionalProperties: false` — so the field was stripped on every
   * request and the liveness sweep, which keys entirely off that column, could
   * never fire for any instrument an operator created. The sweep's own unit
   * test set the column with a direct `prisma.instrument.update`, so nothing
   * exercised the write path and the whole liveness feature shipped dark.
   * These three cases are the round trip through the API that was missing.
   */
  it('persists expectedIntervalSec on create and returns it on read', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: {
        name: 'LIVE001', code: `LIVE001-${runSuffix}`, instrumentType: 'temperature-sensor',
        hierarchyNodeId: areaId, gatewayId, deviceKey: 'live001',
        expectedIntervalSec: 60,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().expectedIntervalSec).toBe(60);

    const read = await app.inject({
      method: 'GET', url: `/api/instruments/${res.json().id}`, headers: auth(),
    });
    expect(read.json().expectedIntervalSec).toBe(60);
  });

  it('updates expectedIntervalSec and audits the before/after values', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: {
        name: 'LIVE002', code: `LIVE002-${runSuffix}`, instrumentType: 'temperature-sensor',
        hierarchyNodeId: areaId, gatewayId, deviceKey: 'live002',
      },
    });
    const id = created.json().id;
    // Omitted on create — exempt from liveness monitoring.
    expect(created.json().expectedIntervalSec).toBeNull();

    const res = await app.inject({
      method: 'PUT', url: `/api/instruments/${id}`, headers: auth(),
      payload: { expectedIntervalSec: 90 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().expectedIntervalSec).toBe(90);

    // Enabling or disabling liveness monitoring is compliance-relevant: it
    // changes whether device-offline alarms can be raised at all.
    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'INSTRUMENT_UPDATED', targetId: id },
      orderBy: { timestamp: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect((audit!.beforeValue as { expectedIntervalSec: number | null }).expectedIntervalSec).toBeNull();
    expect((audit!.afterValue as { expectedIntervalSec: number | null }).expectedIntervalSec).toBe(90);
  });

  it('accepts an explicit null to exempt an instrument, and rejects a zero interval', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: {
        name: 'LIVE003', code: `LIVE003-${runSuffix}`, instrumentType: 'temperature-sensor',
        hierarchyNodeId: areaId, gatewayId, deviceKey: 'live003',
        expectedIntervalSec: 30,
      },
    });
    const id = created.json().id;

    const cleared = await app.inject({
      method: 'PUT', url: `/api/instruments/${id}`, headers: auth(),
      payload: { expectedIntervalSec: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().expectedIntervalSec).toBeNull();

    // 0 would mark every instrument offline on the first sweep.
    const zero = await app.inject({
      method: 'PUT', url: `/api/instruments/${id}`, headers: auth(),
      payload: { expectedIntervalSec: 0 },
    });
    expect(zero.statusCode).toBe(400);
  });

  it('rejects an independent instrument with no profile (CHECK constraint mirror)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: {
        name: 'Orphan', code: `ORPHAN1-${runSuffix}`, instrumentType: 'sensor',
        hierarchyNodeId: areaId,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a gateway-attached instrument with no deviceKey', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: {
        name: 'NoKey', code: `NOKEY-${runSuffix}`, instrumentType: 'sensor',
        hierarchyNodeId: areaId, gatewayId,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a duplicate deviceKey within one gateway', async () => {
    const payload = {
      name: 'Dup A', code: `DUPA-${runSuffix}`, instrumentType: 'sensor',
      hierarchyNodeId: areaId, gatewayId, deviceKey: `shared-key-${runSuffix}`,
    };
    const first = await app.inject({ method: 'POST', url: '/api/instruments', headers: auth(), payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { ...payload, name: 'Dup B', code: `DUPB-${runSuffix}` },
    });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects clearing deviceKey via PUT on a gateway-attached instrument', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: {
        name: 'KeepKey', code: `KEEPKEY-${runSuffix}`, instrumentType: 'sensor',
        hierarchyNodeId: areaId, gatewayId, deviceKey: `keepkey-${runSuffix}`,
      },
    });
    expect(create.statusCode).toBe(200);
    const res = await app.inject({
      method: 'PUT', url: `/api/instruments/${create.json().id}`, headers: auth(),
      payload: { deviceKey: null },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown gatewayId with a clean 400, not a 500', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: {
        name: 'Bad GW', code: `BADGW-${runSuffix}`, instrumentType: 'sensor',
        hierarchyNodeId: areaId, gatewayId: 'does-not-exist', deviceKey: 'bad-gw',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('honours a topic override, leaving other categories derived, and clearing it falls back to derived', async () => {
    const inst = (await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: {
        name: 'OVR001', code: `OVR001-${runSuffix}`, instrumentType: 'sensor',
        hierarchyNodeId: areaId, gatewayId, deviceKey: `ovr001-${runSuffix}`,
      },
    })).json();

    const setRes = await app.inject({
      method: 'PUT', url: `/api/instruments/${inst.id}/topics/TELEMETRY`, headers: auth(),
      payload: { customTopic: 'legacy/raw/ovr001', qos: 2, retain: true, enabled: true },
    });
    expect(setRes.statusCode).toBe(200);
    const setAudit = await prisma.auditTrail.findFirst({
      where: { action: 'INSTRUMENT_TOPIC_OVERRIDE_SET', targetId: setRes.json().id },
    });
    expect(setAudit).not.toBeNull();

    const topics = (await app.inject({
      method: 'GET', url: `/api/instruments/${inst.id}/topics`, headers: auth(),
    })).json();
    expect(topics.TELEMETRY).toBe('legacy/raw/ovr001');
    expect(topics.ALARM).toContain(`instco${runSuffix}/`);

    // Clearing with a blank customTopic falls back to the derived topic and
    // emits CLEARED, not SET.
    const clearRes = await app.inject({
      method: 'PUT', url: `/api/instruments/${inst.id}/topics/TELEMETRY`, headers: auth(),
      payload: { customTopic: '' },
    });
    expect(clearRes.statusCode).toBe(200);
    const clearAudit = await prisma.auditTrail.findFirst({
      where: { action: 'INSTRUMENT_TOPIC_OVERRIDE_CLEARED', targetId: clearRes.json().id },
    });
    expect(clearAudit).not.toBeNull();

    const afterClear = (await app.inject({
      method: 'GET', url: `/api/instruments/${inst.id}/topics`, headers: auth(),
    })).json();
    expect(afterClear.TELEMETRY).toContain(`instco${runSuffix}/`);
    expect(afterClear.TELEMETRY).not.toBe('legacy/raw/ovr001');
  });

  it('requires INSTRUMENT_VIEW — a token without it gets 403', async () => {
    const viewerHash = await hashPassword(VIEWER_PASSWORD);
    await prisma.user.upsert({
      where: { username: VIEWER_USERNAME },
      update: {
        passwordHash: viewerHash,
        fullName: 'Instrument Test Viewer',
        role: 'VIEWER',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        failedLoginAttempts: 0,
        lockedAt: null,
        lockoutUntil: null,
      },
      create: {
        username: VIEWER_USERNAME,
        passwordHash: viewerHash,
        fullName: 'Instrument Test Viewer',
        email: 'instrument-test-viewer@example.test',
        role: 'VIEWER',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
      },
    });
    const viewerToken = await loginAs(app, VIEWER_USERNAME, VIEWER_PASSWORD);
    const res = await app.inject({
      method: 'GET', url: '/api/instruments',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
