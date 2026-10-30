import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { loadAlarmTypeNames, alarmDisplayName } from './load-type-names.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { resolveLocationIds, type FlNode } from '../functional-locations/tree.js';
import { resolveVisibility } from '../instruments/visibility.js';
import { enqueueAlarmWebhook } from '../alarm-webhooks/enqueue.js';
import { describeSnapshot, decimalsFromSnapshot } from '../alarm-webhooks/build-variables.js';
import { validateAcknowledgement, clampSignature } from './validation.js';
import { loadLimitConfig, countWithoutLimits } from './load-limits.js';
import { loadProfileMeasurements } from '../instruments/profile-measurements.js';
import { slotConfigFromMeasurements } from '@digilog/shared';
import {
  ALARM_TYPE_TOKENS, ALARM_STATUS_TOKENS, UUID_RE,
  parseAlarmListQuery, buildAlarmWhere, buildAlarmOrderBy, pageBounds,
} from './list-query.js';

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
  ruleId: { type: 'string', nullable: true },
  ruleSnapshot: { type: 'object', additionalProperties: true },
  instrumentId: { type: 'string' },
  instrumentCode: { type: 'string', nullable: true },
  instrumentName: { type: 'string', nullable: true },
  /** The instrument's FUNCTIONAL location — the authoritative logical grouping,
   *  not the free-text `instruments.location` column, which is superseded. */
  locationName: { type: 'string', nullable: true },
  // DECLARED, or Fastify strips it silently — this repo has lost a field that
  // way five times, most recently `rangeBounds` on the telemetry overview.
  locationAttribute: { type: 'string', nullable: true },
  metric: { type: 'string' },
  triggeredValue: { type: 'number', nullable: true },
  state: { type: 'string' },
  raisedAt: { type: 'string' },
  clearedAt: { type: 'string', nullable: true },
  acknowledgedAt: { type: 'string', nullable: true },
  acknowledgedBy: { type: 'string', nullable: true },
  acknowledgeReason: { type: 'string', nullable: true },
  source: { type: 'string' },
  limitKind: { type: 'string', nullable: true },
  clearedValue: { type: 'number', nullable: true },
} as const;


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

/**
 * The ONE reading of an alarm query's filters and the caller's scope, shared by
 * `GET /api/alarms` and `GET /api/alarms/counts` so the two cannot drift: the
 * parsed query (a bad filter is a 400, sent here), the location expansion and the
 * caller's visibility. Returns null once a 400 has been sent.
 */
async function resolveAlarmQuery(req: FastifyRequest, reply: FastifyReply) {
  const q = parseAlarmListQuery((req.query ?? {}) as Record<string, unknown>);
  if (q.error) {
    reply.code(400).send({ error: 'VALIDATION_ERROR', message: q.error.message, field: q.error.field });
    return null;
  }

  const { where: visibility } = await resolveVisibility(buildContext(req));

  let locationIds: string[] | undefined;
  const askedLocation = (req.query as { functionalLocationId?: string }).functionalLocationId;
  const direct = (req.query as { functionalLocationDirect?: string }).functionalLocationDirect === 'true';
  if (askedLocation && direct) {
    // Pinned to this location itself: no Area expansion. Still ANDed with
    // visibility below, so a location the caller cannot see matches nothing.
    // A non-uuid is a 400 here: the non-direct path resolves an unknown id to
    // no rows, but this one reaches the query as it stands.
    if (!UUID_RE.test(askedLocation)) {
      reply.code(400).send({
        error: 'VALIDATION_ERROR', message: 'functionalLocationId must be a location id', field: 'functionalLocationId',
      });
      return null;
    }
    locationIds = [askedLocation];
  } else if (askedLocation) {
    // resolveLocationIds, never a bare equality: an alarm on an instrument in a
    // Block's AREA must appear when the Block is selected. Querying the id
    // directly returns only what is pinned to the Block itself, which on this
    // installation is nothing at all.
    const nodes = await prisma.functionalLocation.findMany({
      select: { id: true, name: true, type: true, parentId: true },
    });
    locationIds = resolveLocationIds(askedLocation, nodes as FlNode[]);
  }

  return { q, locationIds, visibility };
}

