/**
 * Instrument visibility scope: locations, explicit instruments, and the union.
 *
 * What this file exists to prove:
 *
 * `role_configs.instrument_scope` / `user_configs.instrument_scope` gained a second
 * shape on 2026-08-28. Rows written before that date are a bare `string[]` of
 * functional-location ids; rows written since are `{locationIds, instrumentIds}`.
 * **Legacy rows are deliberately never rewritten**, so both shapes are live in the
 * same column, permanently.
 *
 * The failure this guards is silent and total: every reader of that column decides
 * "is a scope stored here?", and "no" means UNRESTRICTED. A reader that recognises
 * only one shape therefore turns a restricted user into an unrestricted one while
 * the admin screen still shows a restriction. That is an access failure that looks
 * exactly like working software, so the LEGACY cases below are as load-bearing as
 * the new ones.
 *
 * Everything is driven through the seeded OPERATOR over HTTP, never through
 * `resolveVisibility` directly. SUPER_ADMIN short-circuits visibility to
 * unrestricted, so an `admin`-driven version of these assertions would pass against
 * a route with no scoping at all. Each restricted case is paired with a positive
 * control for the same reason in reverse: a route that 404s everything must not
 * look correct here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

let app: FastifyInstance;
let auth: Record<string, string>;
let operator: Record<string, string>;

const s = Date.now();
const instruments: string[] = [];

/** In an AREA under the granted BLOCK — proves the Block still expands. */
let inAreaId = '';
/** In a DIFFERENT block — the instrument that must stay invisible. */
let elsewhereId = '';
/** No functional location at all. Reachable ONLY by being named outright. */
let unplacedId = '';

let blockId = '';
let areaId = '';
let otherBlockId = '';
let roleId = '';
let rolePermsBefore: string[] = [];
let planId = '';
let roomId = '';

/**
 * `telemetry-slots` decides which keys count as temperature. It is administered
 * live and this install's list has drifted, so the room-history case below would
 * otherwise be testing this machine's configuration rather than the code.
 * Restored verbatim in afterAll — the suite shares `compliance_core_db_test`.
 */
const SLOTS = { temperatureKeys: 'temperature', humidityKeys: 'humidity' };
let slotsBefore: { value: unknown; existed: boolean } = { value: null, existed: false };

async function seedReading(instrumentId: string, value: number) {
  await prisma.$executeRaw`
    INSERT INTO instrument_telemetry_history (instrument_id, key, value, value_type, ts)
    VALUES (${instrumentId}, 'temperature', ${JSON.stringify(value)}::jsonb, 'number', ${new Date(Date.now() - 60_000)})
    ON CONFLICT (instrument_id, key, ts) DO NOTHING`;
}

/** enforceReauth passes with the header present whether or not the role requires it. */
const reauth = { 'x-reauth-password': 'Admin@123' };

interface ScopeSelection { locationIds: string[]; instrumentIds: string[] }

async function createInstrument(code: string, functionalLocationId: string | null) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { name: code, code, profileId: await fixtureProfileId('fixture:scope-selection') },
  });
  expect(res.statusCode).toBe(201);
  const { id } = res.json() as { id: string };
  instruments.push(id);
  if (functionalLocationId) {
    await prisma.instrument.update({ where: { id }, data: { functionalLocationId } });
  }
  return id;
}

/**
 * Write the column directly. The LEGACY shape can only be produced this way — the
 * route no longer emits it — and that is exactly the row this suite must cover.
 */
async function storeRoleScope(value: unknown) {
  await prisma.roleConfig.upsert({
    where: { role: 'OPERATOR' },
    create: { role: 'OPERATOR', instrumentScope: value as never },
    update: { instrumentScope: value as never },
  });
}

