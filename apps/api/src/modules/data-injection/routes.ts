/**
 * Data Injection read surface: telemetry, connection health, dead letters.
 *
 * Telemetry itself is NOT audited (spec D5) — it is process data, not a
 * 21 CFR §11 electronic record, and auditing every reading would bury the
 * trail it is meant to preserve.
 *
 * Resolving a dead letter IS audited: that is an operator asserting a judgement
 * about a record ("this message was investigated and dealt with"), which is
 * exactly the kind of decision §11 exists to capture.
 */
import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { stripHtml } from '../../lib/sanitize.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { getLatest, getHistory } from './telemetry.repository.js';
import { getConnectionHealth } from './connection-manager.js';
import { getQueueStats } from './ingestion.service.js';

const MAX_LIMIT = 1000;

/** Rejects a malformed date rather than silently querying an Invalid Date. */
function parseDate(raw: string | undefined, field: string): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${field} is not a valid date.`);
  return d;
}

/** Telemetry reads, mounted under the existing /api/instruments prefix. */
export async function instrumentTelemetryRoutes(app: FastifyInstance) {

  app.get('/:id/telemetry/latest', {
    preHandler: [app.requirePermission('INSTRUMENT_VIEW')],
    schema: {
      tags: ['Data Injection'], summary: 'Latest value per key for an instrument',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const instrument = await prisma.instrument.findUnique({
      where: { id }, select: { id: true, name: true },
    });
    if (!instrument) throw new NotFoundError('Instrument not found.');
    return { instrumentId: id, readings: await getLatest(id) };
  });

  app.get('/:id/telemetry/history', {
    preHandler: [app.requirePermission('INSTRUMENT_VIEW')],
    schema: {
      tags: ['Data Injection'], summary: 'Historical readings for an instrument',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          key: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
          offset: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as {
      key?: string; from?: string; to?: string; limit?: number; offset?: number;
    };
    const instrument = await prisma.instrument.findUnique({ where: { id }, select: { id: true } });
    if (!instrument) throw new NotFoundError('Instrument not found.');

    const from = parseDate(q.from, 'from');
    const to = parseDate(q.to, 'to');
    if (from && to && from > to) throw new ValidationError('`from` must not be after `to`.');

    return getHistory({
      instrumentId: id,
      key: q.key ? stripHtml(q.key) : undefined,
      from, to,
      limit: q.limit ?? 100,
      offset: q.offset ?? 0,
    });
  });
}

/** Operational surface, mounted at /api/data-injection. */
export default async function dataInjectionRoutes(app: FastifyInstance) {

  app.get('/health', {
    preHandler: [app.requirePermission('INSTRUMENT_VIEW')],
    schema: { tags: ['Data Injection'], summary: 'Protocol connection and ingest queue health' },
  }, async () => ({
    connections: getConnectionHealth(),
    queue: getQueueStats(),
  }));

  app.get('/dead-letters', {
    preHandler: [app.requirePermission('INSTRUMENT_VIEW')],
    schema: {
      tags: ['Data Injection'], summary: 'List dead-lettered messages',
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          resolved: { type: 'boolean' },
          reason: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
          offset: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (req) => {
    const q = req.query as {
      resolved?: boolean; reason?: string; limit?: number; offset?: number;
    };
    const where = {
      ...(q.resolved === undefined ? {} : { resolvedAt: q.resolved ? { not: null } : null }),
      ...(q.reason ? { reason: stripHtml(q.reason) } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.deadLetter.findMany({
        where, orderBy: { receivedAt: 'desc' },
        take: q.limit ?? 100, skip: q.offset ?? 0,
      }),
      prisma.deadLetter.count({ where }),
    ]);
    return { rows, total };
  });

  app.post('/dead-letters/:id/resolve', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Mark a dead-lettered message as resolved',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      // `null` is allowed as well as `object`: `note` is optional, so POSTing
      // with no body at all is legitimate. A bare `type: 'object'` rejects it
      // with "body must be object" — a 400 for a perfectly valid request.
      body: {
        type: ['object', 'null'], additionalProperties: false,
        properties: { note: { type: 'string', maxLength: 1000 } },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('UPDATE_INSTRUMENT', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const { note } = (req.body ?? {}) as { note?: string };
    const ctx = buildContext(req);

    const existing = await prisma.deadLetter.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Dead letter not found.');
    if (existing.resolvedAt) throw new ValidationError('This dead letter is already resolved.');

    return prisma.$transaction(async (tx) => {
      const row = await tx.deadLetter.update({
        where: { id },
        data: { resolvedAt: new Date(), resolvedBy: ctx.userId ?? null },
      });
      await auditLog({
        action: 'DEAD_LETTER_RESOLVED', targetType: 'DeadLetter', targetId: row.id,
        beforeValue: { resolvedAt: null, reason: existing.reason, topic: existing.topic },
        afterValue: {
          resolvedAt: row.resolvedAt, reason: row.reason, topic: row.topic,
          note: note ? stripHtml(note) : null,
        },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
  });
}
