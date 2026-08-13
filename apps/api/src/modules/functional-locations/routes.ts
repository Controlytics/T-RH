import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { validateFlDraft, type FlType } from './validation.js';
import { buildTree, locationPath, resolveLocationIds, type FlNode } from './tree.js';

/**
 * Functional Locations — the authoritative Block > Area grouping of instruments.
 *
 * Reads gate on FUNCTIONAL_LOCATION_READ; writes on the matching CREATE / UPDATE /
 * DELETE permission WITH re-authentication, and every write is audited. Grouping
 * decides which instruments an operator is shown, so "who moved this instrument,
 * out of what, into what" has to be answerable.
 *
 * Design: docs/superpowers/specs/2026-08-13-functional-locations-design.md
 */

/**
 * Exempt from HTML stripping, mirroring floorplans/routes.ts. `sanitizeStrings`
 * strips anything tag-shaped — right for prose, wrong for an operator-chosen
 * identifier like `Module-E` that must round-trip byte-identical.
 */
const IDENTITY_FIELDS = ['name'];

const flProps = {
  id: { type: 'string' },
  name: { type: 'string' },
  type: { type: 'string' },
  parentId: { type: 'string', nullable: true },
  ownCount: { type: 'integer' },
  totalCount: { type: 'integer' },
} as const;

/** Recursive shape is declared one level deep, which is all the depth cap allows. */
const flTreeProps = {
  ...flProps,
  children: { type: 'array', items: { type: 'object', properties: flProps } },
} as const;

async function loadNodes(): Promise<FlNode[]> {
  const rows = await prisma.functionalLocation.findMany({
    select: { id: true, name: true, type: true, parentId: true },
  });
  return rows.map((r) => ({ ...r, type: r.type as FlType }));
}

/** location id → instruments linked DIRECTLY to it. */
async function loadOwnCounts(): Promise<Map<string, number>> {
  const grouped = await prisma.instrument.groupBy({
    by: ['functionalLocationId'],
    _count: { _all: true },
    where: { functionalLocationId: { not: null } },
  });
  return new Map(grouped.map((g) => [g.functionalLocationId as string, g._count._all]));
}

