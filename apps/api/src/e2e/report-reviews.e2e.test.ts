import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * HTTP-level coverage of the report review workflow — as reshaped 2026-10-01:
 *
 *  - The requester chooses NOBODY. A request goes to every configured approver
 *    role and user (Configuration → Report Approvers), FROZEN onto the row.
 *  - The requester's ROLE-MATES and every approver may view it, and download it
 *    once approved; only approvers may decide.
 *  - All of them only within their INSTRUMENT SCOPE ("any" overlap). The two
 *    signers and SUPER_ADMIN are not scope-bound.
 *  - Whether a type is requested at all, with remarks, with the password, is
 *    per-type configuration (Configuration → Report Downloads).
 *
 * The cast, by what each proves:
 *   U_REQ       raises the requests                          (ROLE_REQ)
 *   U_MATE      the requester's role-mate — sees, never decides (ROLE_REQ)
 *   U_MATE_OUT  a role-mate scoped to the OTHER instrument     (ROLE_REQ, scope B)
 *   U_APPR      an approver by ROLE                           (ROLE_APPR)
 *   U_APPR_OUT  an approver by role, scoped to the other one  (ROLE_APPR, scope B)
 *   U_NAMED     an approver named OUTRIGHT                    (ROLE_OTHER)
 *   U_OTHER     same role as U_NAMED, not named — a stranger  (ROLE_OTHER)
 *
 * Every assertion is over `app.inject`, the only thing that catches a field the
 * response schema forgot to declare. Config rows are pinned and restored FIRST
 * in `afterAll` (the 2026-08-31 incident).
 */

const PASSWORD = 'ReportReview@Test1';
const STAMP = String(Date.now()).slice(-6);
const ROLE_REQ = `RR_OP_${STAMP}`;
const ROLE_APPR = `RR_SUP_${STAMP}`;
const ROLE_OTHER = `RR_QA_${STAMP}`;
// Short usernames: a login-path column is varchar(20).
const U = {
  REQ: `rrq${STAMP}`, MATE: `rrm${STAMP}`, MATE_OUT: `rro${STAMP}`,
  APPR: `rra${STAMP}`, APPR_OUT: `rrx${STAMP}`, NAMED: `rrn${STAMP}`, OTHER: `rrz${STAMP}`,
};
const USERNAMES = Object.values(U);
const CONFIG_KEYS = ['action-reauth', 'report-approvers', 'report-downloads'] as const;

let app: FastifyInstance;
const tok: Record<keyof typeof U, string> = { REQ: '', MATE: '', MATE_OUT: '', APPR: '', APPR_OUT: '', NAMED: '', OTHER: '' };
let tokAdmin = '';
const ids: Partial<Record<keyof typeof U, string>> = {};
let instA = '';
let instB = '';
const originals = new Map<string, { configValue: unknown; configType: string; requiresReauth: boolean } | null>();
const created: string[] = [];

async function setConfig(key: string, value: unknown, type = 'system') {
  await prisma.systemConfig.upsert({
    where: { configKey: key },
    update: { configValue: value as never, configType: type, requiresReauth: false },
    create: { configKey: key, configValue: value as never, configType: type, requiresReauth: false },
  });
}
const setApprovers = (roles: string[], userIds: string[]) => setConfig('report-approvers', { approverRoles: roles, approverUserIds: userIds });

const snapshot = {
  version: 2, reportType: 'Instrument Time Series', title: 'Temperature and RH Data Report',
  config: { showAppName: false },
  sections: [{ kind: 'table', head: ['DATE', 'TIME'], body: [['2026-08-24', '00:20']] }],
};
const requestMeta = { period: { from: '2026-08-24T00:00:00.000Z', to: '2026-08-24T01:00:00.000Z', label: 'Custom' }, intervalMs: null };

const bearer = (t: string, password?: string) => ({ authorization: `Bearer ${t}`, ...(password ? { 'x-reauth-password': password } : {}) });

/** `password` '' = send none (an `undefined` argument would take the default). */
async function submit(token: string, extra: Record<string, unknown> = {}, password = PASSWORD) {
  return app.inject({
    method: 'POST', url: '/api/report-reviews', headers: bearer(token, password),
    payload: {
      reportKind: 'data-report', reportType: 'Instrument Time Series', title: 'Temperature and RH Data Report',
      requestMeta, dataSnapshot: snapshot, remarks: 'periodic review', instrumentIds: [instA], ...extra,
    },
  });
}
const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: bearer(token) });
const listIds = async (list: string, token: string) => (await get(`/api/report-reviews?list=${list}&pageSize=200`, token)).json().data.map((r: any) => r.id);

