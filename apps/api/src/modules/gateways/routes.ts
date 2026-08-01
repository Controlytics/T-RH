/**
 * Gateways — a parent device that fronts many child instruments.
 * P1 stores configuration only; payload fan-out arrives in P2 and resolves
 * against Instrument.deviceKey.
 */
import { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { stripHtml } from '../../lib/sanitize.js';
import { NotFoundError, ValidationError, ConflictError } from '../../lib/errors.js';
import { sanitizeSlug } from '../hierarchy/hierarchy.repository.js';

/** True for a Prisma foreign-key-violation error (P2003). */
function isFkViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
}

export default async function gatewayRoutes(app: FastifyInstance) {

  app.get('/', {
    preHandler: [app.requirePermission('GATEWAY_VIEW')],
    schema: { tags: ['Data Injection'], summary: 'List gateways' },
  }, async () => prisma.gateway.findMany({
    include: { hierarchyNode: { select: { name: true } }, _count: { select: { instruments: true } } },
    orderBy: { name: 'asc' },
  }));

  app.get('/:id/instruments', {
    preHandler: [app.requirePermission('GATEWAY_VIEW')],
    schema: {
      tags: ['Data Injection'], summary: 'List child instruments of a gateway',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return prisma.instrument.findMany({ where: { gatewayId: id }, orderBy: { name: 'asc' } });
  });

  app.post('/', {
    preHandler: [app.requirePermission('GATEWAY_CREATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Create gateway',
      body: {
        type: 'object', additionalProperties: false,
        required: ['name', 'code', 'gatewayType', 'externalId', 'hierarchyNodeId', 'communicationProfileId'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          code: { type: 'string', minLength: 1, maxLength: 50 },
          gatewayType: { type: 'string', minLength: 1, maxLength: 50 },
          externalId: { type: 'string', minLength: 1, maxLength: 100 },
          hierarchyNodeId: { type: 'string' },
          communicationProfileId: { type: 'string' },
          description: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('CREATE_GATEWAY', req, reply)).ok) return reply;
    const b = req.body as Record<string, string>;
    const ctx = buildContext(req);

    const [node, profile] = await Promise.all([
      prisma.hierarchyNode.findUnique({ where: { id: b.hierarchyNodeId } }),
      prisma.communicationProfile.findUnique({ where: { id: b.communicationProfileId } }),
    ]);
    if (!node) throw new ValidationError('hierarchyNodeId does not reference an existing hierarchy node.');
    if (!profile) throw new ValidationError('communicationProfileId does not reference an existing communication profile.');

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.gateway.create({
        data: {
          name: stripHtml(b.name), code: stripHtml(b.code), slug: sanitizeSlug(b.name),
          gatewayType: stripHtml(b.gatewayType), externalId: stripHtml(b.externalId),
          hierarchyNodeId: b.hierarchyNodeId, communicationProfileId: b.communicationProfileId,
          description: b.description ? stripHtml(b.description) : null,
          createdBy: ctx.userId,
        },
      });
      await auditLog({
        action: 'GATEWAY_CREATED', targetType: 'Gateway', targetId: row.id,
        afterValue: { name: row.name, code: row.code, externalId: row.externalId },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return created;
  });

  app.put('/:id', {
    preHandler: [app.requirePermission('GATEWAY_UPDATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Update gateway',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          gatewayType: { type: 'string', minLength: 1, maxLength: 50 },
          externalId: { type: 'string', minLength: 1, maxLength: 100 },
          communicationProfileId: { type: 'string' },
          description: { type: 'string', maxLength: 500 },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('UPDATE_GATEWAY', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const ctx = buildContext(req);

    const before = await prisma.gateway.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Gateway not found.');

    if (b.communicationProfileId !== undefined) {
      const profile = await prisma.communicationProfile.findUnique({
        where: { id: b.communicationProfileId as string },
      });
      if (!profile) throw new ValidationError('communicationProfileId does not reference an existing communication profile.');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.gateway.update({
        where: { id },
        data: {
          // slug is re-derived on rename because UNS topics are built from it.
          ...(b.name !== undefined && { name: stripHtml(b.name as string), slug: sanitizeSlug(b.name as string) }),
          ...(b.gatewayType !== undefined && { gatewayType: stripHtml(b.gatewayType as string) }),
          ...(b.externalId !== undefined && { externalId: stripHtml(b.externalId as string) }),
          ...(b.communicationProfileId !== undefined && { communicationProfileId: b.communicationProfileId as string }),
          ...(b.description !== undefined && { description: stripHtml(b.description as string) }),
          ...(b.isActive !== undefined && { isActive: b.isActive as boolean }),
        },
      });
      await auditLog({
        action: 'GATEWAY_UPDATED', targetType: 'Gateway', targetId: id,
        beforeValue: { name: before.name, slug: before.slug, externalId: before.externalId, isActive: before.isActive },
        afterValue: { name: row.name, slug: row.slug, externalId: row.externalId, isActive: row.isActive },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return updated;
  });

  app.delete('/:id', {
    preHandler: [app.requirePermission('GATEWAY_DELETE')],
    schema: {
      tags: ['Data Injection'], summary: 'Delete gateway',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('DELETE_GATEWAY', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);

    const before = await prisma.gateway.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Gateway not found.');

    // Instrument.gatewayId → gateways is onDelete: Restrict. Count is
    // re-checked INSIDE the same transaction as the delete (closing the
    // TOCTOU window as far as Postgres's transaction isolation allows), AND
    // a P2003 catch backstops whatever race the re-check still can't close —
    // mirrors communication-profiles/routes.ts's delete guard (Task 7).
    try {
      await prisma.$transaction(async (tx) => {
        const instrumentCount = await tx.instrument.count({ where: { gatewayId: id } });
        if (instrumentCount > 0) {
          throw new ConflictError(
            `Cannot delete gateway '${before.name}': ${instrumentCount} instrument(s) still attached. Reassign or delete them first.`,
            'GATEWAY_IN_USE',
          );
        }

        await tx.gateway.delete({ where: { id } });
        await auditLog({
          action: 'GATEWAY_DELETED', targetType: 'Gateway', targetId: id,
          beforeValue: { name: before.name, code: before.code },
          userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      });
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      if (isFkViolation(err)) {
        throw new ConflictError(
          `Cannot delete gateway '${before.name}': instrument(s) still attached.`,
          'GATEWAY_IN_USE',
        );
      }
      throw err;
    }
    return { success: true };
  });
}
