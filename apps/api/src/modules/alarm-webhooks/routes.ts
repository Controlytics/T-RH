import { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { clampSignature } from '../alarms/validation.js';
import { validateTargetDraft, type TargetDraft } from './validation.js';
import { expandLocations, targetMatches } from './target-scope.js';
import { deliverToTarget } from './send.js';
import { buildWebhookVariables } from './build-variables.js';
import type { FlNode } from '../functional-locations/tree.js';
import { DEFAULT_WEBHOOK_BODY_TEMPLATE } from '@digilog/shared';

/**
 * Alarm webhook targets — the IP hooters an alarm is announced to.
 *
 * Design: docs/superpowers/specs/2026-08-27-alarm-webhook-annunciator-design.md
 *
 * Gated on ALARM_RULE_READ / ALARM_RULE_MANAGE deliberately: a role that can decide
 * WHEN an alarm fires can already decide WHERE it is announced, so this adds no
 * permission.
 */

// EVERY field returned must appear here. Fastify silently strips what it does not
// declare — no error, no warning, and a server-side test still passes because the
// value was there before serialisation. This has bitten this repo twice.
const targetProps = {
  id: { type: 'string' },
  name: { type: 'string' },
  description: { type: 'string', nullable: true },
  url: { type: 'string' },
  method: { type: 'string' },
  headers: { type: 'object', additionalProperties: true },
  contentType: { type: 'string' },
  bodyTemplate: { type: 'string' },
  successRegex: { type: 'string', nullable: true },
  timeoutMs: { type: 'integer' },
  fireOnRaised: { type: 'boolean' },
  fireOnCleared: { type: 'boolean' },
  fireOnAcknowledged: { type: 'boolean' },
  severities: { type: 'array', items: { type: 'string' }, nullable: true },
  cooldownSeconds: { type: 'integer' },
  isActive: { type: 'boolean' },
  scopeLocationIds: { type: 'array', items: { type: 'string' } },
  scopeInstrumentIds: { type: 'array', items: { type: 'string' } },
  /** Resolved server-side so an accidentally empty scope is visible on the page. */
  instrumentCount: { type: 'integer' },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
} as const;

const deliveryProps = {
  id: { type: 'string' },
  targetId: { type: 'string' },
  alarmId: { type: 'string', nullable: true },
  event: { type: 'string' },
  url: { type: 'string' },
  requestBody: { type: 'string' },
  httpStatus: { type: 'integer', nullable: true },
  responseSnippet: { type: 'string', nullable: true },
  attempt: { type: 'integer' },
  status: { type: 'string' },
  error: { type: 'string', nullable: true },
  createdAt: { type: 'string' },
  sentAt: { type: 'string', nullable: true },
} as const;

/** The stored row, as Prisma hands it back. Json columns arrive untyped. */
type TargetRow = Prisma.AlarmWebhookTargetGetPayload<Record<string, never>>;

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const asHeaders = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};

const asSeverities = (v: unknown): string[] | null => (v === null || v === undefined ? null : asStringArray(v));

/**
 * ONE mapper, so "every targetProps key is emitted" is mechanical rather than a
 * property-by-property spread that quietly drops a field when the model grows.
 */
function toTargetResponse(row: TargetRow, instrumentCount: number) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    url: row.url,
    method: row.method,
    headers: asHeaders(row.headers),
    contentType: row.contentType,
    bodyTemplate: row.bodyTemplate,
    successRegex: row.successRegex ?? null,
    timeoutMs: row.timeoutMs,
    fireOnRaised: row.fireOnRaised,
    fireOnCleared: row.fireOnCleared,
    fireOnAcknowledged: row.fireOnAcknowledged,
    severities: asSeverities(row.severities),
    cooldownSeconds: row.cooldownSeconds,
    isActive: row.isActive,
    scopeLocationIds: asStringArray(row.scopeLocationIds),
    scopeInstrumentIds: asStringArray(row.scopeInstrumentIds),
    instrumentCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDeliveryResponse(row: {
  id: string; targetId: string; alarmId: string | null; event: string; url: string;
  requestBody: string; httpStatus: number | null; responseSnippet: string | null;
  attempt: number; status: string; error: string | null; createdAt: Date; sentAt: Date | null;
}) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}

