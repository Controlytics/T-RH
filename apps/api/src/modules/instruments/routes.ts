import { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  createInstrumentSchema,
  updateInstrumentSchema,
  instrumentQuerySchema,
  bulkCreateInstrumentsSchema,
  setInstrumentTokenSchema,
  setInstrumentAttributeSchema,
  updateInstrumentAttributeSchema,
} from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauthAlways } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { generateToken, hashToken, tokenPrefix, tokenMatches } from './token.js';
import { encryptToken, decryptToken, tokenKeyConfigured } from './token-crypto.js';
import { parseInstrumentCsv, type InstrumentDraft } from './bulk-csv.js';
import { invalidateIngestAuthCache } from './ingest-auth.js';
import { invalidateChildMapCache } from './gateway-children.js';
import {
  gatewayInvariantError, lockedGatewayRecheck, lockInstrumentRows, isDeadlock,
  GatewayInvariantViolation,
} from './gateway-invariants.js';
import { getLatest, getHistory } from './telemetry.repository.js';
import { publishAttributeDownlink } from './attribute-downlink.js';
import { publishChildRoster, clearChildRoster } from './child-roster.js';

/**
 * Registry (operator-facing, JWT + permission gated). The device-facing ingest
 * endpoint lives in `ingest-routes.ts` and is deliberately a separate file:
 * that one is on the auth-hook allowlist and reachable from the network without
 * a login, this one is not. Keeping them apart makes it obvious in review which
 * file is internet-facing.
 *
 * LOCK-ORDER RULE FOR EVERY TRANSACTION IN THIS FILE — no transaction may take
 * an instrument row lock AFTER calling `auditLog`. `auditLog` takes the audit
 * chain's advisory lock and holds it to commit, so locking afterwards cycles
 * against a concurrent write and Postgres kills one with 40P01 (a 500). Take
 * the row locks first, via `lockInstrumentRows`/`lockedGatewayRecheck`, parent
 * before self. See `gateway-invariants.ts` and `apps/api/DECISIONS.md`.
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
  /**
   * Can `GET /:id/token` actually return a value? False for a credential issued
   * before 2026-08-06 (no ciphertext exists, and none can be derived from a
   * hash) or on a deployment with no INSTRUMENT_TOKEN_KEY. The UI needs this
   * BEFORE it offers a Reveal button, since finding out the other way costs the
   * operator a password re-auth to reach an error. Not a secret: it says whether
   * a value is recoverable, never anything about the value.
   */
  tokenRevealable: { type: 'boolean' },
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

type CredentialRow = { tokenPrefix: string; tokenEncrypted?: string | null };
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
  return {
    ...rest,
    tokenPrefix: active?.tokenPrefix ?? null,
    // The CIPHERTEXT ITSELF is destructured away with `credentials` and never
    // reaches the client — only the boolean derived from it. Selecting it here
    // is what lets the UI decide whether Reveal is even offered.
    tokenRevealable: Boolean(active?.tokenEncrypted) && tokenKeyConfigured(),
  };
}

const activeCredential = {
  where: { revokedAt: null },
  // `lastUsedAt` is deliberately NOT selected: `present()` does not read it.
  // Last-seen moved to the instrument's own columns (spec D9) — see present().
  select: { tokenPrefix: true, tokenEncrypted: true },
  orderBy: { createdAt: 'desc' },
  take: 1,
} as const;

/** Human label for an audit row, so the trail never carries a bare UUID. */
async function codeOf(
  id: string | null | undefined,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string | null> {
  if (!id) return null;
  const row = await client.instrument.findUnique({ where: { id }, select: { code: true } });
  return row?.code ?? null;
}

/**
 * Tell a gateway who its children are. CALLED AFTER THE COMMIT.
 *
 * Reads the membership HERE rather than inside the transaction, for the reason
 * `announceAttributeChange` re-reads: an in-transaction read cannot see a
 * concurrent commit that linked or unlinked a DIFFERENT child, so it could
 * retain a membership that was never true.
 *
 * Takes the gateway's id, not its code, because every caller has the id and
 * only some have the code — and looking it up here also settles the two cases
 * that must NOT publish: an id that is no longer a gateway (mode was just
 * turned off), and one whose row is gone. Both leave silently.
 *
 * Never throws. A broker failure must not turn a committed link into an error
 * the operator would retry.
 */
async function announceRoster(gatewayId: string | null | undefined): Promise<void> {
  if (!gatewayId) return;
  try {
    const gw = await prisma.instrument.findUnique({
      where: { id: gatewayId }, select: { code: true, isGateway: true },
    });
    if (!gw?.isGateway) return;
    const children = await prisma.instrument.findMany({
      where: { gatewayId },
      select: { code: true, name: true, isActive: true },
    });
    await publishChildRoster(gw.code, children, new Date());
  } catch (e) {
    console.warn('[downlink:children] roster NOT DELIVERED — could not read the membership', {
      gatewayId, err: (e as Error).message,
    });
  }
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
    // FIRST statement of the transaction, before the write and before any
    // auditLog takes the audit advisory lock — see gateway-invariants.ts.
    await lockedGatewayRecheck(tx, { linkTo: (draft.gatewayId as string | null | undefined) ?? null });

    const instrument = await tx.instrument.create({
      data: { ...draft, createdBy: ctx.userId } as unknown as Prisma.InstrumentCreateInput,
    });
    await tx.instrumentCredential.create({
      data: {
        instrumentId: instrument.id,
        tokenHash: hashToken(token),
        tokenPrefix: tokenPrefix(token),
        // Null when no INSTRUMENT_TOKEN_KEY is configured. Issuance must never
        // depend on the key: a deployment without one still registers devices,
        // their tokens just cannot be revealed later.
        tokenEncrypted: encryptToken(token),
      },
    });
    await auditLog({
      action: 'INSTRUMENT_CREATED', targetType: 'Instrument', targetId: instrument.id,
      afterValue: { name: instrument.name, code: instrument.code },
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
        afterValue: { code: instrument.code, isGateway: true },
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
        afterValue: { code: instrument.code, gateway: parentCode, gatewayId: instrument.gatewayId },
        signatureMeaning: `Instrument "${instrument.code}" linked to gateway "${parentCode}"`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    }

    return { id: instrument.id, code: instrument.code, name: instrument.name, token };
  });
}

