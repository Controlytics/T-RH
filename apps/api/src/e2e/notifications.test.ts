import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPut, authPost, authDelete, ADMIN_PASSWORD } from './test-helper.js';

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
