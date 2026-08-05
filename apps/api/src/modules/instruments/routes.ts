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
import { invalidateChildMapCache } from './gateway-children.js';
import { getLatest, getHistory } from './telemetry.repository.js';

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
  /** Last time a reading arrived FOR this instrument — "is it talking?" */
  lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
  // Placement is free text by design (spec D8): `code` stays the identifier.
  location: { type: 'string', nullable: true },
  area: { type: 'string', nullable: true },
  block: { type: 'string', nullable: true },
  isGateway: { type: 'boolean' },
  gatewayId: { type: 'string', nullable: true },
  /** 'direct' | 'gateway' — which path the last reading arrived by. */
  lastSeenVia: { type: 'string', nullable: true },
} as const;

/** The narrow shape both gateway-link pickers render: no secrets, no telemetry. */
const childProps = {
  id: { type: 'string' },
  code: { type: 'string' },
  name: { type: 'string' },
  isActive: { type: 'boolean' },
} as const;

/** One telemetry reading as the UI renders it. `value` is free-form JSON. */
const readingProps = {
  key: { type: 'string' },
  value: {},
  valueType: { type: 'string' },
  ts: { type: 'string', format: 'date-time' },
} as const;

type CredentialRow = { tokenPrefix: string; lastUsedAt: Date | null };
type InstrumentRow = Record<string, unknown> & { credentials?: CredentialRow[] };

/**
 * Flatten the active credential onto the instrument; never leak `tokenHash`.
 *
 * `lastSeenAt` / `lastSeenVia` come from the INSTRUMENT's own columns, not from
 * the credential's `lastUsedAt` (spec D9): a child reported through its gateway
 * never presents its own credential, so a credential-derived value would read
 * "Never" for exactly the instruments the gateway feature exists to serve.
 * `tokenPrefix` stays credential-derived — it IS a property of the credential.
 */
function present(row: InstrumentRow) {
  const { credentials, ...rest } = row;
  const active = credentials?.[0];
  return { ...rest, tokenPrefix: active?.tokenPrefix ?? null };
}

const activeCredential = {
  where: { revokedAt: null },
  select: { tokenPrefix: true, lastUsedAt: true },
  orderBy: { createdAt: 'desc' },
  take: 1,
} as const;

/**
 * Spec D2/D3 invariants. Returns an error payload, or null when the write is
 * allowed. Cannot be a CHECK constraint — two of the three rules read a
 * different row.
 */
async function gatewayInvariantError(
  next: { isGateway?: boolean; gatewayId?: string | null },
  current: { id: string; isGateway: boolean; gatewayId: string | null } | null,
): Promise<{ status: number; body: { error: string; message: string } } | null> {
  const isGateway = next.isGateway ?? current?.isGateway ?? false;
  const gatewayId = next.gatewayId === undefined ? (current?.gatewayId ?? null) : next.gatewayId;

  if (isGateway && gatewayId) {
    return { status: 400, body: { error: 'NESTED_GATEWAY', message: 'A gateway cannot itself be linked to another gateway. Unlink it first.' } };
  }
  if (current && gatewayId === current.id) {
    return { status: 400, body: { error: 'SELF_GATEWAY', message: 'An instrument cannot be its own gateway.' } };
  }
  if (gatewayId) {
    const parent = await prisma.instrument.findUnique({
      where: { id: gatewayId }, select: { id: true, code: true, isGateway: true },
    });
    if (!parent) return { status: 400, body: { error: 'NOT_FOUND', message: 'The selected gateway does not exist.' } };
    if (!parent.isGateway) {
      return { status: 400, body: { error: 'NOT_A_GATEWAY', message: `Instrument "${parent.code}" is not configured as a gateway.` } };
    }
  }
  // Spec D6 — refusing beats silently unlinking, which would stop those
  // sensors reporting with nothing in the UI to say why.
  if (current?.isGateway && next.isGateway === false) {
    const kids = await prisma.instrument.findMany({ where: { gatewayId: current.id }, select: { code: true } });
    if (kids.length > 0) {
      return {
        status: 409,
        body: {
          error: 'GATEWAY_HAS_CHILDREN',
          message: `Unlink these instruments before disabling gateway mode: ${kids.map((k) => k.code).join(', ')}.`,
        },
      };
    }
  }
  return null;
}