/**
 * A 4xx decided INSIDE a transaction. Throwing (rather than returning) is what
 * rolls the partial work back; the handler catches it and sends `body`.
 * `GatewayInvariantViolation` does the same job for the gateway rules — this one
 * exists so a token conflict is not misreported as a gateway invariant.
 */
class HandledRouteError extends Error {
  constructor(readonly status: number, readonly body: { error: string; message: string }) {
    super(body.message);
    this.name = 'HandledRouteError';
  }
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
      description: 'Paginated instrument registry with search and status/placement filters.',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer' },
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
    const { page, limit, search, isActive, block, area, location, isGateway } = parsed.data;

    const where: Prisma.InstrumentWhereInput = {
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
        required: ['name', 'code'],
        properties: {
          name: { type: 'string' }, code: { type: 'string' },
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
      // Born linked → its new parent's roster gained a member. Born a GATEWAY →
      // publish its (empty) roster now, so a gateway that connects before it
      // ever gains a child reads an explicit "no children" instead of an empty
      // slot it cannot tell from a broker that lost the message.
      await announceRoster(parsed.data.gatewayId ?? (parsed.data.isGateway ? id : null));
      const row = await prisma.instrument.findUnique({ where: { id }, include: { credentials: activeCredential } });
      return reply.code(201).send({ ...present(row as unknown as InstrumentRow), token });
    } catch (err) {
      if (err instanceof GatewayInvariantViolation) return reply.code(err.status).send(err.body);
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
            // Whole-file advisories (e.g. a retired column that was ignored).
            // Distinct from `errors`: these fail nothing and cost no rows.
            warnings: { type: 'array', items: { type: 'string' } },
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

    const { rows, rowNumbers, errors, warnings } = parseInstrumentCsv(parsed.data.csv);
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

    return { created, errors, warnings };
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
          name: { type: 'string' }, isActive: { type: 'boolean' },
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

    const ctx = buildContext(req);
    const run = () => prisma.$transaction(async (tx) => {
      // FIRST statement of the transaction, and gated on the REQUESTED value,
      // never on a diff against `existing`.
      //
      // `existing` was read outside the transaction, so "unchanged" is a stale
      // verdict — but `data: parsed.data` below re-asserts the value in SQL
      // regardless. Gating the lock on the diff meant a whole-object PUT from a
      // form (the common case, not an exotic one) re-wrote `gatewayId` with no
      // lock and no re-check: enough to re-link a child to a gateway that had
      // been demoted in between, i.e. exactly the invariant this guard exists
      // to hold. Locking on what was ASKED FOR cannot go stale.
      await lockedGatewayRecheck(tx, {
        linkTo: parsed.data.gatewayId ?? null,
        disablingGatewayId: parsed.data.isGateway === false ? id : null,
        selfId: id,
      });

      // Re-read under those locks. This — not `existing` — decides what counts
      // as a transition, so the audit rows describe what actually changed.
      const before = await tx.instrument.findUnique({ where: { id } });
      if (!before) throw new GatewayInvariantViolation(404, { error: 'NOT_FOUND', message: 'Instrument not found.' });

      // D2/self, re-checked on the EFFECTIVE state (locked row + this request's
      // fields). `lockedGatewayRecheck` covers only the two cross-row rules; the
      // same-row ones were left to the pre-flight, which computes them from a
      // row read outside any transaction. Two ordinary UI actions defeat that,
      // because neither request carries the other's field:
      //
      //   A: PUT /C {isGateway:true}   (detail Save — no gatewayId)
      //   B: PUT /C {gatewayId:GW}     (gateway panel Link — no isGateway)
      //
      // B's pre-flight reads C before A commits, sees isGateway:false, allows
      // it. Both serialise on C's row lock, but B's `parsed.data` has no
      // `isGateway`, so nothing re-evaluates the rule and the commit lands
      // `isGateway && gatewayId` — the nested chain D2 forbids, which no CHECK
      // constraint catches (`instruments_gateway_not_self` covers self only).
      //
      // Both rows are already locked above, so this costs nothing. Mirrors
      // `gatewayInvariantError`'s own defaulting EXACTLY — `??` would be wrong
      // on `gatewayId`, turning an explicit `null` (unlink) back into the old
      // parent. Keep the two in step.
      const effIsGateway = parsed.data.isGateway ?? before.isGateway;
      const effGatewayId = parsed.data.gatewayId === undefined
        ? before.gatewayId
        : (parsed.data.gatewayId ?? null);
      // On a row that ALREADY holds `isGateway && gatewayId`, the pre-flight
      // above returns first and this never runs — see the operator note on
      // `gatewayInvariantError`'s NESTED_GATEWAY branch for what to do about
      // such a row. This copy is for the interleaving described above, where
      // neither request alone looks nested.
      if (effIsGateway && effGatewayId) {
        throw new GatewayInvariantViolation(400, {
          error: 'NESTED_GATEWAY',
          message: 'A gateway cannot itself be linked to another gateway. Unlink it first.',
        });
      }
      if (effGatewayId === id) {
        throw new GatewayInvariantViolation(400, {
          error: 'SELF_GATEWAY', message: 'An instrument cannot be its own gateway.',
        });
      }

      // Only a real transition is audited: a PUT that re-sends the current
      // gatewayId is not a link event, and a trail full of no-op links is a
      // trail nobody reads.
      const gatewayChanged = parsed.data.gatewayId !== undefined
        && (parsed.data.gatewayId ?? null) !== before.gatewayId;
      const modeChanged = parsed.data.isGateway !== undefined
        && parsed.data.isGateway !== before.isGateway;
      const [oldGatewayCode, newGatewayCode] = gatewayChanged
        ? [(await codeOf(before.gatewayId, tx)), (await codeOf(parsed.data.gatewayId, tx))]
        : [null, null];

      const row = await tx.instrument.update({ where: { id }, data: parsed.data as never });
      // EVERY editable field, on both sides. An omission is not cosmetic: a PUT
      // that changes only an omitted field produces a §11 row whose before and
      // after are IDENTICAL — a record that something changed but not what.
      // `code` is included (and is the emitter key the other INSTRUMENT_*
      // actions use) so the trail never has to fall back to a bare UUID.
      //
      // `isGateway`/`gatewayId` are in here even though each ALSO gets a
      // dedicated companion row below. The two carry different things and
      // neither substitutes for the other: the companion rows carry the
      // semantics (a signatureMeaning, the parent's resolved `code`), this row
      // carries the diff. Leaving them out was the whole defect — a
      // `PUT {isGateway:true}` then wrote an INSTRUMENT_UPDATED whose before
      // and after were byte-identical.
      //
      // This list is not kept in step by hand: the e2e test
      // "INSTRUMENT_UPDATED carries the code and a diff over every editable
      // field" derives its expected key set from `updateInstrumentSchema.shape`,
      // so adding a field to the PUT schema and forgetting it here FAILS.
      const audited = (i: typeof before) => ({
        code: i.code, name: i.name, isActive: i.isActive,
        instrumentType: i.instrumentType, manufacturer: i.manufacturer, model: i.model,
        serialNumber: i.serialNumber, description: i.description,
        expectedIntervalSec: i.expectedIntervalSec,
        location: i.location, area: i.area, block: i.block,
        isGateway: i.isGateway, gatewayId: i.gatewayId,
      });
      await auditLog({
        action: 'INSTRUMENT_UPDATED', targetType: 'Instrument', targetId: id,
        beforeValue: audited(before),
        afterValue: audited(row),
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
          beforeValue: { code: before.code, isGateway: before.isGateway },
          afterValue: { code: row.code, isGateway: row.isGateway },
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
          beforeValue: { code: before.code, gateway: oldGatewayCode, gatewayId: before.gatewayId },
          afterValue: { code: row.code, gateway: newGatewayCode, gatewayId: row.gatewayId },
          signatureMeaning: parsed.data.gatewayId
            ? `Instrument "${row.code}" linked to gateway "${newGatewayCode}"`
            : `Instrument "${row.code}" unlinked from gateway "${oldGatewayCode}"`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      }
      return row;
    });

    // Two mirrored demote-and-link requests acquire two PARENT rows in opposite
    // orders, which the parent-before-self rule cannot order (see
    // gateway-invariants.ts). Postgres picks a victim, and the retry is
    // uncontended because the winner has committed by then. ONE retry only — a
    // repeat means a real lock-order bug and should surface as a 500 rather
    // than spin.
    //
    // The retry runs inside the same handling as the first attempt: the winner
    // has usually invalidated the loser's request (the gateway it wanted to
    // link to just stopped being one), so the second attempt very often ends in
    // a legitimate GatewayInvariantViolation that must still become its 4xx.
    let updated: Awaited<ReturnType<typeof run>> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        updated = await run();
        break;
      } catch (err) {
        // The locked re-check refused: the transaction — update and audit rows
        // alike — is already rolled back.
        if (err instanceof GatewayInvariantViolation) return reply.code(err.status).send(err.body);
        if (isDeadlock(err) && attempt === 0) continue;
        throw err;
      }
    }
    if (!updated) throw new Error('Instrument update did not complete.');

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

    // BOTH sides of a move, for the same reason the cache invalidation above
    // does both: the old gateway lost a member and the new one gained it, and a
    // roster that still names a child someone else now owns is worse than none.
    // `updated.gatewayId` is the COMMITTED value, not `parsed.data.gatewayId` —
    // an update that omits `gatewayId` leaves the link untouched, and a rename
    // or a deactivation has to republish its CURRENT parent (both fields are in
    // the payload). Deduped, so the common single-gateway edit publishes once.
    for (const gwId of new Set([existing.gatewayId, updated.gatewayId].filter(Boolean))) {
      await announceRoster(gwId);
    }
    // The row itself is a gateway whose own membership can have changed here:
    // gateway mode was just turned ON (publish its roster), or a child's edit
    // has nothing to do with it. `announceRoster` no-ops when it is not one.
    if (updated.isGateway) await announceRoster(id);
    // Demoted. `gatewayInvariantError` refuses this while it still has children
    // (400 GATEWAY_HAS_CHILDREN), so the roster being cleared is always an empty
    // one — but leaving it retained would leave a `children` slot on an
    // instrument that is no longer a gateway, which is exactly the kind of
    // stale-forever message the delete path below exists to avoid. `code` is
    // immutable, so `existing.code` is still the right topic.
    else if (existing.isGateway) await clearChildRoster(existing.code);

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
    const orphaned = await prisma.$transaction(async (tx) => {
      // FIRST statement: lock this gateway before reading its children. An
      // unlocked read races a concurrent `PUT /C {gatewayId: this}` committing
      // between the read and the delete — C would be missing from `kids`, get no
      // unlink row, and still be unlinked by the SetNull cascade, which is
      // exactly the §11.10(e) gap the audit rows below exist to close. (It also
      // deadlocks on row locks alone: the delete holds this row and wants C
      // while the linker holds C and wants this row.)
      await lockInstrumentRows(tx, [id]);

      // `onDelete: SetNull` unlinks every child in the DATABASE, silently. That
      // is the same access-control event a PUT audits, so it gets the same rows
      // — read before the delete, written in the same transaction, one per
      // child. Without this, "when did S-4 stop being writable by GW-1, and who
      // did it?" has no answer in the trail (§11.10(e)).
      //
      // FOR UPDATE, not a plain read: unlinking takes no lock, so a
      // `PUT /C {gatewayId:null}` can commit between this read and the delete.
      // The cascade would then never touch C, yet we would still have written a
      // row saying C was unlinked BECAUSE this gateway was deleted — a false
      // statement, and a second unlink row for one unlink, in an immutable
      // trail. Waiting here re-qualifies the row and drops C. Order stays
      // `gateway -> children`, matching the link path, so no cycle.
      const kids = await tx.$queryRaw<{ id: string; code: string }[]>`
        SELECT id, code FROM instruments WHERE gateway_id = ${id} FOR UPDATE
      `;

      await tx.instrument.delete({ where: { id } });
      for (const kid of kids) {
        await auditLog({
          action: 'INSTRUMENT_UNLINKED_FROM_GATEWAY', targetType: 'Instrument', targetId: kid.id,
          beforeValue: { code: kid.code, gateway: existing.code, gatewayId: id },
          afterValue: { code: kid.code, gateway: null, gatewayId: null },
          signatureMeaning: `Instrument "${kid.code}" unlinked from gateway "${existing.code}" because that gateway was deleted`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      }
      await auditLog({
        action: 'INSTRUMENT_DELETED', targetType: 'Instrument', targetId: id,
        beforeValue: { name: existing.name, code: existing.code },
        signatureMeaning: `Instrument "${existing.code}" deleted`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return kids;
    });

    invalidateIngestAuthCache(id);
    // The deleted row's own child map, and — if it was itself a child — its
    // former parent's, which still lists it.
    invalidateChildMapCache(id);
    if (existing.gatewayId) invalidateChildMapCache(existing.gatewayId);
    // A deleted gateway's roster must not survive it. This is the one place in
    // the codebase that clears a retained slot, and it is deliberate: unlike a
    // stranded attribute slot (stale metadata about a code nothing can even
    // connect as any more), a stranded roster NAMES INSTRUMENTS THAT ARE STILL
    // LIVE and have just been orphaned by this very delete.
    if (existing.isGateway) await clearChildRoster(existing.code);
    // If it was itself a child, its former parent's roster still lists it.
    await announceRoster(existing.gatewayId);
    // Each orphaned child's ingest identity is cached too, and it no longer has
    // a gateway that may write for it.
    for (const kid of orphaned) invalidateIngestAuthCache(kid.id);
    return { success: true };
  });

  // POST /api/instruments/:id/regenerate-token
  //
  // `enforceReauthAlways`, not the admin-configurable `enforceReauth` (changed
  // 2026-08-06, after the same correction was applied to reveal/set). The
  // argument is the one made for those two, and it is stronger here: this
  // endpoint returns a live plaintext credential in its 200 body, and on a
  // stock install `system_config['action-reauth']` lists nothing — so it needed
  // INSTRUMENT_UPDATE and no password at all. It is also the most destructive
  // of the three: it kills the field device's current credential, which reveal
  // does not. Two hardened siblings and one opt-in was worse than either
  // consistent state.
  //
  // `REGENERATE_INSTRUMENT_TOKEN` was removed from `REAUTH_ACTIONS` at the same
  // time, for the same reason the other two were: every entry there is a
  // per-role policy toggle, and an always-on gate has no policy — the toggle
  // would render and change nothing. The action string still travels in the 401
  // body so a client can name the action it is being challenged for.
  app.post('/:id/regenerate-token', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Regenerate instrument access token',
      description: 'Revokes the current credential and issues a new one. The device stops authenticating until it is reconfigured. The new token is shown once. Requires INSTRUMENT_UPDATE and an ALWAYS-ON password re-auth (send it as the `x-reauth-password` header — it is not admin-configurable and cannot be turned off).',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: { type: 'object', properties: { token: { type: 'string' }, tokenPrefix: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauthAlways('REGENERATE_INSTRUMENT_TOKEN', req, reply);
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
        data: {
          instrumentId: id,
          tokenHash: hashToken(token),
          tokenPrefix: tokenPrefix(token),
          tokenEncrypted: encryptToken(token),
        },
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

  // GET /api/instruments/:id/token — reveal the live token.
  //
  // This endpoint IS the D5 reversal (spec 2026-08-04, reversed 2026-08-06 at
  // the operator's request). D5's reasoning — a retrievable credential is a
  // standing liability — was not wrong; it was outweighed by the cost of the
  // alternative, which is a site visit to reconfigure a device every time
  // somebody needs to know what its token is. Three controls pay for it:
  // INSTRUMENT_UPDATE (not the read permission — this is not a read of registry
  // metadata), a password re-auth, and an audit row per view. The audit row is
  // the one that matters: the token stays secret, but who looked at it never is.
  //
  // The re-auth is `enforceReauthAlways`, NOT the admin-configurable
  // `enforceReauth` (changed 2026-08-06, the day after this endpoint landed).
  // Configurable was wrong here: `system_config['action-reauth']` lists nothing
  // on a stock install, so a deployment that never opened the policy page would
  // hand out live device credentials to anyone holding INSTRUMENT_UPDATE with no
  // password at all — two of the three compensating controls the D5 reversal was
  // granted on, and no way to tell from the outside which install you are in.
  // A control that the reversal depends on cannot itself be opt-in.
  app.get('/:id/token', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Reveal the instrument access token',
      description: 'Returns the live plaintext token. Requires INSTRUMENT_UPDATE and an ALWAYS-ON password re-auth (send it as the `x-reauth-password` header — it is not admin-configurable and cannot be turned off), and writes an INSTRUMENT_TOKEN_VIEWED audit row. Unavailable for credentials issued before 2026-08-06.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: { type: 'object', properties: { token: { type: 'string' }, tokenPrefix: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // A GET carries no body, so the re-auth password arrives in the
    // `x-reauth-password` header — the alternate `enforceReauthAlways` already
    // accepts, and the reason a reveal does not have to become a POST.
    const { ok } = await enforceReauthAlways('REVEAL_INSTRUMENT_TOKEN', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const existing = await prisma.instrument.findUnique({ where: { id }, select: { id: true, code: true } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const credential = await prisma.instrumentCredential.findFirst({
      where: { instrumentId: id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { tokenPrefix: true, tokenEncrypted: true },
    });
    if (!credential) {
      return reply.code(404).send({
        error: 'NO_CREDENTIAL',
        message: 'This instrument has no active credential. Regenerate its token.',
      });
    }

    // Three distinct failures, deliberately not collapsed into one "cannot show
    // token": each has a different remedy, and an operator staring at a device
    // that will not connect should not have to guess which one they are in.
    if (!credential.tokenEncrypted) {
      return reply.code(409).send({
        error: 'TOKEN_NOT_RECOVERABLE',
        message: 'This token was issued before tokens became viewable, so no recoverable copy exists. Regenerate the token to get a viewable one — the device must then be reconfigured.',
      });
    }
    if (!tokenKeyConfigured()) {
      return reply.code(503).send({
        error: 'TOKEN_KEY_MISSING',
        message: 'INSTRUMENT_TOKEN_KEY is not configured on the server, so stored tokens cannot be decrypted. Ingest is unaffected.',
      });
    }

    let token: string;
    try {
      token = decryptToken(credential.tokenEncrypted);
    } catch (err) {
      // A real alarm, not a validation failure: the ciphertext exists and a key
      // is present, so either the key has been ROTATED (every token silently
      // unviewable from here on) or a row has been tampered with. Logged with
      // the instrument, never with the ciphertext or any partial plaintext.
      req.log.error(
        { err, instrumentId: id, code: existing.code },
        'INSTRUMENT_TOKEN_DECRYPT_FAILED — wrong INSTRUMENT_TOKEN_KEY or tampered ciphertext',
      );
      return reply.code(500).send({
        error: 'TOKEN_DECRYPT_FAILED',
        message: 'The stored token could not be decrypted. The encryption key may have changed. Regenerate the token to issue a readable one.',
      });
    }

    // Inside a transaction, and written BEFORE the value is returned: a view
    // that could not be recorded must not happen at all (§11.10(e)). No row
    // lock is taken anywhere in this handler, so the lock-order rule at the top
    // of this file is not in play.
    const ctx = buildContext(req);
    await prisma.$transaction(async (tx) => {
      await auditLog({
        action: 'INSTRUMENT_TOKEN_VIEWED', targetType: 'Instrument', targetId: id,
        // The PREFIX only. Putting the token in an audit row would move the
        // secret into an immutable, widely-readable table — the exact opposite
        // of what the encryption is for.
        afterValue: { code: existing.code, tokenPrefix: credential.tokenPrefix },
        signatureMeaning: `Access token for instrument "${existing.code}" revealed`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });

    return { token, tokenPrefix: credential.tokenPrefix };
  });

  // PUT /api/instruments/:id/token — set an operator-chosen token.
  //
  // For the case regeneration cannot serve: a device whose credential is fixed
  // in its firmware or its installer's config sheet, where the platform has to
  // match the device rather than the other way round.
  //
  // Same ALWAYS-ON re-auth as the reveal, and for a sharper reason: choosing a
  // token's VALUE is issuing a credential whose bytes the caller already knows.
  // Regeneration at least produces a secret the attacker has to read back
  // afterwards; this endpoint lets a borrowed session install one they picked in
  // advance, in one request, and the device keeps working for whoever has it.
  // That is not a setting an installation should be able to leave switched off.
  app.put('/:id/token', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Set a specific instrument access token',
      description: 'Replaces the credential with an operator-supplied token. Requires INSTRUMENT_UPDATE and an ALWAYS-ON password re-auth (`_currentPassword` in the body or the `x-reauth-password` header — not admin-configurable). The previous credential is revoked, so the device stops authenticating until it is reconfigured. The token value is never echoed back — only its prefix. Any length above the 8-character public prefix is accepted (the 32–128 bounds were removed 2026-08-06 so a credential fixed in device firmware can be entered verbatim); characters are restricted to `[A-Za-z0-9._-]` so the value survives an Authorization header, an MQTT username and a JSON line unescaped.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
      response: {
        200: { type: 'object', properties: { tokenPrefix: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauthAlways('SET_INSTRUMENT_TOKEN', req, reply);
    if (!ok) return;

    // NOT run through `sanitizeStrings`: it strips HTML, and a token is an
    // opaque credential that must be stored byte-for-byte as the device will
    // present it. The Zod character class is far stricter than the sanitiser
    // anyway — `[A-Za-z0-9._-]` cannot contain markup.
    const parsed = setInstrumentTokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const token = parsed.data.token;

    const { id } = req.params as { id: string };
    const existing = await prisma.instrument.findUnique({ where: { id }, select: { id: true, code: true } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const hash = hashToken(token);
    const prefix = tokenPrefix(token);
    // Encrypt BEFORE the transaction: a configured-but-broken key must fail the
    // whole request, not leave behind a credential nobody can ever read back.
    // A deployment with no key at all stores null and carries on, exactly as
    // issuance does.
    let encrypted: string | null;
    try {
      encrypted = encryptToken(token);
    } catch (err) {
      req.log.error({ err, instrumentId: id }, 'INSTRUMENT_TOKEN_KEY is configured but unusable');
      return reply.code(503).send({
        error: 'TOKEN_KEY_INVALID',
        message: 'INSTRUMENT_TOKEN_KEY is configured but unusable, so the token cannot be stored encrypted.',
      });
    }

    const ctx = buildContext(req);
    try {
      await prisma.$transaction(async (tx) => {
        // Serialise on the TOKEN, not on the instrument row, so two operators
        // racing to claim the same token cannot both pass the check below.
        // Two-argument form: a separate key space from the audit chain's
        // single-bigint lock, so there is no chance of collision. Taken BEFORE
        // `auditLog`, per the lock-order rule at the top of this file — and it
        // is not a row lock, so it orders against nothing else in this module.
        //
        // The classid MUST fit in int4: the two-argument overload is
        // `(int4, int4)`, and a literal above 2147483647 is typed `bigint` by
        // Postgres, which resolves to no function at all (42883). 20260806 is
        // the date this endpoint landed — arbitrary but stable and traceable.
        // `hashtext` returns int4, so the second argument needs no cast.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260806, hashtext(${hash}))`;

        // A token in use by a live credential elsewhere would make
        // authentication AMBIGUOUS: `resolveInstrumentByToken` seeks on the
        // prefix and returns the FIRST hash that matches, so the device that
        // "wins" would depend on row order. Revoked credentials are not
        // considered — they authenticate nothing.
        const clash = await tx.instrumentCredential.findMany({
          where: { tokenPrefix: prefix, revokedAt: null },
          select: { instrumentId: true, tokenHash: true },
        });
        for (const c of clash) {
          if (!tokenMatches(token, c.tokenHash)) continue;
          throw new HandledRouteError(409, {
            error: 'TOKEN_IN_USE',
            message: c.instrumentId === id
              ? 'This instrument is already using that token.'
              : 'That token is already in use by another instrument. Choose a different value.',
          });
        }

        // REVOKE-AND-INSERT, not update-in-place — the same shape as
        // `regenerate-token`, and for the same §11 reason. `instrument_credentials`
        // is the record of WHICH secret was live when a given reading arrived:
        // `createdAt`/`revokedAt` bound the window and `lastUsedAt` says it was
        // used inside it. Updating the hash in place would rewrite that history,
        // making every past reading appear to have been authenticated by a
        // credential that did not exist yet — an immutability breach in a table
        // an inspector reads alongside the telemetry.
        await tx.instrumentCredential.updateMany({
          where: { instrumentId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.instrumentCredential.create({
          data: { instrumentId: id, tokenHash: hash, tokenPrefix: prefix, tokenEncrypted: encrypted },
        });
        await auditLog({
          action: 'INSTRUMENT_TOKEN_SET', targetType: 'Instrument', targetId: id,
          // Prefix only — see the note on INSTRUMENT_TOKEN_VIEWED.
          afterValue: { code: existing.code, tokenPrefix: prefix },
          signatureMeaning: `Access token for instrument "${existing.code}" replaced with an operator-supplied value; previous token revoked`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      });
    } catch (err) {
      // Thrown from INSIDE the transaction on purpose: the throw is what rolls
      // the revoke back, so a refused set leaves the live credential untouched.
      if (err instanceof HandledRouteError) return reply.code(err.status).send(err.body);
      throw err;
    }

    // Same reason as regenerate: without this the OLD token keeps authenticating
    // for up to the 10s cache TTL, which would make "the previous token is
    // revoked" untrue for exactly as long as it takes to notice.
    invalidateIngestAuthCache(id);

    return { tokenPrefix: prefix };
  });

  // ---------------------------------------------------------------------------
  // Free-form attributes.
  //
  // A child table, one row per key (see the `InstrumentAttribute` model comment
  // for why this is not a JSONB column). Reading is on INSTRUMENT_READ — an
  // attribute is registry metadata, not a secret — while every write and delete
  // is on INSTRUMENT_UPDATE and audited by key.
  //
  // NO INSTRUMENT ROW LOCK is taken in any of these handlers, so the lock-order
  // rule at the top of this file is not in play. An attribute write cannot
  // violate a gateway invariant: it touches no column any invariant reads.
  // ---------------------------------------------------------------------------

  const attributeProps = {
    key: { type: 'string' },
    value: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  } as const;

  const attributeSelect = { key: true, value: true, createdAt: true, updatedAt: true } as const;

  /** 404 body for an attribute key that is not on this instrument. */
  const noSuchAttribute = (key: string) => ({
    error: 'ATTRIBUTE_NOT_FOUND',
    message: `This instrument has no attribute named "${key}".`,
  });

  /**
   * Sanitise-then-trim a key arriving as a URL segment, so `PUT`/`DELETE`
   * resolve the same stored row that `POST` created. `POST` runs the identical
   * pair (route sanitiser, then the Zod transform) — if these two ever diverge,
   * an attribute becomes creatable but not editable.
   */
  function normaliseKey(raw: string): string {
    return String((sanitizeStrings({ key: raw }) as { key: unknown }).key ?? '').trim();
  }

  /**
   * Serialise concurrent writers of the SAME attribute. Without it, two
   * simultaneous sets of one key both read "absent" and both insert, and the
   * loser gets a P2002 500 instead of an update. Two-argument form — a different
   * key space from the audit chain's single-bigint lock — and the classid MUST
   * fit in int4 (a larger literal is typed `bigint`, for which no overload
   * exists: 42883). 20260807 is arbitrary but stable, and distinct from the
   * token endpoint's 20260806 so the two never queue behind each other.
   */
  async function lockAttribute(tx: Prisma.TransactionClient, instrumentId: string, key: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260807, hashtext(${`${instrumentId}:${key}`}))`;
  }

  /**
   * Everything the downlink needs, in the lookup each handler already does.
   * `gateway.code` is what decides the topic. Read OUTSIDE any transaction, so
   * the lock-order rule at the top of this file stays out of play.
   */
  const attributeOwnerSelect = { code: true, gateway: { select: { code: true } } } as const;

  /**
   * Tell the device an attribute moved. CALLED AFTER THE COMMIT, never inside
   * the transaction — a retained message describing an edit that then rolled
   * back would leave the device permanently ahead of the platform.
   *
   * The complete set is re-read HERE rather than taken from inside the
   * transaction. An in-transaction read is internally consistent but blind to a
   * concurrent commit on a DIFFERENT key, so the retained message could
   * reconstruct a set that is missing an attribute — which is precisely what
   * carrying the complete set exists to prevent. Post-commit is the fresher
   * answer.
   *
   * Never throws. A broker failure, or even the re-read failing, must not turn
   * a committed attribute write into an error the operator would retry.
   */
  async function announceAttributeChange(
    instrumentId: string,
    owner: { code: string; gateway: { code: string } | null },
    changedKey: string,
    changedValue: string | null,
  ): Promise<void> {
    try {
      const rows = await prisma.instrumentAttribute.findMany({
        where: { instrumentId }, select: { key: true, value: true },
      });
      await publishAttributeDownlink(
        {
          code: owner.code,
          gatewayCode: owner.gateway?.code ?? null,
          attributes: Object.fromEntries(rows.map((r) => [r.key, r.value])),
          changedKey,
          changedValue,
          ts: new Date(),
        },
        (msg, meta) => app.log.warn(meta ?? {}, `[downlink:attributes] ${msg}`),
      );
    } catch (e) {
      app.log.warn(
        { err: (e as Error).message, instrumentId, key: changedKey },
        '[downlink:attributes] could not build the downlink message — the device was NOT told about this change',
      );
    }
  }

  // GET /api/instruments/:id/attributes
  app.get('/:id/attributes', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'List an instrument\'s free-form attributes',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'object', properties: attributeProps } } },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const exists = await prisma.instrument.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const data = await prisma.instrumentAttribute.findMany({
      where: { instrumentId: id }, select: attributeSelect, orderBy: { key: 'asc' },
    });
    return { data };
  });

  // POST /api/instruments/:id/attributes — set (create OR update) one attribute
  app.post('/:id/attributes', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Set one free-form attribute',
      description: 'Idempotent on the key: setting an existing key updates it (200) rather than adding a second row (201 on first create). The key is trimmed, so " Room " and "Room" are the same attribute.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', required: ['key', 'value'],
        properties: { key: { type: 'string' }, value: { type: 'string' } },
      },
      response: {
        200: { type: 'object', properties: attributeProps },
        201: { type: 'object', properties: attributeProps },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = setInstrumentAttributeSchema.safeParse(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const { key, value } = parsed.data;

    const existing = await prisma.instrument.findUnique({ where: { id }, select: attributeOwnerSelect });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const ctx = buildContext(req);
    const { row, created } = await prisma.$transaction(async (tx) => {
      await lockAttribute(tx, id, key);

      // Read inside the lock: this is what decides create-vs-update, and it is
      // also the audit row's `beforeValue`.
      const before = await tx.instrumentAttribute.findUnique({
        where: { instrumentId_key: { instrumentId: id, key } },
        select: attributeSelect,
      });
      const saved = await tx.instrumentAttribute.upsert({
        where: { instrumentId_key: { instrumentId: id, key } },
        create: { instrumentId: id, key, value },
        update: { value },
        select: attributeSelect,
      });

      // In the SAME transaction (§11.10(e)): a rollback must take the audit row
      // with it, and an attribute may be a calibration date rather than a note.
      await auditLog({
        action: 'INSTRUMENT_ATTRIBUTE_SET', targetType: 'Instrument', targetId: id,
        // No `beforeValue` at all on a create — an absent attribute is not an
        // empty one, and inventing `value: ''` would misreport the history.
        ...(before ? { beforeValue: { code: existing.code, attribute: key, value: before.value } } : {}),
        afterValue: { code: existing.code, attribute: key, value },
        signatureMeaning: before
          ? `Attribute "${key}" on instrument "${existing.code}" changed`
          : `Attribute "${key}" set on instrument "${existing.code}"`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);

      return { row: saved, created: !before };
    });

    // Committed. Now, and only now, tell the device.
    await announceAttributeChange(id, existing, key, value);

    return reply.code(created ? 201 : 200).send(row);
  });

  // PUT /api/instruments/:id/attributes/:key — edit an EXISTING attribute
  app.put('/:id/attributes/:key', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Update an existing attribute\'s value',
      description: 'Does NOT create: POST is the upsert. A mistyped key here returns 404 rather than quietly adding a second attribute nobody asked for.',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, key: { type: 'string' } },
      },
      body: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
      response: { 200: { type: 'object', properties: attributeProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id, key: rawKey } = req.params as { id: string; key: string };
    const parsed = updateInstrumentAttributeSchema.safeParse(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const value = parsed.data.value;
    const key = normaliseKey(rawKey);

    const existing = await prisma.instrument.findUnique({ where: { id }, select: attributeOwnerSelect });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });
    if (!key) return reply.code(404).send(noSuchAttribute(rawKey));

    const ctx = buildContext(req);
    try {
      const saved = await prisma.$transaction(async (tx) => {
        await lockAttribute(tx, id, key);

        const before = await tx.instrumentAttribute.findUnique({
          where: { instrumentId_key: { instrumentId: id, key } },
          select: attributeSelect,
        });
        // Thrown, not returned: the throw is what rolls the transaction back —
        // there is nothing to undo yet here, but keeping the shape means a
        // future statement added above cannot silently survive a 404.
        if (!before) throw new HandledRouteError(404, noSuchAttribute(key));

        const saved = await tx.instrumentAttribute.update({
          where: { instrumentId_key: { instrumentId: id, key } },
          data: { value },
          select: attributeSelect,
        });
        // Same action as POST: an edit and a re-set are the same event, and a
        // trail that distinguished them by which button was pressed would make
        // "every change to this attribute" a two-query question.
        await auditLog({
          action: 'INSTRUMENT_ATTRIBUTE_SET', targetType: 'Instrument', targetId: id,
          beforeValue: { code: existing.code, attribute: key, value: before.value },
          afterValue: { code: existing.code, attribute: key, value },
          signatureMeaning: `Attribute "${key}" on instrument "${existing.code}" changed`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
        return saved;
      });

      // Committed. Now, and only now, tell the device. A 404 above throws past
      // this line, so a refused edit never reaches a broker.
      await announceAttributeChange(id, existing, key, value);
      return saved;
    } catch (err) {
      if (err instanceof HandledRouteError) return reply.code(err.status).send(err.body);
      throw err;
    }
  });

  // DELETE /api/instruments/:id/attributes/:key
  app.delete('/:id/attributes/:key', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Remove an attribute',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, key: { type: 'string' } },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id, key: rawKey } = req.params as { id: string; key: string };
    const key = normaliseKey(rawKey);

    const existing = await prisma.instrument.findUnique({ where: { id }, select: attributeOwnerSelect });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });
    if (!key) return reply.code(404).send(noSuchAttribute(rawKey));

    const ctx = buildContext(req);
    try {
      await prisma.$transaction(async (tx) => {
        await lockAttribute(tx, id, key);

        const before = await tx.instrumentAttribute.findUnique({
          where: { instrumentId_key: { instrumentId: id, key } },
          select: attributeSelect,
        });
        if (!before) throw new HandledRouteError(404, noSuchAttribute(key));

        await tx.instrumentAttribute.delete({
          where: { instrumentId_key: { instrumentId: id, key } },
        });
        // The removed VALUE is in `beforeValue`: once the row is gone this audit
        // record is the only place it survives, and "what did the calibration
        // date say before someone deleted it?" is exactly the §11 question.
        await auditLog({
          action: 'INSTRUMENT_ATTRIBUTE_REMOVED', targetType: 'Instrument', targetId: id,
          beforeValue: { code: existing.code, attribute: key, value: before.value },
          signatureMeaning: `Attribute "${key}" removed from instrument "${existing.code}"`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      });
    } catch (err) {
      if (err instanceof HandledRouteError) return reply.code(err.status).send(err.body);
      throw err;
    }

    // Committed. `null` in `changed` is what tells the device the attribute was
    // REMOVED rather than merely omitted — the re-read inside will no longer
    // contain the key, and both facts travel in the same message.
    await announceAttributeChange(id, existing, key, null);

    return { success: true };
  });
}
