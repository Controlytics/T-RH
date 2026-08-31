import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

/**
 * `GET /api/alarms` — search, date range, type, status, sorting and server-side paging.
 *
 * The property this file exists to protect: **the four count boxes above the table
 * and the "showing N of M" under it are answers to the same question.** `total` is
 * derived from the four quadrant counts rather than counted separately, and the
 * quadrants partition the filtered set exactly. If that ever stops holding, a box
 * claims more alarms than the table can list — which on a monitoring screen reads
 * as "some alarms are being hidden from me".
 *
 * Every request here is scoped to a fixture Block, so the assertions are exact
 * numbers rather than "at least", and other suites' alarms cannot perturb them.
 */

let app: FastifyInstance;
let auth: Record<string, string>;
/** The seeded OPERATOR. SUPER_ADMIN short-circuits visibility to unrestricted, so
 *  the scoping assertions below would pass against a route with NO scoping at all
 *  if they were driven as `admin`. */
let operator: Record<string, string>;
let roleId = '';
let rolePermsBefore: string[] = [];
let roleScopeBefore: unknown = undefined;
let roleConfigExisted = false;
let blockId = '';
let areaId = '';
const instrumentIds: string[] = [];
const alarmIds: string[] = [];

const STAMP = Date.now();
const CODE_A = `ALF-E2E-A-${STAMP}`;
const CODE_B = `ALF-E2E-B-${STAMP}`;
const AREA_NAME = `Blender Area ${STAMP}`;

/** Fixed, far from any real data, so the range assertions are not clock-dependent. */
const D = (day: number, hour = 12) => new Date(Date.UTC(2026, 0, day, hour, 0, 0));

async function raise(opts: {
  instrumentId: string;
  metric: 'TEMPERATURE' | 'HUMIDITY';
  limitKind: 'HIGH' | 'LOW';
  state: 'ACTIVE' | 'CLEARED';
  acknowledged: boolean;
  raisedAt: Date;
}) {
  const a = await prisma.alarm.create({
    data: {
      instrumentId: opts.instrumentId,
      metric: opts.metric,
      limitKind: opts.limitKind,
      source: 'INSTRUMENT_LIMIT',
      severity: 'CRITICAL',
      state: opts.state,
      triggeredValue: 28.5,
      raisedAt: opts.raisedAt,
      clearedAt: opts.state === 'CLEARED' ? new Date(opts.raisedAt.getTime() + 600_000) : null,
      acknowledgedAt: opts.acknowledged ? new Date(opts.raisedAt.getTime() + 900_000) : null,
      acknowledgedBy: opts.acknowledged ? 'admin' : null,
      acknowledgeReason: opts.acknowledged ? 'Reviewed during the shift handover' : null,
      ruleSnapshot: { limit: 27, limitKind: opts.limitKind, decimals: 1 },
    },
  });
  alarmIds.push(a.id);
  return a.id;
}

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };

  const block = await prisma.functionalLocation.create({
    data: { name: `ALF Block ${STAMP}`, type: 'BLOCK' },
  });
  blockId = block.id;
  // The instruments hang off the AREA, never the Block. Querying the Block must
  // still find them, which is the whole point of resolveLocationIds().
  const area = await prisma.functionalLocation.create({
    data: { name: AREA_NAME, type: 'AREA', parentId: blockId },
  });
  areaId = area.id;

  const profileId = await fixtureProfileId('fixture:alarm-list-filters');
  for (const code of [CODE_A, CODE_B]) {
    const i = await prisma.instrument.create({
      data: { name: `alarm-list ${code}`, code, profileId, functionalLocationId: areaId },
    });
    instrumentIds.push(i.id);
  }
  const [A, B] = instrumentIds;

  // Two per quadrant-pair, spread over three days and four types.
  await raise({ instrumentId: A, metric: 'TEMPERATURE', limitKind: 'HIGH', state: 'ACTIVE', acknowledged: false, raisedAt: D(10) });
  await raise({ instrumentId: B, metric: 'TEMPERATURE', limitKind: 'HIGH', state: 'ACTIVE', acknowledged: false, raisedAt: D(11) });
  await raise({ instrumentId: A, metric: 'HUMIDITY', limitKind: 'HIGH', state: 'ACTIVE', acknowledged: true, raisedAt: D(12) });
  await raise({ instrumentId: A, metric: 'TEMPERATURE', limitKind: 'HIGH', state: 'CLEARED', acknowledged: false, raisedAt: D(10, 8) });
  await raise({ instrumentId: B, metric: 'HUMIDITY', limitKind: 'HIGH', state: 'CLEARED', acknowledged: false, raisedAt: D(11, 8) });
  await raise({ instrumentId: B, metric: 'TEMPERATURE', limitKind: 'LOW', state: 'CLEARED', acknowledged: true, raisedAt: D(12, 8) });

  // The OPERATOR needs ALARM_READ to reach the route at all; without it the
  // scoping cases below would 403 and look like a pass for the wrong reason.
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
  roleId = role.id;
  rolePermsBefore = role.permissions as string[];
  await prisma.role.update({
    where: { id: roleId },
    data: { permissions: [...rolePermsBefore, 'ALARM_READ'] },
  });
  invalidateRolePermsCache('OPERATOR');

  // This suite shares `compliance_core_db_test` with instrument-scope-selection,
  // which also writes this row. Captured verbatim and restored in afterAll.
  const existing = await prisma.roleConfig.findUnique({ where: { role: 'OPERATOR' } });
  roleConfigExisted = Boolean(existing);
  roleScopeBefore = existing?.instrumentScope ?? undefined;

  operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
});

