import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Final review of audit remediation Batch 1 (S6-3, finding #1): with OAuth2 the
 * ACCESS TOKEN is presented to the SMTP server (XOAUTH2). The channel cached the
 * token in module state, returned for ANY config — so after an administrator
 * re-pointed the SMTP host (or the provider), the token fetched for the old one
 * went to the new host on the next send, with no secret ever being typed. The
 * cache now belongs to the destination it was issued for.
 */

const configRef: { current: Record<string, unknown> } = { current: {} };
vi.mock('../config-loader.js', () => ({ getEmailConfig: vi.fn(async () => configRef.current) }));
vi.mock('../../../lib/prisma.js', () => ({ prisma: { systemConfig: { findUnique: vi.fn(), update: vi.fn() } } }));

const createTransport = vi.fn((_opts: Record<string, unknown>) => ({
  sendMail: vi.fn(async () => ({ messageId: 'm-1' })),
  verify: vi.fn(async () => true),
}));
vi.mock('nodemailer', () => ({ default: { createTransport: (o: Record<string, unknown>) => createTransport(o) } }));

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();

const base = {
  enabled: true, authType: 'oauth2', oauth2Provider: 'custom', tokenUrl: 'https://login.dest.example/token',
  clientId: 'cid', clientSecret: 'cs', username: 'mailer@dest.example', port: 587, secure: false,
  fromEmail: 'mailer@dest.example', fromName: 'Plant',
};

function tokenResponse(token: string) {
  return { ok: true, status: 200, text: async () => '', json: async () => ({ access_token: token, expires_in: 3600 }) };
}

const tokenSentTo = (host: string) =>
  createTransport.mock.calls
    .map(([o]) => o as { host: string; auth: { accessToken: string } })
    .filter((o) => o.host === host)
    .map((o) => o.auth.accessToken);

beforeEach(() => {
  vi.resetModules();
  createTransport.mockClear();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as never;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('the OAuth2 access token cache', () => {
  it('is reused for the SAME destination (no second token request)', async () => {
    const { emailChannel } = await import('../channels/email-channel.js');
    configRef.current = { ...base, host: 'smtp.dest.example' };
    fetchMock.mockResolvedValueOnce(tokenResponse('T1'));
    await emailChannel.send({ recipient: 'a@x', subject: 's', message: 'm' } as never);
    await emailChannel.send({ recipient: 'a@x', subject: 's', message: 'm' } as never);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenSentTo('smtp.dest.example')).toEqual(['T1', 'T1']);
  });

  it('is NOT sent to a new SMTP host: a changed host fetches its own token', async () => {
    const { emailChannel } = await import('../channels/email-channel.js');
    configRef.current = { ...base, host: 'smtp.dest.example' };
    fetchMock.mockResolvedValueOnce(tokenResponse('T1'));
    await emailChannel.send({ recipient: 'a@x', subject: 's', message: 'm' } as never);

    configRef.current = { ...base, host: 'smtp.attacker.example' };
    fetchMock.mockResolvedValueOnce(tokenResponse('T2'));
    await emailChannel.send({ recipient: 'a@x', subject: 's', message: 'm' } as never);

    expect(tokenSentTo('smtp.attacker.example')).not.toContain('T1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('is not reused for another token URL either', async () => {
    const { emailChannel } = await import('../channels/email-channel.js');
    configRef.current = { ...base, host: 'smtp.dest.example' };
    fetchMock.mockResolvedValueOnce(tokenResponse('T1'));
    await emailChannel.send({ recipient: 'a@x', subject: 's', message: 'm' } as never);

    configRef.current = { ...base, host: 'smtp.dest.example', tokenUrl: 'https://login.other.example/token' };
    fetchMock.mockResolvedValueOnce(tokenResponse('T3'));
    await emailChannel.send({ recipient: 'a@x', subject: 's', message: 'm' } as never);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokenSentTo('smtp.dest.example')).toEqual(['T1', 'T3']);
  });
});
