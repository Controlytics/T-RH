import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

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
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { profileId: await fixtureProfileId('fixture:gateway-ingest'), ...payload },
  });
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
    const gw = await mk({ name: 'GW', code: `GW-${s}`, isGateway: true });
    const a = await mk({ name: 'A', code: `A-${s}`, gatewayId: gw.id });
    const b = await mk({ name: 'B', code: `B-${s}`, gatewayId: gw.id });

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

  it('accepts the devices LIST with the code under `devN`, and never stores `devN` as a reading', async () => {
    // Operator, 2026-09-05: "devN is common key for all, value will change".
    const s = Date.now();
    const gw = await mk({ name: 'GWS', code: `GWS-${s}`, isGateway: true });
    const a = await mk({ name: 'SA', code: `SA-${s}`, gatewayId: gw.id });
    const b = await mk({ name: 'SB', code: `SB-${s}`, gatewayId: gw.id });

    const res = await ingest(gw.token, {
      devices: [
        { devN: `SA-${s}`, temperature: 21.5, humidity: 47 },
        { devN: `SB-${s}`, temperature: 22.5, humidity: 48 },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 4, rejected: 0 });

    const ta = await app.inject({ method: 'GET', url: `/api/instruments/${a.id}/telemetry`, headers: auth });
    expect(ta.json().latest.map((r: { key: string }) => r.key).sort()).toEqual(['humidity', 'temperature']);
    expect(ta.json().latest.find((r: { key: string }) => r.key === 'temperature').value).toBe(21.5);
    const tb = await app.inject({ method: 'GET', url: `/api/instruments/${b.id}/telemetry`, headers: auth });
    expect(tb.json().latest.find((r: { key: string }) => r.key === 'temperature').value).toBe(22.5);

    // A slot naming an instrument this gateway does not own is dead-lettered
    // by CODE, and the rest of the batch still lands.
    const res2 = await ingest(gw.token, {
      devices: [{ devN: `SA-${s}`, temperature: 1 }, { devN: `NOBODY-${s}`, temperature: 2 }],
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual({ accepted: 1, rejected: 1 });
  });

  it('routes a gateway\'s FLAT message carrying `devN` to that child — one child per message', async () => {
    // The plant's firmware form, found in the data on 2026-09-05: each sensor
    // published flat on the gateway's topic, naming the child under `devN`.
    // Before this, 110 of them had landed on the gateway itself.
    const s = Date.now();
    const gw = await mk({ name: 'GWF', code: `GWF-${s}`, isGateway: true });
    const a = await mk({ name: 'FA', code: `FA-${s}`, gatewayId: gw.id });

    const res = await ingest(gw.token, { devN: `FA-${s}`, id: 2, ty: 2, t: '20.3', h: '60.9' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 4, rejected: 0 });

    const ta = await app.inject({ method: 'GET', url: `/api/instruments/${a.id}/telemetry`, headers: auth });
    const keys = ta.json().latest.map((r: { key: string }) => r.key).sort();
    expect(keys).toEqual(['h', 'id', 't', 'ty']);          // `devN` is NOT a reading
    // Nothing landed on the gateway.
    const tg = await app.inject({ method: 'GET', url: `/api/instruments/${gw.id}/telemetry`, headers: auth });
    expect(tg.json().latest).toEqual([]);

    // A gateway's flat message WITHOUT `devN` is still its own reading.
    const own = await ingest(gw.token, { rssi: -60 });
    expect(own.json()).toEqual({ accepted: 1 });
    const tg2 = await app.inject({ method: 'GET', url: `/api/instruments/${gw.id}/telemetry`, headers: auth });
    expect(tg2.json().latest.map((r: { key: string }) => r.key)).toEqual(['rssi']);

    // And a `devN` naming an instrument this gateway does not own is dead-lettered.
    const foreign = await ingest(gw.token, { devN: `NOBODY-${s}`, t: 1 });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json()).toEqual({ accepted: 0, rejected: 1 });
  });

  it('dead-letters a code it does not own and still stores the rest', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GW2', code: `GW2-${s}`, isGateway: true });
    const a = await mk({ name: 'A2', code: `A2-${s}`, gatewayId: gw.id });
    const orphan = await mk({ name: 'O', code: `O-${s}` });

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

  /**
   * The batch path used to write one dead-letter row PER rejected code, each
   * carrying its own copy of the up-to-4000-char raw payload. A misconfigured
   * or hostile gateway posting a body of ~1000 unknown codes therefore turned
   * one request into ~1000 rows x 4 KB, at a 600 req/min rate limit — and
   * `GET /:id/dead-letters` caps at 200, so the operator could not even see the
   * flood. The flat path has always written exactly one row per request.
   */
  it('caps dead-letters per batch and stores the payload only once', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GWC', code: `GWC-${s}`, isGateway: true });

    const devices: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) devices[`GHOST-${s}-${i}`] = { temperature: i };
    const res = await ingest(gw.token, { devices });
    expect(res.statusCode).toBe(200);
    // Every block is still REJECTED and reported — the cap is on rows written,
    // not on what the caller is told.
    expect(res.json()).toEqual({ accepted: 0, rejected: 25 });

    const dl = await app.inject({
      method: 'GET', url: `/api/instruments/${gw.id}/dead-letters?limit=200`, headers: auth,
    });
    // 20 individual rows + 1 summary.
    expect(dl.json().total).toBe(21);

    const rows = dl.json().data as { reason: string; rawPayload: string | null }[];
    // The payload was identical on every row; keeping 21 copies was the bulk of
    // the amplification.
    expect(rows.filter((r) => r.rawPayload !== null)).toHaveLength(1);

    // The summary names the real total, so the operator is not left believing
    // only 20 blocks were bad.
    const summary = rows.filter((r) => /only the first/.test(r.reason));
    expect(summary).toHaveLength(1);
    expect(summary[0].reason).toContain('25 rejected blocks');
  });

  it('writes no summary row when the batch is under the cap', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GWU', code: `GWU-${s}`, isGateway: true });

    const devices: Record<string, unknown> = {};
    for (let i = 0; i < 3; i++) devices[`GHOSTU-${s}-${i}`] = { temperature: i };
    await ingest(gw.token, { devices });

    const dl = await app.inject({ method: 'GET', url: `/api/instruments/${gw.id}/dead-letters`, headers: auth });
    expect(dl.json().total).toBe(3);
    expect((dl.json().data as { reason: string }[]).some((r) => /only the first/.test(r.reason))).toBe(false);
  });

  /**
   * A gateway's own code is never in its own child map, so folding its own
   * diagnostics into a batch hit the generic "not linked to gateway" reason —
   * which said `"GW-1" is not linked to gateway "GW-1"`. True, and useless.
   */
  it('explains the self-code rejection instead of saying a gateway is not linked to itself', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GWS', code: `GWS-${s}`, isGateway: true });

    const res = await ingest(gw.token, { devices: { [`GWS-${s}`]: { temperature: 1 } } });
    expect(res.json()).toEqual({ accepted: 0, rejected: 1 });

    const dl = await app.inject({ method: 'GET', url: `/api/instruments/${gw.id}/dead-letters`, headers: auth });
    const reason = dl.json().data[0].reason as string;
    expect(reason).toContain('cannot report its own readings inside a batch');
    expect(reason).toContain('flat payload');
    expect(reason).not.toContain('is not linked to gateway');
  });

  /** ...and the remedy that reason names must actually work. */
  it('accepts the gateway\'s own readings on the flat path', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GWF', code: `GWF-${s}`, isGateway: true });

    const res = await ingest(gw.token, { temperature: 42 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1 });

    const t = await app.inject({ method: 'GET', url: `/api/instruments/${gw.id}/telemetry`, headers: auth });
    expect(t.json().latest.map((r: { key: string }) => r.key)).toEqual(['temperature']);
  });

  it('refuses a batch from an instrument that is not a gateway', async () => {
    const s = Date.now();
    const plain = await mk({ name: 'P', code: `P-${s}` });
    const res = await ingest(plain.token, { devices: { [`P-${s}`]: { temperature: 1 } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NOT_A_GATEWAY');
  });

  it('records the source: gateway for a relayed child, direct for its own post', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GW3', code: `GW3-${s}`, isGateway: true });
    const c = await mk({ name: 'C', code: `C-${s}`, gatewayId: gw.id });

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
    const gw = await mk({ name: 'GW5', code: `GW5-${s}`, isGateway: true });
    const e = await mk({ name: 'E', code: `E-${s}`, gatewayId: gw.id });

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
    const gw = await mk({ name: 'GW4', code: `GW4-${s}`, isGateway: true });
    const d = await mk({ name: 'D', code: `D-${s}`, gatewayId: gw.id });

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

/**
 * Audit 2026-10-12, findings 4 and 5, through the real database: a block
 * older than every partition is dead-lettered and counted rejected while the
 * good child still lands (it used to sink the batch with a 503 the gateway
 * retried forever); a flat reading that old is a non-retryable 422; and a
 * payload that stores nothing does not stamp last-seen.
 */
describe('ingest — unplaceable readings and empty payloads', () => {
  const OLD = '2019-06-01T00:00:00Z';

  it('stores the good child and rejects only the block older than every partition', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GWP', code: `GWP-${s}`, isGateway: true });
    const a = await mk({ name: 'PA', code: `PA-${s}`, gatewayId: gw.id });
    const b = await mk({ name: 'PB', code: `PB-${s}`, gatewayId: gw.id });

    const res = await ingest(gw.token, {
      devices: { [`PA-${s}`]: { temperature: 1, ts: OLD }, [`PB-${s}`]: { temperature: 2 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1, rejected: 1 });

    const tb = await app.inject({ method: 'GET', url: `/api/instruments/${b.id}/telemetry`, headers: auth });
    expect(tb.json().latest.find((r: { key: string }) => r.key === 'temperature').value).toBe(2);
    const ta = await app.inject({ method: 'GET', url: `/api/instruments/${a.id}/telemetry`, headers: auth });
    expect(ta.json().latest).toEqual([]);
    const dl = await app.inject({ method: 'GET', url: `/api/instruments/${gw.id}/dead-letters`, headers: auth });
    expect(JSON.stringify(dl.json())).toContain('earliest stored partition');
  });

  it('refuses a flat reading older than every partition with a non-retryable 422', async () => {
    const s = Date.now();
    const x = await mk({ name: 'PX', code: `PX-${s}` });
    const res = await ingest(x.token, { temperature: 3, ts: OLD });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('TIMESTAMP_OUT_OF_RANGE');
  });

  it('an all-null or empty payload does not stamp last-seen', async () => {
    const s = Date.now();
    const x = await mk({ name: 'PN', code: `PN-${s}` });
    expect((await ingest(x.token, { t: null, h: null })).statusCode).toBe(200);
    expect((await ingest(x.token, {})).statusCode).toBe(200);
    const row = await app.inject({ method: 'GET', url: `/api/instruments/${x.id}`, headers: auth });
    expect(row.json().lastSeenAt ?? null).toBeNull();
    // Positive control: a real reading DOES stamp, so the null above is not
    // just a field the response never carries.
    expect((await ingest(x.token, { t: 21 })).statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: `/api/instruments/${x.id}`, headers: auth });
    expect(after.json().lastSeenAt).toBeTruthy();
  });
});
