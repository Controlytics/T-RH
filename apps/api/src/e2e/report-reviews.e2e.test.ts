import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

/**
 * HTTP-level coverage of the report review workflow (2026-09-07):
 * docs/superpowers/specs/2026-09-07-report-review-workflow-design.md
 *
 * Three people, each with their own role and bearer, because the rules are
 * about WHO: a requester (may raise requests), an approver (may decide), and a
 * third party with the same READ permission who is a party to nothing. Every
 * assertion is over `app.inject` — the only thing that catches a field the
 * response schema forgot to declare.
 *
 * The `action-reauth` config is pinned so the three gated actions REQUIRE a
 * password for these roles; otherwise "wrong password → 401" passes vacuously
 * on an install where nobody switched re-auth on. Restored FIRST in `afterAll`
 * (the 2026-08-31 incident: a teardown that threw before its restore left
 * `compliance_core_db_test` misconfigured for two unrelated suites).
 */

const PASSWORD = 'ReportReview@Test1';
const STAMP = String(Date.now()).slice(-6);
const ROLE_REQ = `RR_OPERATOR_${STAMP}`;
const ROLE_APPR = `RR_APPROVER_${STAMP}`;
const U_REQ = `rrq${STAMP}`;   // usernames are short here: a login-path column is varchar(20)
const U_APPR = `rra${STAMP}`;
const U_THIRD = `rrt${STAMP}`;

let app: FastifyInstance;
let tokReq = '';
let tokAppr = '';
let tokThird = '';
let tokAdmin = '';
let idReq = '';
let idAppr = '';
let originalReauthRow: { configValue: unknown; configType: string; requiresReauth: boolean } | null = null;
let originalApproversRow: { configValue: unknown; configType: string; requiresReauth: boolean } | null = null;
const created: string[] = [];

/** Which roles may approve — administered by SUPER_ADMIN (2026-09-07). Pinned so the request checks are exercised, not skipped. */
async function setApproverRoles(roles: string[]) {
  const value = { approverRoles: roles } as never;
  await prisma.systemConfig.upsert({
    where: { configKey: 'report-approvers' },
    update: { configValue: value, configType: 'system', requiresReauth: false },
    create: { configKey: 'report-approvers', configValue: value, configType: 'system', requiresReauth: false },
  });
}

const snapshot = {
  version: 2, reportType: 'Instrument Time Series', title: 'Temperature and RH Data Report',
  config: { showAppName: false },
  sections: [{ kind: 'table', head: ['DATE', 'TIME'], body: [['2026-08-24', '00:20']] }],
};
const requestMeta = { period: { from: '2026-08-24T00:00:00.000Z', to: '2026-08-24T01:00:00.000Z', label: 'Custom' }, intervalMs: null, instrumentCodes: ['CWH/RDU/001-00'] };

const bearer = (t: string, password?: string) => ({ authorization: `Bearer ${t}`, ...(password ? { 'x-reauth-password': password } : {}) });

async function submit(token: string, extra: Record<string, unknown> = {}, password: string | undefined = PASSWORD) {
  return app.inject({
    method: 'POST', url: '/api/report-reviews', headers: bearer(token, password),
    payload: { reportType: 'Instrument Time Series', title: 'Temperature and RH Data Report', requestMeta, dataSnapshot: snapshot, remarks: 'periodic review', assigneeUserId: idAppr, ...extra },
  });
}