/** The ids the OPERATOR can actually see, as the list route reports them. */
async function visibleIds(): Promise<string[]> {
  const res = await app.inject({
    method: 'GET', url: '/api/instruments?limit=100', headers: operator,
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { data: { id: string }[]; total: number };
  // `total` is counted with the SAME where as the rows, so a disagreement means
  // the count escaped the scope even though the page did not. Only checkable
  // when the whole result fits on one page — the unrestricted control does not,
  // and this test database holds more instruments than these fixtures.
  // Guarded on `total`, not on `data.length`: guarding on the page size would
  // disable the check on exactly the case it exists to catch — a `total` counted
  // with a wider `where` than the rows.
  if (body.total < 100) expect(body.total).toBe(body.data.length);
  return body.data.map((r) => r.id);
}

/** The detail route's answer for one instrument, as the OPERATOR. */
async function detailStatus(id: string) {
  const res = await app.inject({ method: 'GET', url: `/api/instruments/${id}`, headers: operator });
  return res.statusCode;
}

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };

  const block = await prisma.functionalLocation.create({
    data: { name: `scope-e2e-block-${s}`, type: 'BLOCK' },
  });
  blockId = block.id;
  const area = await prisma.functionalLocation.create({
    data: { name: `scope-e2e-area-${s}`, type: 'AREA', parentId: blockId },
  });
  areaId = area.id;
  const other = await prisma.functionalLocation.create({
    data: { name: `scope-e2e-other-${s}`, type: 'BLOCK' },
  });
  otherBlockId = other.id;

  inAreaId = await createInstrument(`SCOPE-AREA-${s}`, areaId);
  elsewhereId = await createInstrument(`SCOPE-OTHER-${s}`, otherBlockId);
  unplacedId = await createInstrument(`SCOPE-UNPLACED-${s}`, null);

  const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
  roleId = role.id;
  rolePermsBefore = role.permissions as string[];
  await prisma.role.update({
    where: { id: roleId },
    data: { permissions: [...rolePermsBefore, 'INSTRUMENT_READ'] },
  });
  invalidateRolePermsCache('OPERATOR');

  // A room holding BOTH the in-scope and the out-of-scope instrument. The room is
  // geometry, not a grouping concept — membership here says nothing about who may
  // see what, which is exactly why its history endpoint has to be scoped.
  const existingSlots = await prisma.systemConfig.findUnique({ where: { configKey: 'telemetry-slots' } });
  slotsBefore = { value: existingSlots?.configValue ?? null, existed: Boolean(existingSlots) };
  await prisma.systemConfig.upsert({
    where: { configKey: 'telemetry-slots' },
    create: { configKey: 'telemetry-slots', configValue: SLOTS, configType: 'object' },
    update: { configValue: SLOTS },
  });

  const plan = await prisma.floorplan.create({
    data: { name: `scope-e2e-plan-${s}`, imagePath: 'x.png', imageWidth: 100, imageHeight: 100 },
  });
  planId = plan.id;
  const room = await prisma.floorplanRoom.create({
    data: { floorplanId: planId, code: `R-${s}`, x: 0, y: 0, w: 10, h: 10 },
  });
  roomId = room.id;
  await prisma.instrument.updateMany({
    where: { id: { in: [inAreaId, elsewhereId] } }, data: { roomId },
  });
  await seedReading(inAreaId, 21);
  await seedReading(elsewhereId, 22);

  operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
});

afterAll(async () => {
  if (instruments.length) {
    await prisma.$executeRaw`
      DELETE FROM instrument_telemetry_history WHERE instrument_id = ANY(${instruments}::text[])`;
    await prisma.instrument.updateMany({ where: { id: { in: instruments } }, data: { roomId: null } });
  }
  if (planId) await prisma.floorplan.deleteMany({ where: { id: planId } });
  if (slotsBefore.existed) {
    await prisma.systemConfig.update({
      where: { configKey: 'telemetry-slots' }, data: { configValue: slotsBefore.value as never },
    });
  } else {
    await prisma.systemConfig.deleteMany({ where: { configKey: 'telemetry-slots' } });
  }
  await prisma.roleConfig.updateMany({
    where: { role: 'OPERATOR' }, data: { instrumentScope: Prisma.DbNull },
  });
  if (roleId) {
    await prisma.role.update({ where: { id: roleId }, data: { permissions: rolePermsBefore as never } });
    invalidateRolePermsCache('OPERATOR');
  }
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  for (const id of instruments) {
    await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  }
  await prisma.functionalLocation.deleteMany({
    where: { id: { in: [areaId, blockId, otherBlockId].filter(Boolean) } },
  });
  await app.close();
});