async function makeUser(username: string, role: string) {
  const { hashPassword } = await import('../lib/password.js');
  const passwordHash = await hashPassword(PASSWORD);
  return (await prisma.user.create({
    data: { username, passwordHash, fullName: username, email: `${username}@test.example`, role, status: 'ENABLED', forcePasswordChange: false, isTemporaryPassword: false },
    select: { id: true },
  })).id;
}
async function scopeUserTo(userId: string, instrumentIds: string[]) {
  await prisma.userConfig.upsert({
    where: { userId },
    update: { instrumentScope: { locationIds: [], instrumentIds } as never },
    create: { userId, instrumentScope: { locationIds: [], instrumentIds } as never },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.role.create({ data: { name: ROLE_REQ, displayName: 'RR Operator', hierarchyLevel: 1, permissions: ['REPORT_REVIEW_READ', 'INSTRUMENT_READ'] } });
  await prisma.role.create({ data: { name: ROLE_APPR, displayName: 'RR Supervisor', hierarchyLevel: 2, permissions: ['REPORT_REVIEW_READ', 'REPORT_REVIEW_APPROVE', 'INSTRUMENT_READ'] } });
  await prisma.role.create({ data: { name: ROLE_OTHER, displayName: 'RR QA', hierarchyLevel: 2, permissions: ['REPORT_REVIEW_READ', 'REPORT_REVIEW_APPROVE', 'INSTRUMENT_READ'] } });
  invalidateRolePermsCache();

  const profileId = await fixtureProfileId('fixture:report-reviews');
  instA = (await prisma.instrument.create({ data: { name: `RR-A-${STAMP}`, code: `RR-A-${STAMP}`, profileId } })).id;
  instB = (await prisma.instrument.create({ data: { name: `RR-B-${STAMP}`, code: `RR-B-${STAMP}`, profileId } })).id;

  ids.REQ = await makeUser(U.REQ, ROLE_REQ);
  ids.MATE = await makeUser(U.MATE, ROLE_REQ);
  ids.MATE_OUT = await makeUser(U.MATE_OUT, ROLE_REQ);
  ids.APPR = await makeUser(U.APPR, ROLE_APPR);
  ids.APPR_OUT = await makeUser(U.APPR_OUT, ROLE_APPR);
  ids.NAMED = await makeUser(U.NAMED, ROLE_OTHER);
  ids.OTHER = await makeUser(U.OTHER, ROLE_OTHER);
  await scopeUserTo(ids.MATE_OUT, [instB]);
  await scopeUserTo(ids.APPR_OUT, [instB]);
  for (const k of Object.keys(U) as (keyof typeof U)[]) tok[k] = await loginAs(app, U[k], PASSWORD);
  tokAdmin = await loginAs(app);

  for (const key of CONFIG_KEYS) {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: key } });
    originals.set(key, row ? { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth } : null);
  }
  await setConfig('action-reauth', { APPROVE_REPORT: [ROLE_APPR, ROLE_OTHER], REJECT_REPORT: [ROLE_APPR, ROLE_OTHER] }, 'security');
  invalidateReauthCache();
  await setApprovers([ROLE_APPR], [ids.NAMED]);
  await setConfig('report-downloads', {
    dataReportMode: 'REQUEST', dataReportRemarks: true, dataReportPassword: true,
    alarmsMode: 'REQUEST', alarmsRemarks: false, alarmsPassword: false,
    trendChartMode: 'DIRECT',
  });
});

beforeEach(() => invalidateReauthCache());

afterAll(async () => {
  for (const key of CONFIG_KEYS) {
    try {
      const o = originals.get(key);
      if (o) await prisma.systemConfig.update({ where: { configKey: key }, data: o as never });
      else await prisma.systemConfig.deleteMany({ where: { configKey: key } });
    } catch (e) { console.error(`${key} restore failed`, e); }
  }
  invalidateReauthCache();
  try { await prisma.reportReview.deleteMany({ where: { id: { in: created } } }); } catch (e) { console.error(e); }
  try { await prisma.notification.deleteMany({ where: { forUserId: { in: USERNAMES } } }); } catch (e) { console.error(e); }
  try { await prisma.userConfig.deleteMany({ where: { userId: { in: Object.values(ids) as string[] } } }); } catch (e) { console.error(e); }
  try { await prisma.session.deleteMany({ where: { user: { username: { in: USERNAMES } } } }); } catch { /* sessions may cascade */ }
  try { await prisma.user.deleteMany({ where: { username: { in: USERNAMES } } }); } catch (e) { console.error(e); }
  try { await prisma.instrument.deleteMany({ where: { id: { in: [instA, instB].filter(Boolean) } } }); } catch (e) { console.error(e); }
  try { await prisma.role.deleteMany({ where: { name: { in: [ROLE_REQ, ROLE_APPR, ROLE_OTHER] } } }); } catch (e) { console.error(e); }
  invalidateRolePermsCache();
  await app.close();
});

