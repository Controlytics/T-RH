import { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { resolvePageSize } from '../../lib/page-size.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { clampSignature } from '../alarms/validation.js';
import { resolveVisibility } from '../instruments/visibility.js';
import { validateTargetDraft, type TargetDraft, type TargetFieldError } from './validation.js';
import { resolveBlockedReason } from '../../lib/outbound-guard.js';
import { expandLocations, targetMatches } from './target-scope.js';
import { deliverToTarget } from './send.js';
import { buildWebhookVariables } from './build-variables.js';
import type { FlNode } from '../functional-locations/tree.js';
import { ALARM_WEBHOOK_DELIVERY_STATUSES, DEFAULT_WEBHOOK_BODY_TEMPLATE } from '@digilog/shared';

/**
 * Alarm webhook targets — the IP hooters an alarm is announced to.
 *
 * Design: docs/superpowers/specs/2026-08-27-alarm-webhook-annunciator-design.md
 *
 * Gated on ALARM_RULE_READ / ALARM_RULE_MANAGE deliberately: a role that can decide
 * WHEN an alarm fires can already decide WHERE it is announced, so this adds no
 * permission.
 *
 * INSTRUMENT VISIBILITY IS SPLIT HERE, on purpose:
 *
 * - The CONFIG routes (`GET /`, `GET /:id`, and the mutations) are NOT scoped,
 *   matching the alarm RULES routes (`alarms/routes.ts`) and unlike the alarm LIST
 *   routes. A half-scoped config surface is worse than an unscoped one: an admin who
 *   could see only half the plant would build a target that silently omitted the rest
 *   and have no way to tell.
 * - `GET /:id/deliveries` IS scoped. It is not configuration, and it returns
 *   `requestBody` verbatim — the instrument code and the reading for every excursion.
 *   See the route for the detail.
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
  cooldownSeconds: { type: 'integer' },
  isActive: { type: 'boolean' },
  scopeLocationIds: { type: 'array', items: { type: 'string' } },
  scopeInstrumentIds: { type: 'array', items: { type: 'string' } },
  /** Resolved server-side so an accidentally empty scope is visible on the page. */
  instrumentCount: { type: 'integer' },
  /**
   * The outcome of this target's most recent delivery attempt, or null if it has
   * never fired. "Did the hooter actually work last time" is the question the config
   * page exists to answer, and it cannot be derived from anything else on the row.
   */
  lastDeliveryStatus: { type: 'string', nullable: true },
  lastDeliveryAt: { type: 'string', nullable: true },
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

/**
 * ONE mapper, so "every targetProps key is emitted" is mechanical rather than a
 * property-by-property spread that quietly drops a field when the model grows.
 */
function toTargetResponse(row: TargetRow, instrumentCount: number, last: LastDelivery | null) {
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
    cooldownSeconds: row.cooldownSeconds,
    isActive: row.isActive,
    scopeLocationIds: asStringArray(row.scopeLocationIds),
    scopeInstrumentIds: asStringArray(row.scopeInstrumentIds),
    instrumentCount,
    lastDeliveryStatus: last?.status ?? null,
    lastDeliveryAt: last ? (last.sentAt ?? last.createdAt).toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface LastDelivery { status: string; createdAt: Date; sentAt: Date | null }

/**
 * The newest delivery per target, in TWO queries regardless of how many targets there
 * are — a per-target lookup would put the list route's cost on the number of hooters
 * configured, the same trap `resolveInstrumentCounts` avoids.
 *
 * `attempt` breaks the tie between rows written inside the same millisecond, matching
 * the delivery log's own ordering, so a 3-attempt burst reports its LAST attempt
 * rather than an arbitrary one.
 */
async function resolveLastDeliveries(targetIds: string[]): Promise<Map<string, LastDelivery>> {
  const out = new Map<string, LastDelivery>();
  if (targetIds.length === 0) return out;

  const newest = await prisma.alarmWebhookDelivery.groupBy({
    by: ['targetId'],
    where: { targetId: { in: targetIds } },
    _max: { createdAt: true },
  });
  const pairs = newest
    .filter((n): n is typeof n & { _max: { createdAt: Date } } => n._max.createdAt !== null)
    .map((n) => ({ targetId: n.targetId, createdAt: n._max.createdAt }));
  if (pairs.length === 0) return out;

  const rows = await prisma.alarmWebhookDelivery.findMany({
    where: { OR: pairs },
    select: { targetId: true, status: true, createdAt: true, sentAt: true, attempt: true },
    orderBy: { attempt: 'asc' },
  });
  // Ascending attempt, so the last write for a target wins.
  for (const r of rows) out.set(r.targetId, { status: r.status, createdAt: r.createdAt, sentAt: r.sentAt });
  return out;
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
 * Deliberately measured with the fire flags held OPEN. The number
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
      scopeLocationIds,
      scopeInstrumentIds,
    };
    let n = 0;
    for (const i of instruments) {
      if (targetMatches(gatesOpen, {
        event: 'RAISED',
        instrumentId: i.id,
        functionalLocationId: i.functionalLocationId,
        locations: expanded,
      })) n++;
    }
    counts.set(t.id, n);
  }
  return counts;
}

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
    cooldownSeconds: pick('cooldownSeconds', base.cooldownSeconds ?? 0) as number,
    scopeLocationIds: asStringArray(pick('scopeLocationIds', base.scopeLocationIds ?? [])),
    scopeInstrumentIds: asStringArray(pick('scopeInstrumentIds', base.scopeInstrumentIds ?? [])),
  };
}

