import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { offsetKeyTest } from '../instruments/load-offsets.js';
import {
  createInstrumentProfileSchema,
  updateInstrumentProfileSchema,
  parseInstrumentAttributeKeys,
  validateAttributeRemark,
} from '@digilog/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { logger } from '../../lib/logger.js';
import { resolveVisibility, withVisibility } from '../instruments/visibility.js';
import { loadAttributeAccess, refuseAttributeWrite } from '../instruments/attribute-access.js';
import { publishAttributeDownlink } from '../instruments/attribute-downlink.js';
import { announceChildAttributeChange } from '../instruments/child-attributes-bundle.js';

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
 * ONE exception since 2026-09-16 (operator: "when i removed attributes for
 * profile in configuration those are not removing for instruments"): a key
 * REMOVED from the list is also removed from every instrument in the profile
 * that carries it (case-folded, as every attribute surface matches). Each of
 * those deletions is its own §11 record — an INSTRUMENT_ATTRIBUTE_REMOVED row
 * per instrument with the value it held and the operator's remark — which is
 * why such a PUT REQUIRES a `reason` and is refused without one, naming what
 * would go. `GET /:id/attribute-usage` is how the page states that BEFORE the
 * save. A key nobody carries is dropped without ceremony. Adding a key still
 * back-fills nothing.
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

const fold = (k: string) => k.trim().toLowerCase();

/**
 * Which attribute keys the profile's instruments actually carry, folded by
 * case (the spelling shown is the PROFILE's own where the key is listed, else
 * the first recorded one), with the number of instruments carrying each.
 */
async function attributeUsage(profileId: string, listed: string[]): Promise<{ key: string; instruments: number }[]> {
  const rows = await prisma.instrumentAttribute.findMany({
    where: { instrument: { profileId } },
    select: { key: true, instrumentId: true },
    orderBy: [{ key: 'asc' }],
  });
  const byFold = new Map<string, { key: string; instruments: Set<string> }>();
  for (const r of rows) {
    const f = fold(r.key);
    const hit = byFold.get(f);
    if (hit) hit.instruments.add(r.instrumentId);
    else byFold.set(f, { key: listed.find((k) => fold(k) === f) ?? r.key, instruments: new Set([r.instrumentId]) });
  }
  return [...byFold.values()].map((u) => ({ key: u.key, instruments: u.instruments.size }));
}

/**
 * The broker side of a cascaded removal, AFTER the commit (the same rule as the
 * instruments module's `announceAttributeChange`): the instrument's retained
 * slot republished without the key, and its gateway's change event carrying
 * `null` for it. Never throws.
 */
async function announceRemoval(
  instrument: { id: string; code: string; gatewayId: string | null },
  key: string,
): Promise<void> {
  try {
    const rows = await prisma.instrumentAttribute.findMany({ where: { instrumentId: instrument.id }, select: { key: true, value: true } });
    const gateway = instrument.gatewayId
      ? await prisma.instrument.findUnique({ where: { id: instrument.gatewayId }, select: { code: true } })
      : null;
    const log = (msg: string, meta?: Record<string, unknown>) => logger.warn(`[downlink:profile-cascade] ${msg}`, meta ?? {});
    await publishAttributeDownlink({
      code: instrument.code, gatewayCode: gateway?.code ?? null,
      attributes: Object.fromEntries(rows.map((r) => [r.key, r.value])),
      changedKey: key, changedValue: null, ts: new Date(),
    }, log);
    if (instrument.gatewayId) {
      await announceChildAttributeChange(instrument.gatewayId, { code: instrument.code, key, value: null }, log);
    }
  } catch (e) {
    logger.warn('[downlink:profile-cascade] the device was NOT told about a removed attribute', {
      instrument: instrument.id, key, err: (e as Error).message,
    });
  }
}

/**
 * Shape a row for the wire. Both counts come from the SAME fetch — deriving
 * `activeCount` from a second query could disagree with `instrumentCount` if an
 * instrument were toggled between them, and a card showing "3 instruments, 4
 * active" is worse than a stale number.
 */
/**
 * Sensor-offset keys are SUPER_ADMIN-only (2026-10-01). To anyone else a
 * profile's key list simply does not contain them — the New Instrument form and
 * the bulk template then never ask for them.
 */
async function keysFor(req: FastifyRequest): Promise<(attributeKeys: string | null) => string | null> {
  if (req.user?.role === 'SUPER_ADMIN') return (k) => k;
  const isOffset = await offsetKeyTest();
  return (k) => (k === null ? null : parseInstrumentAttributeKeys(k).filter((key) => !isOffset(key)).join('\n'));
}

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
    const strip = await keysFor(req);
    return { data: rows.map((r) => { const p = present(r as ProfileRow); return { ...p, attributeKeys: strip(p.attributeKeys) }; }), total: rows.length };
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
    const p = present(row as ProfileRow);
    return { ...p, attributeKeys: (await keysFor(req))(p.attributeKeys) };
  });

  // GET /api/instrument-profiles/:id/attribute-usage — which keys the
  // profile's instruments carry, so the editor can say what a removal deletes.
  app.get('/:id/attribute-usage', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Which attribute keys the profile\'s instruments carry, with counts',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            keys: {
              type: 'array',
              items: { type: 'object', properties: { key: { type: 'string' }, instruments: { type: 'integer' } } },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const profile = await prisma.instrumentProfile.findUnique({ where: { id }, select: { attributeKeys: true } });
    if (!profile) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });
    const usage = await attributeUsage(id, parseInstrumentAttributeKeys(profile.attributeKeys));
    if (req.user?.role === 'SUPER_ADMIN') return { keys: usage };
    const isOffset = await offsetKeyTest();
    return { keys: usage.filter((u) => !isOffset(u.key)) };
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
    let attributeKeys = parsed.data.attributeKeys ?? '';
    // Only a super admin may list a sensor-offset key on a profile (2026-10-01).
    if (req.user?.role !== 'SUPER_ADMIN') {
      const isOffset = await offsetKeyTest();
      attributeKeys = parseInstrumentAttributeKeys(attributeKeys).filter((k) => !isOffset(k)).join('\n');
    }

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
          reason: { type: 'string', description: 'Required when a removed key is carried by instruments: recorded on each INSTRUMENT_ATTRIBUTE_REMOVED row.' },
        },
      },
      response: { 200: { type: 'object', properties: profileProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = updateInstrumentProfileSchema.safeParse(
      // Exempt for the same reason as POST — see the comment there. `reason`
      // is exempt like every free-text remark: `stripHtml` would blank
      // "value < 20 per SOP" into a §11 record.
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['attributeKeys', 'reason']),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const { reason, ...data } = parsed.data;

    const before = await prisma.instrumentProfile.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });
    // SENSOR OFFSETS (2026-10-01): a non-SUPER_ADMIN never SEES the offset keys
    // (they are stripped from every read), so the list they send never mentions
    // them. Taken literally that would REMOVE them — and removing a key from a
    // profile deletes it from every instrument of the profile. So for them the
    // stored offset keys are carried over unchanged, and any offset key they
    // send is dropped.
    if (req.user?.role !== 'SUPER_ADMIN' && typeof data.attributeKeys === 'string') {
      const isOffset = await offsetKeyTest();
      const kept = parseInstrumentAttributeKeys(before.attributeKeys).filter((k) => isOffset(k));
      data.attributeKeys = [...parseInstrumentAttributeKeys(data.attributeKeys).filter((k) => !isOffset(k)), ...kept].join('\n');
    }
    const ctx = buildContext(req);

    // Which listed keys this PUT DROPS, and which of those instruments carry.
    // `null` re-arms the default template and drops nothing.
    const keysBefore = parseInstrumentAttributeKeys(before.attributeKeys);
    const requested = typeof data.attributeKeys === 'string' ? parseInstrumentAttributeKeys(data.attributeKeys) : null;
    const removed = requested ? keysBefore.filter((k) => !requested.some((a) => fold(a) === fold(k))) : [];
    const affected = removed.length
      ? (await attributeUsage(id, keysBefore)).filter((u) => removed.some((k) => fold(k) === fold(u.key)))
      : [];
    if (affected.length > 0) {
      const problem = validateAttributeRemark(reason);
      if (problem) {
        return reply.code(400).send({
          error: 'REASON_REQUIRED',
          message: `Removing ${affected.map((a) => `"${a.key}"`).join(', ')} deletes the attribute on ${affected.reduce((n, a) => n + a.instruments, 0)} instrument(s). ${problem}`,
          affected,
        });
      }
    }

    try {
      // Scoped like the read routes: this response replaces the row on screen, and
      // an edit must not make the count jump to a number the list never shows.
      const { where: visibility } = await resolveVisibility(ctx);
      if (affected.length > 0) {
        // The cascade is an attribute DELETE on every instrument of the profile,
        // so it answers to the same two rules the direct delete answers to
        // (audit 2026-10-03, API-10): the role's Attribute Access rule per key
        // — a SELECTED-keys role that may not delete a limit on one instrument
        // must not remove it from all 101 via the profile — and the caller's
        // instrument scope: a key carried by an instrument the caller cannot
        // see is refused outright rather than half-removed.
        const access = await loadAttributeAccess(ctx.userRole);
        for (const a of affected) {
          const refusal = refuseAttributeWrite({ access, hasUpdatePermission: true, key: a.key, isNewKey: false, remark: reason as string | undefined });
          if (refusal) return reply.code(refusal.status).send(refusal.body);
        }
        const folds = new Set(affected.map((a) => fold(a.key)));
        const carrying = await prisma.instrumentAttribute.findMany({
          where: { instrument: { profileId: id } },
          select: { key: true, instrument: { select: { id: true } } },
        });
        const carryingIds = new Set(carrying.filter((r) => folds.has(fold(r.key))).map((r) => r.instrument.id));
        if (carryingIds.size > 0) {
          const visibleCount = await prisma.instrument.count({ where: withVisibility({ id: { in: [...carryingIds] } }, visibility) as never });
          if (visibleCount < carryingIds.size) {
            return reply.code(403).send({
              error: 'OUT_OF_SCOPE',
              message: 'Removing this key would delete attributes on instruments outside your instrument scope.',
            });
          }
        }
      }
      const deleted: { instrument: { id: string; code: string; gatewayId: string | null }; key: string }[] = [];
      const row = await prisma.$transaction(async (tx) => {
        const updated = await tx.instrumentProfile.update({
          where: { id },
          data: { ...data, updatedBy: ctx.userId },
          include: withInstruments(visibility),
        });
        if (affected.length > 0) {
          const folds = new Set(affected.map((a) => fold(a.key)));
          const rows = await tx.instrumentAttribute.findMany({
            where: { instrument: { profileId: id } },
            select: { instrumentId: true, key: true, value: true, instrument: { select: { code: true, gatewayId: true } } },
          });
          for (const r of rows) {
            if (!folds.has(fold(r.key))) continue;
            // The same per-attribute advisory lock the instruments module takes.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260807, hashtext(${`${r.instrumentId}:${r.key}`}))`;
            await tx.instrumentAttribute.delete({ where: { instrumentId_key: { instrumentId: r.instrumentId, key: r.key } } });
            // The removed VALUE is in `beforeValue`: once the row is gone this
            // audit record is the only place it survives.
            await auditLog({
              action: 'INSTRUMENT_ATTRIBUTE_REMOVED', targetType: 'Instrument', targetId: r.instrumentId,
              beforeValue: { code: r.instrument.code, attribute: r.key, value: r.value },
              reason: reason as string,
              signatureMeaning: `Attribute "${r.key}" removed from instrument "${r.instrument.code.length <= 80 ? r.instrument.code : `${r.instrument.code.slice(0, 80)}…`}" (key dropped from profile)`,
              userId: ctx.userId, userRole: ctx.userRole,
              ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
            }, tx as unknown as Prisma.TransactionClient);
            deleted.push({ instrument: { id: r.instrumentId, code: r.instrument.code, gatewayId: r.instrument.gatewayId }, key: r.key });
          }
        }
        return updated;
      });

      const keysAfter = parseInstrumentAttributeKeys(row.attributeKeys);
      // Compared as PARSED lists, so a whitespace-only edit that changes no key
      // does not claim the keys changed.
      const keysChanged = keysBefore.join('\n') !== keysAfter.join('\n');
      const cascadeNote = deleted.length > 0
        ? `; removed ${affected.map((a) => `"${a.key}"`).join(', ')} from ${new Set(deleted.map((d) => d.instrument.id)).size} instrument(s)`
        : '';

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
        // The cascade note is clamped so a long key list cannot overflow
        // signature_meaning's varchar(255) — `auditLog` does not truncate.
        signatureMeaning: (() => {
          const base = before.name !== row.name
            ? `Instrument profile renamed "${before.name}" → "${row.name}"`
            : keysChanged
              ? `Instrument profile "${row.name}" attribute keys changed (${keysBefore.length} → ${keysAfter.length})`
              : `Instrument profile "${row.name}" updated`;
          const full = base + cascadeNote;
          if (full.length <= 250) return full;
          const short = base + `; removed ${affected.length} key(s) from ${new Set(deleted.map((d) => d.instrument.id)).size} instrument(s)`;
          return short.length <= 250 ? short : short.slice(0, 249) + '…';
        })(),
        ...(deleted.length > 0 && reason ? { reason } : {}),
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      });

      // Committed. Now, and only now, tell each device — but AFTER this
      // response, not before it: a cascade can be hundreds of removals, and
      // the operator's save must not wait on the broker (2026-09-16: 400
      // removals against a down broker held the response ~27 minutes even
      // before the bridge learned to resolve on queue). The database is the
      // record; the announcements are best-effort and each one logs its own
      // failure.
      if (deleted.length > 0) {
        void (async () => {
          for (const d of deleted) await announceRemoval(d.instrument, d.key);
          logger.info('[downlink:profile-cascade] devices told', { profileId: id, removals: deleted.length });
        })();
      }

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
