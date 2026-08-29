import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPost, authPut, authDelete } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

/**
 * User groups — previously ZERO test coverage (audit finding H4).
 *
 * This module is on the alerting path: `notification-dispatcher.ts` resolves a
 * rule's GROUP recipients through `user_group_members`, so adding or removing
 * a member changes who gets told about an excursion. A silent failure here
 * does not look like a bug — it looks like a quiet plant.
 *
 * The assertions therefore concentrate on the things whose failure would be
 * INVISIBLE: that membership is actually persisted, that a removal is audited
 * with enough detail to reconstruct who stopped being notified, and that
 * deleting a group records the membership it destroyed.
 */
/** Well-formed uuid that names no row — distinguishes 404 from a parse error. */
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

describe('user-groups e2e', () => {
  let app: FastifyInstance;
  let token: string;
  const created: string[] = [];
  let memberUserId: string;

  beforeAll(async () => {
    app = await buildApp();
    token = await loginAs(app);
    const someone = await prisma.user.findFirst({
      where: { username: { not: 'admin' } },
      select: { id: true },
    });
    if (!someone) throw new Error('fixture: expected a second user to exist');
    memberUserId = someone.id;
  });

  afterAll(async () => {
    for (const id of created) {
      await prisma.userGroup.deleteMany({ where: { id } });
    }
    await app.close();
  });

  async function makeGroup(name: string) {
    const res = await authPost(app, '/api/user-groups', token, { name });
    expect(res.statusCode).toBe(200);
    const group = JSON.parse(res.body);
    created.push(group.id);
    return group;
  }

  describe('CRUD', () => {
    it('creates a group and returns it in the list', async () => {
      const name = `E2E Group ${Date.now()}`;
      const group = await makeGroup(name);
      expect(group.name).toBe(name);

      const list = await authGet(app, '/api/user-groups', token);
      expect(list.statusCode).toBe(200);
      const names = JSON.parse(list.body).map((g: any) => g.name);
      expect(names).toContain(name);
    });

    it('rejects a group with no name', async () => {
      const res = await authPost(app, '/api/user-groups', token, {});
      expect(res.statusCode).toBe(400);
    });

    it('rejects an empty name', async () => {
      const res = await authPost(app, '/api/user-groups', token, { name: '' });
      expect(res.statusCode).toBe(400);
    });

    it('updates a group', async () => {
      const group = await makeGroup(`E2E Upd ${Date.now()}`);
      const res = await authPut(app, `/api/user-groups/${group.id}`, token, {
        description: 'now described',
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).description).toBe('now described');
    });

    // The PUT schema sets additionalProperties:false precisely so AJV strips
    // unknown keys before `data: body` reaches Prisma. Without it a client
    // could rewrite the row's provenance. Locking that in.
    it('ignores unknown keys instead of writing them', async () => {
      const group = await makeGroup(`E2E Extra ${Date.now()}`);
      const res = await authPut(app, `/api/user-groups/${group.id}`, token, {
        description: 'legit',
        createdBy: 'attacker',
        id: 'some-other-id',
      });
      expect(res.statusCode).toBe(200);

      const row = await prisma.userGroup.findUnique({ where: { id: group.id } });
      expect(row?.id).toBe(group.id);
      expect(row?.createdBy).not.toBe('attacker');
    });

    // A well-formed uuid that names nothing → 404.
    it('404s updating a group that does not exist', async () => {
      const res = await authPut(app, `/api/user-groups/${ABSENT_UUID}`, token, { name: 'x' });
      expect(res.statusCode).toBe(404);
    });

    it('404s deleting a group that does not exist', async () => {
      const res = await authDelete(app, `/api/user-groups/${ABSENT_UUID}`, token);
      expect(res.statusCode).toBe(404);
    });

    // A MALFORMED id → 400, not 500.
    //
    // This found a real defect (fixed 2026-08-29). `id` is a uuid column, so
    // `findUnique({ where: { id: 'does-not-exist' } })` made Postgres fail to
    // parse the value and Prisma threw P2023 before the handler's own 404
    // check could run. The generic error branch turned that into a 500
    // INTERNAL_ERROR — and in production also dispatched a SYSTEM_ERROR
    // notification — for what is simply a bad request. Now mapped centrally in
    // lib/errors.ts:prismaErrorToResponse, so every uuid-keyed route is covered.
    it('400s on a malformed id rather than 500', async () => {
      const res = await authPut(app, '/api/user-groups/not-a-uuid', token, { name: 'x' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('INVALID_IDENTIFIER');
    });

    it('400s deleting a malformed id rather than 500', async () => {
      const res = await authDelete(app, '/api/user-groups/not-a-uuid', token);
      expect(res.statusCode).toBe(400);
    });
  });

  describe('membership — the alerting path', () => {
    it('adds a member and lists them', async () => {
      const group = await makeGroup(`E2E Mem ${Date.now()}`);
      const add = await authPost(app, `/api/user-groups/${group.id}/members`, token, {
        userIds: [memberUserId],
      });
      expect(add.statusCode).toBe(200);
      expect(JSON.parse(add.body).added).toBe(1);

      const members = await authGet(app, `/api/user-groups/${group.id}/members`, token);
      expect(members.statusCode).toBe(200);
      const body = JSON.parse(members.body);
      const ids = (Array.isArray(body) ? body : body.members ?? []).map(
        (m: any) => m.userId ?? m.user?.id ?? m.id,
      );
      expect(ids).toContain(memberUserId);
    });

    // `skipDuplicates: true` means a re-add inserts nothing. The route reports
    // rows ACTUALLY inserted, so the second call must report 0 — an operator
    // reading "1 added" twice would believe they had two notified members.
    it('reports 0 added when re-adding an existing member', async () => {
      const group = await makeGroup(`E2E Dup ${Date.now()}`);
      const first = await authPost(app, `/api/user-groups/${group.id}/members`, token, {
        userIds: [memberUserId],
      });
      expect(JSON.parse(first.body).added).toBe(1);

      const second = await authPost(app, `/api/user-groups/${group.id}/members`, token, {
        userIds: [memberUserId],
      });
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body).added).toBe(0);

      expect(
        await prisma.userGroupMember.count({ where: { groupId: group.id } }),
      ).toBe(1);
    });

    it('removes a member', async () => {
      const group = await makeGroup(`E2E Rm ${Date.now()}`);
      await authPost(app, `/api/user-groups/${group.id}/members`, token, {
        userIds: [memberUserId],
      });
      const res = await authDelete(
        app, `/api/user-groups/${group.id}/members/${memberUserId}`, token,
      );
      expect(res.statusCode).toBe(200);
      expect(
        await prisma.userGroupMember.count({ where: { groupId: group.id } }),
      ).toBe(0);
    });

    it('404s adding members to a group that does not exist', async () => {
      const res = await authPost(app, `/api/user-groups/${ABSENT_UUID}/members`, token, {
        userIds: [memberUserId],
      });
      expect(res.statusCode).toBe(404);
    });

    it('400s adding members under a malformed group id', async () => {
      const res = await authPost(app, '/api/user-groups/nope/members', token, {
        userIds: [memberUserId],
      });
      expect(res.statusCode).toBe(400);
    });

    it('cascades membership rows when the group is deleted', async () => {
      const group = await makeGroup(`E2E Casc ${Date.now()}`);
      await authPost(app, `/api/user-groups/${group.id}/members`, token, {
        userIds: [memberUserId],
      });
      const res = await authDelete(app, `/api/user-groups/${group.id}`, token);
      expect(res.statusCode).toBe(200);

      expect(await prisma.userGroup.findUnique({ where: { id: group.id } })).toBeNull();
      expect(
        await prisma.userGroupMember.count({ where: { groupId: group.id } }),
      ).toBe(0);
    });
  });

  describe('audit trail', () => {
    // Losing a membership is what silently stops someone's alerts, so the
    // audit row has to carry enough to reconstruct WHO stopped being notified
    // — the group name alone would not.
    it('records the destroyed membership when a group is deleted', async () => {
      const name = `E2E Audit ${Date.now()}`;
      const group = await makeGroup(name);
      await authPost(app, `/api/user-groups/${group.id}/members`, token, {
        userIds: [memberUserId],
      });
      await authDelete(app, `/api/user-groups/${group.id}`, token);

      const row = await prisma.auditTrail.findFirst({
        where: { action: 'USER_GROUP_DELETED', targetId: group.id },
        orderBy: { timestamp: 'desc' },
      });
      expect(row).not.toBeNull();
      const before = row!.beforeValue as any;
      expect(before.name).toBe(name);
      expect(before.memberCount).toBe(1);
      expect(before.memberUserIds).toContain(memberUserId);
    });

    it('audits member addition', async () => {
      const group = await makeGroup(`E2E AuditAdd ${Date.now()}`);
      await authPost(app, `/api/user-groups/${group.id}/members`, token, {
        userIds: [memberUserId],
      });
      const row = await prisma.auditTrail.findFirst({
        where: { action: 'USER_GROUP_MEMBERS_ADDED', targetId: group.id },
        orderBy: { timestamp: 'desc' },
      });
      expect(row).not.toBeNull();
      expect((row!.afterValue as any).requestedUserIds).toContain(memberUserId);
    });
  });

  describe('authentication', () => {
    it('rejects an unauthenticated list', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/user-groups' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an unauthenticated create', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/user-groups', payload: { name: 'nope' },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
