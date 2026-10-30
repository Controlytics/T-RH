import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { invalidateProfileMeasurementsCache } from '../modules/instruments/profile-measurements.js';
import { ALARM_TYPE_TOKENS } from '../modules/alarms/list-query.js';
import { DEFAULT_PROFILE_MEASUREMENTS } from '@digilog/shared';

/**
 * Dashboard builder phase 2, task 2: the overview's `judged` + `lastSeenAt`, and
 * `GET /api/alarms/counts`.
 *
 * Fixture: Block K holds Area X (tA on profile T&RH, pA on profile Pressure whose
 * measurements are `[]`) and Area Y (tB on T&RH). The OPERATOR is scoped to Area X.
 * Every alarm query is scoped to Block K so the shared test database's other alarms
 * cannot move a number.
 *
 *   X/tA  a1 TEMP_HIGH active unack     a2 TEMP_LOW active ack
 *         a3 RH_HIGH cleared unack      a4 RH_LOW cleared ack
 *   X/pA  a5 OFFLINE active unack
 *   Y/tB  a6 TEMP_HIGH active unack     a7 TEMP_HIGH cleared unack
 */

const S = Date.now();
const PW = 'Dp2@Pass1234';
const SA = `dp2_sa_${S}`;
const OP = `dp2_op_${S}`;
const NOREAD = `dp2_nr_${S}`;
const ROLE = `DP2_OP_${S}`;
const ROLE_NR = `DP2_NR_${S}`;
const SEEN = new Date('2026-10-30T10:00:00.000Z');

let app: FastifyInstance;
let sa: Record<string, string>;
let operator: Record<string, string>;
let noRead: Record<string, string>;
let blockK = '', areaX = '', areaY = '';
let profileT = '', profileP = '', profileTH = '', profileH = '', profileNoKey = '';
let tA = '', pA = '', tB = '', iTH = '', iH = '', iNoKey = '';
const alarmIds: string[] = [];
const userIds: string[] = [];

async function instrument(code: string, profileId: string, functionalLocationId: string, lastSeenAt: Date | null) {
  return (await prisma.instrument.create({
    data: { name: `dp2 ${code}`, code, profileId, functionalLocationId, lastSeenAt },
  })).id;
}

async function alarm(
  instrumentId: string,
  kind: { metric: 'TEMPERATURE' | 'HUMIDITY' | 'OFFLINE'; limitKind?: 'HIGH' | 'LOW'; source: 'INSTRUMENT_LIMIT' | 'INACTIVITY' },
  state: 'ACTIVE' | 'CLEARED',
  acked: boolean,
) {
  const a = await prisma.alarm.create({
    data: {
      instrumentId, metric: kind.metric, limitKind: kind.limitKind ?? null, source: kind.source,
      severity: 'CRITICAL', state, triggeredValue: 28.5, raisedAt: new Date('2026-10-30T09:00:00.000Z'),
      clearedAt: state === 'CLEARED' ? new Date('2026-10-30T09:30:00.000Z') : null,
      acknowledgedAt: acked ? new Date('2026-10-30T09:40:00.000Z') : null,
      acknowledgedBy: acked ? 'dp2' : null,
      ruleSnapshot: { limit: 27, limitKind: kind.limitKind ?? null, decimals: 1 },
    },
  });
  alarmIds.push(a.id);
  return a.id;
}

