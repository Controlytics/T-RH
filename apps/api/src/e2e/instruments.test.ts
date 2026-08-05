import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { lockedGatewayRecheck, GatewayInvariantViolation } from '../modules/instruments/gateway-invariants.js';

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

  // lastSeenAt means "a reading landed", NOT "the device authenticated": a
  // device that authenticates and then sends garbage every second must not look
  // healthy. The dead-letters panel is what diagnoses that case.
  it('stamps lastSeenAt when a reading lands, so the list can answer "is it talking?"', async () => {
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

describe('Instrument gateway links', () => {
  const mk = async (payload: Record<string, unknown>) => {
    const res = await app.inject({ method: 'POST', url: '/api/instruments', headers: auth, payload });
    if (res.statusCode === 201) created.push(res.json().id);
    return res;
  };

  it('stores placement fields', async () => {
    const res = await mk({
      name: 'Placed', code: `PL-${Date.now()}`, transport: 'http',
      block: 'Block C', area: 'Sterile Core', location: 'Room 214',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ block: 'Block C', area: 'Sterile Core', location: 'Room 214' });
  });

  it('refuses linking to an instrument that is not a gateway', async () => {
    const s = Date.now();
    const plain = await mk({ name: 'Plain', code: `PN-${s}`, transport: 'http' });
    const res = await mk({ name: 'Child', code: `CH-${s}`, transport: 'http', gatewayId: plain.json().id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NOT_A_GATEWAY');
  });

  it('refuses making a linked child into a gateway (one level only)', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'G', code: `G-${s}`, transport: 'http', isGateway: true });
    const child = await mk({ name: 'C', code: `C-${s}`, transport: 'http', gatewayId: gw.json().id });
    const res = await app.inject({
      method: 'PUT', url: `/api/instruments/${child.json().id}`, headers: auth, payload: { isGateway: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NESTED_GATEWAY');
  });

  it('refuses disabling a gateway that still has children, and names them', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'G2', code: `G2-${s}`, transport: 'http', isGateway: true });
    await mk({ name: 'C2', code: `C2-${s}`, transport: 'http', gatewayId: gw.json().id });
    const res = await app.inject({
      method: 'PUT', url: `/api/instruments/${gw.json().id}`, headers: auth, payload: { isGateway: false },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('GATEWAY_HAS_CHILDREN');
    expect(res.json().message).toContain(`C2-${s}`);
  });

  it('lists children, and eligible candidates exclude gateways and already-linked instruments', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'G3', code: `G3-${s}`, transport: 'http', isGateway: true });
    const child = await mk({ name: 'C3', code: `C3-${s}`, transport: 'http', gatewayId: gw.json().id });

    const kids = await app.inject({ method: 'GET', url: `/api/instruments/${gw.json().id}/children`, headers: auth });
    expect(kids.json().data.map((c: { id: string }) => c.id)).toContain(child.json().id);

    const elig = await app.inject({ method: 'GET', url: '/api/instruments/eligible-children', headers: auth });
    const ids = elig.json().data.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(gw.json().id);      // a gateway cannot be a child
    expect(ids).not.toContain(child.json().id);   // already parented
  });

  it('deleting a gateway unlinks its children rather than deleting them', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'G4', code: `G4-${s}`, transport: 'http', isGateway: true });
    const child = await mk({ name: 'C4', code: `C4-${s}`, transport: 'http', gatewayId: gw.json().id });

    await app.inject({ method: 'DELETE', url: `/api/instruments/${gw.json().id}`, headers: auth });

    const still = await app.inject({ method: 'GET', url: `/api/instruments/${child.json().id}`, headers: auth });
    expect(still.statusCode).toBe(200);
    expect(still.json().gatewayId).toBeNull();
  });

  it('filters the list by block, area, location and isGateway', async () => {
    const s = Date.now();
    const gw = await mk({
      name: 'FGW', code: `FGW-${s}`, transport: 'http', isGateway: true,
      block: `BLK-${s}`, area: `AREA-${s}`, location: `LOC-${s}`,
    });
    const plain = await mk({
      name: 'FPL', code: `FPL-${s}`, transport: 'http',
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
    const res = await app.inject({ method: 'POST', url: '/api/instruments', headers: auth, payload });
    if (res.statusCode === 201) created.push(res.json().id);
    return res;
  };
  const actionsFor = async (targetId: string) =>
    (await prisma.auditTrail.findMany({
      where: { targetId }, select: { action: true }, orderBy: { timestamp: 'asc' },
    })).map((r) => r.action);

  it('writes a link row and an unlink row against the child', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'AGW', code: `AGW-${s}`, transport: 'http', isGateway: true });
    const child = await mk({ name: 'AC', code: `AC-${s}`, transport: 'http' });
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

  it('records gateway mode being enabled and disabled', async () => {
    const s = Date.now();
    const inst = await mk({ name: 'AM', code: `AM-${s}`, transport: 'http' });
    const id = inst.json().id;

    await app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers: auth, payload: { isGateway: true } });
    expect(await actionsFor(id)).toContain('INSTRUMENT_GATEWAY_ENABLED');

    await app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers: auth, payload: { isGateway: false } });
    expect(await actionsFor(id)).toContain('INSTRUMENT_GATEWAY_DISABLED');
  });

  it('audits EVERY child unlinked by deleting its gateway — SetNull is silent otherwise', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'DGW', code: `DGW-${s}`, transport: 'http', isGateway: true });
    const a = await mk({ name: 'DA', code: `DA-${s}`, transport: 'http', gatewayId: gw.json().id });
    const b = await mk({ name: 'DB', code: `DB-${s}`, transport: 'http', gatewayId: gw.json().id });

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
   * backstop is a re-check under a row lock on the GATEWAY, after the mutation.
   *
   * This drives the race deterministically by playing the concurrent linker
   * itself: a held transaction takes the same gateway-row lock the link path
   * takes, links a child, and only commits once the route's PUT is parked on
   * that lock. The PUT then re-reads committed state, refuses, and rolls back —
   * taking its own audit rows with it, which is the §11.10(e) half of the test.
   */
  it('rolls the update AND its audit rows back when the locked re-check loses a race', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'RGW', code: `RGW-${s}`, transport: 'http', isGateway: true });
    const child = await mk({ name: 'RC', code: `RC-${s}`, transport: 'http' });
    const gwId = gw.json().id;

    const auditCount = async () =>
      prisma.auditTrail.count({ where: { targetId: gwId, action: 'INSTRUMENT_GATEWAY_DISABLED' } });
    expect(await auditCount()).toBe(0);

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const linker = prisma.$transaction(async (tx) => {
      // Exactly what the link path does: lock the gateway row, then write the
      // child. Uncommitted, so the route's pre-flight cannot see it.
      await tx.$queryRaw`SELECT id FROM instruments WHERE id = ${gwId} FOR UPDATE`;
      await tx.instrument.update({ where: { id: child.json().id }, data: { gatewayId: gwId } });
      await held;
    }, { timeout: 15_000 });

    const pending = app.inject({
      method: 'PUT', url: `/api/instruments/${gwId}`, headers: auth, payload: { isGateway: false },
    });
    // Let the PUT clear its pre-flight (0 children visible) and park on the
    // gateway row lock the linker is holding.
    await new Promise((r) => setTimeout(r, 500));
    release();
    await linker;

    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('GATEWAY_HAS_CHILDREN');

    // The mutation is undone...
    const after = await prisma.instrument.findUnique({ where: { id: gwId }, select: { isGateway: true } });
    expect(after?.isGateway).toBe(true);
    // ...and so is its audit row. A refactor that moved auditLog outside
    // $transaction would leave one here and fail this line.
    expect(await auditCount()).toBe(0);
  });

  it('the locked re-check refuses both violations when called directly', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'LGW', code: `LGW-${s}`, transport: 'http', isGateway: true });
    const plain = await mk({ name: 'LPL', code: `LPL-${s}`, transport: 'http' });
    await mk({ name: 'LC', code: `LC-${s}`, transport: 'http', gatewayId: gw.json().id });

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
