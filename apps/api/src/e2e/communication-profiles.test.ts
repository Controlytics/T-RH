import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPost, authDelete } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { REDACTED } from '../lib/mask-secrets.js';
import { COMM_PROFILE_AUDIT_SAFE_KEYS } from '../modules/communication-profiles/routes.js';

/**
 * Task 7 — communication profiles module.
 *
 * Provisions its own SUPER_ADMIN user (`commprof_admin`) per apps/api/CLAUDE.md
 * single-fork guidance — the shared `admin` login races across concurrently
 * running suites. Also provisions a low-privilege OPERATOR user
 * (`commprof_operator`) to prove COMM_PROFILE_VIEW is actually enforced —
 * OPERATOR is not granted it by default (the module is off-by-default, per
 * every other 2026-07/08 permission addition in this codebase).
 */
const TEST_USERNAME = 'commprof_admin';
const TEST_PASSWORD = 'CommProf@Test1';
const OPERATOR_USERNAME = 'commprof_operator';
const OPERATOR_PASSWORD = 'CommProfOp@Test1';

describe('communication profiles', () => {
  let app: FastifyInstance;
  let token: string;
  let operatorToken: string;

  beforeAll(async () => {
    app = await buildApp();

    const passwordHash = await hashPassword(TEST_PASSWORD);
    await prisma.user.upsert({
      where: { username: TEST_USERNAME },
      update: {
        passwordHash,
        fullName: 'CommProfile Test Admin',
        email: 'commprof-test@example.test',
        role: 'SUPER_ADMIN',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        failedLoginAttempts: 0,
        lockedAt: null,
        lockoutUntil: null,
      },
      create: {
        username: TEST_USERNAME,
        passwordHash,
        fullName: 'CommProfile Test Admin',
        email: 'commprof-test@example.test',
        role: 'SUPER_ADMIN',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
      },
    });
    token = await loginAs(app, TEST_USERNAME, TEST_PASSWORD);

    const operatorPasswordHash = await hashPassword(OPERATOR_PASSWORD);
    await prisma.user.upsert({
      where: { username: OPERATOR_USERNAME },
      update: {
        passwordHash: operatorPasswordHash,
        fullName: 'CommProfile Test Operator',
        email: 'commprof-operator-test@example.test',
        role: 'OPERATOR',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        failedLoginAttempts: 0,
        lockedAt: null,
        lockoutUntil: null,
      },
      create: {
        username: OPERATOR_USERNAME,
        passwordHash: operatorPasswordHash,
        fullName: 'CommProfile Test Operator',
        email: 'commprof-operator-test@example.test',
        role: 'OPERATOR',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
      },
    });
    operatorToken = await loginAs(app, OPERATOR_USERNAME, OPERATOR_PASSWORD);
  });

  afterAll(async () => {
    // The `name` column is unique — clean up so re-runs against the same
    // (non-reset) test DB don't collide with the rows this file creates.
    await prisma.gateway.deleteMany({ where: { code: { startsWith: 'CPTEST-GW-' } } });
    await prisma.hierarchyNode.deleteMany({ where: { slug: { startsWith: 'cptest-plant-' } } });
    await prisma.communicationProfile.deleteMany({
      where: { name: { in: ['Plant MQTT', 'Delete Me MQTT', 'In Use MQTT'] } },
    });
    await app.close();
  });

  it('lists the seeded protocol registry', async () => {
    const res = await authGet(app, '/api/communication-profiles/protocols', token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(18);
  });

  it('creates a profile and MASKS the secret on read, and keeps it out of the audit row', async () => {
    // Credential-bearing broker URL — the exact shape the fix-round-1 finding
    // was about: userinfo embedded in the connection URL itself.
    const credentialUrl = 'mqtts://svc:S3cret!@broker:8883';
    const create = await authPost(app, '/api/communication-profiles', token, {
      name: 'Plant MQTT', protocolKey: 'mqtt',
      config: { brokerUrl: credentialUrl, username: 'svc', password: 'S3cret!', qos: 1 },
    });
    expect(create.statusCode).toBe(200);
    const profileId = create.json().id;

    const list = await authGet(app, '/api/communication-profiles', token);
    const profile = list.json().find((p: { name: string }) => p.name === 'Plant MQTT');
    // Response path (COMM_PROFILE_VIEW-gated) — password field redacted, and
    // the same secret embedded in brokerUrl's userinfo is stripped too (it
    // used to leak here verbatim even though the sibling `password` field
    // was masked). Host/port survive so the edit form stays usable.
    expect(profile.config.password).toBe(REDACTED);
    expect(profile.config.brokerUrl).toBe('mqtts://broker:8883');
    expect(profile.config.brokerUrl).not.toContain('svc');
    expect(profile.config.brokerUrl).not.toContain('S3cret!');

    // Audit path — strict allowlist. brokerUrl (which carries the credential)
    // must NOT appear verbatim anywhere in the stored afterValue.
    const auditRow = await prisma.auditTrail.findFirst({
      where: { action: 'COMMUNICATION_PROFILE_CREATED', targetId: profileId },
      orderBy: { timestamp: 'desc' },
    });
    expect(auditRow).not.toBeNull();
    const afterValue = auditRow!.afterValue as any;
    expect(afterValue.config.brokerUrl).toBe(REDACTED);
    expect(afterValue.config.password).toBe(REDACTED);
    expect(JSON.stringify(afterValue)).not.toContain('S3cret!');
    expect(JSON.stringify(afterValue)).not.toContain(credentialUrl);
  });

  it('strips a credential-bearing query param from a rest/webhook URL, keeping host/path', async () => {
    const create = await authPost(app, '/api/communication-profiles', token, {
      name: 'Webhook With Key', protocolKey: 'rest',
      config: { url: 'https://api.example.com/hook?api_key=SECRETVALUE&foo=bar' },
    });
    expect(create.statusCode).toBe(200);
    const profileId = create.json().id;

    const list = await authGet(app, '/api/communication-profiles', token);
    const profile = list.json().find((p: { id: string }) => p.id === profileId);
    expect(profile.config.url).not.toContain('SECRETVALUE');
    expect(profile.config.url).toContain('https://api.example.com/hook');
    expect(profile.config.url).toContain('foo=bar');

    await prisma.communicationProfile.delete({ where: { id: profileId } });
  });

  it('falls back to the redacted sentinel for a credential-URL key that does not parse as a URL', async () => {
    const create = await authPost(app, '/api/communication-profiles', token, {
      name: 'Unparseable Endpoint', protocolKey: 'rest',
      config: { endpoint: 'not a valid url' },
    });
    expect(create.statusCode).toBe(200);
    const profileId = create.json().id;

    const list = await authGet(app, '/api/communication-profiles', token);
    const profile = list.json().find((p: { id: string }) => p.id === profileId);
    expect(profile.config.endpoint).toBe(REDACTED);

    await prisma.communicationProfile.delete({ where: { id: profileId } });
  });

  it('rejects an unknown protocol key', async () => {
    const res = await authPost(app, '/api/communication-profiles', token, {
      name: 'Bad', protocolKey: 'opc-da', config: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('deletes an unused profile', async () => {
    const create = await authPost(app, '/api/communication-profiles', token, {
      name: 'Delete Me MQTT', protocolKey: 'mqtt', config: { brokerUrl: 'mqtts://x:1' },
    });
    expect(create.statusCode).toBe(200);
    const profileId = create.json().id;

    const del = await authDelete(app, `/api/communication-profiles/${profileId}`, token);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ success: true });

    const list = await authGet(app, '/api/communication-profiles', token);
    expect(list.json().find((p: { id: string }) => p.id === profileId)).toBeUndefined();
  });

  it('returns 409 PROFILE_IN_USE when deleting a profile a gateway depends on', async () => {
    const create = await authPost(app, '/api/communication-profiles', token, {
      name: 'In Use MQTT', protocolKey: 'mqtt', config: { brokerUrl: 'mqtts://x:1' },
    });
    const profileId = create.json().id;

    const node = await prisma.hierarchyNode.create({
      data: { level: 'PLANT', name: 'CPTest Plant', slug: 'cptest-plant-' + Date.now() },
    });
    await prisma.gateway.create({
      data: {
        name: 'CPTest Gateway', code: 'CPTEST-GW-' + Date.now(), slug: 'cptest-gw-' + Date.now(),
        gatewayType: 'edge', externalId: 'cptest-ext-' + Date.now(),
        hierarchyNodeId: node.id, communicationProfileId: profileId,
      },
    });

    const del = await authDelete(app, `/api/communication-profiles/${profileId}`, token);
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toBe('PROFILE_IN_USE');
  });

  it('returns 403 for a role lacking COMM_PROFILE_VIEW', async () => {
    const res = await authGet(app, '/api/communication-profiles', operatorToken);
    expect(res.statusCode).toBe(403);
  });

  // Fix round 3 — guards the INVARIANT, not just today's known keys. A future
  // protocol adding e.g. callbackUrl/proxyUrl to the response allowlist
  // (reasonable — the edit form needs it) must not let it silently inherit
  // into the audit allowlist too.
  it('audit allowlist excludes URL-bearing keys', () => {
    for (const k of ['brokerUrl', 'url', 'endpoint']) {
      expect(COMM_PROFILE_AUDIT_SAFE_KEYS).not.toContain(k);
    }
  });
});
