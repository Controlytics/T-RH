import { type FastifyInstance } from 'fastify';
import { createInstrumentProfileSchema, updateInstrumentProfileSchema } from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { errorResponses } from '../../lib/error-schemas.js';

/**
 * Instrument profiles — a named container for instruments.
 *
 * GROUPING ONLY. A profile carries no settings and instruments inherit nothing
 * from it; see `docs/superpowers/specs/2026-08-08-instrument-profiles-design.md`
 * for why inheritance was left out.
 *
 * PERMISSIONS reuse `INSTRUMENT_*` deliberately. A profile is not a capability
 * boundary of its own — anyone who may register an instrument may create the
 * folder it sits in — and dedicated constants would pull in the PERMISSION_TREE
 * frozen-snapshot test plus three documented counts for no access-control gain.
 */

const profileProps = {
  id: { type: 'string' },
  name: { type: 'string' },
  description: { type: 'string', nullable: true },
  isActive: { type: 'boolean' },
  instrumentCount: { type: 'integer' },
  activeCount: { type: 'integer' },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
  createdBy: { type: 'string', nullable: true },
};

type ProfileRow = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  instruments?: { isActive: boolean }[];
};

/**
 * Shape a row for the wire. Both counts come from the SAME fetch — deriving
 * `activeCount` from a second query could disagree with `instrumentCount` if an
 * instrument were toggled between them, and a card showing "3 instruments, 4
 * active" is worse than a stale number.
 */
function present(row: ProfileRow) {
  const instruments = row.instruments ?? [];
  const { instruments: _omit, ...rest } = row;
  return {
    ...rest,
    instrumentCount: instruments.length,
    activeCount: instruments.filter((i) => i.isActive).length,
  };
}

const withInstruments = { instruments: { select: { isActive: true } } };

/** Prisma's unique-constraint violation — here, only `name` is unique. */
function isDuplicateName(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

export default async function instrumentProfileRoutes(app: FastifyInstance) {
  // GET /api/instrument-profiles
  app.get('/', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'List instrument profiles',
      description: 'Every profile with its instrument count and how many of those are active.',
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object', properties: profileProps } },
            total: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async () => {
    const rows = await prisma.instrumentProfile.findMany({
      include: withInstruments,
      orderBy: { name: 'asc' },
    });
    return { data: rows.map((r) => present(r as ProfileRow)), total: rows.length };
  });

  // GET /api/instrument-profiles/:id
  app.get('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Get an instrument profile',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', properties: profileProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.instrumentProfile.findUnique({ where: { id }, include: withInstruments });
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });
    return present(row as ProfileRow);
  });

  // POST /api/instrument-profiles
  app.post('/', {
    preHandler: [app.requirePermission('INSTRUMENT_CREATE')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Create an instrument profile',
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
      response: { 201: { type: 'object', properties: profileProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const parsed = createInstrumentProfileSchema.safeParse(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, []),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const ctx = buildContext(req);

    try {
      const row = await prisma.instrumentProfile.create({
        data: { ...parsed.data, createdBy: ctx.userId },
        include: withInstruments,
      });

      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'INSTRUMENT_PROFILE_CREATED',
        targetType: 'instrument_profile', targetId: row.id,
        afterValue: { name: row.name, description: row.description, isActive: row.isActive },
        signatureMeaning: `Instrument profile "${row.name}" created`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      });

      return reply.code(201).send(present(row as ProfileRow));
    } catch (err) {
      // Caught rather than pre-checked: a SELECT-then-INSERT has a race that the
      // unique index closes anyway, so the index is the authority and this
      // merely translates it into an answer the operator can act on.
      if (isDuplicateName(err)) {
        return reply.code(409).send({
          error: 'DUPLICATE_NAME',
          message: `A profile named "${parsed.data.name}" already exists.`,
        });
      }
      throw err;
    }
  });

  // PUT /api/instrument-profiles/:id
  app.put('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Update an instrument profile',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
          isActive: { type: 'boolean' },
        },
      },
      response: { 200: { type: 'object', properties: profileProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = updateInstrumentProfileSchema.safeParse(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, []),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    const before = await prisma.instrumentProfile.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });
    const ctx = buildContext(req);

    try {
      const row = await prisma.instrumentProfile.update({
        where: { id },
        data: { ...parsed.data, updatedBy: ctx.userId },
        include: withInstruments,
      });

      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'INSTRUMENT_PROFILE_UPDATED',
        targetType: 'instrument_profile', targetId: id,
        beforeValue: { name: before.name, description: before.description, isActive: before.isActive },
        afterValue: { name: row.name, description: row.description, isActive: row.isActive },
        // A rename is called out explicitly: it changes what an inspector reads
        // against every instrument in the profile, so "updated" alone would
        // understate it.
        signatureMeaning: before.name === row.name
          ? `Instrument profile "${row.name}" updated`
          : `Instrument profile renamed "${before.name}" → "${row.name}"`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      });

      return present(row as ProfileRow);
    } catch (err) {
      if (isDuplicateName(err)) {
        return reply.code(409).send({
          error: 'DUPLICATE_NAME',
          message: `A profile named "${parsed.data.name}" already exists.`,
        });
      }
      throw err;
    }
  });

  // DELETE /api/instrument-profiles/:id
  app.delete('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_DELETE')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Delete an instrument profile',
      description: 'Refused while the profile still contains instruments.',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.instrumentProfile.findUnique({
      where: { id },
      include: { _count: { select: { instruments: true } } },
    });
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });

    // Checked here so the operator gets a COUNT and a next step. The foreign key
    // (ON DELETE RESTRICT) refuses it regardless — this check exists for the
    // message, not for the safety.
    if (row._count.instruments > 0) {
      const n = row._count.instruments;
      return reply.code(409).send({
        error: 'PROFILE_NOT_EMPTY',
        message: `"${row.name}" still contains ${n} instrument${n === 1 ? '' : 's'}. `
          + 'Move or delete them before deleting the profile.',
      });
    }

    const ctx = buildContext(req);
    await prisma.instrumentProfile.delete({ where: { id } });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'INSTRUMENT_PROFILE_DELETED',
      targetType: 'instrument_profile', targetId: id,
      beforeValue: { name: row.name, description: row.description, isActive: row.isActive },
      signatureMeaning: `Instrument profile "${row.name}" deleted`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return { success: true };
  });
}
