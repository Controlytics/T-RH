import { type FastifyInstance } from 'fastify';
import {
  createInstrumentProfileSchema,
  updateInstrumentProfileSchema,
  parseInstrumentAttributeKeys,
} from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { resolveVisibility } from '../instruments/visibility.js';

/**
 * Instrument profiles — a named container for instruments.
 *
 * A profile carries ONE inherited setting: `attributeKeys`, the attribute keys
 * the New Instrument form asks for in this profile. Profiles inherit PROMPTS,
 * never VALUES — nothing is ever back-filled onto an instrument that already
 * exists, and moving an instrument between profiles changes only which keys are
 * suggested. See
 * `docs/superpowers/specs/2026-08-08-per-profile-instrument-attributes-design.md`.
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
  attributeKeys: { type: 'string', nullable: true },
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
  attributeKeys: string | null;
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

/**
 * The instruments a profile's counts are drawn from, NARROWED to what the caller
 * may see.
 *
 * `visibility` is the caller's resolved instrument scope, or undefined when they
 * are unrestricted. Passing it into the nested relation — rather than counting
 * everything — is the whole point: a profile card reading "101 instruments" to
 * someone scoped to four misdescribes what they have AND discloses how many exist
 * outside their scope. Same defect shape as an unscoped list, just expressed as a
 * number instead of rows.
 *
 * `where: undefined` is Prisma's no-filter, so the unrestricted caller's counts
 * are byte-for-byte what they were before.
 */
const withInstruments = (visibility?: object) => ({
  instruments: { where: visibility, select: { isActive: true } },
});

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
  }, async (req) => {
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const rows = await prisma.instrumentProfile.findMany({
      include: withInstruments(visibility),
      orderBy: { name: 'asc' },
    });
    // Every profile is still LISTED, including ones holding nothing the caller can
    // see. A profile is a device type, not an instrument: hiding the type would
    // make the New Instrument form's dropdown depend on who is looking.
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
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const row = await prisma.instrumentProfile.findUnique({
      where: { id }, include: withInstruments(visibility),
    });
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
          attributeKeys: { type: 'string' },
        },
      },
      response: { 201: { type: 'object', properties: profileProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const parsed = createInstrumentProfileSchema.safeParse(
      // `attributeKeys` is EXEMPT from HTML stripping so that the two write
      // paths for this same data agree. The dynamic-config PUT does not strip
      // (config.service.ts:87-93), and stripHtml DISCARDS tag-shaped content
      // rather than escaping it — so without this exemption a key like
      // "Temp <5C" would survive on the Configuration page and be silently
      // truncated to "Temp" here. Not a new exposure: the SPA escapes on
      // output, and this is the same value the config endpoint already stores
      // unstripped.
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['attributeKeys']),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const ctx = buildContext(req);

    // A new profile starts EMPTY — it asks for no attributes until an admin
    // adds them on Configuration → Instrument Attributes (2026-08-08 operator
    // decision, reversing the seed-from-the-global-template rule that shipped
    // earlier the same day). Seeding made every new profile open as an
    // identical copy of the last one, which reads as "the list is global" —
    // the exact confusion per-profile keys exist to remove. The cost is that
    // Block / Area / Location are not asked for until they are added; the
    // config page warns about that per profile.
    const attributeKeys = parsed.data.attributeKeys ?? '';

    try {
      // A profile that has just been created holds nothing, so there is no scope
      // question here — the empty argument keeps one shape for the helper.
      const row = await prisma.instrumentProfile.create({
        data: { ...parsed.data, attributeKeys, createdBy: ctx.userId },
        include: withInstruments(),
      });

      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'INSTRUMENT_PROFILE_CREATED',
        targetType: 'instrument_profile', targetId: row.id,
        afterValue: {
          name: row.name, description: row.description, isActive: row.isActive,
          attributeKeys: parseInstrumentAttributeKeys(row.attributeKeys),
        },
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
          attributeKeys: { type: ['string', 'null'] },
        },
      },
      response: { 200: { type: 'object', properties: profileProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = updateInstrumentProfileSchema.safeParse(
      // Exempt for the same reason as POST — see the comment there.
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['attributeKeys']),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    const before = await prisma.instrumentProfile.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });
    const ctx = buildContext(req);

    try {
      // Scoped like the read routes: this response replaces the row on screen, and
      // an edit must not make the count jump to a number the list never shows.
      const { where: visibility } = await resolveVisibility(ctx);
      const row = await prisma.instrumentProfile.update({
        where: { id },
        data: { ...parsed.data, updatedBy: ctx.userId },
        include: withInstruments(visibility),
      });

      const keysBefore = parseInstrumentAttributeKeys(before.attributeKeys);
      const keysAfter = parseInstrumentAttributeKeys(row.attributeKeys);
      // Compared as PARSED lists, so a whitespace-only edit that changes no key
      // does not claim the keys changed.
      const keysChanged = keysBefore.join('\n') !== keysAfter.join('\n');

      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'INSTRUMENT_PROFILE_UPDATED',
        targetType: 'instrument_profile', targetId: id,
        beforeValue: {
          name: before.name, description: before.description, isActive: before.isActive,
          attributeKeys: keysBefore,
        },
        afterValue: {
          name: row.name, description: row.description, isActive: row.isActive,
          attributeKeys: keysAfter,
        },
        // A rename is called out first: it changes what an inspector reads
        // against every instrument in the profile, so "updated" alone would
        // understate it. A key change is named next, with the counts, because it
        // changes what every future registration is asked. Both fit
        // audit_trail.signature_meaning's varchar(255): ~50 fixed characters
        // plus a name capped at 120.
        signatureMeaning: before.name !== row.name
          ? `Instrument profile renamed "${before.name}" → "${row.name}"`
          : keysChanged
            ? `Instrument profile "${row.name}" attribute keys changed (${keysBefore.length} → ${keysAfter.length})`
            : `Instrument profile "${row.name}" updated`,
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
    // DELIBERATELY UNSCOPED, unlike the read routes above. The guard exists to
    // explain the foreign key's refusal, and the FK counts every instrument
    // regardless of who is asking. A scoped count here would tell a restricted
    // admin the profile is empty and then hand them a raw FK error when they act
    // on it.
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
