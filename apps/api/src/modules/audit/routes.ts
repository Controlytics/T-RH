import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { verifyAuditChecksum } from '../../lib/hash-chain.js';
import { auditLog } from '../../lib/audit.js';
import { auditQuerySchema } from '@digilog/shared';
import { errorResponses } from '../../lib/error-schemas.js';
import { verifyAuditChain } from '../../lib/audit-verify.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import {
  withAuditDeletesAllowed,
  isHardDeleteEnabled,
  HARD_DELETE_DISABLED_MESSAGE,
} from '../../lib/audit-immutability.js';

/**
 * Path-param guard for audit record ids.
 *
 * Every `/:id` route below hits a Prisma `uuid` column. Without a format check
 * a non-uuid segment reaches the query and Prisma throws, which the global
 * handler turns into HTTP 500 AND fires a SYSTEM_ERROR notification — so an
 * unauthenticated typo, a scanner, or `/api/audit/export` (a path that does not
 * exist) all produced 500s and error noise. Validating in the schema makes
 * Fastify answer 400 before the handler runs.
 */
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export default async function auditRoutes(app: FastifyInstance) {
  // GET /api/audit — query audit trail (requires AUDIT_READ permission)
  app.get('/', {
    preHandler: [app.requirePermission('AUDIT_READ')],
    schema: {
      tags: ['Audit'],
      summary: 'Query audit trail',
      description: 'Retrieve paginated audit trail records with optional filtering by date period, user, action, and target type.',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1, description: 'Page number' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 20, description: 'Records per page (capped at 200 to prevent unbounded table dump)' },
          period: { type: 'string', enum: ['today', 'week', 'month', 'quarter', 'year', 'all'], description: 'Predefined date period filter' },
          startDate: { type: 'string', description: 'Start date for custom range (ISO 8601)' },
          endDate: { type: 'string', description: 'End date for custom range (ISO 8601)' },
          search: { type: 'string', description: 'Search across userId, action, targetType, and targetId fields' },
          userId: { type: 'string', description: 'Filter by user ID' },
          action: { type: 'string', description: 'Filter by audit action type' },
          targetType: { type: 'string', description: 'Filter by target entity type' },
          targetId: { type: 'string', description: 'Filter by target entity ID' },
          sortBy: { type: 'string', enum: ['timestamp', 'action', 'userId', 'userRole'], default: 'timestamp', description: 'Field to sort by' },
          sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc', description: 'Sort direction' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  userId: { type: 'string', nullable: true },
                  userRole: { type: 'string', nullable: true },
                  action: { type: 'string' },
                  targetType: { type: 'string', nullable: true },
                  targetId: { type: 'string', nullable: true },
                  beforeValue: { type: 'object', additionalProperties: true, nullable: true },
                  afterValue: { type: 'object', additionalProperties: true, nullable: true },
                  reason: { type: 'string', nullable: true },
                  signatureMeaning: { type: 'string', nullable: true },
                  ipAddress: { type: 'string', nullable: true },
                  timestamp: { type: 'string', format: 'date-time' },
                  integrityValid: { type: 'boolean', description: 'Whether the checksum integrity verification passed' },
                  // Redaction stamps. The handler already spread these off the row,
                  // but Fastify strips any field absent from this schema — so the
                  // frontend received none of them and rendered a redacted §11
                  // record as an ordinary one. Redaction is the VISIBLE,
                  // chain-preserving alternative to deletion; invisible, it does
                  // neither job. Must stay in sync with the redact handler below.
                  redactedAt: { type: 'string', format: 'date-time', nullable: true, description: 'Set when the payload was redacted (chain link preserved)' },
                  redactedBy: { type: 'string', nullable: true, description: 'User id of the redactor' },
                  redactedByName: { type: 'string', nullable: true, description: 'Resolved username of the redactor (read-time enrichment; falls back to the raw id)' },
                  redactionReason: { type: 'string', nullable: true, description: 'Operator-supplied reason for the redaction' },
                },
              },
            },
            total: { type: 'integer' },
            page: { type: 'integer' },
            limit: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const query = auditQuerySchema.parse(req.query);
    const where: Record<string, unknown> = {
      AND: [
        // A SUPER_ADMIN viewer sees SUPER_ADMIN actions too (incl. their own
        // login/logout) — a complete 21 CFR §11 audit trail. Lower roles still
        // never see SUPER_ADMIN rows. (Previously unconditional → SUPER_ADMIN
        // actions were hidden from everyone, so superadmin's own logout looked
        // "unrecorded" even though it was. Same pattern fixed in the single-row
        // fetch below.)
        ...(req.user.role === 'SUPER_ADMIN'
          ? []
          : [{ OR: [{ userRole: { not: 'SUPER_ADMIN' } }, { userRole: null }] }]),
      ],
    };

    // Date filtering by period
    if (query.period && query.period !== 'all') {
      const now = new Date();
      let startDate: Date;

      switch (query.period) {
        case 'today':
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'week':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'quarter':
          startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
        case 'year':
          startDate = new Date(now.getFullYear(), 0, 1);
          break;
        default:
          startDate = new Date(0);
      }

      where.timestamp = { gte: startDate };
    } else if (query.startDate || query.endDate) {
      where.timestamp = {};
      if (query.startDate) (where.timestamp as Record<string, unknown>).gte = new Date(query.startDate);
      if (query.endDate) (where.timestamp as Record<string, unknown>).lte = new Date(query.endDate);
    }
    if (query.search) {
      const term = query.search;
      where.OR = [
        { userId: { contains: term, mode: 'insensitive' } },
        { action: { contains: term, mode: 'insensitive' } },
        { targetType: { contains: term, mode: 'insensitive' } },
        { targetId: { contains: term, mode: 'insensitive' } },
        { userRole: { contains: term, mode: 'insensitive' } },
      ];
    }
    if (query.userId) where.userId = query.userId;
    if (query.action) where.action = query.action;
    if (query.targetType) where.targetType = query.targetType;
    if (query.targetId) where.targetId = query.targetId;

    const sortField = (req.query as any).sortBy || 'timestamp';
    const sortDir = (req.query as any).sortOrder || 'desc';
    const validSortFields = ['timestamp', 'action', 'userId', 'userRole'];
    const orderByField = validSortFields.includes(sortField) ? sortField : 'timestamp';
    const orderByDir = sortDir === 'asc' ? 'asc' : 'desc';

    // Defensive cap: even if Zod schema is bypassed, never pull more than 200 rows.
    // Audit-trail is hash-chained + monotonic — without a cap, any AUDIT_READ caller
    // can pull the entire table in one response (DoS surface).
    const effectiveLimit = Math.min(Math.max(query.limit ?? 20, 1), 200);

    const [records, total] = await Promise.all([
      prisma.auditTrail.findMany({
        where: where as any,
        orderBy: { [orderByField]: orderByDir },
        skip: (query.page - 1) * effectiveLimit,
        take: effectiveLimit,
      }),
      prisma.auditTrail.count({ where: where as any }),
    ]);

    // Read-time enrichment: resolve the redactor UUID (redacted_by) to a
    // username for the inspector view. The redactor may since have been
    // hard-deleted (user delete is physical), so the render falls back to the
    // raw id rather than dropping the attribution. (The cleanroom domain
    // enrichment — filter/cycle/PM/replacement name lookups — was removed with
    // the 2026-07-18 domain strip; historic domain audit rows render with their
    // stored payloads as-is.)
    const redactorIds = new Set<string>();
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const r of records as any[]) {
      if (typeof r.redactedBy === 'string' && UUID_RE.test(r.redactedBy)) redactorIds.add(r.redactedBy);
    }
    const redactors = redactorIds.size > 0
      ? await prisma.user.findMany({ where: { id: { in: Array.from(redactorIds) } }, select: { id: true, username: true } })
      : [];
    const redactorNameById = new Map(redactors.map((u) => [u.id, u.username]));

    const data = records.map((record: any) => {
      return {
        ...record,
        // Redactor username for display; null when the row isn't redacted, the
        // raw id when the redactor's account no longer exists.
        redactedByName: record.redactedBy
          ? (redactorNameById.get(record.redactedBy) ?? record.redactedBy)
          : null,
        // Verify against the ORIGINAL stored afterValue. verifyAuditChecksum
        // null-normalizes internally; beforeValue + the rest pass through raw
        // via `...record` (needed for the expanded checksum).
        integrityValid: verifyAuditChecksum({ ...record, afterValue: record.afterValue }),
      };
    });

    return {
      data,
      total,
      page: query.page,
      limit: effectiveLimit,
      totalPages: Math.ceil(total / effectiveLimit),
    };
  });

  // GET /api/audit/:id — detail (requires AUDIT_READ permission)
  app.get('/:id', {
    preHandler: [app.requirePermission('AUDIT_READ')],
    schema: {
      tags: ['Audit'],
      summary: 'Get audit record by ID',
      description: 'Retrieve a single audit trail record with full details including before/after values.',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          // Must be a UUID. Without this, ANY non-uuid path segment reached the
          // handler and Prisma threw on the uuid column — returning HTTP 500
          // (plus a SYSTEM_ERROR notification) for what is simply a bad URL.
          // e.g. GET /api/audit/export used to 500. Rejecting here yields 400.
          id: { type: 'string', pattern: UUID_PATTERN, description: 'Audit record ID (UUID)' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            userId: { type: 'string' },
            userRole: { type: 'string' },
            action: { type: 'string' },
            targetType: { type: 'string', nullable: true },
            targetId: { type: 'string', nullable: true },
            beforeValue: { type: 'object', additionalProperties: true, nullable: true },
            afterValue: { type: 'object', additionalProperties: true, nullable: true },
            reason: { type: 'string', nullable: true },
            ipAddress: { type: 'string', nullable: true },
            userAgent: { type: 'string', nullable: true },
            sessionId: { type: 'string', nullable: true },
            checksum: { type: 'string' },
            signatureMeaning: { type: 'string', nullable: true },
            previousChecksum: { type: 'string', nullable: true },
            timestamp: { type: 'string', format: 'date-time' },
            integrityValid: { type: 'boolean', description: 'Whether the checksum integrity verification passed' },
            // See the list route: absent from the schema means stripped from the
            // response, however faithfully the handler spreads the row.
            redactedAt: { type: 'string', format: 'date-time', nullable: true, description: 'Set when the payload was redacted (chain link preserved)' },
            redactedBy: { type: 'string', nullable: true, description: 'User id of the redactor' },
            redactedByName: { type: 'string', nullable: true, description: 'Resolved username of the redactor (read-time enrichment; falls back to the raw id)' },
            redactionReason: { type: 'string', nullable: true, description: 'Operator-supplied reason for the redaction' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Mirror the list policy: a SUPER_ADMIN viewer may fetch SUPER_ADMIN rows;
    // lower roles cannot (so a non-SUPER_ADMIN with AUDIT_READ who knows a UUID
    // still can't pull a SUPER_ADMIN row directly).
    const record = await prisma.auditTrail.findFirst({
      where: {
        id,
        ...(req.user.role === 'SUPER_ADMIN'
          ? {}
          : { OR: [{ userRole: { not: 'SUPER_ADMIN' } }, { userRole: null }] }),
      },
    });
    if (!record) return reply.code(404).send({ error: 'Audit record not found' });
    // Resolve the redactor id → username, as the list route does. redacted_by is
    // a varchar, so guard the shape before handing it to a uuid column — a
    // non-uuid value would make findUnique throw rather than just miss.
    const DETAIL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const redactor = record.redactedBy && DETAIL_UUID_RE.test(record.redactedBy)
      ? await prisma.user.findUnique({ where: { id: record.redactedBy }, select: { username: true } })
      : null;
    return {
      ...record,
      redactedByName: record.redactedBy ? (redactor?.username ?? record.redactedBy) : null,
      integrityValid: verifyAuditChecksum(record),
    };
  });

  // POST /api/audit/report-export-log — record ANY report download/generation
  // (audit trail, instrument activity, etc.) as an auditable
  // 21 CFR §11 event. These exports are client-side (jsPDF / Excel over fetched
  // rows), so this is the ONLY place the download is captured. The frontend calls
  // this BEFORE saving the file and blocks the download if it fails (fail-closed),
  // so a successful download is always logged.
  //
  // Auth-only (no specific permission): any authenticated user may record their
  // own report generation — the per-report export permission is already enforced
  // by that report's own view/export gate + data endpoints. The write only
  // attributes a REPORT_GENERATED row to the caller.
  app.post('/report-export-log', {
    schema: {
      tags: ['Audit'],
      summary: 'Record a report download/generation as an auditable event',
      description: 'Writes a REPORT_GENERATED audit row capturing who generated which report, the format, the record count, and any active filters.',
      body: {
        type: 'object',
        required: ['reportType', 'format', 'recordCount', 'remarks'],
        properties: {
          reportType: { type: 'string', minLength: 1, maxLength: 100, description: 'Human report name, e.g. "Audit Trail", "Instrument Activity"' },
          format: { type: 'string', enum: ['PDF', 'Excel'] },
          recordCount: { type: 'integer', minimum: 0 },
          period: { type: 'string' },
          search: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          remarks: { type: 'string', minLength: 1, maxLength: 500, description: 'Why this report was generated. Required — a §11 record states its reason.' },
        },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } }, additionalProperties: false },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // Configurable, not welded on: enforceReauth consults the per-role policy,
    // so an administrator can relax this for a role that downloads routinely
    // without the requirement disappearing from the registry.
    const { ok } = await enforceReauth('DOWNLOAD_REPORT', req, reply);
    if (!ok) return;

    const { reportType, format, recordCount, period, search, startDate, endDate, remarks } =
      req.body as { reportType: string; format: string; recordCount: number; period?: string; search?: string; startDate?: string; endDate?: string; remarks: string };
    // Schema `minLength: 1` alone would accept a whitespace-only string — a
    // blank padded with spaces states no reason. Trim server-side rather than
    // trust the dialog's client-side trim: this endpoint is the ONLY place a
    // report download is captured, so it is the last line of defence for the
    // §11 requirement that the record state its reason.
    const trimmedRemarks = remarks?.trim();
    if (!trimmedRemarks) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'remarks is required and cannot be blank.' });
    }
    await auditLog({
      userId: req.user.username, userRole: req.user.role,
      action: 'REPORT_GENERATED',
      // targetType carries the human report name so the audit template renders
      // "<reportType> report generated by <username>".
      targetType: reportType,
      afterValue: {
        reportType, format, recordCount,
        period: period ?? 'All Time',
        search: search ?? null,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        remarks: trimmedRemarks,
      },
      reason: `Report generated: ${reportType} (${recordCount} record(s)) as ${format} — ${trimmedRemarks}`,
      signatureMeaning: `${req.user.username} generated the ${reportType} report (${recordCount} record(s)) as ${format}`,
      ipAddress: req.ip, userAgent: req.headers['user-agent'], sessionId: req.user.sessionId,
    });
    return { success: true };
  });

  // DELETE /api/audit/:id — delete single audit record (SUPER_ADMIN only)
  // POST /api/audit/:id/redact — redact a single audit record (SUPER_ADMIN only).
  // Replaces DELETE per delta-audit §C1 / May 16 §1.2: physical deletion broke
  // the hash chain at the gap point. REDACT preserves checksum + chain link,
  // NULLs the beforeValue/afterValue payload, and stamps redactedAt/redactedBy.
  // verifyAuditChecksum() treats redactedAt != null rows as "valid (redacted)"
  // — chain integrity preserved, payload contents withheld.
  app.post('/:id/redact', {
    preHandler: [app.requireSuperAdmin()],
    schema: {
      tags: ['Audit'],
      summary: 'Redact audit record',
      description: 'Redact the payload of a single audit trail record while preserving the chain link. SUPER_ADMIN only. Replaces the prior DELETE endpoint per 21 CFR §11.10(e).',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', pattern: UUID_PATTERN, description: 'Audit record ID (UUID)' } },
      },
      body: {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, redactedAt: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('REDACT_AUDIT_RECORD', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const { reason } = req.body as { reason: string };

    const record = await prisma.auditTrail.findUnique({ where: { id } });
    if (!record) return reply.code(404).send({ error: 'Audit record not found' });
    // redactedAt accessed via raw SQL because the Prisma client may not yet
    // be regenerated against the 20260520140000 migration on dev machines
    // with tsx watch holding the engine DLL (per LOCAL_SETUP_WINDOWS notes).
    const priorRedact = await prisma.$queryRaw<Array<{ redacted_at: Date | null }>>`
      SELECT redacted_at FROM audit_trail WHERE id = ${id}::uuid
    `;
    if (priorRedact[0]?.redacted_at) return reply.code(409).send({ error: 'ALREADY_REDACTED', message: 'Record was already redacted' });

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE audit_trail
        SET before_value = NULL,
            after_value = NULL,
            redacted_at = ${now},
            redacted_by = ${req.user.sub},
            redaction_reason = ${reason}
        WHERE id = ${id}::uuid
      `;
      // Meta-audit row records the redaction itself (within the same tx so
      // it cannot be lost if anything else fails).
      await auditLog({
        userId: req.user.username, userRole: req.user.role,
        action: 'AUDIT_RECORD_REDACTED',
        targetType: 'audit_trail', targetId: id,
        beforeValue: { id: record.id, action: record.action, timestamp: record.timestamp, userId: record.userId, targetType: record.targetType, targetId: record.targetId },
        reason,
        signatureMeaning: `Audit record ${id} payload redacted; chain link preserved`,
        ipAddress: req.ip, sessionId: req.user.sessionId,
      }, tx);
    });

    return { success: true, redactedAt: now.toISOString() };
  });

  // POST /api/audit/bulk-redact — redact multiple audit records (SUPER_ADMIN only).
  app.post('/bulk-redact', {
    preHandler: [app.requireSuperAdmin()],
    schema: {
      tags: ['Audit'],
      summary: 'Redact selected audit records',
      description: 'Redact the payloads of multiple audit trail records by ID. SUPER_ADMIN only. Replaces bulk-delete per 21 CFR §11.10(e).',
      body: {
        type: 'object',
        required: ['ids', 'reason'],
        properties: {
          ids: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, maxItems: 1000 },
          reason: { type: 'string', minLength: 5, maxLength: 500 },
        },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, count: { type: 'integer' }, redactedAt: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('BULK_REDACT_AUDIT_RECORDS', req, reply);
    if (!ok) return;
    const { ids, reason } = req.body as { ids: string[]; reason: string };

    // Pull un-redacted matching ids via raw SQL (Prisma client regen-pending
    // on dev). The redacted_at filter ensures we never re-redact (which
    // would overwrite the prior redactor's name + reason).
    const unredacted = await prisma.$queryRaw<Array<{ id: string; action: string; timestamp: Date; user_id: string | null; target_type: string | null; target_id: string | null }>>`
      SELECT id, action, timestamp, user_id, target_type, target_id
      FROM audit_trail
      WHERE id = ANY(${ids}::uuid[]) AND redacted_at IS NULL
    `;
    if (unredacted.length === 0) return reply.code(409).send({ error: 'ALREADY_REDACTED_OR_MISSING', message: 'No matching un-redacted records' });
    const matchedIds = unredacted.map((r) => r.id);

    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE audit_trail
        SET before_value = NULL,
            after_value = NULL,
            redacted_at = ${now},
            redacted_by = ${req.user.sub},
            redaction_reason = ${reason}
        WHERE id = ANY(${matchedIds}::uuid[])
      `;
      await auditLog({
        userId: req.user.username, userRole: req.user.role,
        action: 'AUDIT_RECORDS_BULK_REDACTED',
        // targetId is varchar(255); joining UUIDs overflowed at 7+ records
        // (37n-1 > 255) and Postgres raised 22001 inside the transaction, so
        // the whole bulk op rolled back with a 500. The full id list already
        // lives in the unbounded JSONB beforeValue.records below.
        targetType: 'audit_trail', targetId: undefined,
        beforeValue: { recordCount: unredacted.length, records: unredacted.map((r) => ({
          id: r.id, action: r.action, timestamp: r.timestamp, userId: r.user_id,
          targetType: r.target_type, targetId: r.target_id,
        })) },
        reason,
        signatureMeaning: `${unredacted.length} audit record payloads redacted; chain links preserved`,
        ipAddress: req.ip, sessionId: req.user.sessionId,
      }, tx);
      return updated;
    });

    return { success: true, count: result, redactedAt: now.toISOString() };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PHYSICAL HARD-DELETE (AUDIT_DELETE) — re-added 2026-07-01 at explicit
  // operator request. This is the endpoint that was REMOVED in 2026-05 (see
  // the redact block above) precisely because physical deletion BREAKS the
  // tamper-evident hash chain: it leaves a chain_position gap and orphans the
  // next row's previous_checksum, so GET /api/audit/verify-chain reports the
  // downstream chain INVALID, permanently. REDACT (POST /:id/redact) is the
  // 21 CFR §11.10(e)-compliant alternative that preserves the chain.
  //
  // We do NOT teach verify-chain / verifyAuditChecksum to tolerate authorized
  // deletions — the breakage stays loud and visible on purpose. A meta-audit
  // row (AUDIT_RECORD_DELETED) records who deleted what + why BEFORE the target
  // row is destroyed, so the deletion itself is never silent.
  // ─────────────────────────────────────────────────────────────────────────

  // DELETE /api/audit/:id — physically delete a single audit record (AUDIT_DELETE).
  app.delete('/:id', {
    preHandler: [app.requirePermission('AUDIT_DELETE')],
    schema: {
      tags: ['Audit'],
      summary: 'Permanently delete an audit record',
      description: 'PHYSICALLY delete a single audit trail record. Requires AUDIT_DELETE (SUPER_ADMIN bypasses) + reauth. WARNING: breaks the tamper-evident hash chain — verify-chain will report the downstream chain invalid. Prefer POST /:id/redact, which preserves the chain.',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', pattern: UUID_PATTERN, description: 'Audit record ID (UUID)' } },
      },
      body: {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // Checked BEFORE reauth: an installation that has switched this capability
    // off should not prompt an operator for their password to perform an
    // action that is going to be refused anyway.
    if (!isHardDeleteEnabled()) {
      return reply.code(403).send({
        error: 'AUDIT_HARD_DELETE_DISABLED',
        message: HARD_DELETE_DISABLED_MESSAGE,
      });
    }
    const { ok } = await enforceReauth('DELETE_AUDIT_RECORD', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const { reason } = req.body as { reason: string };

    // Scope the lookup exactly like the list/detail reads: a non-SUPER_ADMIN must
    // not be able to destroy accountability records it isn't even allowed to SEE.
    // Unscoped, an ADMIN granted `audit.delete` could permanently erase
    // SUPER_ADMIN audit rows — and the meta-audit row written first would echo
    // the hidden row's contents straight back to them in beforeValue.
    const record = await prisma.auditTrail.findFirst({
      where: {
        id,
        ...(req.user.role === 'SUPER_ADMIN'
          ? {}
          : { OR: [{ userRole: { not: 'SUPER_ADMIN' } }, { userRole: null }] }),
      },
    });
    if (!record) return reply.code(404).send({ error: 'Audit record not found' });

    await prisma.$transaction(async (tx) => {
      // Meta-audit FIRST (same tx) so the deletion is recorded even though the
      // target row is about to vanish. Skeleton only — mirrors the redact meta.
      await auditLog({
        userId: req.user.username, userRole: req.user.role,
        action: 'AUDIT_RECORD_DELETED',
        targetType: 'audit_trail', targetId: id,
        beforeValue: { id: record.id, action: record.action, timestamp: record.timestamp, userId: record.userId, targetType: record.targetType, targetId: record.targetId },
        reason,
        signatureMeaning: `Audit record ${id} PHYSICALLY DELETED; hash chain broken at this position`,
        ipAddress: req.ip, sessionId: req.user.sessionId,
      }, tx);
      // The audit_trail_no_delete trigger blocks physical deletes. Suspend it
      // for the scope of this tx only — see lib/audit-immutability.ts for the
      // locking rationale and why the re-enable lives in a `finally`.
      await withAuditDeletesAllowed(tx, async () => {
        await tx.auditTrail.delete({ where: { id } });
      });
    });

    return { success: true };
  });

  // POST /api/audit/bulk-delete — physically delete multiple audit records (AUDIT_DELETE).
  app.post('/bulk-delete', {
    preHandler: [app.requirePermission('AUDIT_DELETE')],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      tags: ['Audit'],
      summary: 'Permanently delete selected audit records',
      description: 'PHYSICALLY delete multiple audit trail records by ID. Requires AUDIT_DELETE (SUPER_ADMIN bypasses) + reauth. WARNING: breaks the tamper-evident hash chain — verify-chain will report the downstream chain invalid. Prefer POST /bulk-redact.',
      body: {
        type: 'object',
        required: ['ids', 'reason'],
        properties: {
          ids: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, maxItems: 1000 },
          reason: { type: 'string', minLength: 5, maxLength: 500 },
        },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, count: { type: 'integer' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // See the single-delete route: refused before reauth, not after.
    if (!isHardDeleteEnabled()) {
      return reply.code(403).send({
        error: 'AUDIT_HARD_DELETE_DISABLED',
        message: HARD_DELETE_DISABLED_MESSAGE,
      });
    }
    const { ok } = await enforceReauth('BULK_DELETE_AUDIT_RECORDS', req, reply);
    if (!ok) return;
    const { ids, reason } = req.body as { ids: string[]; reason: string };

    // Same role scoping as the single delete above — ids the caller may not read
    // simply don't match, so they are neither deleted nor echoed back.
    const records = await prisma.auditTrail.findMany({
      where: {
        id: { in: ids },
        ...(req.user.role === 'SUPER_ADMIN'
          ? {}
          : { OR: [{ userRole: { not: 'SUPER_ADMIN' } }, { userRole: null }] }),
      },
    });
    if (records.length === 0) return reply.code(404).send({ error: 'NO_MATCHING_RECORDS', message: 'No matching audit records' });
    const matchedIds = records.map((r) => r.id);

    const result = await prisma.$transaction(async (tx) => {
      await auditLog({
        userId: req.user.username, userRole: req.user.role,
        action: 'AUDIT_RECORDS_BULK_DELETED',
        // targetId is varchar(255) — see bulk-redact above. Ids are recorded in
        // beforeValue.records, which is JSONB and unbounded.
        targetType: 'audit_trail', targetId: undefined,
        beforeValue: { recordCount: records.length, records: records.map((r) => ({
          id: r.id, action: r.action, timestamp: r.timestamp, userId: r.userId,
          targetType: r.targetType, targetId: r.targetId,
        })) },
        reason,
        signatureMeaning: `${records.length} audit records PHYSICALLY DELETED; hash chain broken`,
        ipAddress: req.ip, sessionId: req.user.sessionId,
      }, tx);
      // Suspend the immutability trigger for this tx (see single-delete above).
      return await withAuditDeletesAllowed(tx, async () => {
        const del = await tx.auditTrail.deleteMany({ where: { id: { in: matchedIds } } });
        return del.count;
      });
    });

    return { success: true, count: result };
  });

  // GET /api/audit/verify-chain — audit 2026-05-04 fix C3.
  //
  // Walks the audit chain in chain_position order and reports any per-row
  // checksum mismatch, chain-link mismatch, or chain_position gap. SUPER_ADMIN
  // only — exposes the full integrity surface and should not be operator-
  // accessible by default.
  //
  // The chain itself is built into the audit_trail schema; this endpoint is
  // the auditor-facing read view. See apps/api/src/lib/audit-verify.ts for
  // detection semantics.
  app.get('/verify-chain', {
    preHandler: [app.requireSuperAdmin()],
    schema: {
      tags: ['Audit'],
      summary: 'Verify audit chain integrity',
      description: 'Walk the audit_trail hash chain and report any tampering. SUPER_ADMIN only. Optional fromPosition/toPosition narrow the scope; default is the full table.',
      querystring: {
        type: 'object',
        properties: {
          fromPosition: { type: 'integer', minimum: 0 },
          toPosition: { type: 'integer', minimum: 0 },
          maxAnomalies: { type: 'integer', minimum: 1, maximum: 10000, default: 100 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            intact: { type: 'boolean' },
            totalRowsChecked: { type: 'integer' },
            preChainRows: { type: 'integer' },
            chainedRows: { type: 'integer' },
            highestPosition: { type: 'integer', nullable: true },
            anomalies: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  position: { type: 'integer' },
                  id: { type: 'string' },
                  kind: { type: 'string' },
                  message: { type: 'string' },
                  expected: { type: 'string', nullable: true },
                  actual: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const q = req.query as { fromPosition?: number; toPosition?: number; maxAnomalies?: number };
    const result = await verifyAuditChain({
      fromPosition: q.fromPosition,
      toPosition: q.toPosition,
      maxAnomalies: q.maxAnomalies,
    });
    return result;
  });
}