beforeAll(async () => {
  app = await buildApp();

  blockK = (await prisma.functionalLocation.create({ data: { name: `DP2 K ${S}`, type: 'BLOCK' } })).id;
  areaX = (await prisma.functionalLocation.create({ data: { name: `DP2 X ${S}`, type: 'AREA', parentId: blockK } })).id;
  areaY = (await prisma.functionalLocation.create({ data: { name: `DP2 Y ${S}`, type: 'AREA', parentId: blockK } })).id;
  // NULL measurements read as the defaults (temperature + humidity); `[]` measures nothing.
  profileT = (await prisma.instrumentProfile.create({ data: { name: `dp2-T&RH-${S}`, description: 'dp2 fixture' } })).id;
  profileP = (await prisma.instrumentProfile.create({
    data: { name: `dp2-Pressure-${S}`, description: 'dp2 fixture', measurements: [] as never },
  })).id;
  // An explicitly STORED temperature + humidity list (not the NULL default).
  profileTH = (await prisma.instrumentProfile.create({
    data: { name: `dp2-TH-${S}`, description: 'dp2 fixture', measurements: structuredClone(DEFAULT_PROFILE_MEASUREMENTS) as never },
  })).id;
  // Humidity only, with its device keys: still judged (the `|| humidity` operand).
  profileH = (await prisma.instrumentProfile.create({
    data: {
      name: `dp2-H-${S}`, description: 'dp2 fixture',
      measurements: structuredClone(DEFAULT_PROFILE_MEASUREMENTS).filter((m) => m.code === 'HUMIDITY') as never,
    },
  })).id;
  // A temperature measurement that maps NO device key: nothing it could judge.
  profileNoKey = (await prisma.instrumentProfile.create({
    data: {
      name: `dp2-NoKey-${S}`, description: 'dp2 fixture',
      measurements: structuredClone(DEFAULT_PROFILE_MEASUREMENTS)
        .filter((m) => m.code === 'TEMPERATURE').map((m) => ({ ...m, deviceKeys: [] })) as never,
    },
  })).id;
  invalidateProfileMeasurementsCache();

  iTH = await instrument(`DP2-TH-${S}`, profileTH, areaY, null);
  iH = await instrument(`DP2-H-${S}`, profileH, areaY, null);
  iNoKey = await instrument(`DP2-NK-${S}`, profileNoKey, areaY, new Date());
  tA = await instrument(`DP2-TA-${S}`, profileT, areaX, SEEN);
  // Reporting NOW (the staleness rule is relative to the request instant) and no readings.
  pA = await instrument(`DP2-PA-${S}`, profileP, areaX, new Date());
  tB = await instrument(`DP2-TB-${S}`, profileT, areaY, null);

  await alarm(tA, { metric: 'TEMPERATURE', limitKind: 'HIGH', source: 'INSTRUMENT_LIMIT' }, 'ACTIVE', false);
  await alarm(tA, { metric: 'TEMPERATURE', limitKind: 'LOW', source: 'INSTRUMENT_LIMIT' }, 'ACTIVE', true);
  await alarm(tA, { metric: 'HUMIDITY', limitKind: 'HIGH', source: 'INSTRUMENT_LIMIT' }, 'CLEARED', false);
  await alarm(tA, { metric: 'HUMIDITY', limitKind: 'LOW', source: 'INSTRUMENT_LIMIT' }, 'CLEARED', true);
  await alarm(pA, { metric: 'OFFLINE', source: 'INACTIVITY' }, 'ACTIVE', false);
  await alarm(tB, { metric: 'TEMPERATURE', limitKind: 'HIGH', source: 'INSTRUMENT_LIMIT' }, 'ACTIVE', false);
  await alarm(tB, { metric: 'TEMPERATURE', limitKind: 'HIGH', source: 'INSTRUMENT_LIMIT' }, 'CLEARED', false);

  for (const [name, perms] of [
    [ROLE, ['INSTRUMENT_READ', 'ALARM_READ']],
    [ROLE_NR, ['INSTRUMENT_READ']],
  ] as const) {
    await prisma.role.create({
      data: { name, displayName: `${name}`, hierarchyLevel: 2, isSystem: false, permissions: [...perms] },
    });
  }
  await prisma.roleConfig.create({
    data: { role: ROLE, instrumentScope: { locationIds: [areaX], instrumentIds: [] } as never },
  });
  invalidateRolePermsCache(ROLE);
  invalidateRolePermsCache(ROLE_NR);

  for (const [username, role] of [[SA, 'SUPER_ADMIN'], [OP, ROLE], [NOREAD, ROLE_NR]] as const) {
    const u = await prisma.user.create({
      data: {
        username, fullName: username, role, passwordHash: await hashPassword(PW),
        passwordChangedAt: new Date(), forcePasswordChange: false, isTemporaryPassword: false,
      },
    });
    userIds.push(u.id);
  }
  sa = { authorization: `Bearer ${await loginAs(app, SA, PW)}` };
  operator = { authorization: `Bearer ${await loginAs(app, OP, PW)}` };
  noRead = { authorization: `Bearer ${await loginAs(app, NOREAD, PW)}` };
});

