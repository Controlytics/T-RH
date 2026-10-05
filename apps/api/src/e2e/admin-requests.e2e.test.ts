import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPost } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

/**
 * Admin requests — previously ZERO test coverage (audit finding H4), despite
 * owning the only two UNAUTHENTICATED write/read surfaces in the product:
 * `POST /api/admin-requests` and `GET /api/admin-requests/user-lookup`.
 *
 * The lookup endpoint was hardened once already (2026-05-20) after it returned
 * distinguishable 200-vs-404 responses carrying full PII — a perfect directory
 * enumeration oracle. The hardening has had no test since. These assertions
 * pin the properties that hardening created, so a future refactor cannot
 * quietly undo them:
 *
 *   - the response SHAPE is identical whether or not the user exists
 *   - the status code is 200 either way (no 404 to distinguish on)
 *   - no email, department, role or status is ever returned
 *
 * The residual `exists` boolean is a known, accepted exposure (audit finding
 * M1) and is asserted here as CURRENT behaviour, not endorsed as correct.
 */
describe('admin-requests e2e', () => {
  let app: FastifyInstance;
  let token: string;
  let realUsername: string;
  const created: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    token = await loginAs(app);
    const user = await prisma.user.findFirst({ select: { username: true } });
    if (!user) throw new Error('fixture: expected at least one user');
    realUsername = user.username;
  });

  afterAll(async () => {
    for (const id of created) {
      await prisma.adminRequest.deleteMany({ where: { id } });
    }
    await app.close();
  });

  describe('public submission', () => {
    it('accepts a request with no authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin-requests',
        payload: {
          requestType: 'UNLOCK',
          requesterName: 'E2E Tester',
          requesterEmployeeId: `E2E${Date.now()}`,
          requestData: { reason: 'locked out' },
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.requestId).toBeTruthy();
      created.push(body.requestId);
    });

    it('refuses ENABLE_ACCOUNT — removed from the form on 2026-09-25', async () => {
      const STAMP = Date.now();
      const res = await app.inject({
        method: 'POST', url: '/api/admin-requests',
        payload: {
          requestType: 'ENABLE_ACCOUNT',
          requesterName: 'Nobody',
          requesterEmployeeId: `gone-${STAMP}`,
          requestData: { username: 'someone' },
          remarks: 'should be refused',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(await prisma.adminRequest.count({ where: { requesterEmployeeId: `gone-${STAMP}` } })).toBe(0);
    });

    it('rejects an unknown requestType', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin-requests',
        payload: {
          requestType: 'BECOME_ADMIN',
          requesterName: 'E2E',
          requesterEmployeeId: 'E2E',
          requestData: {},
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it.each([
      ['requestType', { requesterName: 'x', requesterEmployeeId: 'x', requestData: {} }],
      ['requesterName', { requestType: 'UNLOCK', requesterEmployeeId: 'x', requestData: {} }],
      ['requesterEmployeeId', { requestType: 'UNLOCK', requesterName: 'x', requestData: {} }],
      ['requestData', { requestType: 'UNLOCK', requesterName: 'x', requesterEmployeeId: 'x' }],
    ])('rejects a submission missing %s', async (_field, payload) => {
      const res = await app.inject({ method: 'POST', url: '/api/admin-requests', payload });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a malformed email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin-requests',
        payload: {
          requestType: 'UNLOCK',
          requesterName: 'E2E',
          requesterEmployeeId: 'E2E',
          requesterEmail: 'not-an-email',
          requestData: {},
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('public user-lookup — enumeration hardening', () => {
    async function lookup(username: string) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin-requests/user-lookup?username=${encodeURIComponent(username)}`,
      });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    }

    it('answers 200 for a user that exists', async () => {
      const { status, body } = await lookup(realUsername);
      expect(status).toBe(200);
      expect(body.exists).toBe(true);
    });

    // The whole point of the 2026-05-20 fix: a missing user must NOT 404.
    it('answers 200 — not 404 — for a user that does not exist', async () => {
      const { status, body } = await lookup(`definitely-not-a-user-${Date.now()}`);
      expect(status).toBe(200);
      expect(body.exists).toBe(false);
    });

    // Identical key sets. A field present in one response and absent in the
    // other is itself an oracle, even with the status codes equalised.
    it('returns the same response SHAPE either way', async () => {
      const hit = await lookup(realUsername);
      const miss = await lookup(`nobody-${Date.now()}`);
      expect(Object.keys(hit.body).sort()).toEqual(Object.keys(miss.body).sort());
    });

    // fullName joined this list 2026-08-29 (audit M1) — it was the last real
    // PII returned to an unauthenticated caller who guessed an employee id.
    it.each(['email', 'department', 'role', 'status', 'passwordHash', 'id', 'fullName'])(
      'never returns %s',
      async (field) => {
        const { body } = await lookup(realUsername);
        expect(body).not.toHaveProperty(field);
      },
    );

    it('requires the username parameter', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin-requests/user-lookup' });
      expect(res.statusCode).toBe(400);
    });

    it('does not fall over on an over-long username', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin-requests/user-lookup?username=${'a'.repeat(200)}`,
      });
      // Rejected by maxLength — the important part is that it is not a 500.
      expect(res.statusCode).toBe(400);
    });
  });

  /**
   * The state guards (operator, 2026-09-02).
   *
   * *"in contact admin user requested for account unlock but that account was
   * actually not locked, when admin approve that request account is showing
   * unlocked"*.
   *
   * The screen was the symptom. The DEFECT is the §11 record: `userService.unlock`
   * writes an `ACCOUNT_UNLOCKED` audit row unconditionally, so approving an unlock
   * for an account that was never locked asserted an administrative act that did
   * not happen. Every assertion below therefore checks the AUDIT TRAIL, not just
   * the response body — a dialog can be corrected later, a regulated record cannot.
   */
  describe('state requests do not act on an account already in that state', () => {
    const STAMP = Date.now();
    const users: string[] = [];
    const requests: string[] = [];

    /**
     * Fixtures are OPERATOR and the caller is SUPER_ADMIN, so
     * `assertCanManageTarget` (which every one of unlock/enable/disable calls)
     * always passes here. **The role-hierarchy guard is therefore NOT exercised by
     * this block** — it is covered in the users suite, and these tests are about
     * the state guard alone. Worth knowing before reading a passing positive
     * control as proof of more than it is.
     */
    async function makeUser(suffix: string, status: 'ENABLED' | 'DISABLED' | 'LOCKED') {
      const username = `ar-state-${suffix}-${STAMP}`;
      const u = await prisma.user.create({
        data: {
          username, fullName: `State ${suffix}`, role: 'OPERATOR', status,
          passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV',
          ...(status === 'LOCKED' ? { lockedAt: new Date(), failedLoginAttempts: 5 } : {}),
        },
        select: { id: true, username: true },
      });
      users.push(u.id);
      return u;
    }

    /** Submit through the PUBLIC route and approve through the ADMIN one, so the
     *  whole path is exercised rather than the service in isolation. */
    const fixturePayload = (requestType: string, username: string) => ({
      requestType,
      requesterName: 'State Fixture',
      requesterEmployeeId: `req-${STAMP}`,
      requestData: { username },
      remarks: 'e2e state guard',
    });

    async function approve(id: string) {
      // Approving is a §11 e-signature — `enforceReauth('APPROVE_ADMIN_REQUEST')`
      // 401s without a password. Sent as the header rather than `_currentPassword`
      // so the request body stays exactly what the route's schema declares.
      const res = await app.inject({
        method: 'POST', url: `/api/admin-requests/${id}/process`,
        headers: { authorization: `Bearer ${token}`, 'x-reauth-password': 'Admin@123' },
        payload: { action: 'approve', adminRemarks: 'e2e' },
      });
      return { res, requestId: id };
    }

    async function submitAndApprove(requestType: string, username: string) {
      const sub = await app.inject({
        method: 'POST', url: '/api/admin-requests',
        payload: fixturePayload(requestType, username),
      });
      expect(sub.statusCode).toBe(201);
      const found = await prisma.adminRequest.findFirst({
        where: { requestType, requesterEmployeeId: `req-${STAMP}`, status: 'PENDING' },
        orderBy: { requestedAt: 'desc' },
      });
      if (!found) throw new Error('fixture: request was not stored');
      requests.push(found.id);
      return approve(found.id);
    }

    /**
     * ENABLE_ACCOUNT can no longer be SUBMITTED (operator, 2026-09-25: "in contact
     * admin page remove enable user account feature" — the page option and the
     * public route's enum both went; the refusal is pinned under "public
     * submission"). The approval path survives so a request stored BEFORE the
     * removal can still be decided and rendered, so these fixtures are seeded
     * straight into the table, the way such a row would already exist.
     */
    async function seedAndApprove(requestType: string, username: string) {
      const row = await prisma.adminRequest.create({
        data: { ...fixturePayload(requestType, username), status: 'PENDING' },
      });
      requests.push(row.id);
      return approve(row.id);
    }

    const auditRowsFor = (userId: string, action: string) =>
      prisma.auditTrail.count({ where: { targetId: userId, action } });

    afterAll(async () => {
      for (const id of requests) await prisma.adminRequest.deleteMany({ where: { id } });
      for (const id of users) await prisma.user.deleteMany({ where: { id } });
    });

    it('UNLOCK on an account that is NOT locked changes nothing and says so', async () => {
      const u = await makeUser('unlock-noop', 'ENABLED');
      const before = await auditRowsFor(u.id, 'ACCOUNT_UNLOCKED');

      const { res } = await submitAndApprove('UNLOCK', u.username);
      expect(res.statusCode).toBe(200);
      const body = res.json();

      // Declared in the response schema, or Fastify strips it and every approval
      // reads as an action performed.
      expect(body.changed).toBe(false);
      expect(body.message).toContain('was not locked');
      // No temporary password: the requester asked for an unlock, not a credential
      // change, and issuing one would be doing something nobody approved.
      expect(body.temporaryPassword).toBeUndefined();

      // THE ASSERTION THIS BLOCK EXISTS FOR.
      expect(await auditRowsFor(u.id, 'ACCOUNT_UNLOCKED')).toBe(before);

      // And the account is untouched.
      const after = await prisma.user.findUnique({ where: { id: u.id }, select: { status: true } });
      expect(after?.status).toBe('ENABLED');
    });

    it('UNLOCK on a genuinely LOCKED account still works', async () => {
      // The positive control. Without it the test above passes against a build
      // where unlock is broken outright.
      const u = await makeUser('unlock-real', 'LOCKED');
      const { res } = await submitAndApprove('UNLOCK', u.username);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.changed).toBe(true);
      expect(body.temporaryPassword).toBeTruthy();
      expect(await auditRowsFor(u.id, 'ACCOUNT_UNLOCKED')).toBe(1);
      const after = await prisma.user.findUnique({ where: { id: u.id }, select: { status: true } });
      expect(after?.status).toBe('ENABLED');
    });

    it('ENABLE_ACCOUNT on an already-enabled account changes nothing', async () => {
      const u = await makeUser('enable-noop', 'ENABLED');
      const { res } = await seedAndApprove('ENABLE_ACCOUNT', u.username);
      expect(res.statusCode).toBe(200);
      expect(res.json().changed).toBe(false);
      expect(res.json().message).toContain('already enabled');
      expect(await auditRowsFor(u.id, 'ACCOUNT_ENABLED')).toBe(0);
    });

    it('ENABLE_ACCOUNT on a disabled account enables it', async () => {
      const u = await makeUser('enable-real', 'DISABLED');
      const { res } = await seedAndApprove('ENABLE_ACCOUNT', u.username);
      expect(res.json().changed).toBe(true);
      const after = await prisma.user.findUnique({ where: { id: u.id }, select: { status: true } });
      expect(after?.status).toBe('ENABLED');
    });

    it('DISABLE_ACCOUNT on an already-disabled account changes nothing', async () => {
      const u = await makeUser('disable-noop', 'DISABLED');
      const { res } = await submitAndApprove('DISABLE_ACCOUNT', u.username);
      expect(res.json().changed).toBe(false);
      expect(res.json().message).toContain('already disabled');
      expect(await auditRowsFor(u.id, 'ACCOUNT_DISABLED')).toBe(0);
    });

    it('DISABLE_ACCOUNT on an enabled account disables it, and the USER_DISABLED row names the request as its reason', async () => {
      const u = await makeUser('disable-real', 'ENABLED');
      const { res, requestId } = await submitAndApprove('DISABLE_ACCOUNT', u.username);
      expect(res.json().changed).toBe(true);
      const after = await prisma.user.findUnique({ where: { id: u.id }, select: { status: true } });
      expect(after?.status).toBe('DISABLED');
      // DATA-11: a disable needs a reason; here it is the approved request.
      const row = await prisma.auditTrail.findFirst({ where: { action: 'USER_DISABLED', targetId: u.id } });
      expect(row?.reason).toContain(requestId);
      expect(row?.reason).toContain('e2e'); // the admin's remarks
    });

    /**
     * Audit 2026-10-03, API-20: MODIFY_USER forwarded an UNTYPED `newValue`
     * from the public form straight to `userService.update`, and nothing
     * refused a request for the SUPER_ADMIN role. Both refusals roll the
     * approval back — the request is PENDING again, not APPROVED (API-7: the
     * claim and the decision commit together).
     */
    it('MODIFY_USER asking for the SUPER_ADMIN role is refused (403) and the request stays PENDING', async () => {
      const u = await makeUser('modify-sa', 'ENABLED');
      const row = await prisma.adminRequest.create({
        data: {
          requestType: 'MODIFY_USER', requesterName: 'State Fixture', requesterEmployeeId: `req-${STAMP}`,
          requestData: { username: u.username, modifyField: 'role', newValue: 'SUPER_ADMIN' }, status: 'PENDING',
        },
      });
      requests.push(row.id);
      const { res } = await approve(row.id);
      expect(res.statusCode).toBe(403);
      expect((await prisma.adminRequest.findUnique({ where: { id: row.id } }))?.status).toBe('PENDING');
      expect((await prisma.user.findUnique({ where: { id: u.id } }))?.role).toBe('OPERATOR');
    });

    it('MODIFY_USER with a value the user schema refuses is a 400 and the request stays PENDING', async () => {
      const u = await makeUser('modify-bad', 'ENABLED');
      const row = await prisma.adminRequest.create({
        data: {
          requestType: 'MODIFY_USER', requesterName: 'State Fixture', requesterEmployeeId: `req-${STAMP}`,
          requestData: { username: u.username, modifyField: 'status', newValue: 'BANANA' }, status: 'PENDING',
        },
      });
      requests.push(row.id);
      const { res } = await approve(row.id);
      expect(res.statusCode).toBe(400);
      expect((await prisma.adminRequest.findUnique({ where: { id: row.id } }))?.status).toBe('PENDING');
      expect((await prisma.user.findUnique({ where: { id: u.id } }))?.status).toBe('ENABLED');
    });

    it('a decided request has its ADMIN_REQUEST_APPROVED row (claim and record commit together)', async () => {
      const u = await makeUser('modify-ok', 'ENABLED');
      const row = await prisma.adminRequest.create({
        data: {
          requestType: 'MODIFY_USER', requesterName: 'State Fixture', requesterEmployeeId: `req-${STAMP}`,
          requestData: { username: u.username, modifyField: 'department', newValue: 'QC' }, status: 'PENDING',
        },
      });
      requests.push(row.id);
      const { res } = await approve(row.id);
      expect(res.statusCode).toBe(200);
      expect((await prisma.adminRequest.findUnique({ where: { id: row.id } }))?.status).toBe('APPROVED');
      expect(await prisma.auditTrail.count({ where: { action: 'ADMIN_REQUEST_APPROVED', targetId: row.id } })).toBe(1);
    });

    it('names the TARGET account and its role in the approval audit record', async () => {
      /**
       * Operator, 2026-09-02: the record showed only the REQUESTER. Their case had
       * requester 101020 and approver 101010 — two people — and named neither the
       * account acted on nor its role.
       */
      const u = await makeUser('audit-name', 'DISABLED');
      const { requestId } = await seedAndApprove('ENABLE_ACCOUNT', u.username);

      const row = await prisma.auditTrail.findFirst({
        where: { targetId: requestId, action: 'ADMIN_REQUEST_APPROVED' },
        orderBy: { timestamp: 'desc' },
      });
      const after = (row?.afterValue ?? {}) as Record<string, unknown>;
      expect(String(after.name)).toContain(u.username);      // the target account
      expect(String(after.name)).toContain('OPERATOR');      // its role
      expect(String(after.name)).toContain('State Fixture'); // who asked
      expect(after.targetUsername).toBe(u.username);
      // `by {actor}` renders from userId — the VERIFIED approver, a different
      // person from the requester.
      expect(row?.userId).toBeTruthy();
      expect(row?.userId).not.toBe(`req-${STAMP}`);
    });
  });

  describe('admin surface', () => {
    it('requires authentication to list requests', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin-requests' });
      expect(res.statusCode).toBe(401);
    });

    it('lists requests for an authorised admin', async () => {
      const res = await authGet(app, '/api/admin-requests', token);
      expect(res.statusCode).toBe(200);
    });

    it('filters by status', async () => {
      const res = await authGet(app, '/api/admin-requests?status=PENDING', token);
      expect(res.statusCode).toBe(200);
    });

    it('rejects an invalid status filter', async () => {
      const res = await authGet(app, '/api/admin-requests?status=BANANA', token);
      expect(res.statusCode).toBe(400);
    });

    it('reports a pending count', async () => {
      const res = await authGet(app, '/api/admin-requests/pending-count', token);
      expect(res.statusCode).toBe(200);
    });

    it('400s processing a malformed request id rather than 500', async () => {
      const res = await authPost(app, '/api/admin-requests/not-a-uuid/process', token, {
        action: 'REJECT', remarks: 'no',
      });
      expect([400, 404]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(500);
    });
  });
});

/**
 * Audit 2026-10-03, API-6: the public form's audit row carried the TYPED
 * employee id as the acting user, so an anonymous POST could attribute a
 * hash-chained row to any username. The row is a SYSTEM action now — no actor
 * — and the typed id is data on the record.
 */
describe('POST /api/admin-requests audit attribution', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await app.close(); });

  it('writes the submitted row with NO acting user; the typed employee id is data, not the actor', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/admin-requests',
      payload: {
        requestType: 'UNLOCK',
        requesterName: 'Anyone At All',
        requesterEmployeeId: 'superadmin',
        requestData: { reason: 'attribution e2e' },
      },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().requestId as string;
    expect(id).toBeTruthy();
    const row = await prisma.auditTrail.findFirst({ where: { action: 'ADMIN_REQUEST_SUBMITTED', targetId: id } });
    expect(row).not.toBeNull();
    expect(row!.userId).toBeNull();
    expect((row!.afterValue as { requesterEmployeeId: string }).requesterEmployeeId).toBe('superadmin');
    await prisma.adminRequest.deleteMany({ where: { id } });
  });
});