describe('POST /api/report-reviews', () => {
  it('sends the request to EVERY configured approver, frozen on the row, with its instruments; audits; notifies approvers in scope, per user', async () => {
    const res = await submit(tok.REQ);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    created.push(body.id);
    expect(body).toMatchObject({
      status: 'PENDING', requestedByName: U.REQ, requestedByRole: ROLE_REQ, requestRemarks: 'periodic review',
      approverRoles: [ROLE_APPR], approverUserIds: [ids.NAMED], instrumentIds: [instA],
      assigneeUserId: null, assigneeRole: null,
    });
    expect(body.dataSnapshot).toBeUndefined();
    const audit = await prisma.auditTrail.findFirst({ where: { action: 'REPORT_REVIEW_REQUESTED', targetId: body.id } });
    expect((audit!.afterValue as any).approvers).toEqual({ roles: [ROLE_APPR], userIds: [ids.NAMED] });
    const notified = (await prisma.notification.findMany({ where: { type: 'REPORT_REVIEW_REQUESTED', forUserId: { in: USERNAMES } } })).map((n) => n.forUserId);
    expect(notified.sort()).toEqual([U.APPR, U.NAMED].sort());
    // Never a role broadcast — it would reach the out-of-scope approver.
    expect(await prisma.notification.count({ where: { forRole: { in: [ROLE_APPR, ROLE_OTHER] } } })).toBe(0);
  });

  it('a type with remarks and password OFF is requested with neither', async () => {
    const res = await submit(tok.REQ, { reportKind: 'alarms', reportType: 'Alarms', title: 'ALARM REPORT', remarks: '', instrumentIds: [instA] }, '');
    expect(res.statusCode).toBe(201);
    created.push(res.json().id);
    expect(res.json().requestRemarks).toBe('');
  });

  it('refuses: wrong or missing password, blank remarks, no instruments, an unknown or out-of-scope instrument', async () => {
    expect((await submit(tok.REQ, {}, 'wrong-password')).statusCode).toBe(401);
    expect((await submit(tok.REQ, {}, '')).json().error).toBe('REAUTH_REQUIRED');
    expect((await submit(tok.REQ, { remarks: '   ' })).statusCode).toBe(400);
    expect((await submit(tok.REQ, { instrumentIds: [] })).statusCode).toBe(400);
    expect((await submit(tok.REQ, { instrumentIds: ['00000000-0000-0000-0000-000000000000'] })).statusCode).toBe(404);
    // The role-mate scoped to B cannot request a report about A.
    expect((await submit(tok.MATE_OUT, { instrumentIds: [instA] })).statusCode).toBe(404);
  });

  it('refuses a DIRECT type (409), a missing or unknown kind (400), and an Audit Trail that names instruments', async () => {
    // temperature-trend inherits Direct from the legacy trendChart setting.
    const direct = await submit(tok.REQ, { reportKind: 'temperature-trend', reportType: 'Instrument Trend — Temperature' });
    expect(direct.statusCode).toBe(409);
    expect(direct.json().error).toBe('REPORT_IS_DIRECT');
    expect((await submit(tok.REQ, { reportKind: undefined })).statusCode).toBe(400);
    expect((await submit(tok.REQ, { reportKind: 'Instrument Time Series' })).statusCode).toBe(400);
    expect((await submit(tok.REQ, { reportKind: 'audit-trail', reportType: 'Audit Trail', instrumentIds: [instA] })).statusCode).toBe(400);
    // A kind is bound to its report type: a reviewed one cannot be relabelled.
    const mismatch = await submit(tok.REQ, { reportKind: 'alarms' });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toBe('REPORT_TYPE_MISMATCH');
    // Refused BEFORE the password: no password sent, still the 409, not a 401.
    expect((await submit(tok.REQ, { reportKind: 'temperature-trend', reportType: 'Instrument Trend — Temperature' }, '')).statusCode).toBe(409);
  });

  it('refuses EVERY request while no approver is configured — fail closed, naming the fix', async () => {
    await setApprovers([], []);
    try {
      const res = await submit(tok.REQ);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('NO_APPROVER');
      expect(res.json().message).toMatch(/Report Settings/);
    } finally {
      await setApprovers([ROLE_APPR], [ids.NAMED]);
    }
  });

  it('a later configuration change does NOT re-route a request already raised', async () => {
    await setApprovers([ROLE_OTHER], []);
    try {
      const res = await get(`/api/report-reviews/${created[0]}`, tok.REQ);
      expect(res.json()).toMatchObject({ approverRoles: [ROLE_APPR], approverUserIds: [ids.NAMED] });
      // And U_OTHER, now an approver by role for NEW requests, still cannot see the old one.
      expect((await get(`/api/report-reviews/${created[0]}`, tok.OTHER)).statusCode).toBe(404);
    } finally {
      await setApprovers([ROLE_APPR], [ids.NAMED]);
    }
  });
});

