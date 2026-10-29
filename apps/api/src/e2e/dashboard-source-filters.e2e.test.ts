import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

/**
 * The two routes a dashboard's widgets read — `/api/instruments/telemetry-overview`
 * and `/api/alarms` — take a profile, an id list and (alarms) direct-only.
 *
 * Fixture: Block K holds C directly and Area X (holding A) and Area Y (holding B).
 * A and C are profile P, B is profile Q. One ACTIVE alarm on each. The OPERATOR is
 * scoped to Area X, so a filter that widened visibility would show up as B or C.
 */

const S = Date.now();
const PW = 'Dsf@Pass1234';
const SA = `dsf_sa_${S}`;
const OP = `dsf_op_${S}`;
const ROLE = `DSF_OP_${S}`;

let app: FastifyInstance;
let sa: Record<string, string>;
let operator: Record<string, string>;
let blockK = '', areaX = '', areaY = '';
let profileP = '', profileQ = '';
let A = '', B = '', C = '';
let aAlarm = '', bAlarm = '', cAlarm = '';
const userIds: string[] = [];

async function instrument(code: string, profileId: string, functionalLocationId: string) {
  return (await prisma.instrument.create({
    data: { name: `dsf ${code}`, code, profileId, functionalLocationId },
  })).id;
}

async function alarm(instrumentId: string) {
  return (await prisma.alarm.create({
    data: {
      instrumentId, metric: 'TEMPERATURE', limitKind: 'HIGH', source: 'INSTRUMENT_LIMIT',
      severity: 'CRITICAL', state: 'ACTIVE', triggeredValue: 28.5, raisedAt: new Date(),
      ruleSnapshot: { limit: 27, limitKind: 'HIGH', decimals: 1 },
    },
  })).id;
}

beforeAll(async () => {
  app = await buildApp();

  blockK = (await prisma.functionalLocation.create({ data: { name: `DSF K ${S}`, type: 'BLOCK' } })).id;
  areaX = (await prisma.functionalLocation.create({ data: { name: `DSF X ${S}`, type: 'AREA', parentId: blockK } })).id;
  areaY = (await prisma.functionalLocation.create({ data: { name: `DSF Y ${S}`, type: 'AREA', parentId: blockK } })).id;
  profileP = (await prisma.instrumentProfile.create({ data: { name: `dsf-P-${S}`, description: 'dsf fixture' } })).id;
  profileQ = (await prisma.instrumentProfile.create({ data: { name: `dsf-Q-${S}`, description: 'dsf fixture' } })).id;

  A = await instrument(`DSF-A-${S}`, profileP, areaX);
  B = await instrument(`DSF-B-${S}`, profileQ, areaY);
  C = await instrument(`DSF-C-${S}`, profileP, blockK);
  aAlarm = await alarm(A);
  bAlarm = await alarm(B);
  cAlarm = await alarm(C);

  await prisma.role.create({
    data: {
      name: ROLE, displayName: `DSF ${S}`, hierarchyLevel: 2, isSystem: false,
      permissions: ['INSTRUMENT_READ', 'ALARM_READ'],
    },
  });
  await prisma.roleConfig.create({
    data: { role: ROLE, instrumentScope: { locationIds: [areaX], instrumentIds: [] } as never },
  });
  invalidateRolePermsCache(ROLE);

  for (const [username, role] of [[SA, 'SUPER_ADMIN'], [OP, ROLE]] as const) {
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
});

afterAll(async () => {
  await prisma.alarm.deleteMany({ where: { id: { in: [aAlarm, bAlarm, cAlarm].filter(Boolean) } } }).catch(() => {});
  await prisma.instrument.deleteMany({ where: { id: { in: [A, B, C].filter(Boolean) } } }).catch(() => {});
  await prisma.functionalLocation.deleteMany({ where: { id: { in: [areaX, areaY].filter(Boolean) } } }).catch(() => {});
  await prisma.functionalLocation.deleteMany({ where: { id: blockK } }).catch(() => {});
  await prisma.instrumentProfile.deleteMany({ where: { id: { in: [profileP, profileQ].filter(Boolean) } } }).catch(() => {});
  await prisma.roleConfig.deleteMany({ where: { role: ROLE } }).catch(() => {});
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.passwordHistory.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await prisma.role.deleteMany({ where: { name: ROLE } }).catch(() => {});
  invalidateRolePermsCache(ROLE);
  await app.close();
});

const overview = (qs: string, headers = sa) =>
  app.inject({ method: 'GET', url: `/api/instruments/telemetry-overview?${qs}`, headers });
const alarms = (qs: string, headers = sa) =>
  app.inject({ method: 'GET', url: `/api/alarms?${qs}`, headers });

const ids = (res: { json: () => { data: { instrumentId: string }[] } }) =>
  res.json().data.map((r) => r.instrumentId).sort();
const sorted = (...x: string[]) => [...x].sort();
const sumCounts = (c: Record<string, number>) => Object.values(c).reduce((n, v) => n + v, 0);
const alarmIds = (res: { json: () => { data: { id: string }[] } }) => res.json().data.map((r) => r.id).sort();

describe('telemetry-overview filters', () => {
  it('overview by profile', async () => {
    const res = await overview(`profileId=${profileP}`);
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual(sorted(A, C));
  });

  it('overview by id list, inside scope', async () => {
    const res = await overview(`instrumentIds=${A},${B}`, operator);
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual([A]);
  });

  it('an empty instrumentIds selects nothing', async () => {
    const res = await overview('instrumentIds=');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it('an unknown profileId selects nothing', async () => {
    const res = await overview(`profileId=${randomUUID()}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it('a bad id list is a 400', async () => {
    const bad = await overview('instrumentIds=nope');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('VALIDATION_ERROR');
    const many = await overview(`instrumentIds=${Array.from({ length: 201 }, () => randomUUID()).join(',')}`);
    expect(many.statusCode).toBe(400);
  });
});

describe('GET /api/alarms filters', () => {
  it('alarms by id list and by profile; counts agree', async () => {
    const byIds = await alarms(`instrumentIds=${A},${B}`);
    expect(alarmIds(byIds)).toEqual(sorted(aAlarm, bAlarm));
    expect(byIds.json().total).toBe(2);
    expect(sumCounts(byIds.json().counts)).toBe(2);

    const byProfile = await alarms(`profileId=${profileP}`);
    expect(alarmIds(byProfile)).toEqual(sorted(aAlarm, cAlarm));
    expect(byProfile.json().total).toBe(2);
    expect(sumCounts(byProfile.json().counts)).toBe(2);
  });

  it('an empty instrumentIds selects no alarms; a bad one is a 400', async () => {
    expect((await alarms('instrumentIds=')).json().data).toEqual([]);
    expect((await alarms('instrumentIds=nope')).statusCode).toBe(400);
    expect((await alarms('profileId=nope')).statusCode).toBe(400);
  });

  it('alarms direct-only', async () => {
    const withAreas = await alarms(`functionalLocationId=${blockK}`);
    expect(alarmIds(withAreas)).toEqual(sorted(aAlarm, bAlarm, cAlarm));

    const direct = await alarms(`functionalLocationId=${blockK}&functionalLocationDirect=true`);
    expect(alarmIds(direct)).toEqual([cAlarm]);
    expect(direct.json().total).toBe(1);
  });

  it('alarm filters stay inside scope', async () => {
    const res = await alarms(`instrumentIds=${A},${B}`, operator);
    expect(res.statusCode).toBe(200);
    expect(alarmIds(res)).toEqual([aAlarm]);
  });
});