describe('legacy bare-array scope — rows written before 2026-08-28', () => {
  it('still restricts to its locations, and still expands a Block to its Areas', async () => {
    await storeRoleScope([blockId]);
    const ids = await visibleIds();
    expect(ids).toContain(inAreaId);
    expect(ids).not.toContain(elsewhereId);
    expect(ids).not.toContain(unplacedId);
  });

  it('still means SEE NOTHING when it is an empty array', async () => {
    // The most dangerous single row in the system. `[]` read as "nothing stored"
    // would flip a total deny into a total grant.
    await storeRoleScope([]);
    expect(await visibleIds()).toEqual([]);
    expect(await detailStatus(inAreaId)).toBe(404);
  });
});

describe('location scope in the new shape', () => {
  it('behaves exactly as the legacy array it replaces', async () => {
    await storeRoleScope({ locationIds: [blockId], instrumentIds: [] });
    const ids = await visibleIds();
    expect(ids).toContain(inAreaId);
    expect(ids).not.toContain(elsewhereId);
    expect(ids).not.toContain(unplacedId);
  });
});

describe('explicit instrument scope', () => {
  it('grants exactly the named instrument and nothing else', async () => {
    await storeRoleScope({ locationIds: [], instrumentIds: [elsewhereId] });
    expect(await visibleIds()).toEqual([elsewhereId]);
    expect(await detailStatus(elsewhereId)).toBe(200);
    // 404, never 403 — a 403 would confirm the instrument exists.
    expect(await detailStatus(inAreaId)).toBe(404);
  });

  it('reaches an instrument that has NO functional location', async () => {
    // Changed 2026-08-28. The location branch cannot reach an unplaced instrument
    // (`IN (...)` never matches NULL), so before explicit ids existed, assigning a
    // freshly commissioned device silently did nothing.
    await storeRoleScope({ locationIds: [], instrumentIds: [unplacedId] });
    expect(await visibleIds()).toEqual([unplacedId]);
    expect(await detailStatus(unplacedId)).toBe(200);
  });

  it('a location grant alone still does NOT reach an unplaced instrument', async () => {
    // The positive control for the case above: the new branch is what grants it,
    // not some accidental widening of the location branch.
    await storeRoleScope({ locationIds: [blockId, otherBlockId], instrumentIds: [] });
    expect(await visibleIds()).not.toContain(unplacedId);
  });
});

describe('the two lists are a UNION', () => {
  it('shows instruments in the granted location AND the named ones', async () => {
    await storeRoleScope({ locationIds: [blockId], instrumentIds: [unplacedId] });
    const ids = await visibleIds();
    expect(ids).toContain(inAreaId);
    expect(ids).toContain(unplacedId);
    expect(ids).not.toContain(elsewhereId);
  });

  it('both lists empty means SEES NOTHING, never everything', async () => {
    // `{ OR: [] }` matches nothing in Prisma and `{}` matches everything; the two
    // are one "tidy up the empty branch" refactor apart. This is that guard, over
    // HTTP rather than over the fragment.
    await storeRoleScope({ locationIds: [], instrumentIds: [] });
    expect(await visibleIds()).toEqual([]);
    expect(await detailStatus(inAreaId)).toBe(404);
    expect(await detailStatus(unplacedId)).toBe(404);
  });

  it('a NULL column is inherit — here, unrestricted — and the controls are visible', async () => {
    await prisma.roleConfig.updateMany({
      where: { role: 'OPERATOR' }, data: { instrumentScope: Prisma.DbNull },
    });
    const ids = await visibleIds();
    expect(ids).toEqual(expect.arrayContaining([inAreaId, elsewhereId, unplacedId]));
  });
});

