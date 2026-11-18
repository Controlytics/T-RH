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

  /**
   * Audit 2026-10-12 #6 — GET /sms masked twilioAuthToken / vonageApiSecret only.
   * The http-gateway's header VALUES (bearer tokens) and the API key in its URL
   * query (MSG91 `authkey=`, Plivo, Kaleyra…) went to every CONFIG_READ holder in
   * plain text. Masked now, with mask-means-keep on save.
   */
  it('GET /sms masks gateway header values and URL query values; a round-trip PUT keeps them', async () => {
    const MASK = '••••••••';
    const url = 'https://gw.example/send?authkey=E2E-URL-SECRET&mobiles={phone}&message={message}&route=4';
    // The body template's secret-NAMED fields are masked too; the rest stays readable.
    const TEMPLATE = '{"authkey":"E2E-TPL-SECRET","mobiles":"{phone}","sender":"DIGLOG"}';
    const put1 = await app.inject({
      method: 'PUT', url: '/api/notification-settings/sms', headers: auth(),
      payload: {
        provider: 'http-gateway', enabled: false,
        httpGatewayUrl: url,
        httpGatewayMethod: 'GET',
        httpGatewayHeaders: { Authorization: 'Bearer E2E-GW-BEARER' },
        httpGatewayBodyTemplate: TEMPLATE,
      },
    });
    expect(put1.statusCode).toBe(200);

    const got = await app.inject({ method: 'GET', url: '/api/notification-settings/sms', headers: auth() });
    expect(got.statusCode).toBe(200);
    const body = got.json();
    expect(JSON.stringify(body)).not.toContain('E2E-URL-SECRET');
    expect(JSON.stringify(body)).not.toContain('E2E-GW-BEARER');
    expect(JSON.stringify(body)).not.toContain('E2E-TPL-SECRET');
    expect(body.httpGatewayBodyTemplate).toBe(`{"authkey":"${MASK}","mobiles":"{phone}","sender":"DIGLOG"}`);
    expect(body.httpGatewayHeaders).toEqual({ Authorization: MASK });
    // Names and the {phone}/{message} placeholders stay readable.
    expect(body.httpGatewayUrl).toBe(`https://gw.example/send?authkey=${MASK}&mobiles={phone}&message={message}&route=${MASK}`);

    // The screen sends back exactly what it was given, with one unrelated change.
    const put2 = await app.inject({
      method: 'PUT', url: '/api/notification-settings/sms', headers: auth(),
      payload: { ...body, senderId: 'CHANGED' },
    });
    expect(put2.statusCode).toBe(200);
    const stored = (await prisma.systemConfig.findUnique({ where: { configKey: 'notification-sms' } }))!.configValue as any;
    expect(stored.httpGatewayUrl).toBe(url);
    expect(stored.httpGatewayHeaders).toEqual({ Authorization: 'Bearer E2E-GW-BEARER' });
    expect(stored.httpGatewayBodyTemplate).toBe(TEMPLATE);
    expect(stored.senderId).toBe('CHANGED');

    // A mask for a query key with nothing stored cannot be resolved: refused, not stored as bullets.
    const bad = await app.inject({
      method: 'PUT', url: '/api/notification-settings/sms', headers: auth(),
      payload: { ...body, httpGatewayUrl: `https://gw.example/send?newkey=${MASK}` },
    });
    expect(bad.statusCode).toBe(400);
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
    // An UNRELATED field: since audit 2026-11-07 S6-3 a changed host with the
    // mask is refused (see the destination describe below).
    const res = await app.inject({
      method: 'PUT', url: '/api/notification-settings/email', headers: auth(),
      payload: { host: 'smtp.e2e.example', enabled: false, password: MASK, fromName: 'Changed Sender' },
    });
    expect(res.statusCode).toBe(200);

    // The rehydration really happened (the live secret was preserved, not clobbered).
    const stored = await prisma.systemConfig.findUnique({ where: { configKey: 'notification-email' } });
    expect((stored!.configValue as any).password).toBe('E2E-STORED-PASSWORD');

    // ...and it did NOT reach the audit trail.
    const row = await latestRow('UPDATE_EMAIL_CONFIG');
    expect(serializeRow(row)).not.toContain('E2E-STORED-PASSWORD');
    expect((row!.afterValue as any).fromName).toBe('Changed Sender');
  });

  /**
   * Audit 2026-11-07, S6-3 (runtime-proven for SMTP and OAuth): the mask means
   * "keep the stored secret", and the kept secret went wherever the request now
   * pointed. A CONFIG_UPDATE holder could send `host: <theirs>, password: <mask>`
   * and have the next mail deliver the real SMTP password to their server. A kept
   * secret now goes only where it went before.
   */
  describe('a kept secret never follows a new destination', () => {
    const MASK = '••••••••';
    let emailBefore: unknown = undefined;
    let smsBefore: unknown = undefined;

    beforeAll(async () => {
      emailBefore = (await prisma.systemConfig.findUnique({ where: { configKey: 'notification-email' } }))?.configValue ?? null;
      smsBefore = (await prisma.systemConfig.findUnique({ where: { configKey: 'notification-sms' } }))?.configValue ?? null;
    });
    afterAll(async () => {
      // Restore FIRST, each on its own guard (a suite hands back what it touched).
      for (const [key, before] of [['notification-email', emailBefore], ['notification-sms', smsBefore]] as const) {
        if (before === null) {
          await prisma.systemConfig.deleteMany({ where: { configKey: key } });
        } else {
          await prisma.systemConfig.updateMany({ where: { configKey: key }, data: { configValue: before as never } });
        }
      }
    });

    const putEmail = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: '/api/notification-settings/email', headers: auth(), payload });
    const storedEmail = async () =>
      (await prisma.systemConfig.findUnique({ where: { configKey: 'notification-email' } }))!.configValue as Record<string, unknown>;

    it('SMTP: a masked password with a changed port is refused, and nothing is written', async () => {
      expect((await putEmail({ host: 'smtp.dest.example', port: 587, enabled: false, password: 'DEST-PW' })).statusCode).toBe(200);
      const res = await putEmail({ host: 'smtp.dest.example', port: 2525, enabled: false, password: MASK });
      expect(res.statusCode).toBe(400);
      expect(res.json().field).toBe('password');
      expect(await storedEmail()).toMatchObject({ port: 587, password: 'DEST-PW' });
    });

    it('SMTP: a masked password with a changed host is refused', async () => {
      const res = await putEmail({ host: 'smtp.attacker.example', port: 587, enabled: false, password: MASK });
      expect(res.statusCode).toBe(400);
      expect(res.json().field).toBe('password');
      expect((await storedEmail()).host).toBe('smtp.dest.example');
    });

    it('SMTP: the same host in other case keeps the stored password', async () => {
      const res = await putEmail({ host: 'SMTP.Dest.example', port: 587, enabled: false, password: MASK, fromName: 'X' });
      expect(res.statusCode).toBe(200);
      expect((await storedEmail()).password).toBe('DEST-PW');
    });

    it('OAuth2: a masked client secret with a new token URL host is refused', async () => {
      expect((await putEmail({
        host: 'smtp.dest.example', port: 587, enabled: false, authType: 'oauth2',
        oauth2Provider: 'custom', tokenUrl: 'https://login.dest.example/oauth/token',
        clientSecret: 'DEST-CS', refreshToken: 'DEST-RT',
      })).statusCode).toBe(200);
      const res = await putEmail({
        host: 'smtp.dest.example', port: 587, enabled: false, authType: 'oauth2',
        oauth2Provider: 'custom', tokenUrl: 'https://login.attacker.example/oauth/token',
        clientSecret: MASK, refreshToken: MASK,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().field).toBe('clientSecret');
      expect(await storedEmail()).toMatchObject({
        clientSecret: 'DEST-CS', refreshToken: 'DEST-RT', tokenUrl: 'https://login.dest.example/oauth/token',
      });
    });

    it('OAuth2: a NEW client secret for a new provider is saved, and the old refresh token is NOT carried to it', async () => {
      const res = await putEmail({
        host: 'smtp.dest.example', port: 587, enabled: false, authType: 'oauth2',
        oauth2Provider: 'custom', tokenUrl: 'https://login.other.example/oauth/token',
        clientSecret: 'NEW-CS', refreshToken: MASK,
      });
      expect(res.statusCode).toBe(200);
      const stored = await storedEmail();
      expect(stored.clientSecret).toBe('NEW-CS');
      expect(stored.refreshToken).toBeUndefined();
      expect(stored.oauth2Configured).not.toBe(true);
    });

    // Final review #1: with OAuth2 the ACCESS TOKEN is presented to the SMTP
    // host:port (XOAUTH2), so a new SMTP host is a new destination for it too.
    it('OAuth2: a masked client secret with only the SMTP host or port changed is refused', async () => {
      expect((await putEmail({
        host: 'smtp.dest.example', port: 587, enabled: false, authType: 'oauth2',
        oauth2Provider: 'custom', tokenUrl: 'https://login.dest.example/oauth/token',
        clientSecret: 'HOST-CS', refreshToken: 'HOST-RT',
      })).statusCode).toBe(200);
      for (const moved of [{ host: 'smtp.attacker.example', port: 587 }, { host: 'smtp.dest.example', port: 2525 }]) {
        const res = await putEmail({
          ...moved, enabled: false, authType: 'oauth2',
          oauth2Provider: 'custom', tokenUrl: 'https://login.dest.example/oauth/token',
          clientSecret: MASK, refreshToken: MASK,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().field).toBe('clientSecret');
      }
      expect(await storedEmail()).toMatchObject({ host: 'smtp.dest.example', port: 587, clientSecret: 'HOST-CS', refreshToken: 'HOST-RT' });
    });

    it('OAuth2: a new token URL PATH on the same host keeps the stored secrets', async () => {
      expect((await putEmail({
        host: 'smtp.dest.example', port: 587, enabled: false, authType: 'oauth2',
        oauth2Provider: 'custom', tokenUrl: 'https://login.other.example/oauth/token',
        clientSecret: 'KEEP-CS', refreshToken: 'KEEP-RT',
      })).statusCode).toBe(200);
      const res = await putEmail({
        host: 'smtp.dest.example', port: 587, enabled: false, authType: 'oauth2',
        oauth2Provider: 'custom', tokenUrl: 'https://login.other.example/v2/oauth/token',
        clientSecret: MASK, refreshToken: MASK,
      });
      expect(res.statusCode).toBe(200);
      expect(await storedEmail()).toMatchObject({ clientSecret: 'KEEP-CS', refreshToken: 'KEEP-RT' });
    });

    const putSms = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: '/api/notification-settings/sms', headers: auth(), payload });
    const storedSms = async () =>
      (await prisma.systemConfig.findUnique({ where: { configKey: 'notification-sms' } }))!.configValue as Record<string, unknown>;

    it('SMS gateway: masked headers or URL secrets with a new gateway host are refused', async () => {
      expect((await putSms({
        provider: 'http-gateway', enabled: false,
        httpGatewayUrl: 'https://sms.dest.example/send?apikey=DEST-KEY&to={phone}',
        httpGatewayHeaders: { Authorization: 'Bearer DEST-BEARER' },
      })).statusCode).toBe(200);
      const viaHeader = await putSms({
        provider: 'http-gateway', enabled: false,
        httpGatewayUrl: 'https://sms.attacker.example/send?to={phone}',
        httpGatewayHeaders: { Authorization: MASK },
      });
      expect(viaHeader.statusCode).toBe(400);
      expect(viaHeader.json().field).toBe('httpGatewayHeaders');
      const viaUrl = await putSms({
        provider: 'http-gateway', enabled: false,
        httpGatewayUrl: `https://sms.attacker.example/send?apikey=${MASK}&to={phone}`,
        httpGatewayHeaders: { Authorization: 'Bearer typed-again' },
      });
      expect(viaUrl.statusCode).toBe(400);
      expect(viaUrl.json().field).toBe('httpGatewayUrl');
      expect((await storedSms()).httpGatewayUrl).toBe('https://sms.dest.example/send?apikey=DEST-KEY&to={phone}');
    });

    it('SMS gateway: the same host with masked secrets keeps them', async () => {
      const res = await putSms({
        provider: 'http-gateway', enabled: false,
        httpGatewayUrl: `https://sms.dest.example/v2/send?apikey=${MASK}&to={phone}`,
        httpGatewayHeaders: { Authorization: MASK },
      });
      expect(res.statusCode).toBe(200);
      const stored = await storedSms();
      expect(stored.httpGatewayUrl).toBe('https://sms.dest.example/v2/send?apikey=DEST-KEY&to={phone}');
      expect(stored.httpGatewayHeaders).toEqual({ Authorization: 'Bearer DEST-BEARER' });
    });
  });
});
