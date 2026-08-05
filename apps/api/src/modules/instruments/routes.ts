import { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  createInstrumentSchema,
  updateInstrumentSchema,
  instrumentQuerySchema,
  bulkCreateInstrumentsSchema,
} from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { generateToken, hashToken, tokenPrefix } from './token.js';
import { parseInstrumentCsv, type InstrumentDraft } from './bulk-csv.js';
import { invalidateIngestAuthCache } from './ingest-auth.js';

/**
 * Registry (operator-facing, JWT + permission gated). The device-facing ingest
 * endpoint lives in `ingest-routes.ts` and is deliberately a separate file:
 * that one is on the auth-hook allowlist and reachable from the network without
 * a login, this one is not. Keeping them apart makes it obvious in review which
 * file is internet-facing.
 */

/**
 * Shape returned to the UI. The token itself is NEVER in here — only the
 * non-secret prefix, so an operator can tell which credential a device is
 * holding without the value being retrievable (design spec D5).
 */
const instrumentProps = {
  id: { type: 'string' },
  name: { type: 'string' },
  code: { type: 'string' },
  transport: { type: 'string' },
  isActive: { type: 'boolean' },
  instrumentType: { type: 'string', nullable: true },
  manufacturer: { type: 'string', nullable: true },
  model: { type: 'string', nullable: true },
  serialNumber: { type: 'string', nullable: true },
  description: { type: 'string', nullable: true },
  expectedIntervalSec: { type: 'integer', nullable: true },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
  createdBy: { type: 'string', nullable: true },
  tokenPrefix: { type: 'string', nullable: true },
  /** Last time this instrument's token successfully authenticated — "is it talking?" */
  lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
} as const;

type CredentialRow = { tokenPrefix: string; lastUsedAt: Date | null };
type InstrumentRow = Record<string, unknown> & { credentials?: CredentialRow[] };

/** Flatten the active credential onto the instrument; never leak `tokenHash`. */
function present(row: InstrumentRow) {
  const { credentials, ...rest } = row;
  const active = credentials?.[0];
  return { ...rest, tokenPrefix: active?.tokenPrefix ?? null, lastSeenAt: active?.lastUsedAt ?? null };
}

const activeCredential = {
  where: { revokedAt: null },
  select: { tokenPrefix: true, lastUsedAt: true },
  orderBy: { createdAt: 'desc' },
  take: 1,
} as const;

/**
 * Create an instrument and its first credential in ONE transaction, with the
 * audit row joined to that same transaction (§11.10(e) — a rollback must take
 * the audit row with it). Returns the plaintext token, which is the only moment
 * it is knowable.
 */
async function createWithCredential(
  draft: Record<string, unknown>,
  ctx: ReturnType<typeof buildContext>,
): Promise<{ id: string; code: string; name: string; token: string }> {
  const token = generateToken();
  return prisma.$transaction(async (tx) => {
    const instrument = await tx.instrument.create({
      data: { ...draft, createdBy: ctx.userId } as unknown as Prisma.InstrumentCreateInput,
    });
    await tx.instrumentCredential.create({
      data: { instrumentId: instrument.id, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) },
    });
    await auditLog({
      action: 'INSTRUMENT_CREATED', targetType: 'Instrument', targetId: instrument.id,
      afterValue: { name: instrument.name, code: instrument.code, transport: instrument.transport },
      signatureMeaning: `Instrument "${instrument.code}" registered and access token issued`,
      userId: ctx.userId, userRole: ctx.userRole,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    }, tx);
    return { id: instrument.id, code: instrument.code, name: instrument.name, token };
  });
}

