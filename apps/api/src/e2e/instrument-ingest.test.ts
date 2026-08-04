import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { generateToken, hashToken, tokenPrefix } from '../modules/instruments/token.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let token: string;
let instrumentId: string;

beforeAll(async () => {
  app = await buildApp();
  token = generateToken();
  const inst = await prisma.instrument.create({
    data: { name: 'Ingest Probe', code: `ING-${Date.now()}`, transport: 'http' },
  });
  instrumentId = inst.id;
  await prisma.instrumentCredential.create({
    data: { instrumentId, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) },
  });
});

afterAll(async () => {
  await prisma.instrument.delete({ where: { id: instrumentId } });
  await app.close();
});

describe('POST /api/ingest/v1/telemetry', () => {
  it('accepts readings with a valid token and stores them', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${token}` },
      payload: { temp: 22.5, rh: 45 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(2);

    const latest = await prisma.$queryRaw<Array<{ key: string }>>`
      SELECT key FROM instrument_telemetry_latest WHERE instrument_id = ${instrumentId} ORDER BY key`;
    expect(latest.map((r) => r.key)).toEqual(['rh', 'temp']);
  });

  it('rejects a missing token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ingest/v1/telemetry', payload: { a: 1 } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${generateToken()}` }, payload: { a: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('dead-letters malformed JSON instead of 500ing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: 'not json at all',
    });
    expect(res.statusCode).not.toBe(500);
  });
});
