import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { updateInstrumentSchema } from '@digilog/shared';
import { prisma } from '../lib/prisma.js';
import { lockedGatewayRecheck, GatewayInvariantViolation } from '../modules/instruments/gateway-invariants.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

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
  return app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    // Default profile so each test states only the fields it is about; a test
    // that cares about the profile passes its own and wins the spread.
    payload: { profileId: await fixtureProfileId('fixture:instruments'), ...payload },
  });
}

describe('Instruments registry', () => {
  it('creates an instrument and returns the token EXACTLY once', async () => {
    const res = await create({ name: 'Probe', code: `P-${Date.now()}` });
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
    const a = await create({ name: 'A', code });
    created.push(a.json().id);
    const b = await create({ name: 'B', code });
    expect(b.statusCode).toBe(409);
  });

  it('bulk-creates with partial success and returns one token per created row', async () => {
    const stamp = Date.now();
    // A blank NAME is no longer an error (it becomes the code, 2026-09-16); a
    // blank CODE still is.
    const csv = `name,code\nBulk A,BA-${stamp}\nBulk B,`;
    const res = await app.inject({
      method: 'POST', url: '/api/instruments/bulk', headers: auth,
      payload: { csv, profileId: await fixtureProfileId('fixture:instruments') },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toHaveLength(1);
    expect(body.created[0].token).toBeDefined();
    expect(body.errors).toHaveLength(1);
    created.push(body.created[0].id);
  });

  // `transport` was a REQUIRED CSV column until 2026-08-06. Operators have
  // saved spreadsheets that still carry it; those must keep importing rather
  // than becoming a file of error rows. The end-to-end guard on that promise.
  it('still imports a legacy CSV that carries the retired `transport` column, warning once', async () => {
    const stamp = Date.now();
    const csv = `name,code,transport\nLegacy A,LA-${stamp},http\nLegacy B,LB-${stamp},carrier-pigeon`;
    const res = await app.inject({
      method: 'POST', url: '/api/instruments/bulk', headers: auth,
      payload: { csv, profileId: await fixtureProfileId('fixture:instruments') },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const c of body.created) created.push(c.id);

    // Both rows land — including the one whose transport value is nonsense,
    // because nothing reads that cell any more.
    expect(body.created).toHaveLength(2);
    expect(body.errors).toEqual([]);
    // But the operator is told, once, that the column did nothing.
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatch(/transport/i);

    // And the value was genuinely discarded, not quietly persisted.
    const got = await app.inject({ method: 'GET', url: `/api/instruments/${body.created[0].id}`, headers: auth });
    expect(got.json()).not.toHaveProperty('transport');
  });

  it('reports a DB code collision as an error row with its SOURCE row number, not a failed batch', async () => {
    const stamp = Date.now();
    const taken = `COL-${stamp}`;
    const first = await create({ name: 'Taken', code: taken });
    created.push(first.json().id);

    // Row 2 collides with the instrument above; rows 3 and 4 must still land.
    const csv = `name,code\nDup,${taken}\nFresh 1,F1-${stamp}\nFresh 2,F2-${stamp}`;
    const res = await app.inject({
      method: 'POST', url: '/api/instruments/bulk', headers: auth,
      payload: { csv, profileId: await fixtureProfileId('fixture:instruments') },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const c of body.created) created.push(c.id);

    expect(body.created).toHaveLength(2);
    expect(body.errors).toEqual([{ row: 2, message: `code "${taken}" already exists` }]);
  });

  it('updates an instrument but never its code', async () => {
    const code = `UPD-${Date.now()}`;
    const res = await create({ name: 'Before', code });
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
    // The payload must be otherwise VALID. Fastify validates the body before it
    // runs preHandler, so an incomplete payload answers 400 and this assertion
    // would pass without the permission gate ever being consulted — the exact
    // false green this test exists to prevent.
    const write = await app.inject({
      method: 'POST', url: '/api/instruments', headers: operator,
      payload: {
        name: 'Nope', code: `NO-${Date.now()}`,
        profileId: await fixtureProfileId('fixture:instruments'),
      },
    });
    expect(write.statusCode).toBe(403);

    // Restore the shared admin session this file's remaining work depends on.
    auth = { authorization: `Bearer ${await loginAs(app)}` };
  });
});

describe('Instrument token lifecycle', () => {
  it('issues a working token, and regeneration revokes the old one immediately', async () => {
    const res = await create({ name: 'Live', code: `LIVE-${Date.now()}` });
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

    // No password → 401, with NOTHING configured in `action-reauth`. This file
    // never touches that config, so the state here is a stock install's: before
    // 2026-08-06 the endpoint used the admin-configurable `enforceReauth` and
    // this request returned 200 with a live plaintext credential in its body.
    const bare = await app.inject({ method: 'POST', url: `/api/instruments/${id}/regenerate-token`, headers: auth });
    expect(bare.statusCode).toBe(401);
    expect(bare.json().error).toBe('REAUTH_REQUIRED');
    expect(bare.json().token).toBeUndefined();
    // The refusal revoked nothing — the device is still authenticating.
    expect((await ingest(oldToken)).statusCode).toBe(200);

    const regen = await app.inject({
      method: 'POST', url: `/api/instruments/${id}/regenerate-token`,
      headers: { ...auth, 'x-reauth-password': 'Admin@123' },
    });
    expect(regen.statusCode).toBe(200);
    const newToken = regen.json().token;
    expect(newToken).not.toBe(oldToken);

    // No TTL wait: the route calls invalidateIngestAuthCache(id), so the next
    // request re-reads the DB and sees revokedAt set. If that call is ever
    // dropped, this fails rather than passing 10 seconds later.
    expect((await ingest(oldToken)).statusCode).toBe(401);
    expect((await ingest(newToken)).statusCode).toBe(200);
  });

  // lastSeenAt means "a reading landed", NOT "the device authenticated": a
  // device that authenticates and then sends garbage every second must not look
  // healthy. The dead-letters panel is what diagnoses that case.
  it('stamps lastSeenAt when a reading lands, so the list can answer "is it talking?"', async () => {
    const res = await create({ name: 'Seen', code: `SEEN-${Date.now()}` });
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
    const res = await create({ name: 'Toggle', code: `TOG-${Date.now()}` });
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

describe('Instrument gateway links', () => {
  const mk = async (payload: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth,
      payload: { profileId: await fixtureProfileId('fixture:instruments'), ...payload },
    });
    if (res.statusCode === 201) created.push(res.json().id);
    return res;
  };

  it('stores placement fields', async () => {
    const res = await mk({
      name: 'Placed', code: `PL-${Date.now()}`,
      block: 'Block C', area: 'Sterile Core', location: 'Room 214',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ block: 'Block C', area: 'Sterile Core', location: 'Room 214' });
  });

  it('refuses linking to an instrument that is not a gateway', async () => {
    const s = Date.now();
    const plain = await mk({ name: 'Plain', code: `PN-${s}` });
    const res = await mk({ name: 'Child', code: `CH-${s}`, gatewayId: plain.json().id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NOT_A_GATEWAY');
  });

  it('refuses making a linked child into a gateway (one level only)', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'G', code: `G-${s}`, isGateway: true });
    const child = await mk({ name: 'C', code: `C-${s}`, gatewayId: gw.json().id });
    const res = await app.inject({
      method: 'PUT', url: `/api/instruments/${child.json().id}`, headers: auth, payload: { isGateway: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NESTED_GATEWAY');
  });

  it('refuses disabling a gateway that still has children, and names them', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'G2', code: `G2-${s}`, isGateway: true });
    await mk({ name: 'C2', code: `C2-${s}`, gatewayId: gw.json().id });
    const res = await app.inject({
      method: 'PUT', url: `/api/instruments/${gw.json().id}`, headers: auth, payload: { isGateway: false },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('GATEWAY_HAS_CHILDREN');
    expect(res.json().message).toContain(`C2-${s}`);
  });

  it('lists children, and eligible candidates exclude gateways and already-linked instruments', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'G3', code: `G3-${s}`, isGateway: true });
    const child = await mk({ name: 'C3', code: `C3-${s}`, gatewayId: gw.json().id });

    const kids = await app.inject({ method: 'GET', url: `/api/instruments/${gw.json().id}/children`, headers: auth });
    expect(kids.json().data.map((c: { id: string }) => c.id)).toContain(child.json().id);

    const elig = await app.inject({ method: 'GET', url: '/api/instruments/eligible-children', headers: auth });
    const ids = elig.json().data.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(gw.json().id);      // a gateway cannot be a child
    expect(ids).not.toContain(child.json().id);   // already parented
  });

  it('deleting a gateway unlinks its children rather than deleting them', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'G4', code: `G4-${s}`, isGateway: true });
    const child = await mk({ name: 'C4', code: `C4-${s}`, gatewayId: gw.json().id });

    await app.inject({ method: 'DELETE', url: `/api/instruments/${gw.json().id}`, headers: auth });

    const still = await app.inject({ method: 'GET', url: `/api/instruments/${child.json().id}`, headers: auth });
    expect(still.statusCode).toBe(200);
    expect(still.json().gatewayId).toBeNull();
  });

  it('filters the list by block, area, location and isGateway', async () => {
    const s = Date.now();
    const gw = await mk({
      name: 'FGW', code: `FGW-${s}`, isGateway: true,
      block: `BLK-${s}`, area: `AREA-${s}`, location: `LOC-${s}`,
    });
    const plain = await mk({
      name: 'FPL', code: `FPL-${s}`,
      block: `BLK-${s}`, area: `OTHER-${s}`, location: `ELSEWHERE-${s}`,
    });
    const ids = async (qs: string) => {
      const res = await app.inject({ method: 'GET', url: `/api/instruments?limit=500&${qs}`, headers: auth });
      expect(res.statusCode).toBe(200);
      return res.json().data.map((r: { id: string }) => r.id);
    };

    // block matches both; area and location discriminate between them.
    const byBlock = await ids(`block=BLK-${s}`);
    expect(byBlock).toContain(gw.json().id);
    expect(byBlock).toContain(plain.json().id);

    expect(await ids(`area=AREA-${s}`)).toEqual([gw.json().id]);
    expect(await ids(`location=ELSEWHERE-${s}`)).toEqual([plain.json().id]);

    // isGateway is a boolean filter, so it must be asserted BOTH ways —
    // `isGateway=true` alone would pass against a filter that ignored the flag
    // if it happened to return everything.
    const gateways = await ids(`block=BLK-${s}&isGateway=true`);
    expect(gateways).toEqual([gw.json().id]);
    const nonGateways = await ids(`block=BLK-${s}&isGateway=false`);
    expect(nonGateways).toEqual([plain.json().id]);
  });
});

/**
 * The §11.10(e) constraint this task turns on: a link/unlink/enable/disable is
 * an access-control change and must leave an audit row, written in the SAME
 * transaction as the mutation. These read `audit_trail` directly — the API has
 * no endpoint that would prove the transactional part.
 */
describe('Instrument gateway audit trail', () => {
  const mk = async (payload: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth,
      payload: { profileId: await fixtureProfileId('fixture:instruments'), ...payload },
    });
    if (res.statusCode === 201) created.push(res.json().id);
    return res;
  };
  const actionsFor = async (targetId: string) =>
    (await prisma.auditTrail.findMany({
      where: { targetId }, select: { action: true }, orderBy: { timestamp: 'asc' },
    })).map((r) => r.action);

  it('writes a link row and an unlink row against the child', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'AGW', code: `AGW-${s}`, isGateway: true });
    const child = await mk({ name: 'AC', code: `AC-${s}` });
    const childId = child.json().id;

    expect(await actionsFor(childId)).not.toContain('INSTRUMENT_LINKED_TO_GATEWAY');

    const link = await app.inject({
      method: 'PUT', url: `/api/instruments/${childId}`, headers: auth,
      payload: { gatewayId: gw.json().id },
    });
    expect(link.statusCode).toBe(200);
    expect(await actionsFor(childId)).toContain('INSTRUMENT_LINKED_TO_GATEWAY');

    const unlink = await app.inject({
      method: 'PUT', url: `/api/instruments/${childId}`, headers: auth, payload: { gatewayId: null },
    });
    expect(unlink.statusCode).toBe(200);
    expect(await actionsFor(childId)).toContain('INSTRUMENT_UNLINKED_FROM_GATEWAY');

    // A no-op re-send is not a link event — the trail must not gain a second row.
    const before = (await actionsFor(childId)).filter((a) => a === 'INSTRUMENT_UNLINKED_FROM_GATEWAY').length;
    await app.inject({ method: 'PUT', url: `/api/instruments/${childId}`, headers: auth, payload: { gatewayId: null } });
    const after = (await actionsFor(childId)).filter((a) => a === 'INSTRUMENT_UNLINKED_FROM_GATEWAY').length;
    expect(after).toBe(before);
  });

  /**
   * INSTRUMENT_UPDATED is the most common instrument row and was the least
   * useful: it carried neither `code` nor `instrument`, so the Audit Trail fell
   * back to rendering a bare UUID, and its diff omitted most of the editable
   * fields. Editing a description produced a row whose beforeValue and
   * afterValue were IDENTICAL — a §11 record that something changed but not
   * what.
   *
   * The field list below is DERIVED from `updateInstrumentSchema.shape`, not
   * typed out. That indirection is here because the hand-maintained version
   * drifted twice in a single review cycle — three fields fixed in one round,
   * five more in the next — and a hardcoded list cannot notice a fourteenth
   * field being added to the schema and forgotten in `audited()`. Adding a
   * field to the PUT schema without adding it to `audited()` now fails HERE.
   */
  it('INSTRUMENT_UPDATED carries the code and a diff over every editable field', async () => {
    const s = Date.now();
    const inst = await mk({
      name: 'UD', code: `UD-${s}`,
      instrumentType: 'probe', manufacturer: 'Acme', model: 'A1',
      serialNumber: 'SN-1', description: 'before text',
    });
    const id = inst.json().id;

    // Only a previously-undiffed field changes. Before the fix this produced
    // two identical JSON blobs.
    const res = await app.inject({
      method: 'PUT', url: `/api/instruments/${id}`, headers: auth,
      payload: { description: 'after text' },
    });
    expect(res.statusCode, res.body).toBe(200);

    const row = await prisma.auditTrail.findFirst({
      where: { targetId: id, action: 'INSTRUMENT_UPDATED' }, orderBy: { timestamp: 'desc' },
    });
    const before = row?.beforeValue as Record<string, unknown>;
    const after = row?.afterValue as Record<string, unknown>;

    // The code, so the trail never renders a bare UUID. `code` (not
    // `instrument`) is the converged key — it matches the column.
    expect(after.code).toBe(`UD-${s}`);
    expect(before.code).toBe(`UD-${s}`);

    // The change itself is legible.
    expect(before.description).toBe('before text');
    expect(after.description).toBe('after text');

    // And every editable field is present on both sides, so no future edit can
    // produce a row that says nothing.
    //
    // Nothing is excluded. `isGateway`/`gatewayId` DO also get their own
    // companion rows (INSTRUMENT_GATEWAY_ENABLED and friends), which was once
    // the argument for leaving them out of this diff — but omitting them meant
    // `PUT {isGateway:true}` wrote an INSTRUMENT_UPDATED whose two sides were
    // identical, i.e. exactly the defect this test exists to prevent. If a
    // field ever genuinely must be excluded, name it here — a visible
    // allowlist, not an implied one.
    const AUDITED_EXCLUSIONS: string[] = [];
    // In the audit payload but NOT in the PUT schema: `code` is deliberately
    // not updatable (it is baked into device config), yet it is carried on
    // both sides as the emitter key so the trail never renders a bare UUID.
    const AUDITED_EXTRAS = ['code'];
    const expectedFields = [
      ...Object.keys(updateInstrumentSchema.shape).filter((f) => !AUDITED_EXCLUSIONS.includes(f)),
      ...AUDITED_EXTRAS,
    ];
    for (const f of expectedFields) {
      expect(before, `beforeValue missing ${f}`).toHaveProperty(f);
      expect(after, `afterValue missing ${f}`).toHaveProperty(f);
    }
  });

  /**
   * Emitter-key convergence: the six gateway actions used to store the code
   * under `instrument`, the other three under `code`. One key now, matching the
   * column. (The web renderer still reads both — historic rows are immutable.)
   */
  it('the gateway actions store the code under `code`, like every other instrument action', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'KGW', code: `KGW-${s}`, isGateway: true });
    const child = await mk({ name: 'KC', code: `KC-${s}` });
    const gwId = gw.json().id;
    const childId = child.json().id;

    await app.inject({ method: 'PUT', url: `/api/instruments/${childId}`, headers: auth, payload: { gatewayId: gwId } });
    await app.inject({ method: 'PUT', url: `/api/instruments/${childId}`, headers: auth, payload: { gatewayId: null } });

    const rows = await prisma.auditTrail.findMany({
      where: { targetId: { in: [gwId, childId] }, action: { startsWith: 'INSTRUMENT_' } },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      for (const v of [r.beforeValue, r.afterValue]) {
        if (!v || typeof v !== 'object') continue;
        expect(v, `${r.action} still emits the legacy \`instrument\` key`).not.toHaveProperty('instrument');
      }
    }
    // ...and the enable row, written at create, really does carry it.
    const enabled = rows.find((r) => r.action === 'INSTRUMENT_GATEWAY_ENABLED');
    expect(enabled?.afterValue).toMatchObject({ code: `KGW-${s}` });
  });

  it('records gateway mode being enabled and disabled', async () => {
    const s = Date.now();
    const inst = await mk({ name: 'AM', code: `AM-${s}` });
    const id = inst.json().id;

    await app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers: auth, payload: { isGateway: true } });
    expect(await actionsFor(id)).toContain('INSTRUMENT_GATEWAY_ENABLED');

    await app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers: auth, payload: { isGateway: false } });
    expect(await actionsFor(id)).toContain('INSTRUMENT_GATEWAY_DISABLED');
  });

  it('audits EVERY child unlinked by deleting its gateway — SetNull is silent otherwise', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'DGW', code: `DGW-${s}`, isGateway: true });
    const a = await mk({ name: 'DA', code: `DA-${s}`, gatewayId: gw.json().id });
    const b = await mk({ name: 'DB', code: `DB-${s}`, gatewayId: gw.json().id });

    const del = await app.inject({ method: 'DELETE', url: `/api/instruments/${gw.json().id}`, headers: auth });
    expect(del.statusCode).toBe(200);

    for (const kid of [a, b]) {
      const rows = await prisma.auditTrail.findMany({
        where: { targetId: kid.json().id, action: 'INSTRUMENT_UNLINKED_FROM_GATEWAY' },
        orderBy: { timestamp: 'asc' },
      });
      // One from the delete (they were created already linked, so the create
      // wrote a LINKED row, never an UNLINKED one).
      expect(rows).toHaveLength(1);
      expect(rows[0].beforeValue).toMatchObject({ gateway: `DGW-${s}` });
      expect(rows[0].afterValue).toMatchObject({ gatewayId: null });
    }
  });

  /**
   * The pre-flight guard cannot see an uncommitted write, so two concurrent
   * requests could commit a non-gateway that still has live children. The
   * backstop is a re-check under a row lock on the GATEWAY, taken as the first
   * statement of the transaction.
   *
   * These two tests drive the race deterministically by playing the concurrent
   * linker: `heldLinker` takes the same locks the real link path takes — the
   * gateway row AND the audit chain's advisory lock, because omitting the
   * advisory lock is precisely what would hide a lock-order deadlock — links a
   * child, and commits only once the route under test is genuinely blocked.
   *
   * "Genuinely blocked" is asked of Postgres (`pg_blocking_pids`), not guessed
   * with a sleep: a timer that expires early would silently downgrade the test
   * to exercising the pre-flight instead of the lock.
   */
  const AUDIT_CHAIN_LOCK_ID = 7421151037n;

  /** Run `work` in a transaction and hold it open, uncommitted, until released. */
  function heldTx(work: (tx: Prisma.TransactionClient) => Promise<void>) {
    let release!: () => void;
    let pidResolve!: (pid: number) => void;
    const held = new Promise<void>((r) => { release = r; });
    const pid = new Promise<number>((r) => { pidResolve = r; });

    const done = prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      await work(tx);
      pidResolve(rows[0].pid);
      await held;
    }, { timeout: 20_000 });

    return { pid, release, done };
  }

  /** Hold the link path's locks + an uncommitted child link, until released. */
  const heldLinker = (gatewayId: string, childId: string) => heldTx(async (tx) => {
    await tx.$queryRaw`SELECT id FROM instruments WHERE id = ${gatewayId} FOR UPDATE`;
    // Lock-equivalence with the real link path: every audit write takes this.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_ID})`;
    await tx.instrument.update({ where: { id: childId }, data: { gatewayId } });
  });

  /** Wait until `pid` is actually blocking another backend. */
  async function waitUntilBlocking(pid: number): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const rows = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
      `;
      if (rows[0].n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`backend ${pid} never blocked anyone — the route did not take the lock`);
  }

  /**
   * The lock must be gated on the value the caller ASKED FOR, never on a diff
   * against a row read outside the transaction.
   *
   * `PUT {gatewayId: GW}` re-sending what the caller believes is already set is
   * the ordinary whole-object form submit. Gating on the diff made that a
   * no-op — no lock, no re-check — while `data: parsed.data` re-asserted the
   * value in SQL anyway, so it could re-link a child to a gateway demoted in
   * the meantime, with no audit row either.
   */
  it('re-asserting an unchanged gatewayId still locks and re-checks', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'SGW', code: `SGW-${s}`, isGateway: true });
    const gwId = gw.json().id;
    const child = await mk({ name: 'SC', code: `SC-${s}`, gatewayId: gwId });
    const childId = child.json().id;

    // The world moves under the request: the child is unlinked and the gateway
    // demoted, uncommitted until the PUT is already in flight.
    const mover = heldTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM instruments WHERE id = ${gwId} FOR UPDATE`;
      await tx.instrument.update({ where: { id: childId }, data: { gatewayId: null } });
      await tx.instrument.update({ where: { id: gwId }, data: { isGateway: false } });
    });
    const moverPid = await mover.pid;

    // Reads `existing` while the child still looks linked, so the diff says
    // "unchanged" — the exact stale verdict.
    const pending = app.inject({
      method: 'PUT', url: `/api/instruments/${childId}`, headers: auth, payload: { gatewayId: gwId },
    });
    await waitUntilBlocking(moverPid);
    mover.release();
    await mover.done;

    const res = await pending;
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NOT_A_GATEWAY');

    // The invariant: no child left pointing at a non-gateway.
    const after = await prisma.instrument.findUnique({ where: { id: childId }, select: { gatewayId: true } });
    expect(after?.gatewayId).toBeNull();
  });

  /** The mirror of the case above, on the other flag. */
  it('re-asserting an unchanged isGateway:false still locks and re-checks', async () => {
    const s = Date.now();
    // Born a plain instrument, so `isGateway:false` reads as "no change".
    const gw = await mk({ name: 'MGW', code: `MGW-${s}` });
    const gwId = gw.json().id;
    const child = await mk({ name: 'MC', code: `MC-${s}` });
    const childId = child.json().id;

    // Concurrently it is promoted to a gateway and given a child.
    const mover = heldTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM instruments WHERE id = ${gwId} FOR UPDATE`;
      await tx.instrument.update({ where: { id: gwId }, data: { isGateway: true } });
      await tx.instrument.update({ where: { id: childId }, data: { gatewayId: gwId } });
    });
    const moverPid = await mover.pid;

    // The pre-flight sees isGateway already false, so the D6 child check is
    // skipped entirely — only the locked re-check can catch this.
    const pending = app.inject({
      method: 'PUT', url: `/api/instruments/${gwId}`, headers: auth, payload: { isGateway: false },
    });
    await waitUntilBlocking(moverPid);
    mover.release();
    await mover.done;

    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('GATEWAY_HAS_CHILDREN');

    // The invariant: never a non-gateway holding a live child.
    const after = await prisma.instrument.findUnique({ where: { id: gwId }, select: { isGateway: true } });
    expect(after?.isGateway).toBe(true);
  });

  /**
   * The other half of the same defect: what counts as a transition must be
   * decided from the row read UNDER THE LOCK, not from `existing`. Gating the
   * audit on the stale diff meant a re-link that really happened left no
   * `INSTRUMENT_LINKED_TO_GATEWAY` row — a silent access-control change.
   */
  it('audits a re-link that the stale diff would have called a no-op', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'NGW', code: `NGW-${s}`, isGateway: true });
    const gwId = gw.json().id;
    const child = await mk({ name: 'NC', code: `NC-${s}`, gatewayId: gwId });
    const childId = child.json().id;

    const links = async () => prisma.auditTrail.count({
      where: { targetId: childId, action: 'INSTRUMENT_LINKED_TO_GATEWAY' },
    });
    // One row from the create — it was born linked.
    expect(await links()).toBe(1);

    // Unlinked underneath the request. The gateway stays a gateway, so the
    // re-check passes and the PUT genuinely re-links.
    //
    // Deliberately NO lock on the gateway row — the real unlink path takes
    // none. That leaves the CHILD row as the only thing the route can block on,
    // which is what makes this test pin `selfId`: a plain read does not wait on
    // a row lock, so without the `FOR UPDATE` on self the route's before/after
    // read sails past and sees the pre-unlink value.
    const mover = heldTx(async (tx) => {
      await tx.instrument.update({ where: { id: childId }, data: { gatewayId: null } });
    });
    const moverPid = await mover.pid;

    const pending = app.inject({
      method: 'PUT', url: `/api/instruments/${childId}`, headers: auth, payload: { gatewayId: gwId },
    });
    await waitUntilBlocking(moverPid);
    mover.release();
    await mover.done;

    expect((await pending).statusCode).toBe(200);
    const after = await prisma.instrument.findUnique({ where: { id: childId }, select: { gatewayId: true } });
    expect(after?.gatewayId).toBe(gwId);
    // `existing.gatewayId` was GW, so the stale diff says "unchanged" and skips
    // the row. The locked read says null -> GW, which is a link.
    expect(await links()).toBe(2);
  });

  /**
   * The one case parent-before-self cannot order: both requests demote
   * themselves AND link to the other, so each locks two PARENTS in the opposite
   * order. Postgres picks a victim; `PUT` retries it once. Without that retry
   * the victim surfaces as a 500.
   */
  it('survives two mirrored demote-and-link requests without a 500', async () => {
    const s = Date.now();
    for (let i = 0; i < 6; i++) {
      const g1 = await mk({ name: 'M1', code: `M1-${s}-${i}`, isGateway: true });
      const g2 = await mk({ name: 'M2', code: `M2-${s}-${i}`, isGateway: true });
      const a = g1.json().id;
      const b = g2.json().id;

      const [ra, rb] = await Promise.all([
        app.inject({ method: 'PUT', url: `/api/instruments/${a}`, headers: auth, payload: { isGateway: false, gatewayId: b } }),
        app.inject({ method: 'PUT', url: `/api/instruments/${b}`, headers: auth, payload: { isGateway: false, gatewayId: a } }),
      ]);

      for (const res of [ra, rb]) {
        expect([200, 400, 409], `unexpected ${res.statusCode}: ${res.body}`).toContain(res.statusCode);
      }

      // And whatever landed, no gateway ended up as somebody's child.
      for (const id of [a, b]) {
        const row = await prisma.instrument.findUnique({ where: { id }, select: { isGateway: true, gatewayId: true } });
        if (row?.gatewayId) expect(row.isGateway).toBe(false);
      }
    }
  });

  it('refuses and writes nothing when the locked re-check loses a race', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'RGW', code: `RGW-${s}`, isGateway: true });
    const child = await mk({ name: 'RC', code: `RC-${s}` });
    const gwId = gw.json().id;

    const auditCount = async () =>
      prisma.auditTrail.count({ where: { targetId: gwId, action: 'INSTRUMENT_GATEWAY_DISABLED' } });
    expect(await auditCount()).toBe(0);

    const linker = heldLinker(gwId, child.json().id);
    const linkerPid = await linker.pid;

    const pending = app.inject({
      method: 'PUT', url: `/api/instruments/${gwId}`, headers: auth, payload: { isGateway: false },
    });
    // The PUT clears its pre-flight (0 children visible) and parks on the
    // gateway row lock. If it never parks, the lock is gone and this throws.
    await waitUntilBlocking(linkerPid);
    linker.release();
    await linker.done;

    const res = await pending;
    // A deadlock instead of a wait would surface here as a 500.
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('GATEWAY_HAS_CHILDREN');

    // Nothing was written: not the mutation...
    const after = await prisma.instrument.findUnique({ where: { id: gwId }, select: { isGateway: true } });
    expect(after?.isGateway).toBe(true);
    // ...and not an audit row.
    //
    // Honest scope: since the re-check was hoisted ahead of the mutation, this
    // refusal happens BEFORE any write, so the assertion pins "the re-check
    // runs first and nothing is written" — it does NOT pin audit-in-transaction.
    // No route path can fail after its audit rows are written, so nothing here
    // can catch a refactor that moved `auditLog` outside `$transaction`; that
    // property rests on passing `tx` and on review. Saying so beats a comment
    // claiming a guarantee that is not there.
    expect(await auditCount()).toBe(0);
  });

  /**
   * The mirror of the missing-row case: an unlink that commits while the delete
   * is in flight must NOT produce a row claiming the child was unlinked
   * *because the gateway was deleted*. The cascade never touches that child, so
   * such a row is a false statement — and a second unlink row for one unlink —
   * in an immutable trail.
   */
  it('does not audit a child that unlinked itself before the gateway delete landed', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'FGW2', code: `FGW2-${s}`, isGateway: true });
    const gwId = gw.json().id;
    const child = await mk({ name: 'FC2', code: `FC2-${s}`, gatewayId: gwId });
    const childId = child.json().id;

    // The real unlink path takes no gateway lock, so neither does this.
    const unlinker = heldTx(async (tx) => {
      await tx.instrument.update({ where: { id: childId }, data: { gatewayId: null } });
    });
    const unlinkerPid = await unlinker.pid;

    const pending = app.inject({ method: 'DELETE', url: `/api/instruments/${gwId}`, headers: auth });
    await waitUntilBlocking(unlinkerPid);
    unlinker.release();
    await unlinker.done;

    expect((await pending).statusCode).toBe(200);

    // Only the child's own unlink happened; the delete must claim nothing.
    const rows = await prisma.auditTrail.findMany({
      where: { targetId: childId, action: 'INSTRUMENT_UNLINKED_FROM_GATEWAY' },
    });
    expect(rows).toHaveLength(0);
  });

  /**
   * Lock ORDER, not just lock presence. `auditLog` takes
   * `pg_advisory_xact_lock` and holds it to commit, so a path that mutates
   * before locking the gateway runs `own row -> advisory -> gateway row` and
   * cycles against a concurrent link. Postgres breaks that with 40P01 and the
   * clean 409 becomes a 500.
   *
   * Both sides here are REAL requests — a synthetic linker can only reproduce
   * the ordering it was written to mimic, which is how this defect survived the
   * first fix round. The assertion is a property, not an outcome: whichever
   * request wins, neither may 500 and the pair may never leave a non-gateway
   * holding a live child.
   */
  it('does not deadlock when a disable and a link race on the same gateway', async () => {
    const s = Date.now();
    for (let i = 0; i < 8; i++) {
      const gw = await mk({ name: 'PGW', code: `PGW-${s}-${i}`, isGateway: true });
      const child = await mk({ name: 'PC', code: `PC-${s}-${i}` });
      const gwId = gw.json().id;

      const [disable, link] = await Promise.all([
        app.inject({ method: 'PUT', url: `/api/instruments/${gwId}`, headers: auth, payload: { isGateway: false } }),
        app.inject({ method: 'PUT', url: `/api/instruments/${child.json().id}`, headers: auth, payload: { gatewayId: gwId } }),
      ]);

      for (const res of [disable, link]) {
        expect([200, 400, 409], `unexpected ${res.statusCode}: ${res.body}`).toContain(res.statusCode);
      }

      const after = await prisma.instrument.findUnique({
        where: { id: gwId }, select: { isGateway: true, children: { select: { id: true } } },
      });
      // The invariant itself: never a non-gateway with live children.
      if (after && !after.isGateway) expect(after.children).toHaveLength(0);
    }
  });

  it('audits a child linked concurrently with the gateway delete — the delete must lock first', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'XGW', code: `XGW-${s}`, isGateway: true });
    const child = await mk({ name: 'XC', code: `XC-${s}` });
    const gwId = gw.json().id;
    const childId = child.json().id;

    const linker = heldLinker(gwId, childId);
    const linkerPid = await linker.pid;

    const pending = app.inject({ method: 'DELETE', url: `/api/instruments/${gwId}`, headers: auth });
    // Without the delete's own FOR UPDATE, it reads `kids` without waiting, the
    // linker's child is invisible, and the child is unlinked by SetNull with no
    // audit row — the exact §11.10(e) gap. So this must block.
    await waitUntilBlocking(linkerPid);
    linker.release();
    await linker.done;

    expect((await pending).statusCode).toBe(200);

    const rows = await prisma.auditTrail.findMany({
      where: { targetId: childId, action: 'INSTRUMENT_UNLINKED_FROM_GATEWAY' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].beforeValue).toMatchObject({ gateway: `XGW-${s}` });
    // And the child itself survived, unlinked.
    const still = await prisma.instrument.findUnique({ where: { id: childId } });
    expect(still?.gatewayId).toBeNull();
  });

  /**
   * D2 (no nested gateways) is a SAME-row rule, so `lockedGatewayRecheck` never
   * covered it — it was left to the pre-flight, which reads outside any
   * transaction. Two ordinary UI actions defeat that, because neither request
   * carries the other's field: the detail page Save sends `isGateway` with no
   * `gatewayId`, and the gateway panel's Link sends `gatewayId` with no
   * `isGateway`.
   *
   * Here the child is promoted to a gateway underneath an in-flight Link. The
   * PUT's pre-flight already read `isGateway:false` and allowed it; only a
   * re-check on the EFFECTIVE state (locked row merged with this request's
   * fields) can refuse. Without it the commit lands `isGateway && gatewayId` —
   * a two-level chain, which no CHECK constraint catches.
   *
   * The mover locks only the child row on purpose: the route locks GW first
   * (uncontended) and then C, so C is the block point this test needs.
   */
  it('refuses a link that would nest, when the child was promoted mid-flight', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'D2GW', code: `D2GW-${s}`, isGateway: true });
    const child = await mk({ name: 'D2C', code: `D2C-${s}` });
    const gwId = gw.json().id;
    const childId = child.json().id;

    const mover = heldTx(async (tx) => {
      await tx.instrument.update({ where: { id: childId }, data: { isGateway: true } });
    });
    const moverPid = await mover.pid;

    const pending = app.inject({
      method: 'PUT', url: `/api/instruments/${childId}`, headers: auth, payload: { gatewayId: gwId },
    });
    await waitUntilBlocking(moverPid);
    mover.release();
    await mover.done;

    const res = await pending;
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NESTED_GATEWAY');

    // The invariant: never a gateway that is itself somebody's child.
    const after = await prisma.instrument.findUnique({
      where: { id: childId }, select: { isGateway: true, gatewayId: true },
    });
    expect(after?.isGateway).toBe(true);
    expect(after?.gatewayId).toBeNull();
  });

  /** The mirror: the field this request omits is `gatewayId`, not `isGateway`. */
  it('refuses enabling gateway mode on an instrument linked mid-flight', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'D2MG', code: `D2MG-${s}`, isGateway: true });
    const child = await mk({ name: 'D2MC', code: `D2MC-${s}` });
    const gwId = gw.json().id;
    const childId = child.json().id;

    const mover = heldTx(async (tx) => {
      await tx.instrument.update({ where: { id: childId }, data: { gatewayId: gwId } });
    });
    const moverPid = await mover.pid;

    const pending = app.inject({
      method: 'PUT', url: `/api/instruments/${childId}`, headers: auth, payload: { isGateway: true },
    });
    await waitUntilBlocking(moverPid);
    mover.release();
    await mover.done;

    const res = await pending;
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NESTED_GATEWAY');

    const after = await prisma.instrument.findUnique({
      where: { id: childId }, select: { isGateway: true, gatewayId: true },
    });
    expect(after?.isGateway).toBe(false);
    expect(after?.gatewayId).toBe(gwId);
  });

  /**
   * An explicit `gatewayId: null` must still read as an unlink under the
   * effective-state merge. `parsed.data.gatewayId ?? before.gatewayId` — the
   * terse form — would resurrect the old parent and refuse a legal unlink of a
   * child that is being promoted in the same request.
   */
  it('allows promoting an instrument that unlinks itself in the same request', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'D2UG', code: `D2UG-${s}`, isGateway: true });
    const child = await mk({ name: 'D2UC', code: `D2UC-${s}`, gatewayId: gw.json().id });

    const res = await app.inject({
      method: 'PUT', url: `/api/instruments/${child.json().id}`, headers: auth,
      payload: { isGateway: true, gatewayId: null },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ isGateway: true, gatewayId: null });
  });

  it('the locked re-check refuses both violations when called directly', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'LGW', code: `LGW-${s}`, isGateway: true });
    const plain = await mk({ name: 'LPL', code: `LPL-${s}` });
    await mk({ name: 'LC', code: `LC-${s}`, gatewayId: gw.json().id });

    const linkToPlain = prisma.$transaction((tx) =>
      lockedGatewayRecheck(tx, { linkTo: plain.json().id }));
    await expect(linkToPlain).rejects.toThrow(GatewayInvariantViolation);
    await expect(linkToPlain).rejects.toMatchObject({ status: 400, body: { error: 'NOT_A_GATEWAY' } });

    const disableWithKids = prisma.$transaction((tx) =>
      lockedGatewayRecheck(tx, { disablingGatewayId: gw.json().id }));
    await expect(disableWithKids).rejects.toMatchObject({
      status: 409, body: { error: 'GATEWAY_HAS_CHILDREN', message: expect.stringContaining(`LC-${s}`) },
    });

    // ...and allows the legal versions of both.
    await expect(prisma.$transaction((tx) =>
      lockedGatewayRecheck(tx, { linkTo: gw.json().id }))).resolves.toBeUndefined();
    await expect(prisma.$transaction((tx) =>
      lockedGatewayRecheck(tx, { disablingGatewayId: plain.json().id }))).resolves.toBeUndefined();
  });
});
