/**
 * User Groups Routes — CRUD for user groups and membership management.
 */
import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { auditLog } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';

export default async function userGroupRoutes(app: FastifyInstance) {

  // GET /api/user-groups — list all groups with member count
  app.get('/', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: { tags: ['User Groups'], summary: 'List user groups' },
  }, async (req) => {
    const groups = await prisma.userGroup.findMany({
      include: { _count: { select: { members: true } } },
      orderBy: { name: 'asc' },
    });
    return groups.map(g => ({
      ...g,
      memberCount: g._count.members,
      _count: undefined,
    }));
  });

  // POST /api/user-groups — create group
  app.post('/', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['User Groups'],
      summary: 'Create user group',
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (req) => {
    const { name, description } = req.body as { name: string; description?: string };
    const ctx = buildContext(req);
    const group = await prisma.userGroup.create({
      data: { name, description, createdBy: ctx.userId },
    });
    await auditLog({ action: 'USER_GROUP_CREATED', targetType: 'UserGroup', targetId: group.id, afterValue: { name }, userId: ctx.userId, userRole: ctx.userRole });
    return group;
  });

  // PUT /api/user-groups/:id — update group
  app.put('/:id', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['User Groups'],
      summary: 'Update user group',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
          isActive: { type: 'boolean' },
        },
        // The handler does `data: body`, so any key the client sends reaches
        // Prisma. AJV's removeAdditional only strips unknown keys when the schema
        // declares this — without it createdBy/createdAt were writable and the
        // row's provenance could be rewritten.
        additionalProperties: false,
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const existing = await prisma.userGroup.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('User group not found');

    const group = await prisma.userGroup.update({ where: { id }, data: body as any });

    const ctx = buildContext(req);
    await auditLog({
      action: 'USER_GROUP_UPDATED', targetType: 'UserGroup', targetId: id,
      beforeValue: { name: existing.name, description: existing.description, isActive: existing.isActive },
      afterValue: { name: group.name, description: group.description, isActive: group.isActive },
      signatureMeaning: `User group "${group.name}" updated`,
      userId: ctx.userId, userRole: ctx.userRole,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return group;
  });

  // DELETE /api/user-groups/:id
  app.delete('/:id', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['User Groups'],
      summary: 'Delete user group',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.userGroup.findUnique({
      where: { id },
      include: { members: { select: { userId: true } } },
    });
    if (!existing) throw new NotFoundError('User group not found');

    // Physical delete (members cascade) — capture the membership, since losing it
    // is what silently stops those users' notifications.
    const ctx = buildContext(req);
    await prisma.$transaction(async (tx) => {
      await auditLog({
        action: 'USER_GROUP_DELETED', targetType: 'UserGroup', targetId: id,
        beforeValue: {
          name: existing.name, description: existing.description, isActive: existing.isActive,
          memberCount: existing.members.length,
          memberUserIds: existing.members.map((m) => m.userId),
        },
        signatureMeaning: `User group "${existing.name}" and its ${existing.members.length} membership(s) permanently deleted`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      await tx.userGroup.delete({ where: { id } });
    });
    return { success: true };
  });

  // GET /api/user-groups/:id/members — list group members
  app.get('/:id/members', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['User Groups'],
      summary: 'List group members',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const members = await prisma.userGroupMember.findMany({
      where: { groupId: id },
      orderBy: { createdAt: 'asc' },
    });
    // Fetch user details
    const userIds = members.map(m => m.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true, fullName: true, email: true, role: true, status: true },
    });
    const userMap = new Map(users.map(u => [u.id, u]));
    return members.map(m => ({
      id: m.id,
      userId: m.userId,
      createdAt: m.createdAt,
      user: userMap.get(m.userId) ?? null,
    }));
  });

  // POST /api/user-groups/:id/members — add users to group
  app.post('/:id/members', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['User Groups'],
      summary: 'Add users to group',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['userIds'],
        properties: { userIds: { type: 'array', items: { type: 'string' } } },
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const { userIds } = req.body as { userIds: string[] };
    const group = await prisma.userGroup.findUnique({ where: { id } });
    if (!group) throw new NotFoundError('User group not found');

    const data = userIds.map(userId => ({ groupId: id, userId }));
    const result = await prisma.userGroupMember.createMany({ data, skipDuplicates: true });

    // Membership resolves notification recipients (notification-dispatcher.ts),
    // so adding a member changes who gets alerted.
    const ctx = buildContext(req);
    await auditLog({
      action: 'USER_GROUP_MEMBERS_ADDED', targetType: 'UserGroup', targetId: id,
      afterValue: { groupName: group.name, requestedUserIds: userIds, addedCount: result.count },
      signatureMeaning: `${result.count} member(s) added to user group "${group.name}"`,
      userId: ctx.userId, userRole: ctx.userRole,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    // `added` reports rows actually inserted; skipDuplicates means a re-add of an
    // existing member is not a new row.
    return { success: true, added: result.count };
  });

  // DELETE /api/user-groups/:id/members/:userId — remove user from group
  app.delete('/:id/members/:userId', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['User Groups'],
      summary: 'Remove user from group',
      params: {
        type: 'object',
        properties: { id: { type: 'string' }, userId: { type: 'string' } },
        required: ['id', 'userId'],
      },
    },
  }, async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const group = await prisma.userGroup.findUnique({ where: { id } });
    if (!group) throw new NotFoundError('User group not found');

    // Removing a QA user from a group silently stops their alerts — audit-first
    // inside the tx so the removal can't commit unrecorded.
    const ctx = buildContext(req);
    await prisma.$transaction(async (tx) => {
      await auditLog({
        action: 'USER_GROUP_MEMBER_REMOVED', targetType: 'UserGroup', targetId: id,
        beforeValue: { groupName: group.name, userId },
        signatureMeaning: `Member removed from user group "${group.name}" — they no longer receive its notifications`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      await tx.userGroupMember.deleteMany({ where: { groupId: id, userId } });
    });
    return { success: true };
  });
}
