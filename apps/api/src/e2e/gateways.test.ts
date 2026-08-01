import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';

/**
 * Task 10 — gateways routes. Provisions its own user (`gateway_admin`)
 * rather than the shared `admin` fixture — see apps/api/CLAUDE.md's
 * "per-file authoring tip".
 */
const ADMIN_USERNAME = 'gateway_admin';
const ADMIN_PASSWORD = 'GatewayAdmin@Test1';
const VIEWER_USERNAME = 'gateway_viewer';
const VIEWER_PASSWORD = 'GatewayViewer@Test1';

let app: FastifyInstance;
let token: string;
let nodeId: string;
let profileId: string;

// Unique per run — `hierarchy_nodes.slug` is globally unique (raw ltree SQL),
// `communication_profiles.name` is @unique, and `gateways.code` /
// `instruments.code` are both @unique — a bare re-run of this file against a
// DB that still has a prior run's rows would collide on all four. Every
// fixture name/code below is suffixed with this so the file is re-runnable
// without manual cleanup between runs.
const runSuffix = Date.now();

beforeAll(async () => {
  app = await buildApp();

  const adminHash = await hashPassword(ADMIN_PASSWORD);
  await prisma.user.upsert({
    where: { username: ADMIN_USERNAME },
    update: {
      passwordHash: adminHash,
      fullName: 'Gateway Test Admin',
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
      fullName: 'Gateway Test Admin',
      email: 'gateway-test-admin@example.test',
      role: 'SUPER_ADMIN',
      status: 'ENABLED',
      forcePasswordChange: false,
      isTemporaryPassword: false,
    },
  });
  token = await loginAs(app, ADMIN_USERNAME, ADMIN_PASSWORD);

  const nodeRes = await app.inject({
    method: 'POST', url: '/api/hierarchy', headers: auth(),
    payload: { parentId: null, level: 'COMPANY', name: `GwCo${runSuffix}` },
  });
  expect(nodeRes.statusCode).toBe(200);
  nodeId = nodeRes.json().id;

  const profileRes = await app.inject({
    method: 'POST', url: '/api/communication-profiles', headers: auth(),
    payload: { name: `GW MQTT ${runSuffix}`, protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://b:1883' } },
  });
  expect(profileRes.statusCode).toBe(200);
  profileId = profileRes.json().id;
});

afterAll(async () => { await app.close(); });

// `auth` must read `token` at CALL time, not at module-load time — `token`
// is only assigned inside `beforeAll`.
const auth = () => ({ authorization: `Bearer ${token}` });

describe('gateways routes', () => {
  it('creates a gateway, derives its slug and writes an audit row', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/gateways', headers: auth(),
      payload: {
        name: 'GW 001', code: `GW001-${runSuffix}`, gatewayType: 'edge', externalId: 'gw-001',
        hierarchyNodeId: nodeId, communicationProfileId: profileId,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().slug).toBe('gw-001');

    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'GATEWAY_CREATED', targetId: res.json().id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBe(ADMIN_USERNAME);
  });

  it('re-derives the slug on rename and writes an audit row', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/gateways', headers: auth(),
      payload: {
        name: 'Rename Me', code: `GWRENAME-${runSuffix}`, gatewayType: 'edge', externalId: 'gw-rename',
        hierarchyNodeId: nodeId, communicationProfileId: profileId,
      },
    });
    expect(create.statusCode).toBe(200);
    const id = create.json().id;

    const put = await app.inject({
      method: 'PUT', url: `/api/gateways/${id}`, headers: auth(),
      payload: { name: 'Renamed Gateway' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().slug).toBe('renamed-gateway');

    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'GATEWAY_UPDATED', targetId: id },
    });
    expect(audit).not.toBeNull();
  });

  it('rejects a duplicate code', async () => {
    const payload = {
      name: 'Dup', code: `DUPGW-${runSuffix}`, gatewayType: 'edge', externalId: 'dup',
      hierarchyNodeId: nodeId, communicationProfileId: profileId,
    };
    const first = await app.inject({ method: 'POST', url: '/api/gateways', headers: auth(), payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/api/gateways', headers: auth(), payload });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects an unknown hierarchyNodeId with a clean 400, not a 500', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/gateways', headers: auth(),
      payload: {
        name: 'Bad Node', code: `GWBADNODE-${runSuffix}`, gatewayType: 'edge', externalId: 'gw-bad-node',
        hierarchyNodeId: 'does-not-exist', communicationProfileId: profileId,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown communicationProfileId with a clean 400, not a 500', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/gateways', headers: auth(),
      payload: {
        name: 'Bad Profile', code: `GWBADPROFILE-${runSuffix}`, gatewayType: 'edge', externalId: 'gw-bad-profile',
        hierarchyNodeId: nodeId, communicationProfileId: 'does-not-exist',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists a gateway\'s child instruments', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/gateways', headers: auth(),
      payload: {
        name: 'Instr Parent', code: `GWINSTR-${runSuffix}`, gatewayType: 'edge', externalId: 'gw-instr',
        hierarchyNodeId: nodeId, communicationProfileId: profileId,
      },
    });
    expect(create.statusCode).toBe(200);
    const id = create.json().id;
    const res = await app.inject({ method: 'GET', url: `/api/gateways/${id}/instruments`, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('refuses to delete a gateway with attached instruments, then deletes cleanly once empty', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/gateways', headers: auth(),
      payload: {
        name: 'Delete Me', code: `GWDELETE-${runSuffix}`, gatewayType: 'edge', externalId: 'gw-delete',
        hierarchyNodeId: nodeId, communicationProfileId: profileId,
      },
    });
    expect(create.statusCode).toBe(200);
    const id = create.json().id;

    const instrument = await prisma.instrument.create({
      data: {
        name: 'Blocking Instrument', code: `GWDELETE-INSTR1-${runSuffix}`, slug: 'blocking-instrument',
        instrumentType: 'sensor', hierarchyNodeId: nodeId, gatewayId: id,
      },
    });

    const blocked = await app.inject({ method: 'DELETE', url: `/api/gateways/${id}`, headers: auth() });
    expect(blocked.statusCode).toBe(409);

    await prisma.instrument.delete({ where: { id: instrument.id } });

    const ok = await app.inject({ method: 'DELETE', url: `/api/gateways/${id}`, headers: auth() });
    expect(ok.statusCode).toBe(200);

    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'GATEWAY_DELETED', targetId: id },
    });
    expect(audit).not.toBeNull();
  });

  it('requires GATEWAY_VIEW — a token without it gets 403', async () => {
    const viewerHash = await hashPassword(VIEWER_PASSWORD);
    await prisma.user.upsert({
      where: { username: VIEWER_USERNAME },
      update: {
        passwordHash: viewerHash,
        fullName: 'Gateway Test Viewer',
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
        fullName: 'Gateway Test Viewer',
        email: 'gateway-test-viewer@example.test',
        role: 'VIEWER',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
      },
    });
    const viewerToken = await loginAs(app, VIEWER_USERNAME, VIEWER_PASSWORD);
    const res = await app.inject({
      method: 'GET', url: '/api/gateways',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
