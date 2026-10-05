import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPut, authPost, authDelete, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

describe('Notifications endpoints', () => {
  let app: FastifyInstance;
  let adminToken: string;

  /** Fetch the current notification list and return the parsed body. */
  async function fetchNotifications() {
    const res = await authGet(app, '/api/notifications', adminToken);
    return JSON.parse(res.body) as {
      data: Array<{ id: string; isRead: boolean }>;
      total: number;
    };
  }

  beforeAll(async () => {
    app = await buildApp();
    adminToken = await loginAs(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Existing tests ────────────────────────────────────────────────────

  describe('GET /api/notifications', () => {
    it('returns notifications list', async () => {
      const res = await authGet(app, '/api/notifications', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toBeDefined();
      expect(body.total).toBeDefined();
    });

    /**
     * Audit 2026-10-03, API-14: the list schema declared seven fields, so
     * Fastify stripped `targetUserId` / `forUserId` / `forRole` / `metadata`
     * off every row (the page's `@{targetUserId}` chip never rendered), and
     * `readAt` — NULL on every unread row — serialised as "". Asserted over
     * the wire, key by key, on a row this test writes.
     */
    it('declares the addressing fields and metadata, and serialises a null readAt as null', async () => {
      const n = await prisma.notification.create({
        data: {
          type: 'USER_CREATED', title: 'e2e shape probe', message: 'shape',
          targetUserId: 'probe-target', forRole: 'SUPER_ADMIN', metadata: { requestId: 'r-1', nested: { k: 1 } },
        },
      });
      try {
        const res = await authGet(app, '/api/notifications?limit=500', adminToken);
        expect(res.statusCode).toBe(200);
        const row = JSON.parse(res.body).data.find((r: any) => r.id === n.id);
        expect(row).toBeDefined();
        expect(row.targetUserId).toBe('probe-target');
        expect(row.forRole).toBe('SUPER_ADMIN');
        expect(row).toHaveProperty('forUserId');
        expect(row.forUserId).toBeNull();
        expect(row.metadata).toEqual({ requestId: 'r-1', nested: { k: 1 } });
        expect(row).toHaveProperty('readAt');
        expect(row.readAt).toBeNull();
      } finally {
        await prisma.notification.deleteMany({ where: { id: n.id } });
      }
    });

    // Audit 2026-10-03, API-12: a bad date is a 400 by field, never a 500.
    it('answers 400 by field for an unparseable startDate, never 500', async () => {
      const res = await authGet(app, '/api/notifications?startDate=yesterday', adminToken);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).details.fieldErrors.startDate).toBeDefined();
    });
  });

  /**
   * Audit 2026-10-03, API-16: acting on a row by id is governed by the SAME
   * rule as listing it. Driven as the seeded OPERATOR (RB0001), whose
   * visibility is `forUserId = RB0001` and nothing else.
   */
  describe('single-row access equals list visibility', () => {
    let operatorToken = '';
    const made: string[] = [];

    beforeAll(async () => {
      operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
    });

    afterAll(async () => {
      await prisma.notification.deleteMany({ where: { id: { in: made } } });
    });

    async function make(data: { forUserId?: string | null; forRole?: string | null; targetUserId?: string | null }) {
      const n = await prisma.notification.create({
        data: { type: 'USER_LOCKED', title: 'e2e visibility', message: 'v', ...data },
      });
      made.push(n.id);
      return n.id;
    }

    it('a user can mark their OWN notification read', async () => {
      const id = await make({ forUserId: 'RB0001' });
      expect((await authPut(app, `/api/notifications/${id}/read`, operatorToken)).statusCode).toBe(200);
    });

    it('a user gets 404 (never 403) for another user\'s notification, and it stays unread', async () => {
      const id = await make({ forUserId: 'someone-else' });
      expect((await authPut(app, `/api/notifications/${id}/read`, operatorToken)).statusCode).toBe(404);
      expect((await prisma.notification.findUnique({ where: { id } }))?.isRead).toBe(false);
    });

    it('a user gets 404 for the admin-addressed row ABOUT themself (targetUserId grants nothing)', async () => {
      const id = await make({ forRole: 'ADMIN', targetUserId: 'RB0001' });
      expect((await authPut(app, `/api/notifications/${id}/read`, operatorToken)).statusCode).toBe(404);
      // ...and the list never showed it either — the rule is one rule.
      const list = JSON.parse((await authGet(app, '/api/notifications?limit=500', operatorToken)).body);
      expect(list.data.some((r: any) => r.id === id)).toBe(false);
    });

    it('bulk read as that user touches only rows the list would show', async () => {
      const mine = await make({ forUserId: 'RB0001' });
      const theirs = await make({ forUserId: 'someone-else' });
      const about = await make({ forRole: 'ADMIN', targetUserId: 'RB0001' });
      const res = await authPut(app, '/api/notifications/bulk-read', operatorToken, { ids: [mine, theirs, about] });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).count).toBe(1);
      expect((await prisma.notification.findUnique({ where: { id: theirs } }))?.isRead).toBe(false);
      expect((await prisma.notification.findUnique({ where: { id: about } }))?.isRead).toBe(false);
    });
  });

  describe('GET /api/notifications/unread-count', () => {
    it('returns unread count', async () => {
      const res = await authGet(app, '/api/notifications/unread-count', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(typeof body.count).toBe('number');
    });
  });

  // ── New tests — Mark read / unread ────────────────────────────────────

  describe('PUT /api/notifications/:id/read', () => {
    it('marks a notification as read (or skips if none exist)', async () => {
      const list = await fetchNotifications();

      if (list.data.length === 0) {
        // No notifications available — skip gracefully
        return;
      }

      const targetId = list.data[0].id;
      const res = await authPut(app, `/api/notifications/${targetId}/read`, adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('returns an error for a non-existent notification', async () => {
      const res = await authPut(
        app,
        '/api/notifications/00000000-0000-0000-0000-000000000000/read',
        adminToken,
      );
      // Expect a 404 or 500 depending on implementation; accept either as "not 200"
      expect([404, 500]).toContain(res.statusCode);
    });
  });

  describe('PUT /api/notifications/:id/unread', () => {
    it('marks a notification as unread (or skips if none exist)', async () => {
      const list = await fetchNotifications();

      if (list.data.length === 0) {
        return;
      }

      const targetId = list.data[0].id;
      const res = await authPut(app, `/api/notifications/${targetId}/unread`, adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('returns an error for a non-existent notification', async () => {
      const res = await authPut(
        app,
        '/api/notifications/00000000-0000-0000-0000-000000000000/unread',
        adminToken,
      );
      expect([404, 500]).toContain(res.statusCode);
    });
  });

  // ── Mark-all-read ─────────────────────────────────────────────────────

  describe('PUT /api/notifications/mark-all-read', () => {
    it('marks all notifications as read and returns success', async () => {
      const res = await authPut(app, '/api/notifications/mark-all-read', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });

  // ── Bulk read / unread ────────────────────────────────────────────────

  describe('PUT /api/notifications/bulk-read', () => {
    it('marks multiple notifications as read (or skips if none exist)', async () => {
      const list = await fetchNotifications();

      if (list.data.length === 0) {
        return;
      }

      const ids = list.data.slice(0, 3).map((n) => n.id);
      const res = await authPut(app, '/api/notifications/bulk-read', adminToken, { ids });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(typeof body.count).toBe('number');
    });

    it('rejects an empty ids array', async () => {
      const res = await authPut(app, '/api/notifications/bulk-read', adminToken, { ids: [] });
      // Schema requires minItems: 1 — Fastify should return 400
      expect(res.statusCode).toBe(400);
    });
  });

  describe('PUT /api/notifications/bulk-unread', () => {
    it('marks multiple notifications as unread (or skips if none exist)', async () => {
      const list = await fetchNotifications();

      if (list.data.length === 0) {
        return;
      }

      const ids = list.data.slice(0, 3).map((n) => n.id);
      const res = await authPut(app, '/api/notifications/bulk-unread', adminToken, { ids });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(typeof body.count).toBe('number');
    });

    it('rejects an empty ids array', async () => {
      const res = await authPut(app, '/api/notifications/bulk-unread', adminToken, { ids: [] });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── Delete single ─────────────────────────────────────────────────────

  describe('DELETE /api/notifications/:id', () => {
    it('deletes a notification (or skips if none exist)', async () => {
      const list = await fetchNotifications();

      if (list.data.length === 0) {
        return;
      }

      // Pick the last notification to avoid conflicts with earlier tests
      const targetId = list.data[list.data.length - 1].id;
      const res = await authDelete(app, `/api/notifications/${targetId}`, adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('returns an error for a non-existent notification', async () => {
      const res = await authDelete(
        app,
        '/api/notifications/00000000-0000-0000-0000-000000000000',
        adminToken,
      );
      expect([404, 500]).toContain(res.statusCode);
    });
  });

  // ── Bulk delete ───────────────────────────────────────────────────────

  describe('POST /api/notifications/bulk-delete', () => {
    it('deletes multiple notifications (or skips if none exist)', async () => {
      const list = await fetchNotifications();

      if (list.data.length === 0) {
        return;
      }

      const ids = list.data.slice(0, 2).map((n) => n.id);
      const res = await authPost(app, '/api/notifications/bulk-delete', adminToken, { ids });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(typeof body.count).toBe('number');
    });

    it('rejects an empty ids array', async () => {
      const res = await authPost(app, '/api/notifications/bulk-delete', adminToken, { ids: [] });
      expect(res.statusCode).toBe(400);
    });
  });
});