describe('a request nobody could approve is REFUSED (2026-10-01)', () => {
  // Ticking a role or user is not enough: the approver must hold the approve
  // permission, have the instruments in scope, and not be the requester.
  // Otherwise only a super admin could ever decide it, while the requester was
  // told the approvers had been notified.
  const expectRefused = async (token: string) => {
    const res = await submit(token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NO_ELIGIBLE_APPROVER');
    expect(res.json().message).toMatch(/Report Settings/);
  };

  it('when the only approver is scoped away from the request\'s instruments', async () => {
    await setApprovers([], [ids.APPR_OUT!]);
    try { await expectRefused(tok.REQ); } finally { await setApprovers([ROLE_APPR], [ids.NAMED!]); }
  });

  it('when the only named approver lacks the approve permission', async () => {
    await setApprovers([], [ids.MATE!]);
    try { await expectRefused(tok.REQ); } finally { await setApprovers([ROLE_APPR], [ids.NAMED!]); }
  });

  it('when the requester is the only approver', async () => {
    await setApprovers([], [ids.NAMED!]);
    try { await expectRefused(tok.NAMED); } finally { await setApprovers([ROLE_APPR], [ids.NAMED!]); }
  });

  it('and nothing was written by any of them', async () => {
    const rows = await prisma.reportReview.count({ where: { requestedBy: { in: [ids.REQ!, ids.NAMED!] }, id: { notIn: created } } });
    expect(rows).toBe(0);
  });
});

describe('code-review fixes (2026-10-01)', () => {
  it('an approver whose role can APPROVE but not READ is not eligible — they could never open the queue', async () => {
    const ROLE_BLIND = `RR_BLIND_${STAMP}`;
    await prisma.role.create({ data: { name: ROLE_BLIND, displayName: 'RR Blind', hierarchyLevel: 2, permissions: ['REPORT_REVIEW_APPROVE', 'INSTRUMENT_READ'] } });
    const blind = await makeUser(`rrb${STAMP}`, ROLE_BLIND);
    invalidateRolePermsCache();
    await setApprovers([], [blind]);
    try {
      const res = await submit(tok.REQ);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('NO_ELIGIBLE_APPROVER');
    } finally {
      await setApprovers([ROLE_APPR], [ids.NAMED!]);
      await prisma.user.delete({ where: { id: blind } });
      await prisma.role.delete({ where: { name: ROLE_BLIND } });
      invalidateRolePermsCache();
    }
  });

  it('an Alarm Report about NO instruments is seen only by unrestricted viewers, never by a scoped role-mate', async () => {
    const res = await submit(tok.REQ, { reportKind: 'alarms', reportType: 'Alarms', title: 'EMPTY ALARM REPORT', remarks: '', instrumentIds: [] }, '');
    expect(res.statusCode).toBe(201);
    created.push(res.json().id);
    const id = res.json().id;
    expect((await get(`/api/report-reviews/${id}`, tok.MATE)).statusCode).toBe(200);      // unrestricted role-mate
    expect((await get(`/api/report-reviews/${id}`, tok.MATE_OUT)).statusCode).toBe(404);  // scoped role-mate
    expect(await listIds('mine', tok.MATE_OUT)).not.toContain(id);
    expect(await listIds('queue', tok.APPR_OUT)).not.toContain(id);
  });
});

describe('the configuration round-trips through the REAL save path (the dynamic PUT)', () => {
  // The other cases pin the rows with prisma. This one saves them the way the
  // Configuration page does, so the keys the page writes are proven to be the
  // keys the readers read — the route-shape vs stored-shape mistake already
  // happened once on the browser side.
  const put = (key: string, body: unknown) => app.inject({ method: 'PUT', url: `/api/config/dynamic/${key}`, headers: bearer(tokAdmin), payload: body as never });

  it('report-downloads: a saved Direct / no remarks / no password reads back for that kind only', async () => {
    const before = await prisma.systemConfig.findUnique({ where: { configKey: 'report-downloads' } });
    try {
      const res = await put('report-downloads', { alarmsMode: 'DIRECT', alarmsRemarks: false, alarmsPassword: false, dataReportMode: 'REQUEST' });
      expect(res.statusCode).toBe(200);
      const cur = (await get('/api/config/report-downloads/current', tok.REQ)).json();
      expect(cur.alarms).toEqual({ mode: 'DIRECT', remarksRequired: false, passwordRequired: false });
      expect(cur['data-report']).toEqual({ mode: 'REQUEST', remarksRequired: true, passwordRequired: true });
    } finally {
      if (before) await prisma.systemConfig.update({ where: { configKey: 'report-downloads' }, data: { configValue: before.configValue as never } });
    }
  });

  it('report-approvers: saved roles AND users read back, and a request then goes to both', async () => {
    const res = await put('report-approvers', { approverRoles: [ROLE_APPR], approverUserIds: [ids.NAMED] });
    expect(res.statusCode).toBe(200);
    expect((await get('/api/config/report-approvers/current', tok.REQ)).json()).toEqual({ approverRoles: [ROLE_APPR], approverUserCount: 1 });
  });
});

describe('the config reads', () => {
  it('report-approvers/current: every user reads both lists, already coerced', async () => {
    const res = await get('/api/config/report-approvers/current', tok.REQ);
    expect(res.statusCode).toBe(200);
    // The ACTIVE approvers; users as a COUNT, never their ids (code review, 2026-10-01).
    expect(res.json()).toEqual({ approverRoles: [ROLE_APPR], approverUserCount: 1 });
  });

  it('report-approvers/current drops a disabled approver user, so the dialog never promises one the server refuses', async () => {
    await prisma.user.update({ where: { id: ids.NAMED! }, data: { status: 'DISABLED' } });
    try {
      expect((await get('/api/config/report-approvers/current', tok.REQ)).json()).toEqual({ approverRoles: [ROLE_APPR], approverUserCount: 0 });
    } finally {
      await prisma.user.update({ where: { id: ids.NAMED! }, data: { status: 'ENABLED' } });
    }
  });

  it('report-downloads/current: every user reads all EIGHT kinds, coerced — the split ones inheriting', async () => {
    const res = await get('/api/config/report-downloads/current', tok.REQ);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      'data-report': { mode: 'REQUEST', remarksRequired: true, passwordRequired: true },
      'time-series': { mode: 'REQUEST', remarksRequired: true, passwordRequired: true },
      'trend-header': { mode: 'REQUEST', remarksRequired: true, passwordRequired: true },
      // Both split out of the legacy trendChart setting, which this suite set to Direct.
      'temperature-trend': { mode: 'DIRECT', remarksRequired: true, passwordRequired: true },
      'humidity-trend': { mode: 'DIRECT', remarksRequired: true, passwordRequired: true },
      'instrument-alarms': { mode: 'REQUEST', remarksRequired: true, passwordRequired: true },
      alarms: { mode: 'REQUEST', remarksRequired: false, passwordRequired: false },
      'audit-trail': { mode: 'REQUEST', remarksRequired: true, passwordRequired: true },
    });
  });

  it('report-approvers/candidates lists enabled users as "username … (role)" for the config page, and needs CONFIG_READ', async () => {
    expect((await get('/api/config/report-approvers/candidates', tok.REQ)).statusCode).toBe(403);
    const res = await get('/api/config/report-approvers/candidates', tokAdmin);
    expect(res.statusCode).toBe(200);
    const mine = res.json().find((o: any) => o.value === ids.APPR);
    expect(mine.label).toContain(U.APPR);
    expect(mine.label).toContain(ROLE_APPR);
    expect(res.json().some((o: any) => /\(SUPER_ADMIN\)$/.test(o.label))).toBe(false);
  });

  it('both editors stay SUPER_ADMIN-only', async () => {
    for (const key of ['report-approvers', 'report-downloads']) {
      expect((await get(`/api/config/dynamic/${key}`, tok.REQ)).statusCode).toBe(403);
      expect((await get(`/api/config/dynamic/${key}`, tokAdmin)).statusCode).toBe(200);
    }
  });
});

