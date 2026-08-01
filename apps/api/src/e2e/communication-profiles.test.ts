import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPost } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';

/**
 * Task 7 — communication profiles module.
 *
 * Provisions its own SUPER_ADMIN user (`commprof_admin`) per apps/api/CLAUDE.md
 * single-fork guidance — the shared `admin` login races across concurrently
 * running suites.
 */
const TEST_USERNAME = 'commprof_admin';
const TEST_PASSWORD = 'CommProf@Test1';

describe('communication profiles', () => {
  let app: FastifyInstance;
  let token: string;

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
  });

  afterAll(async () => {
    // The `name` column is unique — clean up so re-runs against the same
    // (non-reset) test DB don't collide with the row this file creates.
    await prisma.communicationProfile.deleteMany({ where: { name: 'Plant MQTT' } });
    await app.close();
  });

  it('lists the seeded protocol registry', async () => {
    const res = await authGet(app, '/api/communication-profiles/protocols', token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(18);
  });

  it('creates a profile and MASKS the secret on read', async () => {
    const create = await authPost(app, '/api/communication-profiles', token, {
      name: 'Plant MQTT', protocolKey: 'mqtt',
      config: { brokerUrl: 'mqtts://broker:8883', username: 'svc', password: 'S3cret!', qos: 1 },
    });
    expect(create.statusCode).toBe(200);

    const list = await authGet(app, '/api/communication-profiles', token);
    const profile = list.json().find((p: { name: string }) => p.name === 'Plant MQTT');
    expect(profile.config.password).not.toBe('S3cret!');
    expect(profile.config.brokerUrl).toBe('mqtts://broker:8883');
  });

  it('rejects an unknown protocol key', async () => {
    const res = await authPost(app, '/api/communication-profiles', token, {
      name: 'Bad', protocolKey: 'opc-da', config: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
