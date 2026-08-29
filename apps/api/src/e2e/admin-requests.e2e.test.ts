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

    it.each(['email', 'department', 'role', 'status', 'passwordHash', 'id'])(
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