describe('who sees what', () => {
  it('queue: approvers by role and by name, in scope — never the requester, a role-mate, or an out-of-scope approver', async () => {
    expect(await listIds('queue', tok.APPR)).toContain(created[0]);
    expect(await listIds('queue', tok.NAMED)).toContain(created[0]);
    for (const k of ['APPR_OUT', 'REQ', 'MATE', 'OTHER'] as const) expect(await listIds('queue', tok[k])).not.toContain(created[0]);
    expect(await listIds('queue', tokAdmin)).toContain(created[0]);
  });

  it('mine ("Requests"): raised by me or by my role, in my scope', async () => {
    expect(await listIds('mine', tok.REQ)).toContain(created[0]);
    expect(await listIds('mine', tok.MATE)).toContain(created[0]);
    expect(await listIds('mine', tok.MATE_OUT)).not.toContain(created[0]);
    expect(await listIds('mine', tok.APPR)).not.toContain(created[0]);
  });

  // Audit 2026-10-12 #9: the page used to re-derive "may I decide this?" in
  // the browser (approver role / user id, not self) and omitted the instrument
  // scope and the APPROVE permission. The SERVER now answers per row, and the
  // approver users arrive as names, so the page needs no /api/users (USER_READ).
  it('every row carries the server\'s own canDecide, and the approver users by name', async () => {
    const rowFor = async (list: string, t: string) =>
      ((await get(`/api/report-reviews?list=${list}&pageSize=200`, t)).json().data as any[]).find((r) => r.id === created[0]);
    expect((await rowFor('queue', tok.APPR)).canDecide).toBe(true);
    expect((await rowFor('queue', tok.NAMED)).canDecide).toBe(true);
    expect((await rowFor('queue', tokAdmin)).canDecide).toBe(true);
    // The requester and a role-mate (no APPROVE permission) see it, never decide it.
    expect((await rowFor('mine', tok.REQ)).canDecide).toBe(false);
    expect((await rowFor('mine', tok.MATE)).canDecide).toBe(false);
    const r = await rowFor('mine', tok.REQ);
    expect(r.approverUserNames).toEqual([U.NAMED]);
    expect(r.approverUserIds).toEqual([ids.NAMED]);
  });

  it('GET /:id: the snapshot to every party in scope; 404 to the out-of-scope and the strangers', async () => {
    for (const k of ['REQ', 'MATE', 'APPR', 'NAMED'] as const) {
      const res = await get(`/api/report-reviews/${created[0]}`, tok[k]);
      expect(res.statusCode, k).toBe(200);
      expect(res.json().dataSnapshot.sections[0].body[0]).toEqual(['2026-08-24', '00:20']);
    }
    for (const k of ['MATE_OUT', 'APPR_OUT', 'OTHER'] as const) {
      expect((await get(`/api/report-reviews/${created[0]}`, tok[k])).statusCode, k).toBe(404);
    }
  });
});

