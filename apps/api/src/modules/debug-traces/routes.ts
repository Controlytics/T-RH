import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';

/**
 * Debug Traces — repointed onto audit_trail (2026-06-12).
 *
 * The original pipeline tracer wrote to `ts_pipeline_traces` in the TimescaleDB
 * `digilog_tsdb` database, which was dropped with the data-ingestion/TSDB
 * teardown (commit a95f6eb). The Debug Traces page is now an operations log
 * backed by the surviving (Postgres) `audit_trail` — every audited action is
 * shown as a single-stage SUCCESS trace. Consequences of the repoint:
 *   - audit_trail records only SUCCESSFUL audited actions, so finalStatus is
 *     always SUCCESS, there are no error codes, and durations are unknown (0).
 *   - the global + per-entity "tracing" toggles are vestigial: audit_trail is
 *     always populated regardless, and the write-path tracer no longer exists.
 *     They are kept config-backed / no-op so the UI doesn't error.
 */

type AuditRow = {
  id: string;
  timestamp: Date;
  userId: string | null;
  userName: string | null;
  userRole: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string | null;
  ipAddress: string | null;
  signatureMeaning: string | null;
};

/** Map an audit_trail row to the FE's PipelineTrace shape (routes/debug/types.ts). */
function toTrace(a: AuditRow) {
  const details: Record<string, unknown> = {};
  if (a.beforeValue != null) details.before = a.beforeValue;
  if (a.afterValue != null) details.after = a.afterValue;
  if (a.signatureMeaning) details.signatureMeaning = a.signatureMeaning;
  if (a.reason) details.reason = a.reason;
  if (a.userName) details.user = a.userName;
  if (a.userRole) details.role = a.userRole;
  if (a.ipAddress) details.ipAddress = a.ipAddress;
  return {
    id: a.id,
    time: a.timestamp.toISOString(),
    messageId: a.id,
    entityId: a.targetId ?? undefined,
    entityName: a.targetType ?? undefined,
    transport: 'API',
    messageType: a.action,
    stages: [
      { stage: 1, name: a.action, status: 'SUCCESS' as const, durationMs: 0, details },
    ],
    finalStatus: 'SUCCESS' as const,
    totalDurationMs: 0,
  };
}

export default async function debugTraceRoutes(app: FastifyInstance) {
  // List — paginated, filtered. audit_trail as the operations log.
  app.get('/', {
    preHandler: [app.requirePermission('READ_DEBUG_TRACE')],
    schema: {
      tags: ['Debug Traces'], summary: 'List audited operations (trace view)',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string' }, pageSize: { type: 'string' },
          status: { type: 'string' }, transport: { type: 'string' },
          errorCode: { type: 'string' }, entityId: { type: 'string' },
          from: { type: 'string' }, to: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(q.pageSize ?? '20', 10) || 20));

    // audit_trail has only SUCCESS / API / no-error rows. Any filter that
    // selects failures, a non-API transport, or an error code yields nothing.
    if ((q.status && q.status !== 'SUCCESS') || (q.transport && q.transport !== 'API') || q.errorCode) {
      return { data: [], total: 0, page, limit, totalPages: 1 };
    }

    const where: Record<string, unknown> = {};
    if (q.entityId) {
      where.OR = [
        { targetId: { contains: q.entityId, mode: 'insensitive' } },
        { userId: { contains: q.entityId, mode: 'insensitive' } },
        { userName: { contains: q.entityId, mode: 'insensitive' } },
        { action: { contains: q.entityId, mode: 'insensitive' } },
      ];
    }
    if (q.from || q.to) {
      const ts: Record<string, Date> = {};
      if (q.from) ts.gte = new Date(q.from);
      if (q.to) ts.lte = new Date(q.to);
      where.timestamp = ts;
    }

    const [rows, total] = await Promise.all([
      prisma.auditTrail.findMany({
        where,
        orderBy: { chainPosition: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.auditTrail.count({ where }),
    ]);

    return {
      data: (rows as AuditRow[]).map(toTrace),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  });

  // Stats — derived from audit_trail. All audited actions are successes.
  app.get('/stats', {
    preHandler: [app.requirePermission('READ_DEBUG_TRACE')],
    schema: { tags: ['Debug Traces'], summary: 'Operations trace stats' },
  }, async () => {
    const now = Date.now();
    const [c1h, c24h] = await Promise.all([
      prisma.auditTrail.count({ where: { timestamp: { gte: new Date(now - 3_600_000) } } }),
      prisma.auditTrail.count({ where: { timestamp: { gte: new Date(now - 86_400_000) } } }),
    ]);
    return {
      successRate1h: c1h > 0 ? 100 : 0,
      successRate24h: c24h > 0 ? 100 : 0,
      avgDurationMs: 0,
      topErrors: [] as Array<{ code: string; count: number }>,
      byTransport: { API: { total: c24h, failed: 0 } },
    };
  });

  // Vestigial global toggle — kept config-backed so the UI persists it without error.
  app.get('/operation-trace', {
    preHandler: [app.requirePermission('READ_DEBUG_TRACE')],
    schema: { tags: ['Debug Traces'], summary: 'Operation-trace flag (vestigial)' },
  }, async () => {
    const cfg = await prisma.systemConfig.findUnique({ where: { configKey: 'debug' } });
    const enabled = (cfg?.configValue as { operation_trace_enabled?: boolean } | null)?.operation_trace_enabled;
    return { enabled: enabled ?? true };
  });
  app.put('/operation-trace', {
    preHandler: [app.requirePermission('MANAGE_DEBUG_TRACE')],
    schema: {
      tags: ['Debug Traces'], summary: 'Set operation-trace flag (vestigial)',
      body: { type: 'object', properties: { enabled: { type: 'boolean' } } },
    },
  }, async (req) => {
    const enabled = !!(req.body as { enabled?: boolean }).enabled;
    await prisma.systemConfig.upsert({
      where: { configKey: 'debug' },
      update: { configValue: { operation_trace_enabled: enabled } },
      create: { configKey: 'debug', configValue: { operation_trace_enabled: enabled }, configType: 'debug' },
    });
    return { enabled };
  });

  // Vestigial per-entity toggle — the per-entity tracer was removed; harmless no-op.
  app.put('/entity/:id/toggle', {
    preHandler: [app.requirePermission('MANAGE_DEBUG_TRACE')],
    schema: { tags: ['Debug Traces'], summary: 'Per-entity tracing toggle (no-op)' },
  }, async () => {
    return { ok: true, note: 'Per-entity tracing was retired with the ingestion/TSDB removal.' };
  });

  // Detail — single audited operation. Registered last so it doesn't shadow the
  // static sub-routes above.
  app.get('/:id', {
    preHandler: [app.requirePermission('READ_DEBUG_TRACE')],
    schema: { tags: ['Debug Traces'], summary: 'Get one audited operation (trace detail)' },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const a = await prisma.auditTrail.findUnique({ where: { id } });
    if (!a) throw new AppError(404, 'NOT_FOUND', 'Trace not found.');
    return toTrace(a as AuditRow);
  });
}