export default async function alarmRoutes(app: FastifyInstance) {
  // ─── Rules ────────────────────────────────────────────────────────────────

  // ── Alarm RULES were removed 2026-08-31 ────────────────────────────────
  //
  // The operator does not use authored rules: alarms here come from the
  // instrument's own limits, its sensor range, a non-numeric reading, or
  // silence. The model, the four CRUD endpoints, the evaluation pass and the
  // config page all went with it, against 0 rules and 0 RULE alarms in the
  // database — nothing regulated was closed or deleted.
  //
  // `ALARM_RULE_READ` / `ALARM_RULE_MANAGE` deliberately SURVIVE: they gate
  // the alarm-webhooks module (`modules/alarm-webhooks/routes.ts`), which has
  // always reused them. The names now read oddly; renaming a permission means
  // rewriting every stored role config, which is not worth it for a label.

  app.get('/', {
    preHandler: [app.requirePermission('ALARM_READ')],
    schema: {
      tags: ['Alarms'],
      summary: 'List alarms',
      querystring: {
        type: 'object',
        properties: {
          // Legacy single-axis filters, still sent by the dashboard's selection
          // panel and the trend page's alarms widget. Kept working.
          state: { type: 'string', enum: ['ACTIVE', 'CLEARED'] },
          acknowledged: { type: 'string', enum: ['true', 'false'] },
          limit: { type: 'integer' },
          // Narrows to one functional location, a Block covering its Areas. It is
          // ANDed with the caller's visibility scope below, never substituted for
          // it: a location filter that widened visibility would be the exact
          // inversion of what both filters are for.
          functionalLocationId: { type: 'string' },
          // With `true`, only alarms on instruments pinned to that location itself,
          // without its Areas (a dashboard's "- direct" source).
          functionalLocationDirect: { type: 'string', enum: ['true', 'false'] },
          instrumentId: { type: 'string' },
          // Dashboard sources: a comma list of instrument ids (at most 200; present
          // but empty selects nothing) and a profile. ANDed with visibility.
          instrumentIds: { type: 'string' },
          profileId: { type: 'string', format: 'uuid' },
          // The Alarms page's own filters.
          search: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          type: { type: 'string', enum: [...ALARM_TYPE_TOKENS] },
          status: { type: 'string', enum: [...ALARM_STATUS_TOKENS] },
          // No `severity`. It is not declared here ON PURPOSE: the querystring
          // schema sets no `additionalProperties: false`, so an undeclared key is
          // passed through and ignored, whereas re-declaring it with its old enum
          // would make `?severity=BOGUS` a 400 on a parameter nothing reads.
          // See parseAlarmListQuery for why it is tolerated rather than refused.
          page: { type: 'integer' },
          pageSize: { type: 'integer' },
          sort: { type: 'string' },
          dir: { type: 'string', enum: ['asc', 'desc'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object', properties: alarmProps } },
            /** Rows matching every filter INCLUDING status — what the table pages over. */
            total: { type: 'integer' },
            /** The four state counts over every filter EXCEPT status, so choosing a
             *  box does not zero the other three. */
            counts: {
              type: 'object',
              properties: {
                'active-unack': { type: 'integer' },
                'active-ack': { type: 'integer' },
                'cleared-unack': { type: 'integer' },
                'cleared-ack': { type: 'integer' },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const resolved = await resolveAlarmQuery(req, reply);
    if (!resolved) return reply;
    const { q, locationIds, visibility } = resolved;

    // scopedToVisible ANDs, so every filter narrows WITHIN the caller's scope and
    // cannot escape it — including a location the caller cannot see, which then
    // matches nothing.
    const baseWhere = scopedToVisible(buildAlarmWhere(q, { locationIds }), visibility);
    const rowWhere = scopedToVisible(buildAlarmWhere(q, { locationIds, includeStatus: true }), visibility);

    const [rows, byState] = await Promise.all([
      prisma.alarm.findMany({
        where: rowWhere,
        orderBy: buildAlarmOrderBy(q.sort, q.dir) as never,
        ...pageBounds(q.page, q.pageSize),
        include: {
          instrument: {
            select: {
              code: true, name: true,
              functionalLocation: { select: { name: true } },
              /**
               * The instrument's OWN `Location` attribute — the free-text
               * placement somebody typed ("Dissolution & UV Room").
               *
               * A THIRD placement fact beside the functional location above:
               * that one is the Block > Area grouping alarms and visibility
               * resolve through, this one names the space. The Location COLUMN
               * showed the functional location until 2026-09-01, so a column
               * headed "Location" printed an AREA — which is what the operator
               * reported. Filtered in SQL rather than loading every attribute:
               * an instrument here carries a dozen.
               */
              attributes: {
                where: { key: { equals: 'Location', mode: 'insensitive' } },
                select: { value: true },
                /**
                 * ORDERED, because `take: 1` without one is whatever Postgres
                 * hands back first — and the match is case-INSENSITIVE precisely
                 * because this installation's keys have drifted, so an instrument
                 * carrying both `Location` and `location` is the case that
                 * actually arises. Unordered, the cell would show an arbitrary one
                 * of the two and could flip between requests with nothing changed.
                 * A §11 screen does not get to be non-deterministic.
                 */
                orderBy: { key: 'asc' },
                take: 1,
              },
            },
          },
        },
      }),
      // ONE query for all four boxes, not four counts.
      // `_count.acknowledgedAt` counts rows where that column is NOT NULL, which
      // IS the signature axis — so grouping by `state` and reading `_all` against
      // it yields the whole 2x2 with a single pass. Four separate counts would
      // also be four separate points in time, and this page polls beside a live
      // evaluator.
      prisma.alarm.groupBy({
        by: ['state'],
        where: baseWhere as never,
        _count: { _all: true, acknowledgedAt: true },
      }),
    ]);

    const counts = { 'active-unack': 0, 'active-ack': 0, 'cleared-unack': 0, 'cleared-ack': 0 };
    for (const g of byState) {
      const acked = g._count.acknowledgedAt;
      const prefix = g.state === 'ACTIVE' ? 'active' : 'cleared';
      counts[`${prefix}-ack` as keyof typeof counts] = acked;
      counts[`${prefix}-unack` as keyof typeof counts] = g._count._all - acked;
    }

    // DERIVED from the counts, never counted separately. The four quadrants
    // partition the base set exactly (see list-query.test.ts), so a card's number
    // and "showing N" are answers to the same question and cannot disagree —
    // which a fifth count(), racing the other four against a live evaluator,
    // could not guarantee.
    const total = q.status ? counts[q.status] : ALARM_STATUS_TOKENS.reduce((n, t) => n + counts[t], 0);

    return {
      data: rows.map((a) => ({
        ...a,
        instrumentCode: a.instrument?.code ?? null,
        instrumentName: a.instrument?.name ?? null,
        locationName: a.instrument?.functionalLocation?.name ?? null,
        // The space, not the grouping. `locationText()` prefers this and falls
        // back to `locationName`, so a row keeps saying something useful when
        // nobody has typed one.
        locationAttribute: a.instrument?.attributes?.[0]?.value?.trim() || null,
        raisedAt: a.raisedAt.toISOString(),
        clearedAt: a.clearedAt?.toISOString() ?? null,
        acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
      })),
      total,
      counts,
    };
  });

  // Registered before any `/:id` route so `counts` is never read as an id.
  //
  // The dashboard's alarm widgets draw counts, not rows. Same query language as the
  // list (resolveAlarmQuery + buildAlarmWhere + the same visibility), paging and
  // sort ignored. The e2e compares this route's quadrants with the list's `counts`
  // for the same query, which is what keeps the two from drifting.
  app.get('/counts', {
    preHandler: [app.requirePermission('ALARM_READ')],
    schema: {
      tags: ['Alarms'],
      summary: 'Alarm counts by state quadrant and by type, over the list filters',
      querystring: {
        type: 'object',
        properties: {
          functionalLocationId: { type: 'string' },
          functionalLocationDirect: { type: 'string', enum: ['true', 'false'] },
          instrumentIds: { type: 'string' },
          profileId: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: [...ALARM_TYPE_TOKENS] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            quadrants: {
              type: 'object',
              properties: {
                activeUnack: { type: 'integer' },
                activeAck: { type: 'integer' },
                clearedUnack: { type: 'integer' },
                clearedAck: { type: 'integer' },
              },
            },
            byType: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  active: { type: 'integer' },
                  unacknowledged: { type: 'integer' },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const resolved = await resolveAlarmQuery(req, reply);
    if (!resolved) return reply;
    const { q, locationIds, visibility } = resolved;

    // ACTIVE and unacknowledged are independent axes: one groupBy by state, with the
    // not-null count of acknowledgedAt, gives both for any where.
    const byState = (where: Record<string, unknown>) => prisma.alarm.groupBy({
      by: ['state'],
      where: where as never,
      _count: { _all: true, acknowledgedAt: true },
    });

    const [quadrantRows, typeRows] = await Promise.all([
      byState(scopedToVisible(buildAlarmWhere(q, { locationIds }), visibility)),
      // Every type token, in order. The token -> rows mapping is buildAlarmWhere's
      // `type` handling and nothing here; a query that already names a type keeps
      // it (the other tokens are then zero, not a second reading of the filter).
      Promise.all(ALARM_TYPE_TOKENS.map((token) => (q.type && q.type !== token
        ? Promise.resolve([])
        : byState(scopedToVisible(buildAlarmWhere({ ...q, type: token }, { locationIds }), visibility))))),
    ]);

    const quadrants = { activeUnack: 0, activeAck: 0, clearedUnack: 0, clearedAck: 0 };
    for (const g of quadrantRows) {
      const acked = g._count.acknowledgedAt;
      if (g.state === 'ACTIVE') {
        quadrants.activeAck = acked;
        quadrants.activeUnack = g._count._all - acked;
      } else {
        quadrants.clearedAck = acked;
        quadrants.clearedUnack = g._count._all - acked;
      }
    }

    const byType = ALARM_TYPE_TOKENS.map((type, i) => {
      let active = 0;
      let unacknowledged = 0;
      for (const g of typeRows[i]) {
        if (g.state === 'ACTIVE') active = g._count._all;
        unacknowledged += g._count._all - g._count.acknowledgedAt;
      }
      return { type, active, unacknowledged };
    });

    return { quadrants, byType };
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

    // The claim, the re-read and the audit row are ONE transaction (audit 2026-10-12
    // #10). They were three separate writes, so an audit insert that failed left the
    // alarm SIGNED with no ALARM_ACKNOWLEDGED row — the one outcome §11 cannot
    // tolerate here. Now a failed audit write rolls the signature back with it.
    type AckOutcome =
      | { kind: 'not_found' }
      | { kind: 'conflict'; message: string }
      | { kind: 'ok'; updated: Prisma.AlarmGetPayload<{ include: { instrument: { select: { code: true; name: true } } } }> };
    const outcome: AckOutcome = await prisma.$transaction(async (tx) => {
      // Claimed with `acknowledgedAt: null` IN THE WHERE, so two simultaneous requests cannot
      // both pass the check above and have the second overwrite the first signature. The
      // check above still runs first, because it produces the message that names who signed.
      const claim = await tx.alarm.updateMany({
        where: { id, acknowledgedAt: null },
        data: { acknowledgedAt: new Date(), acknowledgedBy: ctx.userId, acknowledgeReason: reason.trim() },
      });
      if (claim.count === 0) {
        const won = await tx.alarm.findUnique({ where: { id }, select: { acknowledgedAt: true, acknowledgedBy: true } });
        if (!won?.acknowledgedAt) return { kind: 'not_found' as const };
        return {
          kind: 'conflict' as const,
          message: (validateAcknowledgement(won, reason) as { message: string }).message,
        };
      }
      // `name` as well as `code`: the webhook enqueue below passes `instrumentName`, and
      // every evaluator site already does. Omitting it here made `${instrumentName}`
      // render the NAME on RAISED/CLEARED and the CODE on ACKNOWLEDGED for one alarm
      // (build-variables.ts falls back to the code), against the design's promise that
      // the payload, the email and the dashboard quote one excursion identically.
      const updated = await tx.alarm.findUniqueOrThrow({
        where: { id },
        include: { instrument: { select: { code: true, name: true } } },
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
          // KEPT when severity left every display and config surface on 2026-09-01.
          // This is an audit `afterValue` — the §11 snapshot of the row as it stood
          // at the moment it was signed for — and the column still exists and still
          // carries meaningful history on the 148 alarms raised before that date.
          // Narrowing what an audit record captures is a reduction in the regulated
          // evidence, which is the opposite of what removing a config surface is for.
          severity: updated.severity,
          triggeredValue: updated.triggeredValue,
          raisedAt: updated.raisedAt.toISOString(),
        },
        // Reason goes in BOTH: the column is what the audit detail view shows, and the
        // signature meaning is the §11.50 statement of what was signed.
        reason: reason.trim(),
        signatureMeaning: clampSignature(`Acknowledged alarm on ${updated.instrument?.code ?? updated.instrumentId} (${updated.metric}) — ${reason.trim()}`),
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return { kind: 'ok' as const, updated };
    });

    if (outcome.kind === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND', message: 'Alarm not found.' });
    if (outcome.kind === 'conflict') return reply.code(409).send({ error: 'ALREADY_ACKNOWLEDGED', message: outcome.message });
    const { updated } = outcome;

    // Named and described exactly as the RAISED payload for this alarm was (audit
    // 2026-10-12 #12): the administered alarm-type name for its source, and the
    // condition frozen on its snapshot. `ruleSnapshot.name` existed only on the
    // removed RULE alarms, so every acknowledgement went out as `ruleName: ""`.
    const typeNames = await loadAlarmTypeNames();
    const frozenDescription = updated.ruleSnapshot
      && typeof updated.ruleSnapshot === 'object'
      && !Array.isArray(updated.ruleSnapshot)
      ? (updated.ruleSnapshot as Record<string, unknown>).description
      : undefined;

    // AFTER the atomic claim (updateMany with acknowledgedAt: null in the WHERE), so
    // the loser of two simultaneous acknowledgements fires nothing. Never throws.
    // `ruleSnapshot` carries one of two shapes (RULE vs INSTRUMENT_LIMIT) — see
    // alarm-webhooks/build-variables.ts for why describeSnapshot/decimalsFromSnapshot
    // branch on it rather than assuming describeRule's shape.
    await enqueueAlarmWebhook('ACKNOWLEDGED', {
      alarmId: id,
      instrumentId: updated.instrumentId,
      instrumentCode: updated.instrument?.code ?? null,
      instrumentName: updated.instrument?.name ?? null,
      metric: updated.metric,
      ruleName: alarmDisplayName(typeNames, updated.source, updated.metric, updated.limitKind),
      condition: (typeof frozenDescription === 'string' && frozenDescription)
        || describeSnapshot(updated.ruleSnapshot),
      triggeredValue: updated.triggeredValue,
      decimals: decimalsFromSnapshot(updated.ruleSnapshot),
      raisedAt: updated.raisedAt,
      clearedAt: updated.clearedAt,
      acknowledgedBy: updated.acknowledgedBy,
      acknowledgeReason: updated.acknowledgeReason,
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
            instrumentsWithoutLimits: { type: 'integer' },
            instrumentsWithoutLimitsCodes: { type: 'array', items: { type: 'string' } },
            limitAlarmsEnabled: { type: 'boolean' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const scoped = (extra: Record<string, unknown>) => scopedToVisible(extra, visibility) as never;

    // Counted with the SAME visibility filter as the list, so the card cannot claim
    // more alarms than the page will show. The instrument lookup for the no-limits
    // count uses that same visibility filter directly (it targets Instrument, not
    // Alarm, so it doesn't go through scoped()/scopedToVisible's nested form).
    const [active, unacknowledged, cfg] = await Promise.all([
      prisma.alarm.count({ where: scoped({ state: 'ACTIVE' }) }),
      prisma.alarm.count({ where: scoped({ acknowledgedAt: null }) }),
      loadLimitConfig(),
    ]);
    // Only the attributes that CAN be a limit are read (audit 2026-10-03,
    // API-19): this used to load every attribute of every visible instrument —
    // a dozen rows each — to count the ones with no usable limit. The alias
    // lists are lower-cased by `parseLimitKeys`, and `resolveLimit` matches an
    // attribute key case-insensitively, so the SQL match must fold case too or
    // an instrument whose key is `T_HL` would be counted as unwatched here while
    // the evaluator watches it. (`resolveLimit` also trims the key; a key stored
    // with surrounding whitespace would miss here — attribute keys are trimmed
    // on write, so none is.)
    //
    // Each instrument is judged by ITS profile's limit keys (2026-10-26), so the
    // SQL filter takes the union of every profile's lists and `countWithoutLimits`
    // applies the instrument's own.
    const profileMeasurements = await loadProfileMeasurements();
    const slotByProfile = new Map([...profileMeasurements].map(([id, ms]) => [id, slotConfigFromMeasurements(ms)]));
    const limitKeys = [...new Set([...slotByProfile.values()].flatMap((s) => Object.values(s.limitKeys).flat()))];
    const visibleInstruments = await prisma.instrument.findMany({
      where: visibility ?? {},
      select: {
        code: true,
        profileId: true,
        attributes: {
          where: { key: { in: limitKeys, mode: 'insensitive' } },
          select: { key: true, value: true },
        },
      },
    });
    const noKeys = slotConfigFromMeasurements([]).limitKeys;
    const without = countWithoutLimits(
      visibleInstruments.map((i) => ({
        code: i.code,
        attributes: i.attributes,
        limitKeys: slotByProfile.get(i.profileId)?.limitKeys ?? noKeys,
      })),
      noKeys,
    );

    return {
      active, unacknowledged,
      instrumentsWithoutLimits: without.count,
      instrumentsWithoutLimitsCodes: without.codes,
      // The worker gates the whole limit-alarm pass on this flag (alarm-evaluation.worker.ts).
      // Without it, "instrumentsWithoutLimits: 17" would look like 3 instruments ARE being
      // watched when the feature is administratively off and NONE are.
      limitAlarmsEnabled: cfg.enabled,
    };
  });
}