/**
 * How many instruments this target's SCOPE names.
 *
 * Deliberately measured with the fire flags and severity filter held OPEN. The number
 * exists so an accidentally empty scope is visible on the page; a deactivated target,
 * or one narrowed to MINOR, still has the scope it has, and reporting 0 for it would
 * hide the very mistake this count is here to expose. The matcher itself is reused
 * unchanged so the two never drift.
 *
 * The tree and the instrument list are loaded ONCE for the whole request — a query
 * per target would put the list route's cost on the number of hooters configured.
 */
async function resolveInstrumentCounts(
  targets: Pick<TargetRow, 'id' | 'scopeLocationIds' | 'scopeInstrumentIds'>[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (targets.length === 0) return counts;

  const [locations, instruments] = await Promise.all([
    prisma.functionalLocation.findMany({ select: { id: true, name: true, type: true, parentId: true } }),
    prisma.instrument.findMany({ select: { id: true, functionalLocationId: true } }),
  ]);
  const nodes = locations.map((l) => ({ ...l, type: l.type as FlNode['type'] })) as FlNode[];

  for (const t of targets) {
    const scopeLocationIds = asStringArray(t.scopeLocationIds);
    const scopeInstrumentIds = asStringArray(t.scopeInstrumentIds);
    const expanded = expandLocations(scopeLocationIds, nodes);
    const gatesOpen = {
      id: t.id,
      isActive: true,
      fireOnRaised: true,
      fireOnCleared: true,
      fireOnAcknowledged: true,
      severities: null,
      scopeLocationIds,
      scopeInstrumentIds,
    };
    let n = 0;
    for (const i of instruments) {
      if (targetMatches(gatesOpen, {
        event: 'RAISED',
        severity: 'CRITICAL',
        instrumentId: i.id,
        functionalLocationId: i.functionalLocationId,
        locations: expanded,
      })) n++;
    }
    counts.set(t.id, n);
  }
  return counts;
}

/** Prisma needs DbNull for a nullable Json column; a plain null means "JSON null". */
const severitiesForWrite = (v: string[] | null) => (v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));

const targetBodyProps = {
  name: { type: 'string', maxLength: 200 },
  description: { type: 'string', maxLength: 500, nullable: true },
  url: { type: 'string', maxLength: 2000 },
  method: { type: 'string' },
  headers: { type: 'object', additionalProperties: { type: 'string' } },
  contentType: { type: 'string', maxLength: 100 },
  bodyTemplate: { type: 'string' },
  successRegex: { type: 'string', nullable: true },
  timeoutMs: { type: 'integer' },
  fireOnRaised: { type: 'boolean' },
  fireOnCleared: { type: 'boolean' },
  fireOnAcknowledged: { type: 'boolean' },
  severities: { type: 'array', items: { type: 'string' }, nullable: true },
  cooldownSeconds: { type: 'integer' },
  isActive: { type: 'boolean' },
  scopeLocationIds: { type: 'array', items: { type: 'string' } },
  scopeInstrumentIds: { type: 'array', items: { type: 'string' } },
} as const;

/**
 * Builds a draft from a body layered over defaults (create) or the stored row (update).
 * `url`, `bodyTemplate` and `successRegex` are NEVER sanitised — stripHtml empties
 * anything tag-shaped, and a template is full of `${...}`.
 */
function draftFrom(body: Record<string, unknown>, base: Partial<TargetDraft>): TargetDraft {
  const pick = <T>(key: string, fallback: T): T => (body[key] === undefined ? fallback : (body[key] as T));
  return {
    name: String(pick('name', base.name ?? '')),
    description: pick('description', base.description ?? null) as string | null,
    url: String(pick('url', base.url ?? '')),
    method: String(pick('method', base.method ?? 'POST')),
    headers: asHeaders(pick('headers', base.headers ?? {})),
    contentType: String(pick('contentType', base.contentType ?? 'application/json')),
    bodyTemplate: String(pick('bodyTemplate', base.bodyTemplate ?? DEFAULT_WEBHOOK_BODY_TEMPLATE)),
    successRegex: (pick('successRegex', base.successRegex ?? null) as string | null) || null,
    timeoutMs: pick('timeoutMs', base.timeoutMs ?? 5000) as number,
    severities: asSeverities(pick('severities', base.severities ?? null)),
    cooldownSeconds: pick('cooldownSeconds', base.cooldownSeconds ?? 0) as number,
    scopeLocationIds: asStringArray(pick('scopeLocationIds', base.scopeLocationIds ?? [])),
    scopeInstrumentIds: asStringArray(pick('scopeInstrumentIds', base.scopeInstrumentIds ?? [])),
  };
}