afterAll(async () => {
  if (roleId) {
    await prisma.role.update({ where: { id: roleId }, data: { permissions: rolePermsBefore } });
    invalidateRolePermsCache('OPERATOR');
  }
  if (roleConfigExisted) {
    // `Prisma.DbNull`, never `JsonNull` — writing the latter stores the JSON value
    // `null`, which is not the same as "no scope stored".
    await prisma.roleConfig.update({
      where: { role: 'OPERATOR' },
      data: { instrumentScope: (roleScopeBefore ?? Prisma.DbNull) as never },
    });
  } else {
    await prisma.roleConfig.deleteMany({ where: { role: 'OPERATOR' } });
  }
  // Restrict FKs: alarms before instruments, instruments before locations.
  if (alarmIds.length) await prisma.alarm.deleteMany({ where: { id: { in: alarmIds } } });
  if (instrumentIds.length) await prisma.instrument.deleteMany({ where: { id: { in: instrumentIds } } });
  if (areaId) await prisma.functionalLocation.delete({ where: { id: areaId } }).catch(() => {});
  if (blockId) await prisma.functionalLocation.delete({ where: { id: blockId } }).catch(() => {});
  await app.close();
});

/** Every request is pinned to the fixture Block so the numbers below are exact. */
const list = (extra: Record<string, string | number> = {}) => {
  const qs = new URLSearchParams({ functionalLocationId: blockId });
  for (const [k, v] of Object.entries(extra)) qs.set(k, String(v));
  return app.inject({ method: 'GET', url: `/api/alarms?${qs.toString()}`, headers: auth });
};

describe('GET /api/alarms — counts and total', () => {
  it('finds instruments in the Block\'s AREAS, not only those pinned to the Block', async () => {
    const body = (await list()).json();
    expect(body.total).toBe(6);
  });

  it('returns the four quadrant counts, and they sum to the total', async () => {
    const { counts, total } = (await list()).json();
    expect(counts).toEqual({
      'active-unack': 2, 'active-ack': 1, 'cleared-unack': 2, 'cleared-ack': 1,
    });
    expect(counts['active-unack'] + counts['active-ack'] + counts['cleared-unack'] + counts['cleared-ack'])
      .toBe(total);
  });

  it('leaves the counts alone when a status is selected, and narrows only the rows', async () => {
    // The boxes are the filter. If choosing one zeroed the other three, the
    // operator could never see what they were about to switch to.
    const body = (await list({ status: 'cleared-unack' })).json();
    expect(body.counts).toEqual({
      'active-unack': 2, 'active-ack': 1, 'cleared-unack': 2, 'cleared-ack': 1,
    });
    expect(body.total).toBe(2);
    expect(body.data).toHaveLength(2);
    for (const a of body.data) {
      expect(a.state).toBe('CLEARED');
      expect(a.acknowledgedAt).toBeNull();
    }
  });

  it('narrows the counts with every OTHER filter, so the boxes describe what is listed', async () => {
    const body = (await list({ type: 'TEMP_HIGH' })).json();
    expect(body.counts).toEqual({
      'active-unack': 2, 'active-ack': 0, 'cleared-unack': 1, 'cleared-ack': 0,
    });
    expect(body.total).toBe(3);
  });
});

