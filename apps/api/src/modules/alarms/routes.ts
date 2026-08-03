/**
 * Alarms REST surface — the alarm queue, the §11.50 acknowledgement, and
 * threshold CRUD.
 *
 * Two deliberate deviations from the instruments/routes.ts template:
 *
 *  1. Acknowledgement uses `enforceReauthAlways`, NOT `enforceReauth`.
 *     `enforceReauth` consults the admin-managed action-reauth config and skips
 *     the password challenge when the action is not configured for the caller's
 *     role — i.e. an administrator could switch the electronic signature off.
 *     The acknowledgement IS the signature (21 CFR §11.50), so it is intrinsic
 *     to the action rather than an opt-in policy.
 *  2. Threshold CRUD keeps the configurable `enforceReauth`. Configuring a
 *     limit is an engineering decision, not a signed disposition, so an
 *     operator may reasonably choose not to challenge it.
 *
 * Nothing here writes alarm STATE except the acknowledgement. Raise, re-breach
 * and resolve belong to the ingest flush (alarm.service.ts) and the liveness
 * sweep; a REST caller must not be able to close out a deviation by hand.
 */
import { type FastifyInstance } from 'fastify';
import { Prisma, type ThresholdOperator } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth, enforceReauthAlways } from '../../lib/reauth-check.js';
import { stripHtml } from '../../lib/sanitize.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { dispatchNotification } from '../notification-delivery/notification-dispatcher.js';
import { applyAck } from './alarm-state.js';

const OPERATORS = ['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ', 'OUT_OF_RANGE'] as const;
const SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR', 'INFO'] as const;
const STATES = ['ACTIVE', 'ACTIVE_ACKED', 'RESOLVED_UNACKED', 'CLOSED'] as const;

/** True for a Prisma foreign-key-violation error (P2003) — no global mapping exists for it. */
function isFkViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
}

interface ThresholdShape {
  operator: ThresholdOperator;
  limit: number | null;
  limitLow: number | null;
  limitHigh: number | null;
  hysteresis: number;
}

/**
 * Validates the threshold the row would END UP as — callers merge the request
 * body over the stored row before calling, so a PUT that touches only
 * `hysteresis` is checked against the limits already on disk. Validating the
 * body alone would let an unrecoverable configuration in through the update
 * path, which is exactly how the create-side guard gets bypassed in practice.
 */
function validateThreshold(t: ThresholdShape): void {
  if (t.hysteresis < 0) {
    throw new ValidationError('hysteresis cannot be negative.');
  }
  if (t.operator === 'OUT_OF_RANGE') {
    if (t.limitLow === null || t.limitHigh === null) {
      throw new ValidationError('OUT_OF_RANGE requires both limitLow and limitHigh.');
    }
    if (t.limitLow >= t.limitHigh) {
      throw new ValidationError('limitLow must be less than limitHigh.');
    }
    // The evaluator recovers an OUT_OF_RANGE excursion only while
    // `limitLow + h <= value <= limitHigh - h` (threshold-evaluator.ts:76-78).
    // Once 2h reaches the width of the band those bounds cross — or meet at a
    // single unreachable point — and NO reading can ever recover the alarm. It
    // would latch permanently and demand a signed acknowledgement forever, so
    // reject the configuration instead of shipping it.
    if (2 * t.hysteresis >= t.limitHigh - t.limitLow) {
      throw new ValidationError(
        'hysteresis is too wide for this range — the alarm could never recover. '
        + 'Require 2 x hysteresis < (limitHigh - limitLow).',
      );
    }
  } else if (t.limit === null) {
    throw new ValidationError(`Operator ${t.operator} requires a limit.`);
  }
}

/** Body properties shared by threshold create and update. */
const thresholdProps = {
  key: { type: 'string', minLength: 1, maxLength: 100 },
  operator: { type: 'string', enum: [...OPERATORS] },
  limit: { type: ['number', 'null'] },
  limitLow: { type: ['number', 'null'] },
  limitHigh: { type: ['number', 'null'] },
  hysteresis: { type: 'number', minimum: 0 },
  severity: { type: 'string', enum: [...SEVERITIES] },
  isActive: { type: 'boolean' },
  _currentPassword: { type: 'string' },
} as const;

const alarmInclude = {
  instrument: { select: { id: true, name: true, code: true } },
  threshold: { select: { id: true, operator: true, limit: true, limitLow: true, limitHigh: true } },
} as const;