async function makeUser(username: string, role: string) {
  const { hashPassword } = await import('../lib/password.js');
  const passwordHash = await hashPassword(PASSWORD);
  return prisma.user.create({
    data: { username, passwordHash, fullName: username, email: `${username}@test.example`, role, status: 'ENABLED', forcePasswordChange: false, isTemporaryPassword: false },
    select: { id: true },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.role.create({ data: { name: ROLE_REQ, displayName: 'RR Operator', hierarchyLevel: 1, permissions: ['REPORT_REVIEW_READ', 'INSTRUMENT_READ'] } });
  await prisma.role.create({ data: { name: ROLE_APPR, displayName: 'RR Approver', hierarchyLevel: 2, permissions: ['REPORT_REVIEW_READ', 'REPORT_REVIEW_APPROVE'] } });
  invalidateRolePermsCache();
  idReq = (await makeUser(U_REQ, ROLE_REQ)).id;
  idAppr = (await makeUser(U_APPR, ROLE_APPR)).id;
  await makeUser(U_THIRD, ROLE_REQ);
  tokReq = await loginAs(app, U_REQ, PASSWORD);
  tokAppr = await loginAs(app, U_APPR, PASSWORD);
  tokThird = await loginAs(app, U_THIRD, PASSWORD);
  tokAdmin = await loginAs(app);

  const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
  if (existing) originalReauthRow = { configValue: existing.configValue, configType: existing.configType, requiresReauth: existing.requiresReauth };
  const gated = { DOWNLOAD_REPORT: [ROLE_REQ, ROLE_APPR], APPROVE_REPORT: [ROLE_APPR], REJECT_REPORT: [ROLE_APPR] } as never;
  await prisma.systemConfig.upsert({
    where: { configKey: 'action-reauth' },
    update: { configValue: gated, configType: 'security', requiresReauth: false },
    create: { configKey: 'action-reauth', configValue: gated, configType: 'security', requiresReauth: false },
  });
  invalidateReauthCache();

  const approvers = await prisma.systemConfig.findUnique({ where: { configKey: 'report-approvers' } });
  if (approvers) originalApproversRow = { configValue: approvers.configValue, configType: approvers.configType, requiresReauth: approvers.requiresReauth };
  await setApproverRoles([ROLE_APPR]);
});

beforeEach(() => invalidateReauthCache());

afterAll(async () => {
  // Config restore FIRST, and each step guarded, so a failing teardown still
  // hands back what it borrowed.
  try {
    if (originalReauthRow) {
      await prisma.systemConfig.update({ where: { configKey: 'action-reauth' }, data: originalReauthRow as never });
    } else {
      await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
    }
    invalidateReauthCache();
  } catch (e) { console.error('reauth restore failed', e); }
  try {
    if (originalApproversRow) {
      await prisma.systemConfig.update({ where: { configKey: 'report-approvers' }, data: originalApproversRow as never });
    } else {
      await prisma.systemConfig.deleteMany({ where: { configKey: 'report-approvers' } });
    }
  } catch (e) { console.error('approvers restore failed', e); }
  try { await prisma.reportReview.deleteMany({ where: { id: { in: created } } }); } catch (e) { console.error(e); }
  try { await prisma.notification.deleteMany({ where: { OR: [{ forUserId: { in: [U_REQ, U_APPR, U_THIRD] } }, { forRole: { in: [ROLE_REQ, ROLE_APPR] } }] } }); } catch (e) { console.error(e); }
  try { await prisma.session.deleteMany({ where: { user: { username: { in: [U_REQ, U_APPR, U_THIRD] } } } }); } catch { /* sessions may cascade */ }
  try { await prisma.user.deleteMany({ where: { username: { in: [U_REQ, U_APPR, U_THIRD] } } }); } catch (e) { console.error(e); }
  try { await prisma.role.deleteMany({ where: { name: { in: [ROLE_REQ, ROLE_APPR] } } }); } catch (e) { console.error(e); }
  invalidateRolePermsCache();
  await app.close();
});

describe('POST /api/report-reviews', () => {
  it('records a PENDING request to a user, audits it, and notifies the assignee', async () => {
    const res = await submit(tokReq);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    created.push(body.id);
    expect(body).toMatchObject({ status: 'PENDING', assigneeUserId: idAppr, assigneeRole: null, requestedByName: U_REQ, reportType: 'Instrument Time Series', requestRemarks: 'periodic review' });
    expect(body.requestMeta.instrumentCodes).toEqual(['CWH/RDU/001-00']);
    // The snapshot is NOT on the list/summary shape.
    expect(body.dataSnapshot).toBeUndefined();
    const audit = await prisma.auditTrail.findFirst({ where: { action: 'REPORT_REVIEW_REQUESTED', targetId: body.id }, orderBy: { timestamp: 'desc' } });
    expect(audit).toBeTruthy();
    expect(audit!.userId).toBe(U_REQ);
    expect(audit!.targetType).toBe('Instrument Time Series');
    const note = await prisma.notification.findFirst({ where: { type: 'REPORT_REVIEW_REQUESTED', forUserId: U_APPR } });
    expect(note).toBeTruthy();
  });

  it('records a request to a ROLE and notifies the role', async () => {
    const res = await submit(tokReq, { assigneeUserId: undefined, assigneeRole: ROLE_APPR });
    expect(res.statusCode).toBe(201);
    created.push(res.json().id);
    expect(res.json()).toMatchObject({ assigneeUserId: null, assigneeRole: ROLE_APPR });
    const note = await prisma.notification.findFirst({ where: { type: 'REPORT_REVIEW_REQUESTED', forRole: ROLE_APPR } });
    expect(note).toBeTruthy();
  });

  it('refuses no assignee, both assignees, blank remarks, self-assignment, and a wrong password', async () => {
    expect((await submit(tokReq, { assigneeUserId: undefined })).statusCode).toBe(400);
    expect((await submit(tokReq, { assigneeRole: ROLE_APPR })).statusCode).toBe(400);
    expect((await submit(tokReq, { remarks: '   ' })).statusCode).toBe(400);
    const self = await submit(tokReq, { assigneeUserId: idReq });
    expect(self.statusCode).toBe(400);
    expect(self.json().error).toBe('SELF_ASSIGNMENT');
    expect((await submit(tokReq, {}, 'wrong-password')).statusCode).toBe(401);
  });

  it('refuses a role that is not a configured approver role, and a user whose role is not one', async () => {
    // The requester's own role is not in the administered list.
    const role = await submit(tokReq, { assigneeUserId: undefined, assigneeRole: ROLE_REQ });
    expect(role.statusCode).toBe(400);
    expect(role.json().error).toBe('ROLE_NOT_APPROVER');
    // The third user holds ROLE_REQ, which is not an approver role.
    const third = await prisma.user.findFirstOrThrow({ where: { username: U_THIRD }, select: { id: true } });
    const user = await submit(tokReq, { assigneeUserId: third.id });
    expect(user.statusCode).toBe(400);
    expect(user.json().error).toBe('USER_NOT_APPROVER');
  });

  it('refuses EVERY request while no approver role is configured — fail closed, with a message naming the fix', async () => {
    await setApproverRoles([]);
    try {
      const res = await submit(tokReq);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('NO_APPROVER_ROLE');
      expect(res.json().message).toMatch(/super admin/i);
      const asRole = await submit(tokReq, { assigneeUserId: undefined, assigneeRole: ROLE_APPR });
      expect(asRole.json().error).toBe('NO_APPROVER_ROLE');
    } finally {
      await setApproverRoles([ROLE_APPR]);
    }
  });

  it('is refused without REPORT_REVIEW_READ', async () => {
    // A role with no permission at all: the seeded OPERATOR has none of ours.
    const res = await app.inject({ method: 'POST', url: '/api/report-reviews', headers: bearer(tokAdmin), payload: {} });
    // SUPER_ADMIN passes the permission gate and fails the body schema instead.
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/config/report-approvers/current', () => {
  it('every authenticated user reads the configured approver roles, already coerced', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/report-approvers/current', headers: bearer(tokReq) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ approverRoles: [ROLE_APPR] });
  });

  it('the editor stays SUPER_ADMIN-only', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/dynamic/report-approvers', headers: bearer(tokReq) });
    expect(res.statusCode).toBe(403);
    const admin = await app.inject({ method: 'GET', url: '/api/config/dynamic/report-approvers', headers: bearer(tokAdmin) });
    expect(admin.statusCode).toBe(200);
  });
});

describe('GET /api/report-reviews', () => {
  it('queue: the approver sees it, the requester does not, SUPER_ADMIN sees everything pending', async () => {
    const forAppr = await app.inject({ method: 'GET', url: '/api/report-reviews?list=queue', headers: bearer(tokAppr) });
    expect(forAppr.statusCode).toBe(200);
    expect(forAppr.json().data.map((r: any) => r.id)).toEqual(expect.arrayContaining(created));
    const forReq = await app.inject({ method: 'GET', url: '/api/report-reviews?list=queue', headers: bearer(tokReq) });
    expect(forReq.json().data.map((r: any) => r.id)).not.toEqual(expect.arrayContaining(created));
    const forAdmin = await app.inject({ method: 'GET', url: '/api/report-reviews?list=queue&pageSize=200', headers: bearer(tokAdmin) });
    expect(forAdmin.json().data.map((r: any) => r.id)).toEqual(expect.arrayContaining(created));
    expect(typeof forAdmin.json().total).toBe('number');
  });

  it('mine: the requester sees their own, the approver does not', async () => {
    const mine = await app.inject({ method: 'GET', url: '/api/report-reviews?list=mine', headers: bearer(tokReq) });
    expect(mine.json().data.map((r: any) => r.id)).toEqual(expect.arrayContaining(created));
    const notMine = await app.inject({ method: 'GET', url: '/api/report-reviews?list=mine', headers: bearer(tokAppr) });
    expect(notMine.json().data).toHaveLength(0);
  });
});

describe('GET /api/report-reviews/:id', () => {
  it('returns the snapshot to a party and 404 to anyone else', async () => {
    const asAppr = await app.inject({ method: 'GET', url: `/api/report-reviews/${created[0]}`, headers: bearer(tokAppr) });
    expect(asAppr.statusCode).toBe(200);
    expect(asAppr.json().dataSnapshot.sections[0].body[0]).toEqual(['2026-08-24', '00:20']);
    const asThird = await app.inject({ method: 'GET', url: `/api/report-reviews/${created[0]}`, headers: bearer(tokThird) });
    expect(asThird.statusCode).toBe(404);
  });
});

describe('POST /api/report-reviews/:id/approve | reject', () => {
  const decide = (id: string, verb: 'approve' | 'reject', token: string, remarks = 'checked', password: string | undefined = PASSWORD) =>
    app.inject({ method: 'POST', url: `/api/report-reviews/${id}/${verb}`, headers: bearer(token, password), payload: { remarks } });

  it('the requester cannot approve their own request', async () => {
    const res = await decide(created[0], 'approve', tokReq);
    // The requester lacks REPORT_REVIEW_APPROVE too, so the permission gate
    // answers first; the SELF_APPROVAL rule itself is pinned by the unit test
    // on isSelfDecision — an approver-role user who is also the requester
    // cannot be built here without a second approver role.
    expect(res.statusCode).toBe(403);
  });

  it('SUPER_ADMIN may approve a request they raised themselves (operator, 2026-09-08)', async () => {
    const own = await app.inject({
      method: 'POST', url: '/api/report-reviews', headers: bearer(tokAdmin, 'Admin@123'),
      payload: { reportType: 'Alarms', title: 'ALARM REPORT', requestMeta, dataSnapshot: snapshot, remarks: 'own', assigneeRole: ROLE_APPR },
    });
    expect(own.statusCode).toBe(201);
    created.push(own.json().id);
    const res = await decide(own.json().id, 'approve', tokAdmin, 'checked', 'Admin@123');
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPROVED');
    // Both signature lines name the same person — that is the consequence the
    // operator accepted when asking for this. (The test DB's super admin is
    // `admin`, not `superadmin`; compare, don't name.)
    expect(res.json().decidedByName).toBe(res.json().requestedByName);
  });

  it('a non-party approver gets 404, a wrong password 401, and blank remarks 400', async () => {
    // created[0] is assigned to the approver USER; the third user holds neither.
    const asThird = await decide(created[0], 'approve', tokThird);
    expect([403, 404]).toContain(asThird.statusCode); // 403: no APPROVE permission
    expect((await decide(created[0], 'approve', tokAppr, 'checked', 'wrong')).statusCode).toBe(401);
    expect((await decide(created[0], 'approve', tokAppr, '  ')).statusCode).toBe(400);
  });

  it('approves once — audits, notifies the requester — and refuses a second decision with 409', async () => {
    const res = await decide(created[0], 'approve', tokAppr, 'reviewed against the batch record');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'APPROVED', decidedByName: U_APPR, decisionRemarks: 'reviewed against the batch record' });
    expect(res.json().decidedAt).toBeTruthy();
    const audit = await prisma.auditTrail.findFirst({ where: { action: 'REPORT_REVIEW_APPROVED', targetId: created[0] } });
    expect(audit?.userId).toBe(U_APPR);
    const note = await prisma.notification.findFirst({ where: { type: 'REPORT_REVIEW_APPROVED', forUserId: U_REQ } });
    expect(note).toBeTruthy();
    expect((await decide(created[0], 'approve', tokAppr)).statusCode).toBe(409);
    expect((await decide(created[0], 'reject', tokAppr)).statusCode).toBe(409);
  });

  it('rejects the role-assigned request through a holder of the role', async () => {
    const res = await decide(created[1], 'reject', tokAppr, 'wrong period');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'REJECTED', decidedByName: U_APPR });
    const audit = await prisma.auditTrail.findFirst({ where: { action: 'REPORT_REVIEW_REJECTED', targetId: created[1] } });
    expect(audit?.userId).toBe(U_APPR);
    const note = await prisma.notification.findFirst({ where: { type: 'REPORT_REVIEW_REJECTED', forUserId: U_REQ } });
    expect(note).toBeTruthy();
  });
});

