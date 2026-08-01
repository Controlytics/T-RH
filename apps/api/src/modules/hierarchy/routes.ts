/**
 * Hierarchy routes — the location tree (Company→Line) that backs UNS paths.
 * All ltree access is delegated to hierarchy.repository.ts.
 *
 * Every mutation (create/rename/move/delete) writes its audit row inside the
 * SAME `prisma.$transaction` as the underlying change — see hierarchy.repository.ts's
 * `moveNode`/`renameNode` doc comments for how the transaction client is threaded
 * through without nesting `$transaction` calls. If the audit insert fails, the
 * whole mutation rolls back rather than leaving an unaudited change to a
 * regulated record (21 CFR §11.10(e)).
 */
import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { stripHtml } from '../../lib/sanitize.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import {
  createNode, listTree, moveNode, renameNode, type HierarchyLevel,
} from './hierarchy.repository.js';

const LEVELS = ['COMPANY', 'SITE', 'PLANT', 'BUILDING', 'BLOCK', 'AREA', 'LINE'] as const;

export default async function hierarchyRoutes(app: FastifyInstance) {

  app.get('/', {
    preHandler: [app.requirePermission('HIERARCHY_VIEW')],
    schema: { tags: ['Data Injection'], summary: 'List hierarchy nodes (flat, path-ordered)' },
  }, async () => listTree());

  app.post('/', {
    preHandler: [app.requirePermission('HIERARCHY_CREATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Create hierarchy node',
      body: {
        type: 'object', required: ['level', 'name'], additionalProperties: false,
        properties: {
          parentId: { type: ['string', 'null'] },
          level: { type: 'string', enum: [...LEVELS] },
          name: { type: 'string', minLength: 1, maxLength: 100 },
          sortOrder: { type: 'integer' },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('CREATE_HIERARCHY_NODE', req, reply)).ok) return reply;
    const body = req.body as { parentId?: string | null; level: HierarchyLevel; name: string; sortOrder?: number };
    const ctx = buildContext(req);

    const node = await prisma.$transaction(async (tx) => {
      const created = await createNode({
        parentId: body.parentId ?? null,
        level: body.level,
        name: stripHtml(body.name),
        sortOrder: body.sortOrder,
        createdBy: ctx.userId,
      }, tx);
      await auditLog({
        action: 'HIERARCHY_NODE_CREATED', targetType: 'HierarchyNode', targetId: created.id,
        afterValue: { name: created.name, level: created.level, path: created.path },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return created;
    });
    return node;
  });

  app.put('/:id', {
    preHandler: [app.requirePermission('HIERARCHY_UPDATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Rename hierarchy node',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', required: ['name'], additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('UPDATE_HIERARCHY_NODE', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const { name } = req.body as { name: string };
    const ctx = buildContext(req);

    const before = await prisma.hierarchyNode.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Hierarchy node not found.');

    const cleanName = stripHtml(name);
    await prisma.$transaction(async (tx) => {
      await renameNode(id, cleanName, tx);
      await auditLog({
        action: 'HIERARCHY_NODE_UPDATED', targetType: 'HierarchyNode', targetId: id,
        beforeValue: { name: before.name, slug: before.slug },
        afterValue: { name: cleanName },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    return { success: true };
  });

  app.post('/:id/move', {
    preHandler: [app.requirePermission('HIERARCHY_UPDATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Reparent a hierarchy node and its subtree',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', required: ['newParentId'], additionalProperties: false,
        properties: { newParentId: { type: ['string', 'null'] } },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('UPDATE_HIERARCHY_NODE', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const { newParentId } = req.body as { newParentId: string | null };
    const ctx = buildContext(req);

    const before = await prisma.hierarchyNode.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Hierarchy node not found.');

    await prisma.$transaction(async (tx) => {
      await moveNode(id, newParentId, tx);
      await auditLog({
        action: 'HIERARCHY_NODE_MOVED', targetType: 'HierarchyNode', targetId: id,
        beforeValue: { parentId: before.parentId },
        afterValue: { parentId: newParentId },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    return { success: true };
  });

  app.delete('/:id', {
    preHandler: [app.requirePermission('HIERARCHY_DELETE')],
    schema: {
      tags: ['Data Injection'], summary: 'Delete a leaf hierarchy node',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('DELETE_HIERARCHY_NODE', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);

    const before = await prisma.hierarchyNode.findUnique({
      where: { id },
      include: { _count: { select: { children: true, gateways: true, instruments: true } } },
    });
    if (!before) throw new NotFoundError('Hierarchy node not found.');
    const { children, gateways, instruments } = before._count;
    if (children || gateways || instruments) {
      throw new ValidationError(
        `Cannot delete: node still has ${children} child node(s), ${gateways} gateway(s) and ${instruments} instrument(s).`,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.hierarchyNode.delete({ where: { id } });
      await auditLog({
        action: 'HIERARCHY_NODE_DELETED', targetType: 'HierarchyNode', targetId: id,
        beforeValue: { name: before.name, level: before.level },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    return { success: true };
  });
}
