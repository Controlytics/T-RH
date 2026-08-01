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
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { stripHtml } from '../../lib/sanitize.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import {
  createNode, listTree, moveNode, renameNode, sanitizeSlug, isRawUniqueViolation,
  type HierarchyLevel,
} from './hierarchy.repository.js';

const LEVELS = ['COMPANY', 'SITE', 'PLANT', 'BUILDING', 'BLOCK', 'AREA', 'LINE'] as const;

/**
 * True for a Prisma foreign-key-violation error (P2003) raised by the typed
 * client's `tx.hierarchyNode.delete(...)` call — mirrors the same helper in
 * gateways/routes.ts and communication-profiles/routes.ts (finding I2).
 */
function isFkViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
}

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
    const parentId = body.parentId ?? null;
    const cleanName = stripHtml(body.name);
    const slug = sanitizeSlug(cleanName);

    try {
      const node = await prisma.$transaction(async (tx) => {
        const created = await createNode({
          parentId,
          level: body.level,
          name: cleanName,
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
    } catch (err) {
      // See isRawUniqueViolation's doc comment (finding I1) — createNode's
      // INSERT goes through $queryRaw, so a slug collision raises P2010, not
      // the P2002 the global handler in app.ts already maps to 409.
      if (isRawUniqueViolation(err)) {
        throw new ConflictError(
          parentId
            ? `Cannot create node: a sibling with slug '${slug}' already exists under this parent.`
            : `Cannot create node: a root-level node with slug '${slug}' already exists.`,
          'HIERARCHY_SLUG_CONFLICT',
        );
      }
      throw err;
    }
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
    const newSlug = sanitizeSlug(cleanName);
    try {
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
    } catch (err) {
      // renameNode's UPDATE goes through $executeRaw — see isRawUniqueViolation.
      if (isRawUniqueViolation(err)) {
        throw new ConflictError(
          before.parentId
            ? `Cannot rename to '${cleanName}': a sibling with slug '${newSlug}' already exists under this parent.`
            : `Cannot rename to '${cleanName}': a root-level node with slug '${newSlug}' already exists.`,
          'HIERARCHY_SLUG_CONFLICT',
        );
      }
      throw err;
    }
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

    try {
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
    } catch (err) {
      // moveNode's UPDATE goes through $executeRaw — see isRawUniqueViolation.
      // The collision here is against the TARGET parent's existing children,
      // since the node keeps its own slug (its leaf label) across a move.
      if (isRawUniqueViolation(err)) {
        throw new ConflictError(
          `Cannot move '${before.name}': the target parent already has a node with slug '${before.slug}'.`,
          'HIERARCHY_SLUG_CONFLICT',
        );
      }
      throw err;
    }
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

    const before = await prisma.hierarchyNode.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Hierarchy node not found.');

    // Dependent count is re-checked INSIDE the same transaction as the
    // delete (closing the TOCTOU window as far as Postgres's transaction
    // isolation allows), AND a P2003 catch backstops whatever race the
    // re-check still can't close — mirrors gateways/routes.ts and
    // communication-profiles/routes.ts's delete guards (finding I2: this
    // handler previously counted OUTSIDE the transaction and threw a plain
    // 400 ValidationError with no P2003 backstop, a different contract than
    // every sibling module for the same "still in use" user action).
    try {
      await prisma.$transaction(async (tx) => {
        const { children, gateways, instruments } = await tx.hierarchyNode.findUniqueOrThrow({
          where: { id },
          select: { _count: { select: { children: true, gateways: true, instruments: true } } },
        }).then(r => r._count);
        if (children || gateways || instruments) {
          throw new ConflictError(
            `Cannot delete '${before.name}': ${children} child node(s), ${gateways} gateway(s) and ${instruments} instrument(s) still attached.`,
            'HIERARCHY_NODE_IN_USE',
          );
        }

        await tx.hierarchyNode.delete({ where: { id } });
        await auditLog({
          action: 'HIERARCHY_NODE_DELETED', targetType: 'HierarchyNode', targetId: id,
          beforeValue: { name: before.name, level: before.level },
          userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      });
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      if (isFkViolation(err)) {
        throw new ConflictError(
          `Cannot delete '${before.name}': dependent record(s) still attached.`,
          'HIERARCHY_NODE_IN_USE',
        );
      }
      throw err;
    }
    return { success: true };
  });
}