/** Human label for an audit row, so the trail never carries a bare UUID. */
async function codeOf(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const row = await prisma.instrument.findUnique({ where: { id }, select: { code: true } });
  return row?.code ?? null;
}

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

    // Gateway wiring is an access-control fact, not metadata: `gatewayId`
    // decides which credential may write this instrument's telemetry. Born
    // linked or born a gateway gets its own row, in this same transaction, so
    // the trail reads the same whether the state was set at create or later.
    if (instrument.isGateway) {
      await auditLog({
        action: 'INSTRUMENT_GATEWAY_ENABLED', targetType: 'Instrument', targetId: instrument.id,
        afterValue: { instrument: instrument.code, isGateway: true },
        signatureMeaning: `Instrument "${instrument.code}" registered as a gateway`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    }
    if (instrument.gatewayId) {
      const parentCode = (await tx.instrument.findUnique({
        where: { id: instrument.gatewayId }, select: { code: true },
      }))?.code ?? instrument.gatewayId;
      await auditLog({
        action: 'INSTRUMENT_LINKED_TO_GATEWAY', targetType: 'Instrument', targetId: instrument.id,
        afterValue: { instrument: instrument.code, gateway: parentCode, gatewayId: instrument.gatewayId },
        signatureMeaning: `Instrument "${instrument.code}" linked to gateway "${parentCode}"`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    }
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
          block: { type: 'string' },
          area: { type: 'string' },
          location: { type: 'string' },
          isGateway: { type: 'string', enum: ['true', 'false'] },
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
    const { page, limit, search, transport, isActive, block, area, location, isGateway } = parsed.data;

    const where: Prisma.InstrumentWhereInput = {
      ...(transport ? { transport } : {}),
      ...(isActive !== undefined ? { isActive: isActive === 'true' } : {}),
      ...(block ? { block: { contains: block, mode: 'insensitive' as const } } : {}),
      ...(area ? { area: { contains: area, mode: 'insensitive' as const } } : {}),
      ...(location ? { location: { contains: location, mode: 'insensitive' as const } } : {}),
      ...(isGateway !== undefined ? { isGateway: isGateway === 'true' } : {}),
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

  // GET /api/instruments/eligible-children — candidates for a gateway link.
  // Registered before `/:id` for readability only: Fastify's router already
  // ranks a static segment above a parameterised one.
  app.get('/eligible-children', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Instruments eligible to be linked to a gateway',
      description: 'Active instruments that are neither a gateway themselves (D2) nor already linked to one (D3). Both exclusions are the invariants, not a UI preference.',
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'object', properties: childProps } } },
        },
        ...errorResponses,
      },
    },
  }, async () => {
    const data = await prisma.instrument.findMany({
      where: { isGateway: false, gatewayId: null, isActive: true },
      select: { id: true, code: true, name: true, isActive: true },
      orderBy: { code: 'asc' },
    });
    return { data };
  });

  // GET /api/instruments/:id/children — what this gateway currently reports for
  app.get('/:id/children', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Instruments linked to this gateway',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'object', properties: childProps } } },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const exists = await prisma.instrument.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const data = await prisma.instrument.findMany({
      where: { gatewayId: id },
      select: { id: true, code: true, name: true, isActive: true },
      orderBy: { code: 'asc' },
    });
    return { data };
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

  // GET /api/instruments/:id/telemetry — latest value per key + recent history.
  // The detail page's whole job is answering "data is being sent, why can't I
  // see it?", which needs the readings and the failures side by side.
  app.get('/:id/telemetry', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Latest and recent telemetry for one instrument',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          limit: { type: 'integer', default: 100 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            latest: { type: 'array', items: { type: 'object', properties: readingProps } },
            history: { type: 'array', items: { type: 'object', properties: readingProps } },
            historyTotal: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { key?: string; limit?: number };
    const exists = await prisma.instrument.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    // Capped server-side: this reads a partitioned history table and the page
    // only ever renders a recent window.
    const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500);
    const [latest, history] = await Promise.all([
      getLatest(id),
      getHistory({ instrumentId: id, key: q.key, limit }),
    ]);
    return { latest, history: history.rows, historyTotal: history.total };
  });

  // GET /api/instruments/:id/dead-letters — this device's rejected payloads
  app.get('/:id/dead-letters', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Rejected payloads for one instrument',
      description: 'Payloads that could not be parsed or were refused. The first place to look when a device reports success but no readings appear.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: { type: 'object', properties: { limit: { type: 'integer', default: 50 } } },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' }, transport: { type: 'string' }, reason: { type: 'string' },
                  rawPayload: { type: 'string', nullable: true },
                  receivedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
            total: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { limit?: number };
    const exists = await prisma.instrument.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const take = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
    const [data, total] = await Promise.all([
      prisma.deadLetter.findMany({ where: { instrumentId: id }, orderBy: { receivedAt: 'desc' }, take }),
      prisma.deadLetter.count({ where: { instrumentId: id } }),
    ]);
    return { data, total };
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
          location: { type: ['string', 'null'] }, area: { type: ['string', 'null'] },
          block: { type: ['string', 'null'] },
          isGateway: { type: 'boolean' },
          gatewayId: { type: ['string', 'null'], format: 'uuid' },
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

    const invalid = await gatewayInvariantError(parsed.data, null);
    if (invalid) return reply.code(invalid.status).send(invalid.body);

    try {
      const { id, token } = await createWithCredential(parsed.data as Record<string, unknown>, buildContext(req));
      // An instrument born linked must be writable by its gateway at once, not
      // after the child-map TTL.
      if (parsed.data.gatewayId) invalidateChildMapCache(parsed.data.gatewayId);
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
          location: { type: ['string', 'null'] }, area: { type: ['string', 'null'] },
          block: { type: ['string', 'null'] },
          isGateway: { type: 'boolean' },
          gatewayId: { type: ['string', 'null'], format: 'uuid', description: 'null unlinks this instrument from its gateway' },
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

    const invalid = await gatewayInvariantError(parsed.data, existing);
    if (invalid) return reply.code(invalid.status).send(invalid.body);

    // Only a real transition is audited: a PUT that re-sends the current
    // gatewayId is not a link event, and a trail full of no-op links is a trail
    // nobody reads.
    const gatewayChanged = parsed.data.gatewayId !== undefined
      && (parsed.data.gatewayId ?? null) !== existing.gatewayId;
    const modeChanged = parsed.data.isGateway !== undefined
      && parsed.data.isGateway !== existing.isGateway;
    // Resolved OUTSIDE the transaction: the codes are only for the audit text,
    // and holding the transaction open for two extra reads buys nothing.
    const [oldGatewayCode, newGatewayCode] = gatewayChanged
      ? await Promise.all([codeOf(existing.gatewayId), codeOf(parsed.data.gatewayId)])
      : [null, null];

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

      // §11.10(e): these rows change WHICH credential may write this
      // instrument's telemetry, so they belong in the same transaction as the
      // mutation — an audit row that can outlive a rolled-back write is worse
      // than none.
      if (modeChanged) {
        await auditLog({
          action: parsed.data.isGateway ? 'INSTRUMENT_GATEWAY_ENABLED' : 'INSTRUMENT_GATEWAY_DISABLED',
          targetType: 'Instrument', targetId: id,
          beforeValue: { instrument: existing.code, isGateway: existing.isGateway },
          afterValue: { instrument: row.code, isGateway: row.isGateway },
          signatureMeaning: parsed.data.isGateway
            ? `Gateway mode enabled on instrument "${row.code}"`
            : `Gateway mode disabled on instrument "${row.code}"`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      }
      if (gatewayChanged) {
        await auditLog({
          action: parsed.data.gatewayId ? 'INSTRUMENT_LINKED_TO_GATEWAY' : 'INSTRUMENT_UNLINKED_FROM_GATEWAY',
          targetType: 'Instrument', targetId: id,
          beforeValue: { instrument: existing.code, gateway: oldGatewayCode, gatewayId: existing.gatewayId },
          afterValue: { instrument: row.code, gateway: newGatewayCode, gatewayId: row.gatewayId },
          signatureMeaning: parsed.data.gatewayId
            ? `Instrument "${row.code}" linked to gateway "${newGatewayCode}"`
            : `Instrument "${row.code}" unlinked from gateway "${oldGatewayCode}"`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      }
      return row;
    });

    // Deactivating an instrument must stop its ingest NOW, not in up to 10s:
    // resolveInstrumentByToken caches the resolved identity, and `isActive` is
    // read at resolution time.
    invalidateIngestAuthCache(id);

    // BOTH sides of a move: left to the 10s TTL a just-unlinked child stays
    // writable by its former gateway. The old parent is invalidated on EVERY
    // update, not only a re-link, because the cached child map also carries
    // `isActive` — deactivating a child must stop its gateway writing for it
    // just as immediately as it stops the child's own token.
    if (existing.gatewayId) invalidateChildMapCache(existing.gatewayId);
    if (parsed.data.gatewayId) invalidateChildMapCache(parsed.data.gatewayId);

    const row = await prisma.instrument.findUnique({ where: { id }, include: { credentials: activeCredential } });
    return present((row ?? updated) as unknown as InstrumentRow);
  });

  // DELETE /api/instruments/:id — cascades the credential rows
  app.delete('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_DELETE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Delete instrument',
      description: 'Permanently delete an instrument and its credentials. Telemetry already written is retained. Deleting a gateway UNLINKS its children (ON DELETE SET NULL) — it never deletes them.',
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
    // The deleted row's own child map, and — if it was itself a child — its
    // former parent's, which still lists it.
    invalidateChildMapCache(id);
    if (existing.gatewayId) invalidateChildMapCache(existing.gatewayId);
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
