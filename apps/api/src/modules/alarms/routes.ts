import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { resolveVisibility } from '../instruments/visibility.js';
import { describeRule } from './decide.js';
import { validateRuleDraft, validateAcknowledgement, clampSignature, type RuleDraft } from './validation.js';

/**
 * Alarm rules and the alarms they raise.
 *
 * Design: docs/superpowers/specs/2026-08-13-alarm-subsystem-design.md
 *
 * ALARMS RESPECT PROJECT D's VISIBILITY SCOPE. An alarm names an instrument, so listing
 * alarms for instruments a role may not see would leak exactly what D withholds — the
 * summary counts included.
 */

const ruleProps = {
  id: { type: 'string' },
  name: { type: 'string' },
  instrumentId: { type: 'string', nullable: true },
  functionalLocationId: { type: 'string', nullable: true },
  metric: { type: 'string' },
  comparison: { type: 'string' },
  thresholdLow: { type: 'number', nullable: true },
  thresholdHigh: { type: 'number', nullable: true },
  delaySeconds: { type: 'integer' },
  severity: { type: 'string' },
  isActive: { type: 'boolean' },
  /** Rendered server-side so the rules page and the alarm row read identically. */
  description: { type: 'string' },
  targetLabel: { type: 'string', nullable: true },
  alarmCount: { type: 'integer' },
} as const;

const alarmProps = {
  id: { type: 'string' },
  ruleId: { type: 'string' },
  ruleSnapshot: { type: 'object', additionalProperties: true },
  instrumentId: { type: 'string' },
  instrumentCode: { type: 'string', nullable: true },
  metric: { type: 'string' },
  triggeredValue: { type: 'number', nullable: true },
  severity: { type: 'string' },
  state: { type: 'string' },
  raisedAt: { type: 'string' },
  clearedAt: { type: 'string', nullable: true },
  acknowledgedAt: { type: 'string', nullable: true },
  acknowledgedBy: { type: 'string', nullable: true },
  acknowledgeReason: { type: 'string', nullable: true },
} as const;

function draftFrom(body: Record<string, unknown>): RuleDraft {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : v === null ? null : Number.NaN);
  return {
    name: String(body.name ?? ''),
    instrumentId: (body.instrumentId as string) ?? null,
    functionalLocationId: (body.functionalLocationId as string) ?? null,
    metric: (body.metric ?? 'TEMPERATURE') as RuleDraft['metric'],
    comparison: (body.comparison ?? 'ABOVE') as RuleDraft['comparison'],
    thresholdLow: body.thresholdLow === undefined ? null : num(body.thresholdLow),
    thresholdHigh: body.thresholdHigh === undefined ? null : num(body.thresholdHigh),
    delaySeconds: typeof body.delaySeconds === 'number' ? body.delaySeconds : 0,
  };
}

/**
 * Visibility is a filter on the INSTRUMENT, so on an alarm query it nests under the
 * relation — withVisibility() cannot be used, since that ANDs at the instrument level.
 * Its rule still applies though: AND, never spread. A spread would let a later
 * `instrument` filter key silently replace the visibility filter and widen the result.
 */
function scopedToVisible(
  filters: Record<string, unknown>,
  visibility: Awaited<ReturnType<typeof resolveVisibility>>['where'],
): Record<string, unknown> {
  return visibility ? { AND: [filters, { instrument: visibility }] } : filters;
}