/**
 * The pure draft checks, then the one that needs the network: a URL whose HOST
 * NAME resolves to a blocked address (`localhost`, a name pointed at
 * 169.254.169.254) is refused before storage (audit 2026-10-12 #1, SSRF). The
 * send path judges the address it actually connects to as well, so a name that
 * rebinds after it was saved is still refused.
 */
async function refuseDraft(draft: TargetDraft): Promise<TargetFieldError | null> {
  const refusal = validateTargetDraft(draft);
  if (refusal) return refusal;
  const blocked = await resolveBlockedReason(draft.url);
  return blocked ? { field: 'url', message: `This address cannot be a webhook target: ${blocked}.` } : null;
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
    const [counts, last] = await Promise.all([
      resolveInstrumentCounts(rows),
      resolveLastDeliveries(rows.map((r) => r.id)),
    ]);
    return { data: rows.map((r) => toTargetResponse(r, counts.get(r.id) ?? 0, last.get(r.id) ?? null)) };
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
    const [counts, last] = await Promise.all([resolveInstrumentCounts([row]), resolveLastDeliveries([row.id])]);
    return toTargetResponse(row, counts.get(row.id) ?? 0, last.get(row.id) ?? null);
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
    const refusal = await refuseDraft(draft);
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
    // A target cannot have fired before it existed.
    return reply.code(201).send(toTargetResponse(created, counts.get(created.id) ?? 0, null));
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
      cooldownSeconds: current.cooldownSeconds,
      scopeLocationIds: asStringArray(current.scopeLocationIds),
      scopeInstrumentIds: asStringArray(current.scopeInstrumentIds),
    });
    const refusal = await refuseDraft(draft);
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

    const [counts, last] = await Promise.all([resolveInstrumentCounts([updated]), resolveLastDeliveries([updated.id])]);
    return toTargetResponse(updated, counts.get(updated.id) ?? 0, last.get(updated.id) ?? null);
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

    const hasDeliveries = (used: number) => ({
      error: 'TARGET_HAS_DELIVERIES',
      message: `"${current.name}" has ${used} delivery record(s) and cannot be deleted. Deactivate it instead.`,
    });

    // The FK is RESTRICT because a delivery row is evidence about a regulated event.
    // Counted first so the refusal names the number and points at deactivation. The
    // count, the delete and its audit row are ONE transaction (audit 2026-10-03,
    // API-20): a delivery written between a separate count and delete reached the
    // database's own refusal, which surfaced as a 500 naming nothing — and a delete
    // that committed with its audit row still to be written could leave a signed act
    // with no record. The FK's refusal (P2003) is caught below and answered the
    // same way as the count, because it is the same fact.
    try {
      const refusal = await prisma.$transaction(async (tx) => {
        const used = await tx.alarmWebhookDelivery.count({ where: { targetId: id } });
        if (used > 0) return hasDeliveries(used);
        await tx.alarmWebhookTarget.delete({ where: { id } });
        await auditLog({
          userId: ctx.userId, userRole: ctx.userRole,
          action: 'ALARM_WEBHOOK_DELETED',
          targetType: 'AlarmWebhookTarget', targetId: id,
          beforeValue: { name: current.name, url: current.url, method: current.method, isActive: current.isActive },
          reason,
          signatureMeaning: clampSignature(`Deleted alarm webhook "${current.name}" — ${reason}`),
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
        return null;
      });
      if (refusal) return reply.code(409).send(refusal);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2003') {
        const used = await prisma.alarmWebhookDelivery.count({ where: { targetId: id } });
        return reply.code(409).send(hasDeliveries(Math.max(used, 1)));
      }
      throw err;
    }
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

    // Fires REGARDLESS of scope, isActive and the fire flags —
    // commissioning a hooter must not require first configuring the conditions you
    // are trying to test.
    const variables = buildWebhookVariables('TEST', {
      alarmId: 'TEST',
      instrumentId: 'TEST',
      instrumentCode: 'TEST',
      instrumentName: 'Test fire',
      metric: 'TEMPERATURE',
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
      // ONE attempt. A test is a diagnostic, not an annunciation — see deliverToTarget.
      // Three attempts would hold this request open for ~19s against a hooter that does
      // not answer (the common case when commissioning one), and the
      // `ALARM_WEBHOOK_TESTED` row below is written only once the send returns: a
      // process death or a client timeout inside that window would leave a buzzer that
      // physically sounded with no audit row naming who pressed the button. The row
      // stays HERE rather than moving earlier because it deliberately carries the
      // OUTCOME (`ok` / `httpStatus` / `error`) — written first it could only lie. One
      // attempt collapses the exposure to a single `timeoutMs`.
      1,
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
        properties: {
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          // Enumerated here so a bad value is a 400 from the schema rather than a
          // filter that silently matches nothing. Applied to BOTH the page and the
          // count below: a filtered page against an unfiltered total is a footer and
          // a pager that disagree with the rows.
          status: { type: 'string', enum: [...ALARM_WEBHOOK_DELIVERY_STATUSES] },
        },
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
    const q = req.query as { limit?: number; offset?: number; status?: string };
    // The target lookup is NOT scoped: a target is configuration, not an instrument,
    // and the config routes above are deliberately unscoped (see the module header).
    const target = await prisma.alarmWebhookTarget.findUnique({ where: { id }, select: { id: true } });
    if (!target) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Alarm webhook target not found.' });

    const take = resolvePageSize(q.limit, 50);   // no ceiling — see lib/page-size.ts
    const skip = Math.max(q.offset ?? 0, 0);
    const base: Prisma.AlarmWebhookDeliveryWhereInput = {
      targetId: id,
      ...(q.status ? { status: q.status } : {}),
    };
    // THIS route IS instrument-visibility scoped, unlike the config routes above. It is
    // not configuration — there is nothing here to misconfigure — and it returns
    // `requestBody` verbatim, which under the default template carries the instrument
    // code and the reading for every excursion. `alarm_webhooks.view` is configurable,
    // so a role with a restricted `instrument_scope` can hold it; the exposure is
    // reachable by design, not hypothetical.
    //
    // A delivery reaches its instrument through its alarm, so the filter nests under
    // the relation the way alarms/routes.ts:scopedToVisible does — AND, never spread,
    // or a later key could silently replace it and widen the result.
    //
    // `alarmId` is NULLABLE (a TEST fire has no alarm) and a nested relation filter
    // never matches a null relation, so the OR is required: without it every TEST row
    // would vanish for a scoped role. A TEST row names no instrument and leaks nothing.
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const where: Prisma.AlarmWebhookDeliveryWhereInput = visibility
      ? { AND: [base, { OR: [{ alarmId: null }, { alarm: { instrument: visibility } }] }] }
      : base;
    const [rows, total] = await Promise.all([
      prisma.alarmWebhookDelivery.findMany({
        where,
        // Same order as the @@index([targetId, createdAt(sort: Desc)]); `attempt`
        // breaks the tie between rows written inside the same millisecond, so a
        // 3-attempt burst reads back in the order it happened.
        orderBy: [{ createdAt: 'desc' }, { attempt: 'desc' }],
        take, skip,
      }),
      prisma.alarmWebhookDelivery.count({ where }),
    ]);
    return { data: rows.map(toDeliveryResponse), total };
  });
}