export default async function functionalLocationRoutes(app: FastifyInstance) {
  // GET / — the whole tree with counts.
  app.get('/', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_READ')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'The Block > Area tree with instrument counts',
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'object', properties: flTreeProps } } },
        },
        ...errorResponses,
      },
    },
  }, async () => {
    const [nodes, counts] = await Promise.all([loadNodes(), loadOwnCounts()]);
    return { data: buildTree(nodes, counts) };
  });

  // GET /linkable-instruments — EVERY instrument with its current location.
  //
  // Not unlinked-only: moving an instrument between locations is allowed and is
  // the documented behaviour, so an unlinked-only endpoint would make moving
  // impossible from the picker. The path is precomputed here rather than in the
  // browser so the two never disagree about how a location is named.
  app.get('/linkable-instruments', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_READ')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'Every instrument with its current functional location',
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  code: { type: 'string' },
                  name: { type: 'string' },
                  functionalLocationId: { type: 'string', nullable: true },
                  functionalLocationPath: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async () => {
    const [nodes, rows] = await Promise.all([
      loadNodes(),
      prisma.instrument.findMany({
        select: { id: true, code: true, name: true, functionalLocationId: true },
        orderBy: { code: 'asc' },
      }),
    ]);
    return {
      data: rows.map((r) => ({
        ...r,
        functionalLocationPath: locationPath(r.functionalLocationId, nodes),
      })),
    };
  });

  // GET /:id — one location, its children, and the instruments in its SCOPE.
  app.get('/:id', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_READ')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'One functional location with its children and instruments',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            ...flProps,
            children: { type: 'array', items: { type: 'object', properties: flProps } },
            instruments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  code: { type: 'string' },
                  name: { type: 'string' },
                  functionalLocationId: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [nodes, counts] = await Promise.all([loadNodes(), loadOwnCounts()]);
    const self = nodes.find((n) => n.id === id);
    if (!self) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Functional location not found.' });

    // resolveLocationIds, NOT `functionalLocationId: id` — a Block's instruments
    // are its own PLUS all its Areas'. Querying the id directly is the bug this
    // helper exists to prevent.
    const scope = resolveLocationIds(id, nodes);
    const instruments = await prisma.instrument.findMany({
      where: { functionalLocationId: { in: scope } },
      select: { id: true, code: true, name: true, functionalLocationId: true },
      orderBy: { code: 'asc' },
    });

    const children = nodes
      .filter((n) => n.parentId === id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ ...c, ownCount: counts.get(c.id) ?? 0, totalCount: counts.get(c.id) ?? 0 }));

    const ownCount = counts.get(id) ?? 0;
    return {
      ...self,
      ownCount,
      totalCount: ownCount + children.reduce((sum, c) => sum + c.totalCount, 0),
      children,
      instruments,
    };
  });

  // POST / — create.
  app.post('/', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_CREATE')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'Create a functional location',
      response: { 201: { type: 'object', properties: flProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('CREATE_FUNCTIONAL_LOCATION', req, reply);
    if (!ok) return;

    const ctx = buildContext(req);
    const body = sanitizeStrings((req.body ?? {}) as Record<string, unknown>, IDENTITY_FIELDS);
    const draft = {
      name: String(body.name ?? ''),
      type: (body.type === 'AREA' ? 'AREA' : 'BLOCK') as FlType,
      parentId: (body.parentId as string | null) ?? null,
    };

    const nodes = await loadNodes();
    const parent = draft.parentId ? nodes.find((n) => n.id === draft.parentId) ?? null : null;
    const siblings = nodes.filter((n) => (n.parentId ?? null) === draft.parentId).map((n) => n.name);

    const err = validateFlDraft(draft, parent, siblings);
    if (err) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: err.message, field: err.field });

    const created = await prisma.functionalLocation.create({
      data: {
        name: draft.name.trim(),
        type: draft.type,
        parentId: draft.parentId,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    });
    const path = locationPath(created.id, [...nodes, { ...created, type: created.type as FlType }]);
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'FUNCTIONAL_LOCATION_CREATED',
      targetType: 'functional_location', targetId: created.id,
      afterValue: { location: path, name: created.name, type: created.type, parentId: created.parentId },
      signatureMeaning: `Functional location "${path}" created`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return reply.code(201).send({ ...created, ownCount: 0, totalCount: 0 });
  });

  // PUT /:id — rename / re-parent.
  app.put('/:id', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_UPDATE')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'Rename or re-parent a functional location',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', properties: flProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FUNCTIONAL_LOCATION', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const ctx = buildContext(req);
    const body = sanitizeStrings((req.body ?? {}) as Record<string, unknown>, IDENTITY_FIELDS);

    const nodes = await loadNodes();
    const current = nodes.find((n) => n.id === id);
    if (!current) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Functional location not found.' });

    const draft = {
      name: body.name === undefined ? current.name : String(body.name),
      type: (body.type === undefined ? current.type : body.type === 'AREA' ? 'AREA' : 'BLOCK') as FlType,
      parentId: body.parentId === undefined ? current.parentId : ((body.parentId as string | null) ?? null),
    };
    const parent = draft.parentId ? nodes.find((n) => n.id === draft.parentId) ?? null : null;
    // SELF EXCLUDED from siblingNames. The validator cannot know its own current
    // name, so without this a rename that keeps the same name is rejected.
    const siblings = nodes
      .filter((n) => (n.parentId ?? null) === draft.parentId && n.id !== id)
      .map((n) => n.name);

    const err = validateFlDraft(draft, parent, siblings, id);
    if (err) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: err.message, field: err.field });

    // Demoting a BLOCK that still has Areas would orphan them.
    if (current.type === 'BLOCK' && draft.type === 'AREA') {
      const kids = nodes.filter((n) => n.parentId === id).length;
      if (kids > 0) {
        return reply.code(409).send({
          error: 'HAS_CHILDREN',
          message: `"${current.name}" has ${kids} area(s) and cannot become an Area itself. Move or delete them first.`,
        });
      }
    }

    const before = locationPath(id, nodes);
    const updated = await prisma.functionalLocation.update({
      where: { id },
      data: { name: draft.name.trim(), type: draft.type, parentId: draft.parentId, updatedBy: ctx.userId },
    });
    const after = locationPath(updated.id, (await loadNodes()));
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'FUNCTIONAL_LOCATION_UPDATED',
      targetType: 'functional_location', targetId: id,
      beforeValue: { location: before, name: current.name, type: current.type, parentId: current.parentId },
      afterValue: { location: after, name: updated.name, type: updated.type, parentId: updated.parentId },
      signatureMeaning: `Functional location "${before}" updated`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    const counts = await loadOwnCounts();
    return { ...updated, ownCount: counts.get(id) ?? 0, totalCount: counts.get(id) ?? 0 };
  });

  // DELETE /:id — refused while it holds anything.
  app.delete('/:id', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_DELETE')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'Delete a functional location',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: { 204: { type: 'null' }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('DELETE_FUNCTIONAL_LOCATION', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const ctx = buildContext(req);
    const nodes = await loadNodes();
    const current = nodes.find((n) => n.id === id);
    if (!current) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Functional location not found.' });

    // The FK is RESTRICT, so the database would refuse this anyway — but a
    // constraint error is not something an operator can act on. These 409s name
    // the counts so they know what to move.
    const [children, linked] = await Promise.all([
      prisma.functionalLocation.count({ where: { parentId: id } }),
      prisma.instrument.count({ where: { functionalLocationId: id } }),
    ]);
    if (children > 0 || linked > 0) {
      const parts = [
        linked > 0 ? `${linked} instrument(s)` : null,
        children > 0 ? `${children} area(s)` : null,
      ].filter(Boolean).join(' and ');
      return reply.code(409).send({
        error: 'NOT_EMPTY',
        message: `"${current.name}" still holds ${parts}. Move or unlink them before deleting it.`,
      });
    }

    const path = locationPath(id, nodes);
    await prisma.functionalLocation.delete({ where: { id } });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'FUNCTIONAL_LOCATION_DELETED',
      targetType: 'functional_location', targetId: id,
      beforeValue: { location: path, name: current.name, type: current.type, parentId: current.parentId },
      signatureMeaning: `Functional location "${path}" deleted`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return reply.code(204).send();
  });

  // PUT /:id/instruments — set membership wholesale.
  //
  // Mirrors PUT /api/floorplans/:id/rooms/:roomId/instruments so there is one way
  // to do this in the codebase. Linking an instrument that already belongs
  // elsewhere MOVES it; that is the documented behaviour, and the audit row
  // records both sides so the move is attributable.
  app.put('/:id/instruments', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_UPDATE')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'Set which instruments belong to this functional location',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: { instrumentIds: { type: 'array', items: { type: 'string' } } },
        required: ['instrumentIds'],
      },
      response: {
        200: {
          type: 'object',
          properties: { linked: { type: 'integer' }, unlinked: { type: 'integer' }, moved: { type: 'integer' } },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FUNCTIONAL_LOCATION', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const { instrumentIds } = req.body as { instrumentIds: string[] };
    const ctx = buildContext(req);

    const nodes = await loadNodes();
    const current = nodes.find((n) => n.id === id);
    if (!current) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Functional location not found.' });

    const wanted = [...new Set(instrumentIds)];
    const existing = await prisma.instrument.findMany({
      where: { OR: [{ functionalLocationId: id }, { id: { in: wanted } }] },
      select: { id: true, code: true, functionalLocationId: true },
    });

    const toLink = existing.filter((i) => wanted.includes(i.id) && i.functionalLocationId !== id);
    const toUnlink = existing.filter((i) => i.functionalLocationId === id && !wanted.includes(i.id));
    const moved = toLink.filter((i) => i.functionalLocationId !== null);

    await prisma.$transaction([
      ...(toLink.length
        ? [prisma.instrument.updateMany({ where: { id: { in: toLink.map((i) => i.id) } }, data: { functionalLocationId: id } })]
        : []),
      ...(toUnlink.length
        ? [prisma.instrument.updateMany({ where: { id: { in: toUnlink.map((i) => i.id) } }, data: { functionalLocationId: null } })]
        : []),
    ]);

    const path = locationPath(id, nodes);
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'FUNCTIONAL_LOCATION_INSTRUMENTS_CHANGED',
      targetType: 'functional_location', targetId: id,
      beforeValue: {
        location: path,
        linked: existing.filter((i) => i.functionalLocationId === id).map((i) => i.code),
      },
      afterValue: {
        location: path,
        linked: wanted.map((w) => existing.find((i) => i.id === w)?.code ?? w),
        movedFromElsewhere: moved.map((i) => i.code),
      },
      signatureMeaning: `Instruments linked to functional location "${path}" changed`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return { linked: toLink.length, unlinked: toUnlink.length, moved: moved.length };
  });
}
