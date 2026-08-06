import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let auth: Record<string, string>;
const created: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});
afterAll(async () => {
  for (const id of created) await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  await app.close();
});

async function mk(payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/api/instruments', headers: auth, payload });
  expect(res.statusCode).toBe(201);
  created.push(res.json().id);
  return res.json() as { id: string; code: string; token: string };
}
const ingest = (token: string, body: unknown) => app.inject({
  method: 'POST', url: '/api/ingest/v1/telemetry',
  headers: { authorization: `Bearer ${token}` }, payload: body as Record<string, unknown>,
});

describe('gateway ingest', () => {
  it('accepts a batch for its own children and attributes each block correctly', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GW', code: `GW-${s}`, transport: 'http', isGateway: true });
    const a = await mk({ name: 'A', code: `A-${s}`, transport: 'http', gatewayId: gw.id });
    const b = await mk({ name: 'B', code: `B-${s}`, transport: 'http', gatewayId: gw.id });

    const res = await ingest(gw.token, {
      devices: { [`A-${s}`]: { temperature: 21.5 }, [`B-${s}`]: { humidity: 47 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 2, rejected: 0 });

    const ta = await app.inject({ method: 'GET', url: `/api/instruments/${a.id}/telemetry`, headers: auth });
    expect(ta.json().latest.map((r: { key: string }) => r.key)).toEqual(['temperature']);
    const tb = await app.inject({ method: 'GET', url: `/api/instruments/${b.id}/telemetry`, headers: auth });
    expect(tb.json().latest.map((r: { key: string }) => r.key)).toEqual(['humidity']);
  });

  it('dead-letters a code it does not own and still stores the rest', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GW2', code: `GW2-${s}`, transport: 'http', isGateway: true });
    const a = await mk({ name: 'A2', code: `A2-${s}`, transport: 'http', gatewayId: gw.id });
    const orphan = await mk({ name: 'O', code: `O-${s}`, transport: 'http' });

    const res = await ingest(gw.token, {
      devices: { [`A2-${s}`]: { temperature: 1 }, [`O-${s}`]: { temperature: 2 } },
    });
    expect(res.json()).toEqual({ accepted: 1, rejected: 1 });

    // Filed against the GATEWAY, naming the code it tried to write.
    const dl = await app.inject({ method: 'GET', url: `/api/instruments/${gw.id}/dead-letters`, headers: auth });
    expect(dl.json().data[0].reason).toContain(`O-${s}`);

    // The orphan must have received nothing.
    const to = await app.inject({ method: 'GET', url: `/api/instruments/${orphan.id}/telemetry`, headers: auth });
    expect(to.json().latest).toEqual([]);
  });

  it('refuses a batch from an instrument that is not a gateway', async () => {
    const s = Date.now();
    const plain = await mk({ name: 'P', code: `P-${s}`, transport: 'http' });
    const res = await ingest(plain.token, { devices: { [`P-${s}`]: { temperature: 1 } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NOT_A_GATEWAY');
  });

  it('records the source: gateway for a relayed child, direct for its own post', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GW3', code: `GW3-${s}`, transport: 'http', isGateway: true });
    const c = await mk({ name: 'C', code: `C-${s}`, transport: 'http', gatewayId: gw.id });

    await ingest(gw.token, { devices: { [`C-${s}`]: { temperature: 3 } } });
    let row = await app.inject({ method: 'GET', url: `/api/instruments/${c.id}`, headers: auth });
    expect(row.json().lastSeenVia).toBe('gateway');
    expect(row.json().lastSeenAt).not.toBeNull();

    // The child keeps its own credential (spec D4) and using it flips the source.
    await ingest(c.token, { temperature: 4 });
    row = await app.inject({ method: 'GET', url: `/api/instruments/${c.id}`, headers: auth });
    expect(row.json().lastSeenVia).toBe('direct');
  });

  it('stamps the gateway itself as direct when it relays a batch, distinct from its children', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GW5', code: `GW5-${s}`, transport: 'http', isGateway: true });
    const e = await mk({ name: 'E', code: `E-${s}`, transport: 'http', gatewayId: gw.id });

    const res = await ingest(gw.token, { devices: { [`E-${s}`]: { temperature: 7 } } });
    expect(res.json()).toEqual({ accepted: 1, rejected: 0 });

    const gwRow = await app.inject({ method: 'GET', url: `/api/instruments/${gw.id}`, headers: auth });
    expect(gwRow.json().lastSeenVia).toBe('direct');
    expect(gwRow.json().lastSeenAt).not.toBeNull();

    const eRow = await app.inject({ method: 'GET', url: `/api/instruments/${e.id}`, headers: auth });
    expect(eRow.json().lastSeenVia).toBe('gateway');
  });

  it('stops writing a child the moment it is unlinked — no cache grace period', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GW4', code: `GW4-${s}`, transport: 'http', isGateway: true });
    const d = await mk({ name: 'D', code: `D-${s}`, transport: 'http', gatewayId: gw.id });

    expect((await ingest(gw.token, { devices: { [`D-${s}`]: { temperature: 5 } } })).json())
      .toEqual({ accepted: 1, rejected: 0 });

    await app.inject({
      method: 'PUT', url: `/api/instruments/${d.id}`, headers: auth, payload: { gatewayId: null },
    });

    // Proves link changes invalidate the child-map cache rather than waiting
    // out its 10s TTL.
    expect((await ingest(gw.token, { devices: { [`D-${s}`]: { temperature: 6 } } })).json())
      .toEqual({ accepted: 0, rejected: 1 });
  });
});