export default async function alarmRoutes(app: FastifyInstance) {

  app.get('/', {
    preHandler: [app.requirePermission('ALARM_VIEW')],
    schema: {
      tags: ['Data Injection'], summary: 'List alarms',
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          state: { type: 'string', enum: [...STATES] },
          severity: { type: 'string', enum: [...SEVERITIES] },
          instrumentId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
        },
      },
    },
  }, async (req) => {
    const q = req.query as { state?: string; severity?: string; instrumentId?: string; limit?: number };
    return prisma.alarm.findMany({
      where: {
        ...(q.state && { state: q.state as never }),
        ...(q.severity && { severity: q.severity as never }),
        ...(q.instrumentId && { instrumentId: q.instrumentId }),
      },
      include: alarmInclude,
      // Newest excursion first — the queue is worked from the top.
      orderBy: { firstBreachAt: 'desc' },
      take: q.limit ?? 200,
    });
  });

  app.get('/:id', {
    preHandler: [app.requirePermission('ALARM_VIEW')],
    schema: {
      tags: ['Data Injection'], summary: 'Get one alarm',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await prisma.alarm.findUnique({ where: { id }, include: alarmInclude });
    if (!row) throw new NotFoundError('Alarm not found.');
    return row;
  });

  app.post('/:id/acknowledge', {
    preHandler: [app.requirePermission('ALARM_ACKNOWLEDGE')],
    schema: {
      tags: ['Data Injection'], summary: 'Acknowledge an alarm',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', additionalProperties: false, required: ['reason'],
        properties: {
          reason: { type: 'string', minLength: 1, maxLength: 1000 },
          _currentPassword: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    // ALWAYS-on: the acknowledgement is the e-signature, so it must not be
    // disableable through the admin-managed action-reauth config.
    if (!(await enforceReauthAlways('ACKNOWLEDGE_ALARM', req, reply)).ok) return reply;

    const { id } = req.params as { id: string };
    const { reason } = req.body as { reason: string };
    const clean = stripHtml(reason).trim();
    // minLength:1 in the schema passes a string of markup or spaces; the signed
    // meaning of the record must not end up blank.
    if (clean.length === 0) throw new ValidationError('A reason is required to acknowledge an alarm.');

    const ctx = buildContext(req);
    const existing = await prisma.alarm.findUnique({
      where: { id },
      include: { instrument: { select: { name: true } } },
    });
    if (!existing) throw new NotFoundError('Alarm not found.');

    const next = applyAck(existing.state);
    if (next === null) {
      // Not a no-op — re-signing an already-signed record would put a second
      // attributable signature on one event.
      return reply.code(409).send({
        error: 'ALREADY_ACKNOWLEDGED',
        message: `Alarm is ${existing.state} and cannot be acknowledged again.`,
      });
    }

    const now = new Date();
    // Human-readable identity for the audit row. AUDIT_TEMPLATE_DEFAULTS renders
    // `Alarm "{targetName}" acknowledged by {actor}`, and targetName resolves from
    // afterValue.name — without this an inspector sees which USER signed but not
    // WHAT they signed.
    const targetName = `${existing.instrument.name} / ${existing.key}`;

    const updated = await prisma.$transaction(async (tx) => {
      // COMPARE-AND-SET on `state`. The read above is outside this transaction,
      // so an unconditional update would let two concurrent acknowledgements
      // both clear the applyAck check and the second would overwrite the first
      // signer's ackedBy/ackedAt/ackReason and write a SECOND audit row — a
      // regulated §11.50 signature attributed to the wrong person, with two
      // conflicting rows for one event. Naming the read state in the WHERE
      // makes Postgres arbitrate: under READ COMMITTED the loser's UPDATE
      // blocks on the winner's row lock, then re-evaluates the predicate
      // against the committed new state and matches nothing.
      const res = await tx.alarm.updateMany({
        where: { id, state: existing.state },
        data: {
          state: next, ackedBy: ctx.userId, ackedAt: now, ackReason: clean,
          // Only stamp closedAt on the transition that actually closes. The
          // brief's `: null` arm would blank a timestamp on any other path.
          ...(next === 'CLOSED' && { closedAt: now }),
        },
      });
      // Lost the race. Return without writing an audit row — the winner's
      // signature is the only one that happened.
      if (res.count === 0) return null;
      // updateMany returns a count, not the row; re-read inside the same
      // transaction so the response and notification reflect the post-write
      // state rather than the stale pre-read.
      const row = await tx.alarm.findUniqueOrThrow({ where: { id } });
      await auditLog({
        action: 'ALARM_ACKNOWLEDGED', targetType: 'Alarm', targetId: id,
        beforeValue: { state: existing.state },
        afterValue: {
          name: targetName, state: next, breachCount: row.breachCount,
          instrumentId: row.instrumentId, key: row.key, severity: row.severity,
        },
        reason: clean,
        signatureMeaning: 'Acknowledged alarm',
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });

    if (updated === null) {
      const current = await prisma.alarm.findUnique({ where: { id }, select: { state: true } });
      return reply.code(409).send({
        error: 'ALARM_STATE_CHANGED',
        message: `Alarm was ${existing.state} when read and is now ${current?.state ?? 'unknown'}; `
          + 'it was not acknowledged. Reload and review the current state before signing.',
      });
    }

    // Fire-and-forget with a logged catch — the alarm row and its audit row are
    // both committed above, so the regulated record survives whatever the
    // notifier does. `instrumentName` (not instrumentId) is what every
    // ALARM_ACKNOWLEDGED consumer renders; ALARM_RAISED shipped with exactly
    // this bug and it is bound by a test in __tests__.
    void dispatchNotification({
      eventType: 'ALARM_ACKNOWLEDGED',
      context: { severity: updated.severity, instrumentId: updated.instrumentId },
      variables: {
        instrumentName: existing.instrument.name,
        instrumentId: updated.instrumentId,
        key: updated.key, severity: updated.severity,
        ackedBy: ctx.userId ?? 'unknown', reason: clean,
        timestamp: now.toISOString(),
      },
    }).catch(err => app.log.error({ err }, 'alarm-ack notification dispatch failed'));

    return updated;
  });
}

/**
 * Threshold CRUD. Mounted at /api/alarm-thresholds — separate from the alarm
 * queue because a threshold is configuration, whereas an alarm is a record.
 */
export async function alarmThresholdRoutes(app: FastifyInstance) {

  app.post('/', {
    preHandler: [app.requirePermission('ALARM_THRESHOLD_MANAGE')],
    schema: {
      tags: ['Data Injection'], summary: 'Create alarm threshold',
      body: {
        type: 'object', additionalProperties: false,
        required: ['instrumentId', 'key', 'operator', 'severity'],
        properties: { instrumentId: { type: 'string' }, ...thresholdProps },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('MANAGE_ALARM_THRESHOLD', req, reply)).ok) return reply;
    const b = req.body as Record<string, never>;
    const ctx = buildContext(req);

    const instrumentId = b.instrumentId as string;
    const shape: ThresholdShape = {
      operator: b.operator as ThresholdOperator,
      limit: (b.limit as number | null | undefined) ?? null,
      limitLow: (b.limitLow as number | null | undefined) ?? null,
      limitHigh: (b.limitHigh as number | null | undefined) ?? null,
      hysteresis: (b.hysteresis as number | undefined) ?? 0,
    };
    validateThreshold(shape);

    const instrument = await prisma.instrument.findUnique({ where: { id: instrumentId } });
    if (!instrument) throw new ValidationError('instrumentId does not reference an existing instrument.');

    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const row = await tx.alarmThreshold.create({
          data: {
            instrumentId,
            key: stripHtml(b.key as string),
            operator: shape.operator,
            limit: shape.limit, limitLow: shape.limitLow, limitHigh: shape.limitHigh,
            hysteresis: shape.hysteresis,
            severity: b.severity as never,
            ...(b.isActive !== undefined && { isActive: b.isActive as boolean }),
            createdBy: ctx.userId,
          },
        });
        await auditLog({
          action: 'ALARM_THRESHOLD_CREATED', targetType: 'AlarmThreshold', targetId: row.id,
          afterValue: {
            name: `${instrument.name} / ${row.key}`,
            instrumentId, key: row.key, operator: row.operator,
            limit: row.limit, limitLow: row.limitLow, limitHigh: row.limitHigh,
            hysteresis: row.hysteresis, severity: row.severity,
          },
          userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
        return row;
      });
    } catch (err) {
      // Closes the check-then-insert race on a concurrently deleted instrument;
      // P2003 has no global mapping and would otherwise 500.
      if (isFkViolation(err)) throw new ValidationError('The referenced instrument no longer exists.');
      throw err;
    }
    return created;
  });

  app.put('/:id', {
    preHandler: [app.requirePermission('ALARM_THRESHOLD_MANAGE')],
    schema: {
      tags: ['Data Injection'], summary: 'Update alarm threshold',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', additionalProperties: false, properties: { ...thresholdProps } },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('MANAGE_ALARM_THRESHOLD', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const ctx = buildContext(req);

    const before = await prisma.alarmThreshold.findUnique({
      where: { id }, include: { instrument: { select: { name: true } } },
    });
    if (!before) throw new NotFoundError('Alarm threshold not found.');

    // Validate the MERGED row, not the patch — see validateThreshold.
    const merged: ThresholdShape = {
      operator: (b.operator as ThresholdOperator | undefined) ?? before.operator,
      limit: b.limit !== undefined ? (b.limit as number | null) : before.limit,
      limitLow: b.limitLow !== undefined ? (b.limitLow as number | null) : before.limitLow,
      limitHigh: b.limitHigh !== undefined ? (b.limitHigh as number | null) : before.limitHigh,
      hysteresis: b.hysteresis !== undefined ? (b.hysteresis as number) : before.hysteresis,
    };
    validateThreshold(merged);

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.alarmThreshold.update({
        where: { id },
        data: {
          ...(b.key !== undefined && { key: stripHtml(b.key as string) }),
          operator: merged.operator,
          limit: merged.limit, limitLow: merged.limitLow, limitHigh: merged.limitHigh,
          hysteresis: merged.hysteresis,
          ...(b.severity !== undefined && { severity: b.severity as never }),
          ...(b.isActive !== undefined && { isActive: b.isActive as boolean }),
        },
      });
      await auditLog({
        action: 'ALARM_THRESHOLD_UPDATED', targetType: 'AlarmThreshold', targetId: id,
        beforeValue: {
          key: before.key, operator: before.operator, limit: before.limit,
          limitLow: before.limitLow, limitHigh: before.limitHigh,
          hysteresis: before.hysteresis, severity: before.severity, isActive: before.isActive,
        },
        afterValue: {
          name: `${before.instrument.name} / ${row.key}`,
          key: row.key, operator: row.operator, limit: row.limit,
          limitLow: row.limitLow, limitHigh: row.limitHigh,
          hysteresis: row.hysteresis, severity: row.severity, isActive: row.isActive,
        },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return updated;
  });

  app.delete('/:id', {
    preHandler: [app.requirePermission('ALARM_THRESHOLD_MANAGE')],
    schema: {
      tags: ['Data Injection'], summary: 'Delete alarm threshold',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      // No body schema. A DELETE is normally sent without one, and a
      // `type: 'object'` schema makes Fastify reject the bodyless request with
      // a bare 400 before the handler runs. The reauth password comes in on
      // the `x-reauth-password` header for this verb (enforceReauth accepts
      // either), same as the instruments delete route.
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('MANAGE_ALARM_THRESHOLD', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);

    const before = await prisma.alarmThreshold.findUnique({
      where: { id }, include: { instrument: { select: { name: true } } },
    });
    if (!before) throw new NotFoundError('Alarm threshold not found.');

    // alarms.threshold_id is onDelete: Restrict — a threshold that has ever
    // fired cannot be destroyed, because the alarm rows are the regulated
    // record of the excursion and must keep pointing at the limit that raised
    // them. Deactivating (isActive:false) is the supported retirement path.
    const raised = await prisma.alarm.count({ where: { thresholdId: id } });
    if (raised > 0) {
      throw new ValidationError(
        `This threshold has raised ${raised} alarm(s) and cannot be deleted — `
        + 'those records reference it. Set isActive to false to retire it instead.',
      );
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.alarmThreshold.delete({ where: { id } });
        await auditLog({
          action: 'ALARM_THRESHOLD_DELETED', targetType: 'AlarmThreshold', targetId: id,
          beforeValue: {
            name: `${before.instrument.name} / ${before.key}`,
            key: before.key, operator: before.operator, severity: before.severity,
          },
          userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      });
    } catch (err) {
      // The count above closes the common case; an alarm raised between the
      // count and the delete still trips the FK, which has no global mapping.
      if (isFkViolation(err)) {
        throw new ValidationError(
          'This threshold has raised alarms and cannot be deleted — '
          + 'set isActive to false to retire it instead.',
        );
      }
      throw err;
    }
    return { success: true };
  });
}

/**
 * Mounted on the /api/alarm-thresholds prefix would make this
 * `/api/alarm-thresholds/instrument/:id`; it belongs to the instrument, so it
 * rides the /api/instruments prefix as a second plugin — the same pattern
 * `instrumentTelemetryRoutes` already uses in app.ts.
 */
export async function instrumentThresholdRoutes(app: FastifyInstance) {
  app.get('/:id/thresholds', {
    preHandler: [app.requirePermission('ALARM_VIEW')],
    schema: {
      tags: ['Data Injection'], summary: 'List alarm thresholds for an instrument',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const instrument = await prisma.instrument.findUnique({ where: { id }, select: { id: true } });
    if (!instrument) throw new NotFoundError('Instrument not found.');
    return prisma.alarmThreshold.findMany({
      where: { instrumentId: id },
      orderBy: [{ key: 'asc' }, { operator: 'asc' }],
    });
  });
}
