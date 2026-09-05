import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { generateToken, hashToken, tokenPrefix } from '../modules/instruments/token.js';
import { invalidateIngestAuthCache } from '../modules/instruments/ingest-auth.js';
import mqttAuthRoutes from '../modules/instruments/mqtt-auth-routes.js';

/**
 * `POST /api/ingest/v1/mqtt-auth` — the hook EMQX calls per CONNECT.
 *
 * Driven through the shared `buildApp()` on purpose: the route must be
 * registered there AND reachable without a user JWT. If it ever leaves the
 * auth-hook allowlist these tests get a 401 instead of a `deny`, which is the
 * intended coupling.
 */

const S = Date.now();
let app: FastifyInstance;

const instrumentIds: string[] = [];
let goodCode: string;
let goodId: string;
let goodToken: string;
let slashCode: string;
let slashToken: string;
let revokedCode: string;
let revokedToken: string;
let inactiveCode: string;
let inactiveToken: string;
let otherCode: string;

async function mkInstrument(
  code: string,
  extra: { isActive?: boolean } = {},
): Promise<{ id: string; token: string; credentialId: string }> {
  const inst = await prisma.instrument.create({
    data: { name: code, code, profileId: await fixtureProfileId('fixture:mqtt-auth'), ...extra },
  });
  instrumentIds.push(inst.id);
  const token = generateToken();
  const cred = await prisma.instrumentCredential.create({
    data: { instrumentId: inst.id, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) },
  });
  return { id: inst.id, token, credentialId: cred.id };
}

function ask(body: unknown) {
  return app.inject({ method: 'POST', url: '/api/ingest/v1/mqtt-auth', payload: body as object });
}

beforeAll(async () => {
  goodCode = `MQA-${S}`;
  const good = await mkInstrument(goodCode);
  goodToken = good.token;
  // The client id is the instrument's CODE (again) since 2026-09-04. The UUID
  // is kept here only to prove it is REFUSED — a device still configured with
  // the previous contract must fail at CONNECT, not silently publish nowhere.
  goodId = good.id;

  // The plant's real shape: three levels. The auth hook compares strings and
  // must not care, but the assertion is what proves that.
  slashCode = `CWH/MQA/${S}`;
  slashToken = (await mkInstrument(slashCode)).token;

  otherCode = `MQO-${S}`;
  await mkInstrument(otherCode);

  revokedCode = `MQR-${S}`;
  const revoked = await mkInstrument(revokedCode);
  revokedToken = revoked.token;
  await prisma.instrumentCredential.update({
    where: { id: revoked.credentialId }, data: { revokedAt: new Date() },
  });

  inactiveCode = `MQI-${S}`;
  const inactive = await mkInstrument(inactiveCode, { isActive: false });
  inactiveToken = inactive.token;

  invalidateIngestAuthCache();
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
  await prisma.instrument.deleteMany({ where: { id: { in: instrumentIds } } });
  invalidateIngestAuthCache();
});

describe('EMQX auth hook', () => {
  it('allows a valid token presented as the username, under the instrument CODE as client id', async () => {
    const res = await ask({ clientid: goodCode, username: goodToken, password: '' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: 'allow' });
  });

  it('allows a slash-separated code as the client id — CWH/RDU/001-00 is the plant\'s shape', async () => {
    const res = await ask({ clientid: slashCode, username: slashToken, password: '' });
    expect(JSON.parse(res.body)).toEqual({ result: 'allow' });
  });

  it('DENIES the instrument UUID as client id — the pre-2026-09-04 contract is not accepted', async () => {
    // One identity on the wire. A device left on the old contract must be
    // refused at CONNECT, where the failure is visible, rather than admitted
    // and then publishing to a topic the ACL denies.
    const res = await ask({ clientid: goodId, username: goodToken, password: '' });
    expect(JSON.parse(res.body)).toEqual({ result: 'deny' });
  });

  it('denies an unknown token', async () => {
    const res = await ask({ clientid: goodCode, username: generateToken(), password: '' });
    expect(JSON.parse(res.body)).toEqual({ result: 'deny' });
  });

  it('denies a REVOKED token — the property that justifies asking us per connection', async () => {
    // If EMQX held the credential itself, this token would keep working until
    // whatever sync interval the broker used caught up. It asks us instead, so
    // the revocation is in force on the very next CONNECT.
    const res = await ask({ clientid: revokedCode, username: revokedToken, password: '' });
    expect(JSON.parse(res.body)).toEqual({ result: 'deny' });
  });

  it('denies a valid token whose instrument is deactivated', async () => {
    const res = await ask({ clientid: inactiveCode, username: inactiveToken, password: '' });
    expect(JSON.parse(res.body)).toEqual({ result: 'deny' });
  });

  it('denies when the username is missing entirely', async () => {
    expect(JSON.parse((await ask({ clientid: goodCode, password: '' })).body))
      .toEqual({ result: 'deny' });
  });

  it('denies every unexpected body shape rather than erroring', async () => {
    // A non-2xx would read to EMQX as "the authenticator broke", not "denied".
    // Deny is the default for anything we do not recognise.
    for (const body of [{}, [], { clientid: goodCode, username: 42 }, { username: goodToken }, '']) {
      const res = await ask(body);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ result: 'deny' });
    }
  });

  it('denies a VALID token presented under another instrument\'s client id', async () => {
    // Leg 1 of the topic binding. EMQX's ACL can only template a topic on
    // ${clientid} (the username is the secret token and must never appear in a
    // topic), so `instruments/${clientid}/telemetry` is only an authorisation
    // rule if the client id is proved to belong to the token. Delete this check
    // and any valid device can publish as any other instrument.
    const res = await ask({ clientid: otherCode, username: goodToken, password: '' });
    expect(JSON.parse(res.body)).toEqual({ result: 'deny' });
  });

  it('carries a route-level rate limit', async () => {
    // CONFIGURED, not exercised: `@fastify/rate-limit` is registered in app.ts
    // and NOT in test-helper.ts, so hammering the route here would prove
    // nothing. Capture the route options the plugin would read instead.
    const probe = Fastify({ logger: false });
    let cfg: unknown;
    probe.addHook('onRoute', (r) => {
      if (r.url.endsWith('/mqtt-auth')) cfg = (r.config as { rateLimit?: unknown })?.rateLimit;
    });
    await probe.register(mqttAuthRoutes, { prefix: '/api/ingest/v1' });
    await probe.ready();
    await probe.close();
    expect(cfg).toEqual({ max: 600, timeWindow: '1 minute' });
  });
});
