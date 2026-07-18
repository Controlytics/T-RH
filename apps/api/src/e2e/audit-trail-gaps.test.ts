/**
 * 21 CFR §11.10(e) — audit coverage for surfaces that mutate/destroy records.
 *
 * These endpoints all wrote NO audit_trail row before 2026-07-15:
 *   - user-groups PUT / DELETE / add-members / remove-member (only CREATE audited).
 *     Group membership resolves notification recipients (notification-dispatcher.ts),
 *     so removing a QA user silently stops their alerts with no record of who did it.
 *   - notification-settings DELETE /logs/:id — destroys the evidence that QA was
 *     emailed about (e.g.) an account lockout. Also 500'd (unmapped P2025) on a
 *     missing id instead of 404.
 *
 * Each test asserts the AUDIT ROW, not just a 200 — a route that succeeds while
 * writing nothing is exactly the bug being fixed here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs, authPost, authPut, authDelete } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

describe('Audit-trail gap closures', () => {
  let app: FastifyInstance;
  let adminToken: string;

  /** Newest audit row for an action, optionally pinned to a target. */
  async function latestAudit(action: string, targetId?: string) {
    return prisma.auditTrail.findFirst({
      where: { action, ...(targetId ? { targetId } : {}) },
      orderBy: { timestamp: 'desc' },
    });
  }

  beforeAll(async () => {
    app = await buildApp();
    adminToken = await loginAs(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // ── User groups (findings 4-7) ────────────────────────────────────────

  describe('user-groups mutations are audited', () => {
    async function createGroup(name: string) {
      const res = await authPost(app, '/api/user-groups', adminToken, { name });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body) as { id: string; name: string };
    }

    it('PUT /:id writes USER_GROUP_UPDATED with before/after', async () => {
      const g = await createGroup(`e2e-upd-${Date.now()}`);

      const res = await authPut(app, `/api/user-groups/${g.id}`, adminToken, {
        name: `${g.name}-renamed`,
        isActive: false,
      });
      expect(res.statusCode).toBe(200);

      const row = await latestAudit('USER_GROUP_UPDATED', g.id);
      expect(row, 'no USER_GROUP_UPDATED audit row').not.toBeNull();
      expect((row!.beforeValue as any).name).toBe(g.name);
      expect((row!.beforeValue as any).isActive).toBe(true);
      expect((row!.afterValue as any).name).toBe(`${g.name}-renamed`);
      expect((row!.afterValue as any).isActive).toBe(false);
      expect(row!.userId).toBeTruthy();

      await prisma.userGroup.deleteMany({ where: { id: g.id } });
    });

    it('POST /:id/members writes USER_GROUP_MEMBERS_ADDED naming the users', async () => {
      const g = await createGroup(`e2e-add-${Date.now()}`);
      const user = await prisma.user.findFirstOrThrow({ select: { id: true } });

      const res = await authPost(app, `/api/user-groups/${g.id}/members`, adminToken, {
        userIds: [user.id],
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).added).toBe(1);

      const row = await latestAudit('USER_GROUP_MEMBERS_ADDED', g.id);
      expect(row, 'no USER_GROUP_MEMBERS_ADDED audit row').not.toBeNull();
      expect((row!.afterValue as any).requestedUserIds).toEqual([user.id]);
      expect((row!.afterValue as any).addedCount).toBe(1);

      await prisma.userGroup.deleteMany({ where: { id: g.id } });
    });

    it('DELETE /:id/members/:userId writes USER_GROUP_MEMBER_REMOVED', async () => {
      const g = await createGroup(`e2e-rm-${Date.now()}`);
      const user = await prisma.user.findFirstOrThrow({ select: { id: true } });
      await authPost(app, `/api/user-groups/${g.id}/members`, adminToken, { userIds: [user.id] });

      const res = await authDelete(app, `/api/user-groups/${g.id}/members/${user.id}`, adminToken);
      expect(res.statusCode).toBe(200);

      const row = await latestAudit('USER_GROUP_MEMBER_REMOVED', g.id);
      expect(row, 'no USER_GROUP_MEMBER_REMOVED audit row').not.toBeNull();
      // The removed user must be identifiable after the membership row is gone.
      expect((row!.beforeValue as any).userId).toBe(user.id);
      expect((row!.beforeValue as any).groupName).toBe(g.name);
      // The membership really is gone.
      expect(await prisma.userGroupMember.count({ where: { groupId: g.id, userId: user.id } })).toBe(0);

      await prisma.userGroup.deleteMany({ where: { id: g.id } });
    });

    it('DELETE /:id writes USER_GROUP_DELETED capturing the destroyed membership', async () => {
      const g = await createGroup(`e2e-del-${Date.now()}`);
      const user = await prisma.user.findFirstOrThrow({ select: { id: true } });
      await authPost(app, `/api/user-groups/${g.id}/members`, adminToken, { userIds: [user.id] });

      const res = await authDelete(app, `/api/user-groups/${g.id}`, adminToken);
      expect(res.statusCode).toBe(200);

      const row = await latestAudit('USER_GROUP_DELETED', g.id);
      expect(row, 'no USER_GROUP_DELETED audit row').not.toBeNull();
      // Physical delete — the audit row is the only surviving record of the group
      // and of whose notifications just stopped.
      expect((row!.beforeValue as any).name).toBe(g.name);
      expect((row!.beforeValue as any).memberCount).toBe(1);
      expect((row!.beforeValue as any).memberUserIds).toEqual([user.id]);
      expect(await prisma.userGroup.count({ where: { id: g.id } })).toBe(0);
    });

    it('returns 404 (not 500) for a mutation on an unknown group', async () => {
      const ghost = '00000000-0000-0000-0000-000000000000';
      const res = await authDelete(app, `/api/user-groups/${ghost}`, adminToken);
      expect(res.statusCode).toBe(404);
    });
  });

  // ── Notification delivery log (finding 3) ─────────────────────────────

  describe('notification delivery log delete is audited', () => {
    it('DELETE /logs/:id writes NOTIFICATION_LOG_DELETED capturing the dispatch', async () => {
      const log = await prisma.notificationLog.create({
        data: {
          channel: 'EMAIL',
          recipient: 'qa@example.com',
          subject: 'Account locked: RB0001',
          message: 'Account RB0001 was locked out.',
          status: 'SENT',
        },
      });

      const res = await authDelete(app, `/api/notification-settings/logs/${log.id}`, adminToken);
      expect(res.statusCode).toBe(200);

      const row = await latestAudit('NOTIFICATION_LOG_DELETED', log.id);
      expect(row, 'no NOTIFICATION_LOG_DELETED audit row').not.toBeNull();
      // Who was told what — the whole point of keeping the evidence.
      expect((row!.beforeValue as any).recipient).toBe('qa@example.com');
      expect((row!.beforeValue as any).subject).toBe('Account locked: RB0001');
      expect((row!.beforeValue as any).channel).toBe('EMAIL');
      expect((row!.beforeValue as any).status).toBe('SENT');
      expect(await prisma.notificationLog.count({ where: { id: log.id } })).toBe(0);
    });

    it('returns 404 (not 500) for an unknown log id', async () => {
      // Pre-fix this hit Prisma P2025 unmapped → 500.
      const res = await authDelete(
        app,
        '/api/notification-settings/logs/00000000-0000-0000-0000-000000000000',
        adminToken,
      );
      expect(res.statusCode).toBe(404);
    });
  });
});