describe('GET /api/alarms — filters', () => {
  it('filters by type through the enum pair that defines it', async () => {
    expect((await list({ type: 'TEMP_LOW' })).json().total).toBe(1);
    expect((await list({ type: 'RH_HIGH' })).json().total).toBe(2);
    // Every alarm here is INSTRUMENT_LIMIT, so the RULE token must match none.
    expect((await list({ type: 'RULE' })).json().total).toBe(0);
  });

  it('searches the instrument code', async () => {
    const body = (await list({ search: CODE_A })).json();
    expect(body.total).toBe(3);
    for (const a of body.data) expect(a.instrumentCode).toBe(CODE_A);
  });

  it('searches the functional location name, case-insensitively', async () => {
    expect((await list({ search: AREA_NAME.toLowerCase() })).json().total).toBe(6);
  });

  it('applies the date range to raisedAt, inclusive at both ends', async () => {
    const on11 = await list({
      from: D(11, 0).toISOString(),
      to: D(11, 23).toISOString(),
    });
    expect(on11.json().total).toBe(2);

    // The 10th 08:00 alarm is the earliest; an exact-match lower bound must include it.
    const fromExact = await list({ from: D(10, 8).toISOString() });
    expect(fromExact.json().total).toBe(6);
  });

  it('rejects an unreadable date instead of silently listing the whole range', async () => {
    const res = await list({ from: 'last tuesday' });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('from');
  });

  it('rejects a range that ends before it starts', async () => {
    const res = await list({ from: D(12).toISOString(), to: D(10).toISOString() });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('to');
  });
});