afterAll(async () => {
  await prisma.alarm.deleteMany({ where: { id: { in: alarmIds } } }).catch(() => {});
  await prisma.instrument.deleteMany({ where: { id: { in: [tA, pA, tB, iTH, iH, iNoKey].filter(Boolean) } } }).catch(() => {});
  await prisma.functionalLocation.deleteMany({ where: { id: { in: [areaX, areaY].filter(Boolean) } } }).catch(() => {});
  await prisma.functionalLocation.deleteMany({ where: { id: blockK } }).catch(() => {});
  await prisma.instrumentProfile.deleteMany({ where: { id: { in: [profileT, profileP, profileTH, profileH, profileNoKey].filter(Boolean) } } }).catch(() => {});
  invalidateProfileMeasurementsCache();
  await prisma.roleConfig.deleteMany({ where: { role: ROLE } }).catch(() => {});
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.passwordHistory.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await prisma.role.deleteMany({ where: { name: { in: [ROLE, ROLE_NR] } } }).catch(() => {});
  invalidateRolePermsCache(ROLE);
  invalidateRolePermsCache(ROLE_NR);
  await app.close();
});

const overview = (qs: string, headers = sa) =>
  app.inject({ method: 'GET', url: `/api/instruments/telemetry-overview?${qs}`, headers });
const counts = (qs: string, headers = sa) =>
  app.inject({ method: 'GET', url: `/api/alarms/counts?${qs}`, headers });
const list = (qs: string, headers = sa) =>
  app.inject({ method: 'GET', url: `/api/alarms?${qs}`, headers });

type Quadrants = { activeUnack: number; activeAck: number; clearedUnack: number; clearedAck: number };
const fromList = (c: Record<string, number>): Quadrants => ({
  activeUnack: c['active-unack'], activeAck: c['active-ack'],
  clearedUnack: c['cleared-unack'], clearedAck: c['cleared-ack'],
});

describe('telemetry-overview: judged + lastSeenAt', () => {
  it('a reporting pressure-only instrument is NO_DATA (unchanged) and not judged; T&RH is judged', async () => {
    const res = await overview(`instrumentIds=${tA},${pA},${tB}`);
    expect(res.statusCode).toBe(200);
    const rows = Object.fromEntries(res.json().data.map((r: { instrumentId: string }) => [r.instrumentId, r]));
    expect(rows[pA].reporting).toBe(true);
    expect(rows[pA].status).toBe('NO_DATA');
    expect(rows[pA].judged).toBe(false);
    expect(rows[tA].judged).toBe(true);
    expect(rows[tB].judged).toBe(true);
  });

  it('judged follows the profile: stored T&RH, humidity-only true; a temperature entry with no device key false', async () => {
    const res = await overview(`instrumentIds=${iTH},${iH},${iNoKey}`);
    const rows = Object.fromEntries(res.json().data.map((r: { instrumentId: string }) => [r.instrumentId, r]));
    expect(rows[iTH].judged).toBe(true);
    expect(rows[iH].judged).toBe(true);
    expect(rows[iNoKey].reporting).toBe(true);
    expect(rows[iNoKey].status).toBe('NO_DATA');
    expect(rows[iNoKey].judged).toBe(false);
  });

  it('lastSeenAt round-trips as an ISO string, null when never seen', async () => {
    const res = await overview(`instrumentIds=${tA},${tB}`);
    const rows = Object.fromEntries(res.json().data.map((r: { instrumentId: string }) => [r.instrumentId, r]));
    expect(rows[tA].lastSeenAt).toBe(SEEN.toISOString());
    expect(rows[tB].lastSeenAt).toBeNull();
  });
});

