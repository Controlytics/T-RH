import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let auth: Record<string, string>;
const created: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  // loginAs returns a RAW TOKEN STRING, not a headers object.
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});

afterAll(async () => {
  for (const id of created) await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  await app.close();
});

async function create(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/instruments', headers: auth, payload });
}

describe('Instruments registry', () => {
  it('creates an instrument and returns the token EXACTLY once', async () => {
    const res = await create({ name: 'Probe', code: `P-${Date.now()}`, transport: 'http' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    created.push(body.id);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    // Re-reading must NOT expose it.
    const again = await app.inject({ method: 'GET', url: `/api/instruments/${body.id}`, headers: auth });
    expect(again.json().token).toBeUndefined();
    expect(again.json().tokenPrefix).toBeDefined();

    // Nor must the list.
    const list = await app.inject({ method: 'GET', url: `/api/instruments?search=${body.code}`, headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().data[0].token).toBeUndefined();
    expect(list.json().data[0].tokenPrefix).toBe(body.tokenPrefix);
  });

  it('rejects a duplicate code', async () => {
    const code = `DUP-${Date.now()}`;
    const a = await create({ name: 'A', code, transport: 'http' });
    created.push(a.json().id);
    const b = await create({ name: 'B', code, transport: 'http' });
    expect(b.statusCode).toBe(409);
  });

  it('rejects an unknown transport', async () => {
    const res = await create({ name: 'X', code: `X-${Date.now()}`, transport: 'carrier-pigeon' });
    expect(res.statusCode).toBe(400);
  });

  it('bulk-creates with partial success and returns one token per created row', async () => {
    const stamp = Date.now();
    const csv = `name,code,transport\nBulk A,BA-${stamp},http\nBulk B,BB-${stamp},nonsense`;
    const res = await app.inject({ method: 'POST', url: '/api/instruments/bulk', headers: auth, payload: { csv } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toHaveLength(1);
    expect(body.created[0].token).toBeDefined();
    expect(body.errors).toHaveLength(1);
    created.push(body.created[0].id);
  });

  it('reports a DB code collision as an error row with its SOURCE row number, not a failed batch', async () => {
    const stamp = Date.now();
    const taken = `COL-${stamp}`;
    const first = await create({ name: 'Taken', code: taken, transport: 'http' });
    created.push(first.json().id);

    // Row 2 collides with the instrument above; rows 3 and 4 must still land.
    const csv = `name,code,transport\nDup,${taken},http\nFresh 1,F1-${stamp},http\nFresh 2,F2-${stamp},mqtt`;
    const res = await app.inject({ method: 'POST', url: '/api/instruments/bulk', headers: auth, payload: { csv } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const c of body.created) created.push(c.id);

    expect(body.created).toHaveLength(2);
    expect(body.errors).toEqual([{ row: 2, message: `code "${taken}" already exists` }]);
  });

  it('updates an instrument but never its code', async () => {
    const code = `UPD-${Date.now()}`;
    const res = await create({ name: 'Before', code, transport: 'http' });
    const id = res.json().id;
    created.push(id);

    const put = await app.inject({
      method: 'PUT', url: `/api/instruments/${id}`, headers: auth,
      payload: { name: 'After', code: 'HIJACKED', isActive: false },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().name).toBe('After');
    expect(put.json().code).toBe(code);
    expect(put.json().isActive).toBe(false);
  });

  it('404s on an unknown instrument', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/instruments/00000000-0000-0000-0000-000000000000', headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/instruments' })).statusCode).toBe(401);
  });

  it('refuses a non-privileged role — the permission gate, not just the login', async () => {
    // admin is SUPER_ADMIN and bypasses requirePermission entirely, so every
    // other test in this file would still pass with a misspelt permission
    // string. RB0001 is the OPERATOR fixture from vitest.global-setup.ts.
    const operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
    const read = await app.inject({ method: 'GET', url: '/api/instruments', headers: operator });
    expect(read.statusCode).toBe(403);
    const write = await app.inject({
      method: 'POST', url: '/api/instruments', headers: operator,
      payload: { name: 'Nope', code: `NO-${Date.now()}`, transport: 'http' },
    });
    expect(write.statusCode).toBe(403);

    // Restore the shared admin session this file's remaining work depends on.
    auth = { authorization: `Bearer ${await loginAs(app)}` };
  });
});

describe('Instrument token lifecycle', () => {
  it('issues a working token, and regeneration revokes the old one immediately', async () => {
    const res = await create({ name: 'Live', code: `LIVE-${Date.now()}`, transport: 'http' });
    const { id, token: oldToken } = res.json();
    created.push(id);

    const ingest = (t: string) => app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${t}` },
      payload: { temperature: 21.5 },
    });

    const before = await ingest(oldToken);
    expect(before.statusCode).toBe(200);
    expect(before.json().accepted).toBe(1);

    const regen = await app.inject({ method: 'POST', url: `/api/instruments/${id}/regenerate-token`, headers: auth });
    expect(regen.statusCode).toBe(200);
    const newToken = regen.json().token;
    expect(newToken).not.toBe(oldToken);

    // No TTL wait: the route calls invalidateIngestAuthCache(id), so the next
    // request re-reads the DB and sees revokedAt set. If that call is ever
    // dropped, this fails rather than passing 10 seconds later.
    expect((await ingest(oldToken)).statusCode).toBe(401);
    expect((await ingest(newToken)).statusCode).toBe(200);
  });

  it('stamps lastSeenAt when the device authenticates, so the list can answer "is it talking?"', async () => {
    const res = await create({ name: 'Seen', code: `SEEN-${Date.now()}`, transport: 'http' });
    const { id, token } = res.json();
    created.push(id);

    const before = await app.inject({ method: 'GET', url: `/api/instruments/${id}`, headers: auth });
    expect(before.json().lastSeenAt).toBeNull();

    await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${token}` },
      payload: { temperature: 20 },
    });

    const after = await app.inject({ method: 'GET', url: `/api/instruments/${id}`, headers: auth });
    expect(after.json().lastSeenAt).not.toBeNull();
  });

  it('stops ingest the moment an instrument is deactivated', async () => {
    const res = await create({ name: 'Toggle', code: `TOG-${Date.now()}`, transport: 'http' });
    const { id, token } = res.json();
    created.push(id);

    await app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers: auth, payload: { isActive: false } });

    const after = await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${token}` },
      payload: { temperature: 9 },
    });
    expect(after.statusCode).toBe(401);
  });
});