export default async function alarmRoutes(app: FastifyInstance) {
  // ─── Rules ────────────────────────────────────────────────────────────────

  app.get('/rules', {
    preHandler: [app.requirePermission('ALARM_RULE_READ')],
    schema: {
      tags: ['Alarms'],
      summary: 'List alarm rules',
      response: {
        200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: ruleProps } } } },
        ...errorResponses,
      },
    },
  }, async () => {
    const rows = await prisma.alarmRule.findMany({
      orderBy: { name: 'asc' },
      include: {
        instrument: { select: { code: true } },
        functionalLocation: { select: { name: true } },
        _count: { select: { alarms: true } },
      },
    });
    return {
      data: rows.map((r) => ({
        id: r.id, name: r.name,
        instrumentId: r.instrumentId, functionalLocationId: r.functionalLocationId,
        metric: r.metric, comparison: r.comparison,
        thresholdLow: r.thresholdLow, thresholdHigh: r.thresholdHigh,
        delaySeconds: r.delaySeconds, severity: r.severity, isActive: r.isActive,
        description: describeRule(r),
        targetLabel: r.instrument?.code ?? r.functionalLocation?.name ?? null,
        alarmCount: r._count.alarms,
      })),
    };
  });

  app.post('/rules', {
    preHandler: [app.requirePermission('ALARM_RULE_MANAGE')],
    schema: {
      tags: ['Alarms'],
      summary: 'Create an alarm rule',
      response: { 201: { type: 'object', properties: ruleProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('MANAGE_ALARM_RULE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const draft = draftFrom(sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['name']));
    const err = validateRuleDraft(draft);
    if (err) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: err.message, field: err.field });

    const created = await prisma.alarmRule.create({
      data: { ...draft, name: draft.name.trim(), severity: 'MAJOR', createdBy: ctx.userId, updatedBy: ctx.userId },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'CONFIG_CHANGED',
      targetType: 'alarm_rule', targetId: created.id,
      afterValue: { name: created.name, condition: describeRule(created), delaySeconds: created.delaySeconds },
      signatureMeaning: clampSignature(`Alarm rule "${created.name}" created — ${describeRule(created)}`),
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return reply.code(201).send({ ...created, description: describeRule(created), targetLabel: null, alarmCount: 0 });
  });

  app.put('/rules/:id', {
    preHandler: [app.requirePermission('ALARM_RULE_MANAGE')],
    schema: {
      tags: ['Alarms'],
      summary: 'Update an alarm rule',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', properties: ruleProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('MANAGE_ALARM_RULE', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);
    const current = await prisma.alarmRule.findUnique({ where: { id } });
    if (!current) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Alarm rule not found.' });

    const body = sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['name']);
    const merged: RuleDraft = {
      ...draftFrom({ ...current, ...body } as Record<string, unknown>),
      // isActive is not part of the draft shape; carried through separately below.
    };
    const err = validateRuleDraft(merged);
    if (err) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: err.message, field: err.field });

    const updated = await prisma.alarmRule.update({
      where: { id },
      data: {
        ...merged,
        name: merged.name.trim(),
        isActive: typeof body.isActive === 'boolean' ? body.isActive : current.isActive,
        updatedBy: ctx.userId,
      },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'CONFIG_CHANGED',
      targetType: 'alarm_rule', targetId: id,
      beforeValue: { name: current.name, condition: describeRule(current), isActive: current.isActive },
      afterValue: { name: updated.name, condition: describeRule(updated), isActive: updated.isActive },
      // Naming the OLD and NEW condition matters: alarms raised before this edit carry
      // their own snapshot, and this row is what ties the two together.
      signatureMeaning: clampSignature(`Alarm rule "${updated.name}" changed from "${describeRule(current)}" to "${describeRule(updated)}"`),
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return { ...updated, description: describeRule(updated), targetLabel: null, alarmCount: 0 };
  });

  app.delete('/rules/:id', {
    preHandler: [app.requirePermission('ALARM_RULE_MANAGE')],
    schema: {
      tags: ['Alarms'],
      summary: 'Delete an alarm rule',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: { 204: { type: 'null' }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('MANAGE_ALARM_RULE', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);
    const current = await prisma.alarmRule.findUnique({ where: { id }, include: { _count: { select: { alarms: true } } } });
    if (!current) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Alarm rule not found.' });

    // The FK is RESTRICT because alarms are regulated records. A constraint error is
    // not actionable, so this says what to do instead: deactivate.
    if (current._count.alarms > 0) {
      return reply.code(409).send({
        error: 'HAS_ALARMS',
        message: `"${current.name}" has raised ${current._count.alarms} alarm(s), which are permanent records and cannot be deleted. Deactivate the rule instead.`,
      });
    }

    await prisma.alarmRule.delete({ where: { id } });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'CONFIG_CHANGED',
      targetType: 'alarm_rule', targetId: id,
      beforeValue: { name: current.name, condition: describeRule(current) },
      signatureMeaning: clampSignature(`Alarm rule "${current.name}" deleted`),
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return reply.code(204).send();
  });

  // ─── Alarms ───────────────────────────────────────────────────────────────

  app.get('/', {
    preHandler: [app.requirePermission('ALARM_READ')],
    schema: {
      tags: ['Alarms'],
      summary: 'List alarms',
      querystring: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['ACTIVE', 'CLEARED'] },
          acknowledged: { type: 'string', enum: ['true', 'false'] },
          instrumentId: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
      response: {
        200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: alarmProps } } } },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const q = req.query as { state?: string; acknowledged?: string; instrumentId?: string; limit?: number };
    const { where: visibility } = await resolveVisibility(buildContext(req));

    const filters: Record<string, unknown> = {};
    if (q.state) filters.state = q.state;
    if (q.acknowledged === 'true') filters.acknowledgedAt = { not: null };
    if (q.acknowledged === 'false') filters.acknowledgedAt = null;
    if (q.instrumentId) filters.instrumentId = q.instrumentId;
    const where = scopedToVisible(filters, visibility);

    const rows = await prisma.alarm.findMany({
      where,
      orderBy: { raisedAt: 'desc' },
      take: Math.min(q.limit ?? 200, 500),
      include: { instrument: { select: { code: true } } },
    });
    return {
      data: rows.map((a) => ({
        ...a,
        instrumentCode: a.instrument?.code ?? null,
        raisedAt: a.raisedAt.toISOString(),
        clearedAt: a.clearedAt?.toISOString() ?? null,
        acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
      })),
    };
  });

  app.post('/:id/acknowledge', {
    preHandler: [app.requirePermission('ALARM_ACKNOWLEDGE')],
    schema: {
      tags: ['Alarms'],
      summary: 'Acknowledge an alarm (e-signature: reason + re-authentication)',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['reason'],
        // Bounded on purpose. `audit_trail.reason` is TEXT, but `signature_meaning` is
        // VARCHAR(255) — an over-long reason would acknowledge the alarm and THEN throw
        // inside auditLog, leaving an acknowledged alarm with no audit row, which is the
        // one outcome §11 cannot tolerate here. Refuse before the write instead. The
        // signature line is also clamped below, since the instrument code varies.
        properties: { reason: { type: 'string', maxLength: 500 } },
      },
      response: { 200: { type: 'object', properties: alarmProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('ACKNOWLEDGE_ALARM', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);
    const body = sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['reason']);
    const reason = String(body.reason ?? '');

    // Visibility-scoped lookup, so an alarm outside this user's scope is NOT FOUND rather
    // than forbidden — a 403 would confirm that an instrument they may not see exists.
    const { where: visibility } = await resolveVisibility(ctx);
    const alarm = await prisma.alarm.findFirst({
      where: scopedToVisible({ id }, visibility) as { id: string },
      include: { instrument: { select: { code: true } } },
    });
    if (!alarm) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Alarm not found.' });

    // `acknowledgedBy` holds a USERNAME, because buildContext's userId is req.user.username
    // (not a UUID) — so the 409 already names a person and needs no user lookup. Querying
    // prisma.user by id with it raises a Postgres invalid-uuid error, which is a 500.
    const refusal = validateAcknowledgement(alarm, reason);
    if (refusal) {
      return refusal.code === 'ALREADY_ACKNOWLEDGED'
        ? reply.code(409).send({ error: refusal.code, message: refusal.message })
        : reply.code(400).send({ error: refusal.code, message: refusal.message, field: refusal.field });
    }

    // Claimed with `acknowledgedAt: null` IN THE WHERE, so two simultaneous requests cannot
    // both pass the check above and have the second overwrite the first signature. The
    // check above still runs first, because it produces the message that names who signed.
    const claim = await prisma.alarm.updateMany({
      where: { id, acknowledgedAt: null },
      data: { acknowledgedAt: new Date(), acknowledgedBy: ctx.userId, acknowledgeReason: reason.trim() },
    });
    if (claim.count === 0) {
      const won = await prisma.alarm.findUnique({ where: { id }, select: { acknowledgedAt: true, acknowledgedBy: true } });
      if (!won?.acknowledgedAt) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Alarm not found.' });
      return reply.code(409).send({
        error: 'ALREADY_ACKNOWLEDGED',
        message: (validateAcknowledgement(won, reason) as { message: string }).message,
      });
    }
    const updated = await prisma.alarm.findUniqueOrThrow({
      where: { id },
      include: { instrument: { select: { code: true } } },
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'ALARM_ACKNOWLEDGED',
      targetType: 'Alarm', targetId: id,
      // `name` is what the audit trail's {targetName} placeholder reads, and the
      // "<code> / <metric>" shape matches the rows already in the trail.
      afterValue: {
        name: `${updated.instrument?.code ?? updated.instrumentId} / ${updated.metric}`,
        instrumentId: updated.instrumentId,
        state: updated.state,
        severity: updated.severity,
        triggeredValue: updated.triggeredValue,
        raisedAt: updated.raisedAt.toISOString(),
      },
      // Reason goes in BOTH: the column is what the audit detail view shows, and the
      // signature meaning is the §11.50 statement of what was signed.
      reason: reason.trim(),
      signatureMeaning: clampSignature(`Acknowledged alarm on ${updated.instrument?.code ?? updated.instrumentId} (${updated.metric}) — ${reason.trim()}`),
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return {
      ...updated,
      instrumentCode: updated.instrument?.code ?? null,
      raisedAt: updated.raisedAt.toISOString(),
      clearedAt: updated.clearedAt?.toISOString() ?? null,
      acknowledgedAt: updated.acknowledgedAt?.toISOString() ?? null,
    };
  });

  app.get('/summary', {
    preHandler: [app.requirePermission('ALARM_READ')],
    schema: {
      tags: ['Alarms'],
      summary: 'Alarm counts for the dashboard card',
      response: {
        200: {
          type: 'object',
          properties: {
            active: { type: 'integer' },
            unacknowledged: { type: 'integer' },
            critical: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const scoped = (extra: Record<string, unknown>) => scopedToVisible(extra, visibility) as never;

    // Counted with the SAME visibility filter as the list, so the card cannot claim
    // more alarms than the page will show.
    const [active, unacknowledged, critical] = await Promise.all([
      prisma.alarm.count({ where: scoped({ state: 'ACTIVE' }) }),
      prisma.alarm.count({ where: scoped({ acknowledgedAt: null }) }),
      prisma.alarm.count({ where: scoped({ state: 'ACTIVE', severity: 'CRITICAL' }) }),
    ]);
    return { active, unacknowledged, critical };
  });
}