describe('GET /api/alarms/counts', () => {
  it('counts the four quadrants and every type, zeros included, in token order', async () => {
    const res = await counts(`functionalLocationId=${blockK}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().quadrants).toEqual({ activeUnack: 3, activeAck: 1, clearedUnack: 2, clearedAck: 1 });
    const byType = res.json().byType as { type: string; active: number; unacknowledged: number }[];
    expect(byType.map((t) => t.type)).toEqual([...ALARM_TYPE_TOKENS]);
    expect(byType).toEqual([
      { type: 'TEMP_HIGH', active: 2, unacknowledged: 3 },
      { type: 'TEMP_LOW', active: 1, unacknowledged: 0 },
      { type: 'RH_HIGH', active: 0, unacknowledged: 1 },
      { type: 'RH_LOW', active: 0, unacknowledged: 0 },
      { type: 'OFFLINE', active: 1, unacknowledged: 1 },
      { type: 'RS485', active: 0, unacknowledged: 0 },
      { type: 'RANGE', active: 0, unacknowledged: 0 },
    ]);
  });

  it('the OPERATOR counts only in-scope alarms; the out-of-scope alarms move the SA, not them', async () => {
    const op = await counts(`functionalLocationId=${blockK}`, operator);
    expect(op.statusCode).toBe(200);
    expect(op.json().quadrants).toEqual({ activeUnack: 2, activeAck: 1, clearedUnack: 1, clearedAck: 1 });
    const byType = op.json().byType as { type: string; active: number; unacknowledged: number }[];
    expect(byType.find((t) => t.type === 'TEMP_HIGH')).toEqual({ type: 'TEMP_HIGH', active: 1, unacknowledged: 1 });
    // The Area Y alarms (a6, a7) are the whole SA-vs-operator difference.
    const all = await counts(`functionalLocationId=${blockK}`);
    expect(all.json().quadrants.activeUnack - op.json().quadrants.activeUnack).toBe(1);
    expect(all.json().quadrants.clearedUnack - op.json().quadrants.clearedUnack).toBe(1);
    // Asking for the out-of-scope Area directly yields nothing for the operator.
    const outside = await counts(`instrumentIds=${tB}`, operator);
    expect(outside.json().quadrants).toEqual({ activeUnack: 0, activeAck: 0, clearedUnack: 0, clearedAck: 0 });
  });

  const queries: [string, () => string][] = [
    ['instrumentIds', () => `instrumentIds=${tA},${tB}`],
    ['profileId', () => `profileId=${profileT}`],
    ['functionalLocationDirect', () => `functionalLocationId=${areaX}&functionalLocationDirect=true`],
    ['functionalLocationId, Block direct', () => `functionalLocationId=${blockK}&functionalLocationDirect=true`],
    ['functionalLocationId (Block expands to Areas)', () => `functionalLocationId=${blockK}`],
    ['type', () => `functionalLocationId=${blockK}&type=TEMP_HIGH`],
  ];
  for (const [name, qs] of queries) {
    it(`narrows by ${name} exactly as GET /api/alarms counts does`, async () => {
      const [c, l] = await Promise.all([counts(qs()), list(qs())]);
      expect(c.statusCode).toBe(200);
      expect(l.statusCode).toBe(200);
      expect(c.json().quadrants).toEqual(fromList(l.json().counts));
    });
  }

  it('absolute numbers for the instrumentIds and profileId filters', async () => {
    // tA + tB: a1 a2 a3 a4 / a6 a7
    const ids = await counts(`instrumentIds=${tA},${tB}`);
    expect(ids.json().quadrants).toEqual({ activeUnack: 2, activeAck: 1, clearedUnack: 2, clearedAck: 1 });
    // profile T&RH holds tA and tB too (pA is the Pressure profile)
    const prof = await counts(`profileId=${profileT}`);
    expect(prof.json().quadrants).toEqual({ activeUnack: 2, activeAck: 1, clearedUnack: 2, clearedAck: 1 });
    const pressure = await counts(`profileId=${profileP}`);
    expect(pressure.json().quadrants).toEqual({ activeUnack: 1, activeAck: 0, clearedUnack: 0, clearedAck: 0 });
  });

  it('functionalLocationDirect on a Block excludes its Areas (the expanded Block holds 7)', async () => {
    const expanded = await counts(`functionalLocationId=${blockK}`);
    const total = (q: Quadrants) => q.activeUnack + q.activeAck + q.clearedUnack + q.clearedAck;
    expect(total(expanded.json().quadrants)).toBe(7);
    const direct = await counts(`functionalLocationId=${blockK}&functionalLocationDirect=true`);
    expect(direct.json().quadrants).toEqual({ activeUnack: 0, activeAck: 0, clearedUnack: 0, clearedAck: 0 });
    const l = await list(`functionalLocationId=${blockK}&functionalLocationDirect=true`);
    expect(fromList(l.json().counts)).toEqual(direct.json().quadrants);
  });

  it('an empty instrumentIds selects nothing; a bad filter is a 400 like the list', async () => {
    const empty = await counts('instrumentIds=');
    expect(empty.statusCode).toBe(200);
    expect(empty.json().quadrants).toEqual({ activeUnack: 0, activeAck: 0, clearedUnack: 0, clearedAck: 0 });
    expect((await counts('instrumentIds=nope')).statusCode).toBe(400);
    expect((await counts('profileId=nope')).statusCode).toBe(400);
    expect((await counts('functionalLocationId=nope&functionalLocationDirect=true')).statusCode).toBe(400);
  });

  it('a user without ALARM_READ gets 403', async () => {
    const res = await counts(`functionalLocationId=${blockK}`, noRead);
    expect(res.statusCode).toBe(403);
  });
});
