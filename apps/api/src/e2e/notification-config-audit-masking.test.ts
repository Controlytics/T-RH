import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

/**
 * Audit L136 wiring coverage.
 *
 * lib/__tests__/mask-secrets.test.ts proves the helper masks correctly; this
 * proves the two PUT handlers actually CALL it with the right allowlist. That
 * distinction matters here: the unit test's allowlists are hand-copied from the
 * route constants, so a drift in the route would leave the unit test green while
 * the route leaks.
 *
 * The leak is permanent — audit_trail is immutable and hash-chained, so a secret
 * that lands here can never be scrubbed, and AUDIT_READ is held by far more roles
 * than CONFIG_UPDATE. Hence the assertion is a substring sweep over the whole
 * persisted row rather than a per-key check: any path that smuggles a token in
 * fails, however it got there.
 *
 * Runs against digilog_test_db (vitest.env.ts), never the real audit trail.
 */
const TEST_USERNAME = 'notif_mask_admin';
const TEST_PASSWORD = 'NotifMask@Test1';

async function ensureUser() {
  const { hashPassword } = await import('../lib/password.js');
  const passwordHash = await hashPassword(TEST_PASSWORD);
  await prisma.user.upsert({
    where: { username: TEST_USERNAME },
    update: {
      passwordHash, role: 'SUPER_ADMIN', status: 'ENABLED',
      forcePasswordChange: false, isTemporaryPassword: false,
      failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null,
    },
    create: {
      username: TEST_USERNAME, passwordHash,
      fullName: 'Notification Mask Test', email: 'notif-mask@test.example',
      role: 'SUPER_ADMIN', status: 'ENABLED',
      forcePasswordChange: false, isTemporaryPassword: false,
    },
  });
}

describe('notification config PUT — audit secret masking (L136)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await ensureUser();
    token = await loginAs(app, TEST_USERNAME, TEST_PASSWORD);
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => ({
    authorization: `Bearer ${token}`,
    // Sent unconditionally: these routes are reauth-gated when the operator has
    // enabled it for the action, and a no-op header otherwise.
    'x-reauth-password': TEST_PASSWORD,
  });

  const latestRow = (action: string) =>
    prisma.auditTrail.findFirst({ where: { action }, orderBy: { timestamp: 'desc' } });

  // audit_trail.chain_position is BIGSERIAL — plain JSON.stringify throws on it.
  const serializeRow = (row: unknown) =>
    JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

  it('PUT /email persists no SMTP/OAuth2 secret into the audit row', async () => {
    const secrets = {
      password: 'E2E-SMTP-PASSWORD',
      clientSecret: 'E2E-CLIENT-SECRET',
      refreshToken: 'E2E-REFRESH-TOKEN',
      accessToken: 'E2E-ACCESS-TOKEN',
    };
    const res = await app.inject({
      method: 'PUT',
      url: '/api/notification-settings/email',
      headers: auth(),
      payload: {
        host: 'smtp.e2e.example', port: 587, secure: false,
        username: 'e2e@example.com', fromEmail: 'e2e@example.com',
        fromName: 'E2E', enabled: false,
        ...secrets,
      },
    });
    expect(res.statusCode).toBe(200);

    const row = await latestRow('UPDATE_EMAIL_CONFIG');
    expect(row).toBeTruthy();
    const serialized = serializeRow(row);
    for (const secret of Object.values(secrets)) {
      expect(serialized, `${secret} leaked into audit_trail`).not.toContain(secret);
    }
    // Non-secret config still recorded, so the row remains useful to an inspector.
    expect((row!.afterValue as any).host).toBe('smtp.e2e.example');
    expect((row!.afterValue as any).password).toBe('[redacted]');
  });

  it('PUT /sms persists no provider token — including bearer tokens nested in httpGatewayHeaders', async () => {
    const secrets = {
      twilioAuthToken: 'E2E-TWILIO-TOKEN',
      vonageApiSecret: 'E2E-VONAGE-SECRET',
    };
    const res = await app.inject({
      method: 'PUT',
      url: '/api/notification-settings/sms',
      headers: auth(),
      payload: {
        provider: 'http-gateway', enabled: false, senderId: 'E2EIN',
        twilioAccountSid: 'AC-e2e-public-sid',
        vonageApiKey: 'e2e-public-key',
        httpGatewayUrl: 'https://gw.example/send?authkey=E2E-URL-APIKEY',
        httpGatewayMethod: 'POST',
        httpGatewayHeaders: { Authorization: 'Bearer E2E-BEARER-TOKEN' },
        httpGatewayBodyTemplate: '{"authkey":"E2E-TEMPLATE-APIKEY"}',
        ...secrets,
      },
    });
    expect(res.statusCode).toBe(200);

    const row = await latestRow('UPDATE_SMS_CONFIG');
    expect(row).toBeTruthy();
    const serialized = serializeRow(row);
    for (const secret of [...Object.values(secrets), 'E2E-URL-APIKEY', 'E2E-BEARER-TOKEN', 'E2E-TEMPLATE-APIKEY']) {
      expect(serialized, `${secret} leaked into audit_trail`).not.toContain(secret);
    }
    expect((row!.afterValue as any).httpGatewayHeaders).toBe('[redacted]');
    expect((row!.afterValue as any).senderId).toBe('E2EIN');
  });

  // The aggravating half of the finding: the PUT handlers substitute the REAL
  // stored secrets back into `body` when the client echoes the mask sentinel
  // (which the GET always returns). So an admin editing one unrelated field
  // silently pushes live credentials through auditLog — masking must hold on
  // the rehydrated body, not just on a body the client happened to send.
  it('masks secrets rehydrated from storage when the client echoes the mask sentinel', async () => {
    const MASK = '••••••••';

    // Seed a stored secret, then edit an unrelated field echoing the sentinel.
    await app.inject({
      method: 'PUT', url: '/api/notification-settings/email', headers: auth(),
      payload: { host: 'smtp.e2e.example', enabled: false, password: 'E2E-STORED-PASSWORD' },
    });
    const res = await app.inject({
      method: 'PUT', url: '/api/notification-settings/email', headers: auth(),
      payload: { host: 'smtp.changed.example', enabled: false, password: MASK },
    });
    expect(res.statusCode).toBe(200);

    // The rehydration really happened (the live secret was preserved, not clobbered).
    const stored = await prisma.systemConfig.findUnique({ where: { configKey: 'notification-email' } });
    expect((stored!.configValue as any).password).toBe('E2E-STORED-PASSWORD');

    // ...and it did NOT reach the audit trail.
    const row = await latestRow('UPDATE_EMAIL_CONFIG');
    expect(serializeRow(row)).not.toContain('E2E-STORED-PASSWORD');
    expect((row!.afterValue as any).host).toBe('smtp.changed.example');
  });
});
