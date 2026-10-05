import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { publicBaseUrl } from '../modules/notification-delivery/routes.js';

/**
 * The OAuth2 redirect URI is built from ONE origin rule (audit 2026-10-03,
 * SEC-6): `PUBLIC_BASE_URL` when configured, else Fastify's own
 * `req.protocol` / `req.host`. The three OAuth2 routes used to read the raw
 * `x-forwarded-host` / `x-forwarded-proto` headers regardless of `trustProxy`,
 * so on a direct deployment any client could steer the redirect URI, and the
 * scheme defaulted to `http` on an HTTPS install.
 *
 * `buildApp()` has no trustProxy, like the AWS unit. The trustProxy-on case is
 * proven on a bare Fastify instance, because that behaviour is Fastify's and
 * the helper must simply defer to it.
 */
const CALLBACK = '/api/notification-settings/email/oauth2/code';

describe('OAuth2 redirect URI origin (SEC-6)', () => {
  let app: FastifyInstance;
  let token: string;
  const savedBaseUrl = process.env.PUBLIC_BASE_URL;

  beforeAll(async () => {
    app = await buildApp();
    token = await loginAs(app);
  });

  afterAll(async () => {
    if (savedBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = savedBaseUrl;
    await app.close();
  });

  it('ignores X-Forwarded-Host / X-Forwarded-Proto when trustProxy is off', async () => {
    delete process.env.PUBLIC_BASE_URL;
    const res = await app.inject({
      method: 'GET',
      url: '/api/notification-settings/email/oauth2/redirect-uri',
      headers: {
        authorization: `Bearer ${token}`,
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'https',
      },
    });
    expect(res.statusCode).toBe(200);
    const { redirectUri } = JSON.parse(res.body);
    expect(redirectUri).not.toContain('attacker.example');
    // inject() presents Host: localhost:80 over a plain socket.
    expect(redirectUri).toBe(`http://localhost:80${CALLBACK}`);
  });

  it('uses PUBLIC_BASE_URL verbatim (minus a trailing slash) when configured', async () => {
    process.env.PUBLIC_BASE_URL = 'https://digilog.pharma.local/';
    const res = await app.inject({
      method: 'GET',
      url: '/api/notification-settings/email/oauth2/redirect-uri',
      headers: {
        authorization: `Bearer ${token}`,
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'https',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).redirectUri).toBe(`https://digilog.pharma.local${CALLBACK}`);
  });

  it('a blank PUBLIC_BASE_URL counts as unset', async () => {
    process.env.PUBLIC_BASE_URL = '   ';
    const res = await app.inject({
      method: 'GET',
      url: '/api/notification-settings/email/oauth2/redirect-uri',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(res.body).redirectUri).toBe(`http://localhost:80${CALLBACK}`);
  });

  it('honours the forwarded headers ONLY on an app built with trustProxy', async () => {
    delete process.env.PUBLIC_BASE_URL;
    const probe = async (trustProxy: boolean) => {
      const bare = Fastify({ logger: false, trustProxy });
      bare.get('/origin', async (req) => ({ origin: publicBaseUrl(req) }));
      await bare.ready();
      const res = await bare.inject({
        method: 'GET', url: '/origin',
        headers: { 'x-forwarded-host': 'digilog.pharma.local', 'x-forwarded-proto': 'https' },
      });
      await bare.close();
      return JSON.parse(res.body).origin as string;
    };
    expect(await probe(true)).toBe('https://digilog.pharma.local');
    expect(await probe(false)).toBe('http://localhost:80');
  });
});