describe('POST /api/report-reviews/:id/approve | reject', () => {
  const decide = (id: string, verb: 'approve' | 'reject', token: string, remarks = 'checked', password: string | undefined = PASSWORD) =>
    app.inject({ method: 'POST', url: `/api/report-reviews/${id}/${verb}`, headers: bearer(token, password), payload: { remarks } });

  it('a role-mate may not decide (no APPROVE permission); an out-of-scope approver gets 404; a stranger approver 404', async () => {
    expect((await decide(created[0], 'approve', tok.MATE)).statusCode).toBe(403);
    expect((await decide(created[0], 'approve', tok.APPR_OUT)).statusCode).toBe(404);
    expect((await decide(created[0], 'approve', tok.OTHER)).statusCode).toBe(404);
  });

  it('a wrong password is 401 and blank remarks 400 — the decision is always signed and reasoned', async () => {
    expect((await decide(created[0], 'approve', tok.APPR, 'checked', 'wrong')).statusCode).toBe(401);
    expect((await decide(created[0], 'approve', tok.APPR, '  ')).statusCode).toBe(400);
  });

  it('the NAMED approver approves once — audited, requester notified — and a second decision is 409', async () => {
    const res = await decide(created[0], 'approve', tok.NAMED, 'reviewed against the batch record');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'APPROVED', decidedByName: U.NAMED, decidedByRole: ROLE_OTHER });
    const note = await prisma.notification.findFirst({ where: { type: 'REPORT_REVIEW_APPROVED', forUserId: U.REQ } });
    expect(note).toBeTruthy();
    expect((await decide(created[0], 'approve', tok.APPR)).statusCode).toBe(409);
  });

  it('an approver by ROLE rejects the other request', async () => {
    const res = await decide(created[1], 'reject', tok.APPR, 'wrong period');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'REJECTED', decidedByName: U.APPR });
  });

  it('SUPER_ADMIN may approve a request they raised themselves (operator, 2026-09-08)', async () => {
    const own = await app.inject({
      method: 'POST', url: '/api/report-reviews', headers: bearer(tokAdmin, 'Admin@123'),
      payload: { reportKind: 'audit-trail', reportType: 'Audit Trail', title: 'AUDIT TRAIL', requestMeta, dataSnapshot: snapshot, remarks: 'own' },
    });
    expect(own.statusCode).toBe(201);
    created.push(own.json().id);
    expect(own.json().instrumentIds).toEqual([]);
    const res = await decide(own.json().id, 'approve', tokAdmin, 'checked', 'Admin@123');
    expect(res.statusCode).toBe(200);
    expect(res.json().decidedByName).toBe(res.json().requestedByName);
  });
});