describe('the admin surface', () => {
  it('reports a LEGACY row as a real restriction, not as "nothing set"', async () => {
    // The bug this pins: the admin GET had its own `Array.isArray` reader. Any
    // reader that recognised one shape only would render a restricted role as
    // unrestricted here — and then save it back that way.
    await storeRoleScope([blockId]);
    const res = await app.inject({ method: 'GET', url: '/api/roles/instrument-scope', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { roles: { role: string; scope: ScopeSelection | null }[] };
    const row = body.roles.find((r) => r.role === 'OPERATOR')!;
    expect(row.scope).not.toBeNull();
    expect(row.scope!.locationIds).toEqual([blockId]);
    expect(row.scope!.instrumentIds).toEqual([]);
  });

  it('round-trips a written scope through PUT and GET', async () => {
    const scope = { locationIds: [areaId], instrumentIds: [unplacedId] };
    const put = await app.inject({
      method: 'PUT', url: '/api/roles/instrument-scope/role/OPERATOR',
      headers: { ...auth, ...reauth }, payload: { scope },
    });
    expect(put.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/roles/instrument-scope', headers: auth });
    const body = res.json() as { roles: { role: string; scope: ScopeSelection | null }[] };
    expect(body.roles.find((r) => r.role === 'OPERATOR')!.scope).toEqual(scope);

    // And it is enforced, not merely stored.
    const ids = await visibleIds();
    expect(ids).toContain(inAreaId);
    expect(ids).toContain(unplacedId);
    expect(ids).not.toContain(elsewhereId);
  });

  it('writes a real SQL NULL for "all instruments", not the JSON value null', async () => {
    // DbNull vs JsonNull. JSON `null` is not an array and not an object, so
    // normalizeScope would still read it as inherit — but the two are different
    // values in the column and the distinction is this feature's whole contract.
    const put = await app.inject({
      method: 'PUT', url: '/api/roles/instrument-scope/role/OPERATOR',
      headers: { ...auth, ...reauth }, payload: { scope: null },
    });
    expect(put.statusCode).toBe(200);
    const [row] = await prisma.$queryRaw<{ isNull: boolean }[]>`
      SELECT instrument_scope IS NULL AS "isNull" FROM role_configs WHERE role = 'OPERATOR'`;
    expect(row.isNull).toBe(true);
  });

  it('refuses a malformed scope rather than storing half of one', async () => {
    const put = await app.inject({
      method: 'PUT', url: '/api/roles/instrument-scope/role/OPERATOR',
      headers: { ...auth, ...reauth }, payload: { scope: { locationIds: [blockId] } },
    });
    expect(put.statusCode).toBe(400);
  });

  it('offers EVERY instrument to the picker, including unplaced ones', async () => {
    // Deliberately unscoped: an admin who is themselves restricted would otherwise
    // build a scope from half the plant with no way to tell.
    const res = await app.inject({
      method: 'GET', url: '/api/roles/instrument-scope/instruments', headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as { data: { id: string; coveringLocationIds: string[] }[] }).data;
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([inAreaId, elsewhereId, unplacedId]));

    // `coveringLocationIds` tells the editor which instruments a selected location
    // ALREADY grants, so the screen can show them as included. It must match what
    // the query actually does — an instrument in an Area is covered by that Area
    // AND by its Block, which is the case the UI exists to make visible.
    const inArea = rows.find((r) => r.id === inAreaId)!;
    expect([...inArea.coveringLocationIds].sort()).toEqual([areaId, blockId].sort());

    // An instrument with no location is covered by nothing: it can only be
    // reached by being named outright.
    expect(rows.find((r) => r.id === unplacedId)!.coveringLocationIds).toEqual([]);
  });

  it('every instrument the picker claims a location covers IS returned by that scope', () => {
    // The screen saying "included via CWH Block" while the query omits the
    // instrument would be a lie on an access-control surface. This walks the
    // picker's own answer and checks it against the live query, rather than
    // trusting that two implementations of containment agree.
    return (async () => {
      const picker = await app.inject({
        method: 'GET', url: '/api/roles/instrument-scope/instruments', headers: auth,
      });
      const rows = (picker.json() as { data: { id: string; coveringLocationIds: string[] }[] }).data;

      for (const locationId of [blockId, areaId, otherBlockId]) {
        const claimed = rows.filter((r) => r.coveringLocationIds.includes(locationId)).map((r) => r.id);
        await storeRoleScope({ locationIds: [locationId], instrumentIds: [] });
        const actual = await visibleIds();
        for (const id of claimed) expect(actual).toContain(id);
        // And nothing the picker did NOT claim slipped in.
        for (const id of actual) expect(claimed).toContain(id);
      }
    })();
  });

  it('names the instrument count in the §11 signature, not just the locations', async () => {
    // "set to N functional location(s)" became a FALSE statement the moment
    // instruments could be named. A signature is a claim about what was done.
    await app.inject({
      method: 'PUT', url: '/api/roles/instrument-scope/role/OPERATOR',
      headers: { ...auth, ...reauth },
      payload: { scope: { locationIds: [blockId], instrumentIds: [unplacedId] } },
    });
    const row = await prisma.auditTrail.findFirst({
      where: { targetType: 'role_config', targetId: 'OPERATOR' },
      orderBy: { timestamp: 'desc' },
      select: { signatureMeaning: true },
    });
    expect(row?.signatureMeaning).toContain('1 functional location(s)');
    expect(row?.signatureMeaning).toContain('1 instrument(s)');
  });
});

/**
 * Two routes that read an instrument's DATA and were never scoped. Both are
 * pre-existing gaps of the same shape as the `GET /:id/telemetry` one closed on
 * 2026-08-24 — a sibling route left on a bare lookup after its neighbour was
 * fixed. "The user cannot see that instrument's data" is not true while either
 * one answers.
 */
describe('data routes that were leaking outside the scope', () => {
  beforeAll(async () => {
    await storeRoleScope({ locationIds: [blockId], instrumentIds: [] });
  });

  it('dead letters 404 for an out-of-scope instrument and answer for an in-scope one', async () => {
    // `rawPayload` is the device's own message — it carries the readings, so this
    // was a full data leak, not merely a disclosure that the instrument exists.
    const out = await app.inject({
      method: 'GET', url: `/api/instruments/${elsewhereId}/dead-letters`, headers: operator,
    });
    expect(out.statusCode).toBe(404);

    const inside = await app.inject({
      method: 'GET', url: `/api/instruments/${inAreaId}/dead-letters`, headers: operator,
    });
    expect(inside.statusCode).toBe(200);
  });

  it('room history returns only the in-scope instruments sharing the room', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/floorplans/${planId}/rooms/${roomId}/history?window=1h`,
      headers: operator,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { room: { id: string }; series: { instrumentId: string }[] };
    // The ROOM itself is still returned: it is a space, not an instrument, and the
    // graphical view is entitled to its geometry.
    expect(body.room.id).toBe(roomId);
    const seen = new Set(body.series.map((x) => x.instrumentId));
    expect(seen.has(inAreaId)).toBe(true);
    expect(seen.has(elsewhereId)).toBe(false);
  });

  it('an unrestricted caller still sees both instruments in that room', async () => {
    // The control. Without it, a route that returned nothing at all would pass
    // the case above.
    const res = await app.inject({
      method: 'GET', url: `/api/floorplans/${planId}/rooms/${roomId}/history?window=1h`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const seen = new Set((res.json() as { series: { instrumentId: string }[] }).series.map((x) => x.instrumentId));
    expect(seen.has(inAreaId)).toBe(true);
    expect(seen.has(elsewhereId)).toBe(true);
  });
});

/**
 * The DASHBOARD, which is what the request was actually about: "once instruments
 * are assigned the user can see them in the dashboard; if not assigned, they
 * can't see the instrument or its data."
 *
 * The overview and the chart path are the two routes that answer that, and both
 * compose the visibility fragment into a `where` that already has its own keys —
 * the overview ANDs it with a selection filter, the chart path ANDs it into a
 * lookup. An INSTRUMENT-ONLY scope is the discriminating fixture for both: any
 * step that assumes a scope names functional locations would come back empty
 * here while the plain list page still showed the instrument.
 */
describe('the dashboard routes, under an instrument-only scope', () => {
  beforeAll(async () => {
    await storeRoleScope({ locationIds: [], instrumentIds: [unplacedId] });
  });

  it('the telemetry overview shows the named instrument and nothing else', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/instruments/telemetry-overview', headers: operator,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: { instrumentId: string }[] }).data.map((r) => r.instrumentId);
    expect(ids).toContain(unplacedId);
    expect(ids).not.toContain(inAreaId);
    expect(ids).not.toContain(elsewhereId);
  });

  it('the chart path serves the named instrument and 404s its siblings', async () => {
    const range = `?key=temperature&points=50&from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date().toISOString()}`;
    const ok = await app.inject({
      method: 'GET', url: `/api/instruments/${unplacedId}/telemetry${range}`, headers: operator,
    });
    expect(ok.statusCode).toBe(200);

    const denied = await app.inject({
      method: 'GET', url: `/api/instruments/${inAreaId}/telemetry${range}`, headers: operator,
    });
    expect(denied.statusCode).toBe(404);
  });
});

/**
 * "Same role, different users, different instruments" — the requirement the
 * per-user override exists for. The user's scope REPLACES the role's rather than
 * intersecting it, so it can widen as well as narrow; that is documented, is why
 * setting one is reauth-gated and audited, and is only decided in effectiveScope.
 */
describe('a per-user override, in the new shape', () => {
  it('replaces the role scope rather than intersecting with it', async () => {
    await storeRoleScope({ locationIds: [blockId], instrumentIds: [] });
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'RB0001' }, select: { id: true } });

    const put = await app.inject({
      method: 'PUT', url: `/api/roles/instrument-scope/user/${user.id}`,
      headers: { ...auth, ...reauth },
      payload: { scope: { locationIds: [], instrumentIds: [unplacedId] } },
    });
    expect(put.statusCode).toBe(200);

    // The role granted the block and NOT the unplaced instrument. If the two
    // intersected, this user would see nothing at all.
    const ids = await visibleIds();
    expect(ids).toEqual([unplacedId]);

    await prisma.userConfig.updateMany({
      where: { userId: user.id }, data: { instrumentScope: Prisma.DbNull },
    });
    // Back to inheriting the role, which proves the override was what did it.
    expect(await visibleIds()).toContain(inAreaId);
  });
});

/**
 * Counts must be scoped too, not just lists.
 *
 * A profile card reading "101 instruments" to someone who may see four is wrong
 * twice over: it misdescribes what they have, and it discloses how many
 * instruments exist outside their scope. This is the same defect shape as the
 * dead-letters and room-history leaks above — a number derived from a query that
 * never had the visibility filter applied.
 */
describe('instrument profile counts', () => {
  beforeAll(async () => {
    await storeRoleScope({ locationIds: [], instrumentIds: [unplacedId] });
  });

  it('counts only the instruments the caller can see', async () => {
    const seen = await visibleIds();
    expect(seen).toEqual([unplacedId]);

    const res = await app.inject({ method: 'GET', url: '/api/instrument-profiles', headers: operator });
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as { data: { id: string; instrumentCount: number; activeCount: number }[] }).data;
    const total = rows.reduce((sum, r) => sum + r.instrumentCount, 0);
    expect(total).toBe(seen.length);
    // activeCount is a subset of the same population, so it can never exceed it.
    for (const r of rows) expect(r.activeCount).toBeLessThanOrEqual(r.instrumentCount);
  });

  it('scopes the single-profile route the same way', async () => {
    const unplaced = await prisma.instrument.findUniqueOrThrow({
      where: { id: unplacedId }, select: { profileId: true },
    });
    const res = await app.inject({
      method: 'GET', url: `/api/instrument-profiles/${unplaced.profileId}`, headers: operator,
    });
    expect(res.statusCode).toBe(200);
    // Exactly the one instrument this caller may see, out of however many the
    // profile really holds.
    expect((res.json() as { instrumentCount: number }).instrumentCount).toBe(1);
  });

  it('still reports the TRUE total to an unrestricted caller', async () => {
    // The control: the count is scoped, not broken.
    const res = await app.inject({ method: 'GET', url: '/api/instrument-profiles', headers: auth });
    const rows = (res.json() as { data: { instrumentCount: number }[] }).data;
    const total = rows.reduce((sum, r) => sum + r.instrumentCount, 0);
    expect(total).toBeGreaterThanOrEqual(3);
  });

  it('the DELETE guard still counts EVERY instrument, scope or not', async () => {
    // Deliberately NOT scoped: the guard exists because the FK refuses the delete.
    // A scoped count would tell a restricted admin the profile is empty and then
    // hand them a raw foreign-key error when they act on it.
    const unplaced = await prisma.instrument.findUniqueOrThrow({
      where: { id: unplacedId }, select: { profileId: true },
    });
    const res = await app.inject({
      method: 'DELETE', url: `/api/instrument-profiles/${unplaced.profileId}`,
      headers: { ...auth, ...reauth },
    });
    expect(res.statusCode).toBe(409);
    const message = (res.json() as { message: string }).message;
    // The fixture profile holds our three instruments at minimum; the message must
    // quote the real number, never the caller's visible subset.
    const quoted = Number(/contains (\d+) instrument/.exec(message)?.[1]);
    expect(quoted).toBeGreaterThanOrEqual(3);
  });
});

/**
 * The Block > Area tree the dashboard navigates by. Its counts are a disclosure
 * too — before this was scoped, a Block card announced "100" to a caller who
 * could see one, revealing the size of the estate they were excluded from.
 */
describe('functional location tree counts', () => {
  beforeAll(async () => {
    await storeRoleScope({ locationIds: [areaId], instrumentIds: [] });
    // The tree route has its own permission, separate from INSTRUMENT_READ.
    const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
    await prisma.role.update({
      where: { id: role.id },
      data: { permissions: [...new Set([...(role.permissions as string[]), 'FUNCTIONAL_LOCATION_READ'])] },
    });
    invalidateRolePermsCache('OPERATOR');
  });

  it('counts only the instruments this caller may see, while still showing every location', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/functional-locations', headers: operator });
    expect(res.statusCode).toBe(200);
    const blocks = (res.json() as { data: { id: string; totalCount: number; children: { id: string; totalCount: number }[] }[] }).data;
    const block = blocks.find((b) => b.id === blockId)!;
    const other = blocks.find((b) => b.id === otherBlockId)!;

    // The scope granted ONE Area holding ONE instrument.
    expect(block.totalCount).toBe(1);
    expect(block.children.find((c) => c.id === areaId)!.totalCount).toBe(1);
    // The other Block holds an instrument, but not one this caller may see.
    expect(other.totalCount).toBe(0);
    // Both are still LISTED: a location is a place, not an instrument, and the
    // plant's structure must not change shape depending on who is looking.
    expect(other).toBeDefined();
  });

  it('reports the true counts to an unrestricted caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/functional-locations', headers: auth });
    const blocks = (res.json() as { data: { id: string; totalCount: number }[] }).data;
    expect(blocks.find((b) => b.id === blockId)!.totalCount).toBe(1);
    expect(blocks.find((b) => b.id === otherBlockId)!.totalCount).toBe(1);
  });
});

describe('GET /api/instruments?functionalLocationId — the Alarms page filters', () => {
  /**
   * Added 2026-09-01 so the Alarms page can offer Block / Area / Instrument
   * pickers whose instrument list is narrowed BY THE SERVER.
   *
   * NOT the `block`/`area` query params beside it: those match the SUPERSEDED
   * free-text `Instrument.block` / `.area` columns, which are no longer read for
   * grouping. This one is the authoritative tree.
   */
  const list = async (qs: string, headers = auth) => {
    const res = await app.inject({ method: 'GET', url: `/api/instruments?limit=500&${qs}`, headers });
    expect(res.statusCode).toBe(200);
    return (res.json() as { data: { id: string }[] }).data.map((i) => i.id);
  };

  it('resolves a BLOCK to the instruments in its AREAS', async () => {
    /**
     * THE assertion. `inAreaId` is pinned to the Area, and NOTHING is pinned to
     * the Block itself — which is the shape of this whole installation. A bare
     * `functionalLocationId = <block>` equality returns an empty list and looks
     * like a working filter over an empty plant.
     */
    const ids = await list(`functionalLocationId=${blockId}`);
    expect(ids).toContain(inAreaId);
    expect(ids).not.toContain(elsewhereId);
    expect(ids).not.toContain(unplacedId);
  });

  it('resolves an AREA to its own instruments', async () => {
    const ids = await list(`functionalLocationId=${areaId}`);
    expect(ids).toContain(inAreaId);
    expect(ids).not.toContain(elsewhereId);
  });

  it('returns nothing for a location holding no instruments', async () => {
    expect(await list(`functionalLocationId=${otherBlockId}`)).not.toContain(inAreaId);
  });

  it('lists everything placed and unplaced when no location is given', async () => {
    // The filter must be opt-in: an absent parameter is not an empty one.
    const ids = await list('');
    expect(ids).toEqual(expect.arrayContaining([inAreaId, elsewhereId, unplacedId]));
  });

  it('rejects a malformed id rather than silently ignoring it', async () => {
    // A filter quietly dropped would list the whole plant while the picker showed
    // one Area — the operator would be choosing from instruments outside it.
    const res = await app.inject({
      method: 'GET', url: '/api/instruments?functionalLocationId=not-a-uuid', headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  it('cannot widen a restricted caller past their own scope', async () => {
    // The filter ANDs with visibility. Asking for a Block they cannot see returns
    // nothing, rather than revealing it.
    await storeRoleScope({ locationIds: [], instrumentIds: [] });
    const operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
    expect(await list(`functionalLocationId=${blockId}`, operator)).toEqual([]);
  });
});

describe('GET /api/instruments — functionalLocationId survives the response filter', () => {
  /**
   * Declared in `instrumentProps` on 2026-09-01. The query already selected the
   * whole model, so the value existed and Fastify was stripping it silently —
   * the failure mode this repo has now hit SIX times.
   *
   * The Alarm Report needs it: a single-instrument download names that
   * instrument's Block and Area in its header, and without this both printed
   * blank because neither control had been touched.
   */
  it('returns the placement of a placed instrument', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/instruments?limit=500&functionalLocationId=${areaId}`, headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const row = (res.json() as { data: { id: string; functionalLocationId?: string }[] })
      .data.find((i) => i.id === inAreaId);
    expect(row).toBeDefined();
    expect(row!.functionalLocationId).toBe(areaId);
  });

  it('returns null for an instrument that is not placed', async () => {
    // Not absent — the report prints a dash for it, and an absent key and a null
    // are different things to a client that checks.
    const res = await app.inject({ method: 'GET', url: '/api/instruments?limit=500', headers: auth });
    const row = (res.json() as { data: { id: string; functionalLocationId?: string | null }[] })
      .data.find((i) => i.id === unplacedId);
    expect(row).toBeDefined();
    expect(row!.functionalLocationId ?? null).toBeNull();
  });
});
