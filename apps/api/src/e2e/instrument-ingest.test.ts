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

  // NOTE: sending literally-invalid JSON (e.g. `'not json at all'`) never
  // reaches this route's handler — Fastify's built-in JSON body parser
  // rejects it during body parsing and the app's global error handler
  // returns 400 before our code runs. To exercise OUR dead-letter path we
  // need a payload that is syntactically valid JSON but semantically wrong
  // (parsePayload rejects non-object top-level values, e.g. an array).
  it('dead-letters a well-formed-but-non-object payload (202) and records the reason', async () => {
    const before = await prisma.deadLetter.count({ where: { instrumentId } });

    const res = await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${token}` },
      payload: [1, 2, 3],
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(0);

    const rows = await prisma.deadLetter.findMany({
      where: { instrumentId }, orderBy: { receivedAt: 'desc' }, take: 1,
    });
    expect(rows.length).toBe(before + 1);
    expect(rows[0].reason).toBe('Payload must be a JSON object');
  });

  it('rejects a devices (batch) payload with 400 instead of silently dropping it', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${token}` },
      payload: { devices: { dev1: { temp: 1 } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('UNSUPPORTED_BATCH_PAYLOAD');
  });

  it('rejects a payload over the key-count limit with 400', async () => {
    const values: Record<string, number> = {};
    for (let i = 0; i < 1001; i++) values[`k${i}`] = i;

    const res = await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${token}` },
      payload: values,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('TOO_MANY_KEYS');
  });

  it('rejects an oversized body with 413 before the token is even checked', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { 'content-type': 'application/json' }, // no Authorization header at all
      payload: JSON.stringify({ blob: 'x'.repeat(200_000) }), // > 64 KB route bodyLimit
    });
    expect(res.statusCode).toBe(413);
  });
});