describe('approved list and download-log', () => {
  it('approved: the requester, the role-mate, the approver who signed and the approver role in scope see it; the out-of-scope and strangers do not', async () => {
    for (const k of ['REQ', 'MATE', 'NAMED', 'APPR'] as const) expect(await listIds('approved', tok[k]), k).toContain(created[0]);
    for (const k of ['MATE_OUT', 'APPR_OUT', 'OTHER'] as const) expect(await listIds('approved', tok[k]), k).not.toContain(created[0]);
    // A rejected one is never in the approved list.
    expect(await listIds('approved', tok.REQ)).not.toContain(created[1]);
  });

  it('download-log: the role-mate may take a signed copy; out of scope 404; not approved 409', async () => {
    const ok = await app.inject({ method: 'POST', url: `/api/report-reviews/${created[0]}/download-log`, headers: bearer(tok.MATE), payload: {} });
    expect(ok.statusCode).toBe(200);
    const audit = await prisma.auditTrail.findFirst({ where: { action: 'REPORT_DOWNLOADED', targetId: created[0] } });
    expect(audit?.userId).toBe(U.MATE);
    expect((await app.inject({ method: 'POST', url: `/api/report-reviews/${created[0]}/download-log`, headers: bearer(tok.APPR_OUT), payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/report-reviews/${created[1]}/download-log`, headers: bearer(tok.REQ), payload: {} })).statusCode).toBe(409);
  });

  it('has no DELETE route — a request is a §11 record', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/report-reviews/${created[0]}`, headers: bearer(tokAdmin, 'Admin@123') });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * Snapshot tamper evidence (audit 2026-10-03, DATA-7). The digest of the
 * frozen document is stored on the row, written into the REQUESTED and
 * APPROVED audit rows, and recomputed before every download.
 */
describe('snapshot hash', () => {
  it('the request carries sha256(canonical snapshot) on the row, in the response and in both signed audit rows', async () => {
    const { snapshotDigest } = await import('../modules/report-reviews/service.js');
    const expected = snapshotDigest(snapshot);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    const row = await prisma.reportReview.findUnique({ where: { id: created[0] } });
    expect(row?.snapshotHash).toBe(expected);
    expect((await get(`/api/report-reviews/${created[0]}`, tok.REQ)).json().snapshotHash).toBe(expected);
    const requested = await prisma.auditTrail.findFirst({ where: { action: 'REPORT_REVIEW_REQUESTED', targetId: created[0] } });
    expect((requested?.afterValue as { snapshotHash?: string }).snapshotHash).toBe(expected);
    const approvedRow = await prisma.auditTrail.findFirst({ where: { action: 'REPORT_REVIEW_APPROVED', targetId: created[0] } });
    expect((approvedRow?.afterValue as { snapshotHash?: string }).snapshotHash).toBe(expected);
    const downloaded = await prisma.auditTrail.findFirst({ where: { action: 'REPORT_DOWNLOADED', targetId: created[0] } });
    expect(downloaded?.afterValue).toMatchObject({ snapshotHash: expected, snapshotAttested: true });
  });

  it('a download is REFUSED once the stored document no longer hashes to what was signed — mutation of the snapshot', async () => {
    const id = created[0];
    const original = (await prisma.reportReview.findUnique({ where: { id }, select: { dataSnapshot: true } }))!.dataSnapshot;
    const edited = JSON.parse(JSON.stringify(original));
    edited.sections[0].body[0][1] = '00:21';
    await prisma.$executeRaw`UPDATE report_reviews SET data_snapshot = ${JSON.stringify(edited)}::jsonb WHERE id = ${id}::uuid`;
    try {
      const res = await app.inject({ method: 'POST', url: `/api/report-reviews/${id}/download-log`, headers: bearer(tok.REQ), payload: {} });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('SNAPSHOT_MISMATCH');
    } finally {
      await prisma.$executeRaw`UPDATE report_reviews SET data_snapshot = ${JSON.stringify(original)}::jsonb WHERE id = ${id}::uuid`;
    }
    expect((await app.inject({ method: 'POST', url: `/api/report-reviews/${id}/download-log`, headers: bearer(tok.REQ), payload: {} })).statusCode).toBe(200);
  });

  it('editing the stored column to agree with an edited snapshot is still refused — the audit row is the anchor', async () => {
    const id = created[0];
    const { snapshotDigest } = await import('../modules/report-reviews/service.js');
    const original = (await prisma.reportReview.findUnique({ where: { id }, select: { dataSnapshot: true, snapshotHash: true } }))!;
    const edited = JSON.parse(JSON.stringify(original.dataSnapshot));
    edited.sections[0].body[0][1] = '00:22';
    await prisma.$executeRaw`UPDATE report_reviews SET data_snapshot = ${JSON.stringify(edited)}::jsonb, snapshot_hash = ${snapshotDigest(edited)} WHERE id = ${id}::uuid`;
    try {
      const res = await app.inject({ method: 'POST', url: `/api/report-reviews/${id}/download-log`, headers: bearer(tok.REQ), payload: {} });
      expect(res.statusCode).toBe(409);
    } finally {
      await prisma.$executeRaw`UPDATE report_reviews SET data_snapshot = ${JSON.stringify(original.dataSnapshot)}::jsonb, snapshot_hash = ${original.snapshotHash} WHERE id = ${id}::uuid`;
    }
  });

  /** An APPROVED row written directly — what a request raised before a fix looks like. */
  async function directRow(title: string, snapshotHash: string | null) {
    const row = await prisma.reportReview.create({
      data: {
        reportType: 'Audit Trail', title, requestMeta, dataSnapshot: snapshot, status: 'APPROVED', snapshotHash,
        requestedBy: ids.REQ!, requestedByName: U.REQ, requestedByRole: ROLE_REQ, requestRemarks: 'old',
        approverRoles: [ROLE_APPR], approverUserIds: [], instrumentIds: [],
        decidedBy: ids.APPR!, decidedByName: U.APPR, decidedByRole: ROLE_APPR, decidedAt: new Date(), decisionRemarks: 'old',
      },
      select: { id: true, snapshotHash: true },
    });
    created.push(row.id);
    return row;
  }
  const downloadLog = (id: string) => app.inject({ method: 'POST', url: `/api/report-reviews/${id}/download-log`, headers: bearer(tok.REQ), payload: {} });

  it('a request older than the digest (no column, a REQUESTED audit row with no hash) downloads and is recorded as unattested', async () => {
    // A row raised before 2026-10-05: NULL snapshot_hash and a REQUESTED audit
    // row with no snapshotHash — the shape of every legacy row on the local
    // database (13 of 13, read-only check 2026-10-12).
    const legacy = await directRow('LEGACY', null);
    expect(legacy.snapshotHash).toBeNull();
    const { auditLog } = await import('../lib/audit.js');
    await auditLog({
      userId: U.REQ, userRole: ROLE_REQ, action: 'REPORT_REVIEW_REQUESTED', targetType: 'Audit Trail', targetId: legacy.id,
      afterValue: { title: 'LEGACY', status: 'PENDING' },
    });
    const res = await downloadLog(legacy.id);
    expect(res.statusCode).toBe(200);
    const audit = await prisma.auditTrail.findFirst({ where: { action: 'REPORT_DOWNLOADED', targetId: legacy.id } });
    expect(audit?.afterValue).toMatchObject({ snapshotAttested: false });
  });

  // Audit 2026-10-12 #8: the download check FAILS CLOSED. Until then a row with
  // no REQUESTED audit row fell back to the row's own (editable) column — so a
  // request whose audit write was lost could have its snapshot AND column
  // edited together and still download as signed.
  it('a request with NO REQUESTED audit row is refused, even when its column agrees with its snapshot', async () => {
    const { snapshotDigest } = await import('../modules/report-reviews/service.js');
    const orphan = await directRow('ORPHAN', snapshotDigest(snapshot));
    const res = await downloadLog(orphan.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SNAPSHOT_UNATTESTED');
    expect(await prisma.auditTrail.count({ where: { action: 'REPORT_DOWNLOADED', targetId: orphan.id } })).toBe(0);
  });

  it('a request with no audit row and no column (nothing attests it at all) is refused too', async () => {
    const bare = await directRow('BARE', null);
    const res = await downloadLog(bare.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SNAPSHOT_UNATTESTED');
  });

  it('a column set while the REQUESTED audit row carries no hash is refused — the two are only ever written together', async () => {
    const { snapshotDigest } = await import('../modules/report-reviews/service.js');
    const odd = await directRow('ODD', snapshotDigest(snapshot));
    const { auditLog } = await import('../lib/audit.js');
    await auditLog({
      userId: U.REQ, userRole: ROLE_REQ, action: 'REPORT_REVIEW_REQUESTED', targetType: 'Audit Trail', targetId: odd.id,
      afterValue: { title: 'ODD', status: 'PENDING' },
    });
    const res = await downloadLog(odd.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SNAPSHOT_UNATTESTED');
  });
});

/**
 * Audit 2026-10-12 #8 (HIGH): a request and a decision are each ONE transaction
 * with their audit row. Proved with a trigger that refuses the audit insert for
 * this file's users only: on the old code the request / decision committed
 * first and the audit write failed after it, leaving a §11 record with no
 * audit row.
 */
describe('a request or a decision never exists without its audit row', () => {
  const FN = `rr_refuse_audit_${STAMP}`;
  const TRG = `rr_refuse_audit_trg_${STAMP}`;
  async function refuse(action: string, userId: string) {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = '${action}' AND NEW.user_id = '${userId}' THEN RAISE EXCEPTION 'test: audit insert refused'; END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${TRG} BEFORE INSERT ON audit_trail FOR EACH ROW EXECUTE FUNCTION ${FN}()`);
  }
  async function allow() {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRG} ON audit_trail`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${FN}()`);
  }
  afterAll(async () => { try { await allow(); } catch (e) { console.error('trigger cleanup failed', e); } });

  it('submit: the audit insert failing leaves NO request behind', async () => {
    const before = await prisma.reportReview.count({ where: { requestedBy: ids.REQ! } });
    await refuse('REPORT_REVIEW_REQUESTED', U.REQ);
    try {
      const res = await submit(tok.REQ);
      expect(res.statusCode).toBe(500);
    } finally { await allow(); }
    expect(await prisma.reportReview.count({ where: { requestedBy: ids.REQ! } })).toBe(before);
  });

  it('decide: the audit insert failing leaves the request PENDING and undecided', async () => {
    const res = await submit(tok.REQ);
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    created.push(id);
    await refuse('REPORT_REVIEW_APPROVED', U.APPR);
    try {
      const d = await app.inject({ method: 'POST', url: `/api/report-reviews/${id}/approve`, headers: bearer(tok.APPR, PASSWORD), payload: { remarks: 'checked' } });
      expect(d.statusCode).toBe(500);
    } finally { await allow(); }
    const row = await prisma.reportReview.findUnique({ where: { id } });
    expect(row).toMatchObject({ status: 'PENDING', decidedBy: null, decidedAt: null });
    // And once the audit can be written, the decision goes through normally.
    const ok = await app.inject({ method: 'POST', url: `/api/report-reviews/${id}/approve`, headers: bearer(tok.APPR, PASSWORD), payload: { remarks: 'checked' } });
    expect(ok.statusCode).toBe(200);
    expect(await prisma.auditTrail.count({ where: { action: 'REPORT_REVIEW_APPROVED', targetId: id } })).toBe(1);
  });
});

/**
 * `eligibleApprovers` resolves permissions once per role and the scope once per
 * (role, user-config) pair (audit 2026-10-03, API-19). The answer must be the
 * one the per-user version gave: the approver by role in scope and the named
 * approver, never the out-of-scope approver, the stranger of the named
 * approver's role, or the requester's role-mates.
 */
describe('eligibleApprovers', () => {
  it('names exactly the approvers who hold both permissions and see an instrument of the request', async () => {
    const { eligibleApprovers } = await import('../modules/report-reviews/service.js');
    const names = await eligibleApprovers({
      requestedBy: ids.REQ!, approverRoles: [ROLE_APPR], approverUserIds: [ids.NAMED!],
      instrumentIds: [instA], reportType: 'Instrument Time Series',
    });
    expect([...names].sort()).toEqual([U.APPR, U.NAMED].sort());
    // About the other instrument: the approver scoped to B now qualifies, and
    // so does the UNSCOPED approver (no user config, no role config = sees
    // everything) — two users of one role with different scopes, resolved
    // from two different cache keys. The named approver's role is not listed.
    const forB = await eligibleApprovers({
      requestedBy: ids.REQ!, approverRoles: [ROLE_APPR], approverUserIds: [],
      instrumentIds: [instB], reportType: 'Instrument Time Series',
    });
    expect([...forB].sort()).toEqual([U.APPR, U.APPR_OUT].sort());
  });
});