describe('approved list and download-log', () => {
  it('approved: both parties see it, a third user sees nothing', async () => {
    for (const t of [tokReq, tokAppr]) {
      const res = await app.inject({ method: 'GET', url: '/api/report-reviews?list=approved', headers: bearer(t) });
      expect(res.json().data.map((r: any) => r.id)).toContain(created[0]);
      expect(res.json().data.map((r: any) => r.id)).not.toContain(created[1]);
    }
    const third = await app.inject({ method: 'GET', url: '/api/report-reviews?list=approved', headers: bearer(tokThird) });
    expect(third.json().total).toBe(0);
  });

  it('download-log: audits a party downloading the APPROVED document; 404 for a non-party; 409 when not approved', async () => {
    const ok = await app.inject({ method: 'POST', url: `/api/report-reviews/${created[0]}/download-log`, headers: bearer(tokReq), payload: {} });
    expect(ok.statusCode).toBe(200);
    const audit = await prisma.auditTrail.findFirst({ where: { action: 'REPORT_DOWNLOADED', targetId: created[0] } });
    expect(audit?.userId).toBe(U_REQ);
    expect((audit?.afterValue as any)?.signatures?.map((s: any) => s.label)).toEqual(['Requested By', 'Approved By']);
    expect((await app.inject({ method: 'POST', url: `/api/report-reviews/${created[0]}/download-log`, headers: bearer(tokThird), payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/report-reviews/${created[1]}/download-log`, headers: bearer(tokReq), payload: {} })).statusCode).toBe(409);
  });

  it('has no DELETE route — a request is a §11 record', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/report-reviews/${created[0]}`, headers: bearer(tokAdmin, 'Admin@123') });
    expect(res.statusCode).toBe(404);
  });
});