describe('GET /api/alarms — paging and sorting', () => {
  it('pages server-side while total keeps describing the whole match', async () => {
    const p1 = (await list({ pageSize: 4, page: 1 })).json();
    const p2 = (await list({ pageSize: 4, page: 2 })).json();
    expect(p1.data).toHaveLength(4);
    expect(p2.data).toHaveLength(2);
    expect(p1.total).toBe(6);
    expect(p2.total).toBe(6);

    // No row may appear on both pages, and between them they must be the whole set.
    const ids = [...p1.data, ...p2.data].map((a: { id: string }) => a.id);
    expect(new Set(ids).size).toBe(6);
  });

  it('defaults to newest first', async () => {
    const rows = (await list()).json().data as { raisedAt: string }[];
    const times = rows.map((r) => Date.parse(r.raisedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('sorts by the instrument code rather than its foreign key', async () => {
    const rows = (await list({ sort: 'instrumentCode', dir: 'asc' })).json().data as { instrumentCode: string }[];
    expect(rows[0].instrumentCode).toBe(CODE_A);
    expect(rows[rows.length - 1].instrumentCode).toBe(CODE_B);
  });

  it('keeps still-active alarms last when sorting by cleared time', async () => {
    // Postgres floats NULLs to the top on DESC; the three ACTIVE rows have no
    // cleared time and would otherwise bury the rows the sort was asked about.
    const rows = (await list({ sort: 'clearedAt', dir: 'desc' })).json().data as { clearedAt: string | null }[];
    expect(rows.slice(0, 3).every((r) => r.clearedAt !== null)).toBe(true);
    expect(rows.slice(3).every((r) => r.clearedAt === null)).toBe(true);
  });

  it('still honours the legacy `limit` parameter its other callers send', async () => {
    // The dashboard's selection panel and the trend page's alarms widget both send
    // `limit`. If it stopped meaning page size they would silently drop to 25 rows.
    expect((await list({ limit: 500 })).json().data).toHaveLength(6);
    expect((await list({ limit: 2 })).json().data).toHaveLength(2);
  });
});

describe('GET /api/alarms — row payload', () => {
  it('names where the instrument is, from its functional location', async () => {
    // Fastify strips any field the response schema does not declare, so this is
    // asserted through the HTTP body rather than the handler's return value.
    const row = (await list({ pageSize: 1 })).json().data[0];
    expect(row.locationName).toBe(AREA_NAME);
    expect(row.instrumentName).toContain('alarm-list');
  });

  it('does not carry a room — the column shows the functional location alone', async () => {
    // Dropped 2026-08-31 with the Location column's second line. The room is
    // geometry, and every room here is coded with its instrument's own code.
    const row = (await list({ pageSize: 1 })).json().data[0];
    expect(row.roomLabel).toBeUndefined();
  });
});

describe('GET /api/alarms — instrument visibility', () => {
  /** Restrict the OPERATOR to instrument A alone, by explicit id. */
  const scopeTo = async (instrumentIds: string[]) => {
    await prisma.roleConfig.upsert({
      where: { role: 'OPERATOR' },
      create: { role: 'OPERATOR', instrumentScope: { locationIds: [], instrumentIds } as never },
      update: { instrumentScope: { locationIds: [], instrumentIds } as never },
    });
  };

  const asOperator = (extra: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams({ functionalLocationId: blockId });
    for (const [k, v] of Object.entries(extra)) qs.set(k, String(v));
    return app.inject({ method: 'GET', url: `/api/alarms?${qs.toString()}`, headers: operator });
  };

  it('scopes the COUNTS, not only the rows', async () => {
    // The counts come from a `groupBy`, which is a different query path from the
    // `findMany` that returns the rows — so "the rows are scoped" is not evidence
    // that the boxes are. A count that escaped the scope would tell a restricted
    // operator how many alarms exist on equipment they may not see, which is
    // precisely what this module's docstring says the scope withholds.
    await scopeTo([instrumentIds[0]]);
    const body = (await asOperator()).json();

    expect(body.total).toBe(3);
    expect(body.counts).toEqual({
      'active-unack': 1, 'active-ack': 1, 'cleared-unack': 1, 'cleared-ack': 0,
    });
    expect(body.data).toHaveLength(3);
    for (const a of body.data) expect(a.instrumentCode).toBe(CODE_A);
  });

  it('keeps the scope when another filter is applied', async () => {
    // Every new filter is ANDed INSIDE the visibility clause. A filter that
    // replaced it rather than narrowing within it would widen the result.
    await scopeTo([instrumentIds[0]]);
    const body = (await asOperator({ type: 'TEMP_HIGH' })).json();
    expect(body.total).toBe(2);
    for (const a of body.data) expect(a.instrumentCode).toBe(CODE_A);
  });

  it('cannot be widened by searching for an instrument outside the scope', async () => {
    // Search matches the instrument code. If it were ORed alongside visibility
    // instead of ANDed within it, naming B would reveal B.
    await scopeTo([instrumentIds[0]]);
    const body = (await asOperator({ search: CODE_B })).json();
    expect(body.total).toBe(0);
    expect(body.data).toHaveLength(0);
    expect(body.counts).toEqual({
      'active-unack': 0, 'active-ack': 0, 'cleared-unack': 0, 'cleared-ack': 0,
    });
  });

  it('shows nothing at all for an EMPTY selection', async () => {
    // An empty selection means SEE NOTHING, never "no restriction stored".
    await scopeTo([]);
    const body = (await asOperator()).json();
    expect(body.total).toBe(0);
    expect(body.data).toHaveLength(0);
  });

  it('positive control: unrestricted sees all six', async () => {
    // Without this, a route that returned nothing to everybody would pass every
    // assertion above.
    await prisma.roleConfig.upsert({
      where: { role: 'OPERATOR' },
      create: { role: 'OPERATOR', instrumentScope: Prisma.DbNull },
      update: { instrumentScope: Prisma.DbNull },
    });
    const body = (await asOperator()).json();
    expect(body.total).toBe(6);
    expect(body.counts).toEqual({
      'active-unack': 2, 'active-ack': 1, 'cleared-unack': 2, 'cleared-ack': 1,
    });
  });
});
