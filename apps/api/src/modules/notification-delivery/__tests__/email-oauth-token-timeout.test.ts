import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * Performance audit 2026-11-17, G4-03: the OAuth2 token request had no time
 * limit. A token endpoint that accepted the connection and never answered held
 * the e-mail send — and the notification job and retry behind it — open for as
 * long as the socket lived. Every token request now carries
 * `AbortSignal.timeout(OAUTH_TOKEN_TIMEOUT_MS)`.
 *
 * The first block checks every provider's request carries a live signal; the
 * last drives the REAL fetch against a listener that never answers.
 */

const configRef: { current: Record<string, unknown> } = { current: {} };
vi.mock('../config-loader.js', () => ({ getEmailConfig: vi.fn(async () => configRef.current) }));
vi.mock('../../../lib/prisma.js', () => ({
  prisma: { systemConfig: { findUnique: vi.fn(async () => null), update: vi.fn(), upsert: vi.fn() } },
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({ sendMail: vi.fn(async () => ({ messageId: 'm-1' })), verify: vi.fn(async () => true) }),
  },
}));

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();

const base = {
  enabled: true, authType: 'oauth2', clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt',
  username: 'mailer@dest.example', host: 'smtp.dest.example', port: 587, secure: false,
  fromEmail: 'mailer@dest.example', fromName: 'Plant',
};

function tokenResponse(token: string) {
  return { ok: true, status: 200, text: async () => '', json: async () => ({ access_token: token, expires_in: 3600 }) };
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as never;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('G4-03: every OAuth2 token request is time-limited', () => {
  it.each([
    ['custom', { oauth2Provider: 'custom', tokenUrl: 'https://login.dest.example/token' }],
    ['microsoft', { oauth2Provider: 'microsoft', providerTenantId: 'tenant' }],
    ['google', { oauth2Provider: 'google' }],
  ])('the %s token request carries a live AbortSignal', async (_name, provider) => {
    const { emailChannel } = await import('../channels/email-channel.js');
    configRef.current = { ...base, ...provider };
    fetchMock.mockResolvedValueOnce(tokenResponse('T1'));
    await emailChannel.send({ recipient: 'a@x', subject: 's', message: 'm' } as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
  });
});

describe('G4-03: a token endpoint that never answers', () => {
  const sockets = new Set<Socket>();
  let server: http.Server;

  beforeEach(async () => {
    server = http.createServer(() => { /* accept the request and never answer */ });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  });
  afterEach(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fails the send after OAUTH_TOKEN_TIMEOUT_MS instead of hanging', async () => {
    globalThis.fetch = originalFetch; // the real fetch, over a real socket
    const { emailChannel, OAUTH_TOKEN_TIMEOUT_MS } = await import('../channels/email-channel.js');
    const port = (server.address() as AddressInfo).port;
    configRef.current = { ...base, oauth2Provider: 'custom', tokenUrl: `http://127.0.0.1:${port}/token` };

    const started = Date.now();
    const result = await emailChannel.send({ recipient: 'a@x', subject: 's', message: 'm' } as never);
    const elapsed = Date.now() - started;

    expect(result.success).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(OAUTH_TOKEN_TIMEOUT_MS - 500);
    expect(elapsed).toBeLessThan(OAUTH_TOKEN_TIMEOUT_MS + 5_000);
  }, 40_000);
});