export default async function alarmWebhookRoutes(app: FastifyInstance) {
  // ── GET / ─────────────────────────────────────────────────────────────────
  app.get('/', {
    preHandler: [app.requirePermission('ALARM_RULE_READ')],
    schema: {
      tags: ['Alarm Webhooks'],
      summary: 'List alarm webhook targets',
      response: {
        200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: targetProps } } } },
        ...errorResponses,
      },
    },
  }, async () => {
    const rows = await prisma.alarmWebhookTarget.findMany({ orderBy: { name: 'asc' } });
    const counts = await resolveInstrumentCounts(rows);
    return { data: rows.map((r) => toTargetResponse(r, counts.get(r.id) ?? 0)) };
  });

  // ── GET /:id ──────────────────────────────────────────────────────────────
  app.get('/:id', {
    preHandler: [app.requirePermission('ALARM_RULE_READ')],
    schema: {
      tags: ['Alarm Webhooks'],
      summary: 'Get one alarm webhook target',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', properties: targetProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.alarmWebhookTarget.findUnique({ where: { id } });
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Alarm webhook target not found.' });
    const counts = await resolveInstrumentCounts([row]);
    return toTargetResponse(row, counts.get(row.id) ?? 0);
  });

  // ── POST / — the reference handler. Every other mutating route follows this exact
  // shape: reauth first, validate, write, audit with afterValue.name, return a
  // fully-declared response.
  app.post('/', {
    preHandler: [app.requirePermission('ALARM_RULE_MANAGE')],
    schema: {
      tags: ['Alarm Webhooks'],
      summary: 'Create an alarm webhook target (e-signature: re-authentication)',
      body: { type: 'object', required: ['name', 'url'], properties: targetBodyProps },
      response: { 201: { type: 'object', properties: targetProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('MANAGE_ALARM_WEBHOOK', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    // `description` is operator prose and IS sanitised; there is no free-text reason on
    // create. `url` and `bodyTemplate` are skipped: stripHtml empties anything
    // tag-shaped, and a template is full of `${...}` and braces.
    const body = sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['url', 'bodyTemplate', 'successRegex']);

    const draft = draftFrom(body, {});
    const refusal = validateTargetDraft(draft);
    if (refusal) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: refusal.message, field: refusal.field });
    }

    const created = await prisma.alarmWebhookTarget.create({
      data: {
        name: draft.name.trim(),
        description: draft.description || null,
        url: draft.url,
        method: draft.method,
        headers: draft.headers as Prisma.InputJsonValue,
        contentType: draft.contentType,
        bodyTemplate: draft.bodyTemplate,
        successRegex: draft.successRegex,
        timeoutMs: draft.timeoutMs,
        severities: severitiesForWrite(draft.severities),
        cooldownSeconds: draft.cooldownSeconds,
        scopeLocationIds: draft.scopeLocationIds as Prisma.InputJsonValue,
        scopeInstrumentIds: draft.scopeInstrumentIds as Prisma.InputJsonValue,
        fireOnRaised: body.fireOnRaised !== false,
        fireOnCleared: body.fireOnCleared !== false,
        fireOnAcknowledged: body.fireOnAcknowledged !== false,
        isActive: body.isActive !== false,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'ALARM_WEBHOOK_CREATED',
      targetType: 'AlarmWebhookTarget', targetId: created.id,
      // `name` is what the audit trail's {targetName} placeholder reads.
      afterValue: { name: created.name, url: created.url, method: created.method, isActive: created.isActive },
      signatureMeaning: clampSignature(`Created alarm webhook "${created.name}" -> ${created.url}`),
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    const counts = await resolveInstrumentCounts([created]);
    return reply.code(201).send(toTargetResponse(created, counts.get(created.id) ?? 0));
  });

  // ── PUT /:id ──────────────────────────────────────────────────────────────
  app.put('/:id', {
    preHandler: [app.requirePermission('ALARM_RULE_MANAGE')],
    schema: {
      tags: ['Alarm Webhooks'],
      summary: 'Update an alarm webhook target (e-signature: re-authentication)',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: { type: 'object', properties: targetBodyProps },
      response: { 200: { type: 'object', properties: targetProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('MANAGE_ALARM_WEBHOOK', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);
    const current = await prisma.alarmWebhookTarget.findUnique({ where: { id } });
    if (!current) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Alarm webhook target not found.' });

    const body = sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['url', 'bodyTemplate', 'successRegex']);
    // A partial body must keep the stored value for every key it omits — the page's
    // Activate / Deactivate toggle sends `isActive` alone.
    const draft = draftFrom(body, {
      name: current.name,
      description: current.description,
      url: current.url,
      method: current.method,
      headers: asHeaders(current.headers),
      contentType: current.contentType,
      bodyTemplate: current.bodyTemplate,
      successRegex: current.successRegex,
      timeoutMs: current.timeoutMs,
      severities: asSeverities(current.severities),
      cooldownSeconds: current.cooldownSeconds,
      scopeLocationIds: asStringArray(current.scopeLocationIds),
      scopeInstrumentIds: asStringArray(current.scopeInstrumentIds),
    });
    const refusal = validateTargetDraft(draft);
    if (refusal) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: refusal.message, field: refusal.field });
    }

    const updated = await prisma.alarmWebhookTarget.update({
      where: { id },
      data: {
        name: draft.name.trim(),
        description: draft.description || null,
        url: draft.url,
        method: draft.method,
        headers: draft.headers as Prisma.InputJsonValue,
        contentType: draft.contentType,
        bodyTemplate: draft.bodyTemplate,
        successRegex: draft.successRegex,
        timeoutMs: draft.timeoutMs,
        severities: severitiesForWrite(draft.severities),
        cooldownSeconds: draft.cooldownSeconds,
        scopeLocationIds: draft.scopeLocationIds as Prisma.InputJsonValue,
        scopeInstrumentIds: draft.scopeInstrumentIds as Prisma.InputJsonValue,
        fireOnRaised: typeof body.fireOnRaised === 'boolean' ? body.fireOnRaised : current.fireOnRaised,
        fireOnCleared: typeof body.fireOnCleared === 'boolean' ? body.fireOnCleared : current.fireOnCleared,
        fireOnAcknowledged: typeof body.fireOnAcknowledged === 'boolean' ? body.fireOnAcknowledged : current.fireOnAcknowledged,
        isActive: typeof body.isActive === 'boolean' ? body.isActive : current.isActive,
        updatedBy: ctx.userId,
      },
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'ALARM_WEBHOOK_UPDATED',
      targetType: 'AlarmWebhookTarget', targetId: id,
      beforeValue: { name: current.name, url: current.url, method: current.method, isActive: current.isActive },
      afterValue: { name: updated.name, url: updated.url, method: updated.method, isActive: updated.isActive },
      signatureMeaning: clampSignature(`Updated alarm webhook "${updated.name}" -> ${updated.url}`),
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    const counts = await resolveInstrumentCounts([updated]);
    return toTargetResponse(updated, counts.get(updated.id) ?? 0);
  });

  // ── DELETE /:id ───────────────────────────────────────────────────────────
  app.delete('/:id', {
    preHandler: [app.requirePermission('ALARM_RULE_MANAGE')],
    schema: {
      tags: ['Alarm Webhooks'],
      summary: 'Delete an alarm webhook target (e-signature: reason + re-authentication)',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['reason'],
        // In the BODY, never a query string: a free-text reason must not land in access
        // logs. Bounded because `audit_trail.signature_meaning` is VARCHAR(255) and an
        // overflow throws INSIDE auditLog — after the delete has committed, leaving a
        // regulated action with no audit row.
        properties: { reason: { type: 'string', maxLength: 500 } },
      },
      response: { 204: { type: 'null' }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('MANAGE_ALARM_WEBHOOK', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);
    // `reason` is EXEMPT from sanitizeStrings: stripHtml empties anything tag-shaped,
    // so "value < 20 per SOP-114" would be silently blanked into a regulated record.
    const body = sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['reason']);
    const reason = String(body.reason ?? '').trim();
    // Guarded here as well as in the schema, so the refusal does not depend on how
    // Fastify treats an absent DELETE body.
    if (!reason) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'A reason is required.', field: 'reason' });
    }

    const current = await prisma.alarmWebhookTarget.findUnique({ where: { id } });
    if (!current) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Alarm webhook target not found.' });

    // The FK is RESTRICT because a delivery row is evidence about a regulated event.
    // Counted first so the refusal names the number and points at deactivation — a raw
    // FK violation would surface as a 500 naming nothing.
    const used = await prisma.alarmWebhookDelivery.count({ where: { targetId: id } });
    if (used > 0) {
      return reply.code(409).send({
        error: 'TARGET_HAS_DELIVERIES',
        message: `"${current.name}" has ${used} delivery record(s) and cannot be deleted. Deactivate it instead.`,
      });
    }

    await prisma.alarmWebhookTarget.delete({ where: { id } });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'ALARM_WEBHOOK_DELETED',
      targetType: 'AlarmWebhookTarget', targetId: id,
      beforeValue: { name: current.name, url: current.url, method: current.method, isActive: current.isActive },
      reason,
      signatureMeaning: clampSignature(`Deleted alarm webhook "${current.name}" — ${reason}`),
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return reply.code(204).send();
  });

  // ── POST /:id/test ────────────────────────────────────────────────────────
  app.post('/:id/test', {
    preHandler: [app.requirePermission('ALARM_RULE_MANAGE')],
    schema: {
      tags: ['Alarm Webhooks'],
      summary: 'Test-fire an alarm webhook target (e-signature: re-authentication)',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            httpStatus: { type: 'integer', nullable: true },
            responseSnippet: { type: 'string', nullable: true },
            error: { type: 'string', nullable: true },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('MANAGE_ALARM_WEBHOOK', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);
    const target = await prisma.alarmWebhookTarget.findUnique({ where: { id } });
    if (!target) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Alarm webhook target not found.' });

    // Fires REGARDLESS of scope, severity filter, isActive and the fire flags —
    // commissioning a hooter must not require first configuring the conditions you
    // are trying to test.
    const variables = buildWebhookVariables('TEST', {
      alarmId: 'TEST',
      instrumentId: 'TEST',
      instrumentCode: 'TEST',
      instrumentName: 'Test fire',
      metric: 'TEMPERATURE',
      severity: 'CRITICAL',
      ruleName: 'Manual test',
      condition: 'manual test from the alarm webhook page',
      triggeredValue: 0,
      raisedAt: new Date(),
    });
    const delivered = await deliverToTarget(
      {
        id: target.id, url: target.url, method: target.method, headers: target.headers,
        contentType: target.contentType, bodyTemplate: target.bodyTemplate,
        successRegex: target.successRegex, timeoutMs: target.timeoutMs,
      },
      'TEST',
      null,
      variables,
    );

    // deliverToTarget returns only a boolean and writes a row per attempt. The raw
    // status and response body are what an operator diagnoses a silent hooter with,
    // so they are read back off the newest attempt rather than re-derived.
    const last = await prisma.alarmWebhookDelivery.findFirst({
      where: { targetId: id, event: 'TEST' },
      orderBy: [{ createdAt: 'desc' }, { attempt: 'desc' }],
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'ALARM_WEBHOOK_TESTED',
      targetType: 'AlarmWebhookTarget', targetId: id,
      // The OUTCOME belongs in the audit row: "test-fired" with no result is not
      // evidence that anything sounded.
      afterValue: {
        name: target.name,
        url: target.url,
        ok: delivered,
        httpStatus: last?.httpStatus ?? null,
        error: last?.error ?? null,
      },
      signatureMeaning: clampSignature(
        `Test-fired alarm webhook "${target.name}" -> ${target.url} — ${delivered ? 'delivered' : 'failed'}`,
      ),
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return {
      ok: delivered,
      httpStatus: last?.httpStatus ?? null,
      responseSnippet: last?.responseSnippet ?? null,
      error: last?.error ?? null,
    };
  });

  // ── GET /:id/deliveries ───────────────────────────────────────────────────
  app.get('/:id/deliveries', {
    preHandler: [app.requirePermission('ALARM_RULE_READ')],
    schema: {
      tags: ['Alarm Webhooks'],
      summary: 'Delivery log for one alarm webhook target, newest first',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer' }, offset: { type: 'integer' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object', properties: deliveryProps } },
            total: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { limit?: number; offset?: number };
    const target = await prisma.alarmWebhookTarget.findUnique({ where: { id }, select: { id: true } });
    if (!target) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Alarm webhook target not found.' });

    const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const skip = Math.max(q.offset ?? 0, 0);
    const [rows, total] = await Promise.all([
      prisma.alarmWebhookDelivery.findMany({
        where: { targetId: id },
        // Same order as the @@index([targetId, createdAt(sort: Desc)]); `attempt`
        // breaks the tie between rows written inside the same millisecond, so a
        // 3-attempt burst reads back in the order it happened.
        orderBy: [{ createdAt: 'desc' }, { attempt: 'desc' }],
        take, skip,
      }),
      prisma.alarmWebhookDelivery.count({ where: { targetId: id } }),
    ]);
    return { data: rows.map(toDeliveryResponse), total };
  });
}