/** Postgres unique-violation on `instruments.code`. */
function isDuplicateCode(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export default async function instrumentRoutes(app: FastifyInstance) {
  // GET /api/instruments — paginated list
  app.get('/', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'List instruments',
      description: 'Paginated instrument registry with search and transport/status filters.',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer' },
          transport: { type: 'string' },
          isActive: { type: 'string', enum: ['true', 'false'] },
          search: { type: 'string', description: 'Matches name, code or serial number' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object', properties: instrumentProps } },
            total: { type: 'integer' }, page: { type: 'integer' },
            limit: { type: 'integer' }, totalPages: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const parsed = instrumentQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const { page, limit, search, transport, isActive } = parsed.data;

    const where: Prisma.InstrumentWhereInput = {
      ...(transport ? { transport } : {}),
      ...(isActive !== undefined ? { isActive: isActive === 'true' } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { code: { contains: search, mode: 'insensitive' as const } },
              { serialNumber: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.instrument.findMany({
        where,
        include: { credentials: activeCredential },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.instrument.count({ where }),
    ]);

    return {
      data: rows.map((r) => present(r as unknown as InstrumentRow)),
      total, page, limit, totalPages: Math.ceil(total / limit) || 1,
    };
  });

  // GET /api/instruments/:id — detail
  app.get('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Get instrument by ID',
      description: 'Full instrument detail. The access token is never returned — only its prefix.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', properties: instrumentProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.instrument.findUnique({ where: { id }, include: { credentials: activeCredential } });
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });
    return present(row as unknown as InstrumentRow);
  });

  // POST /api/instruments — create one instrument + its credential
  app.post('/', {
    preHandler: [app.requirePermission('INSTRUMENT_CREATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Create instrument',
      description: 'Creates an instrument and issues its access token. The token is returned ONCE and cannot be retrieved later.',
      body: {
        type: 'object',
        required: ['name', 'code', 'transport'],
        properties: {
          name: { type: 'string' }, code: { type: 'string' },
          transport: { type: 'string', description: 'http|https|mqtt|mqtts|websocket|wss|tcp' },
          isActive: { type: 'boolean' },
          instrumentType: { type: 'string' }, manufacturer: { type: 'string' },
          model: { type: 'string' }, serialNumber: { type: 'string' },
          description: { type: 'string' },
          expectedIntervalSec: { type: ['integer', 'null'] },
        },
      },
      response: {
        // `token` appears HERE and in no other response schema — Fastify strips
        // unlisted properties, so the write-once rule is enforced by
        // serialization rather than by remembering to omit it on every read.
        201: { type: 'object', properties: { ...instrumentProps, token: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const parsed = createInstrumentSchema.safeParse(sanitizeStrings((req.body ?? {}) as Record<string, unknown>));
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    try {
      const { id, token } = await createWithCredential(parsed.data as Record<string, unknown>, buildContext(req));
      const row = await prisma.instrument.findUnique({ where: { id }, include: { credentials: activeCredential } });
      return reply.code(201).send({ ...present(row as unknown as InstrumentRow), token });
    } catch (err) {
      if (isDuplicateCode(err)) {
        return reply.code(409).send({ error: 'DUPLICATE_CODE', message: `An instrument with code "${parsed.data.code}" already exists.` });
      }
      throw err;
    }
  });

  // POST /api/instruments/bulk — CSV, partial success
  app.post('/bulk', {
    preHandler: [app.requirePermission('INSTRUMENT_CREATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Bulk-create instruments from CSV',
      description: 'Per-row validation with partial success: valid rows are created, invalid rows are reported with their source row number. The response carries one plaintext token per created instrument — it is a live credential file.',
      body: { type: 'object', required: ['csv'], properties: { csv: { type: 'string' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            created: {
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' }, token: { type: 'string' } } },
            },
            errors: {
              type: 'array',
              items: { type: 'object', properties: { row: { type: 'integer' }, message: { type: 'string' } } },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const parsed = bulkCreateInstrumentsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    const { rows, rowNumbers, errors } = parseInstrumentCsv(parsed.data.csv);
    const ctx = buildContext(req);
    const created: { id: string; code: string; name: string; token: string }[] = [];
    // Rows are created one transaction at a time, not one big one: a code that
    // collides with an EXISTING instrument (the realistic case — a re-uploaded
    // file) must become an error row, not roll back the other 199. The parser's
    // own `seen` set only catches duplicates within the file.
    for (let i = 0; i < rows.length; i++) {
      const draft: InstrumentDraft = rows[i];
      try {
        created.push(await createWithCredential(sanitizeStrings(draft as unknown as Record<string, unknown>), ctx));
      } catch (err) {
        if (isDuplicateCode(err)) {
          errors.push({ row: rowNumbers[i], message: `code "${draft.code}" already exists` });
          continue;
        }
        throw err;
      }
    }

    // Parse errors and collision errors are interleaved by source row so the
    // operator reads one ascending list against their spreadsheet.
    errors.sort((a, b) => a.row - b.row);

    return { created, errors };
  });

  // PUT /api/instruments/:id — update
  app.put('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Update instrument',
      description: 'Update instrument metadata. `code` is immutable — it is baked into MQTT topics and into the device configuration.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' }, transport: { type: 'string' }, isActive: { type: 'boolean' },
          instrumentType: { type: ['string', 'null'] }, manufacturer: { type: ['string', 'null'] },
          model: { type: ['string', 'null'] }, serialNumber: { type: ['string', 'null'] },
          description: { type: ['string', 'null'] }, expectedIntervalSec: { type: ['integer', 'null'] },
        },
      },
      response: { 200: { type: 'object', properties: instrumentProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = updateInstrumentSchema.safeParse(sanitizeStrings((req.body ?? {}) as Record<string, unknown>));
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    const existing = await prisma.instrument.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const ctx = buildContext(req);
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.instrument.update({ where: { id }, data: parsed.data as never });
      await auditLog({
        action: 'INSTRUMENT_UPDATED', targetType: 'Instrument', targetId: id,
        beforeValue: { name: existing.name, transport: existing.transport, isActive: existing.isActive, expectedIntervalSec: existing.expectedIntervalSec },
        afterValue: { name: row.name, transport: row.transport, isActive: row.isActive, expectedIntervalSec: row.expectedIntervalSec },
        signatureMeaning: `Instrument "${row.code}" updated`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });

    // Deactivating an instrument must stop its ingest NOW, not in up to 10s:
    // resolveInstrumentByToken caches the resolved identity, and `isActive` is
    // read at resolution time.
    invalidateIngestAuthCache(id);

    const row = await prisma.instrument.findUnique({ where: { id }, include: { credentials: activeCredential } });
    return present((row ?? updated) as unknown as InstrumentRow);
  });

  // DELETE /api/instruments/:id — cascades the credential rows
  app.delete('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_DELETE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Delete instrument',
      description: 'Permanently delete an instrument and its credentials. Telemetry already written is retained.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.instrument.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const ctx = buildContext(req);
    await prisma.$transaction(async (tx) => {
      await tx.instrument.delete({ where: { id } });
      await auditLog({
        action: 'INSTRUMENT_DELETED', targetType: 'Instrument', targetId: id,
        beforeValue: { name: existing.name, code: existing.code, transport: existing.transport },
        signatureMeaning: `Instrument "${existing.code}" deleted`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });

    invalidateIngestAuthCache(id);
    return { success: true };
  });

  // POST /api/instruments/:id/regenerate-token
  app.post('/:id/regenerate-token', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Regenerate instrument access token',
      description: 'Revokes the current credential and issues a new one. The device stops authenticating until it is reconfigured. The new token is shown once.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: { type: 'object', properties: { token: { type: 'string' }, tokenPrefix: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('REGENERATE_INSTRUMENT_TOKEN', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const existing = await prisma.instrument.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const ctx = buildContext(req);
    const token = generateToken();
    await prisma.$transaction(async (tx) => {
      // Revoke rather than delete: the credential history is the §11 record of
      // which secret was live when a given reading arrived.
      await tx.instrumentCredential.updateMany({
        where: { instrumentId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.instrumentCredential.create({
        data: { instrumentId: id, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) },
      });
      await auditLog({
        action: 'INSTRUMENT_TOKEN_REGENERATED', targetType: 'Instrument', targetId: id,
        afterValue: { code: existing.code, tokenPrefix: tokenPrefix(token) },
        signatureMeaning: `Access token for instrument "${existing.code}" regenerated; previous token revoked`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });

    // Without this the OLD token keeps authenticating for up to the cache TTL,
    // which would make "revoked immediately" untrue.
    invalidateIngestAuthCache(id);

    return { token, tokenPrefix: tokenPrefix(token) };
  });
}
