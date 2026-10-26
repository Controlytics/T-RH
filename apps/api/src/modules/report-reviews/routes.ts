/**
 * `/api/report-reviews` — the report review workflow (2026-09-07). See
 * `service.ts` for the rules and the spec for the design.
 *
 * Six routes, no DELETE: a request is a §11 record. Every read is party-scoped
 * by the service, and a non-party gets a 404, never a 403 — a 403 would confirm
 * the id exists. Every response schema DECLARES its fields: Fastify strips what
 * the schema does not name (the seventh time this has mattered in this repo),
 * and the two JSON blobs are `additionalProperties: true` for the same reason.
 */
import { type FastifyInstance } from 'fastify';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauth, enforceReauthAlways } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { resolvePageSize } from '../../lib/page-size.js';
import { reportReviewService, policyForKind, assertRequestable, assertMayExportReport, type ReviewList } from './service.js';

const summaryProps = {
  id: { type: 'string' },
  reportType: { type: 'string' },
  title: { type: 'string' },
  subtitle: { type: 'string', nullable: true },
  requestMeta: { type: 'object', additionalProperties: true },
  status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] },
  requestedBy: { type: 'string' },
  requestedByName: { type: 'string' },
  // The roles at signing (2026-09-25) — declared, or Fastify strips them silently.
  requestedByRole: { type: 'string', nullable: true },
  requestedAt: { type: 'string' },
  requestRemarks: { type: 'string' },
  assigneeUserId: { type: 'string', nullable: true },
  assigneeRole: { type: 'string', nullable: true },
  // The frozen approvers and instruments (2026-10-01) — declared, or stripped.
  approverRoles: { type: 'array', items: { type: 'string' } },
  approverUserIds: { type: 'array', items: { type: 'string' } },
  instrumentIds: { type: 'array', items: { type: 'string' } },
  decidedBy: { type: 'string', nullable: true },
  decidedByName: { type: 'string', nullable: true },
  decidedByRole: { type: 'string', nullable: true },
  decidedAt: { type: 'string', nullable: true },
  decisionRemarks: { type: 'string', nullable: true },
  // sha256 of the frozen document (DATA-7) — declared, or stripped. NULL on a
  // request older than the column.
  snapshotHash: { type: 'string', nullable: true },
  createdAt: { type: 'string' },
} as const;

const summarySchema = { type: 'object', properties: summaryProps } as const;
// The list rows carry the SERVER's decision and the approver names (audit
// 2026-10-12 #9) — declared, or Fastify strips them and the page sees neither.
const listRowSchema = {
  type: 'object',
  properties: {
    ...summaryProps,
    canDecide: { type: 'boolean' },
    // Which of the two the caller may do (2026-10-26): separate permissions now.
    canApprove: { type: 'boolean' },
    canReject: { type: 'boolean' },
    approverUserNames: { type: 'array', items: { type: 'string' } },
  },
} as const;
const fullSchema = { type: 'object', properties: { ...summaryProps, dataSnapshot: { type: 'object', additionalProperties: true } } } as const;

/** `remarks` must state a reason: the schema's minLength alone accepts spaces. */
function requireRemarks(remarks: unknown): string | null {
  const trimmed = typeof remarks === 'string' ? remarks.trim() : '';
  return trimmed ? trimmed : null;
}

export default async function reportReviewRoutes(app: FastifyInstance) {
  // ── POST / — raise a request ───────────────────────────────────────────────
  app.post('/', {
    preHandler: [app.requirePermission('REPORT_REVIEW_READ')],
    // A snapshot carries every table row and any chart raster; well above the
    // default 1 MB.
    bodyLimit: 8 * 1024 * 1024,
    schema: {
      tags: ['Report Reviews'],
      summary: 'Raise a report request (every PDF download is one)',
      body: {
        type: 'object',
        required: ['reportKind', 'reportType', 'title', 'requestMeta', 'dataSnapshot'],
        properties: {
          // Which configured report type this is (2026-10-01) — decides whether
          // it may be requested at all, and whether remarks and the password are required.
          reportKind: { type: 'string', maxLength: 50 },
          reportType: { type: 'string', minLength: 1, maxLength: 100 },
          title: { type: 'string', minLength: 1, maxLength: 500 },
          subtitle: { type: 'string', maxLength: 1000 },
          requestMeta: { type: 'object', additionalProperties: true },
          dataSnapshot: { type: 'object', additionalProperties: true },
          remarks: { type: 'string', maxLength: 500 },
          instrumentIds: { type: 'array', items: { type: 'string' }, maxItems: 1000 },
        },
      },
      response: {
        // `eligibleApproverCount` — the users notified, who can decide it — is
        // declared, or Fastify strips it silently (2026-10-24).
        201: { type: 'object', properties: { ...summaryProps, eligibleApproverCount: { type: 'integer' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const raw = req.body as Record<string, unknown>;
    // The kind's policy BEFORE the password: nobody is asked to sign a request
    // the configuration refuses. Password = Yes asks EVERY role (2026-10-01);
    // the request is then the signature event the download used to be.
    const { kind, policy } = await policyForKind(raw.reportKind, raw.reportType);
    // The Audit Trail needs Export Audit Trail (2026-10-24) — before the password.
    await assertMayExportReport(req.user.role, String(raw.reportType));
    // Remarks are a free-text reason and exempt from HTML stripping, like every
    // other reason here ("value < 20 per SOP" must survive). The snapshot and
    // the meta are data, not text fields, and are not sanitised either.
    const body = sanitizeStrings(raw, ['remarks', 'dataSnapshot', 'requestMeta']);
    // Blank is allowed only when the kind's remarks are off.
    const remarks = requireRemarks(body.remarks) ?? '';
    // Mode and remarks BEFORE the password (code review, 2026-10-01).
    assertRequestable(kind, policy, remarks);
    if (policy.passwordRequired) {
      const { ok } = await enforceReauthAlways('DOWNLOAD_REPORT', req, reply);
      if (!ok) return;
    }
    const row = await reportReviewService.submit(buildContext(req), {
      reportKind: kind, policy,
      reportType: String(body.reportType), title: String(body.title),
      subtitle: typeof body.subtitle === 'string' ? body.subtitle : undefined,
      requestMeta: body.requestMeta, dataSnapshot: body.dataSnapshot, remarks,
      instrumentIds: Array.isArray(body.instrumentIds) ? (body.instrumentIds as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    });
    return reply.code(201).send(row);
  });

  // ── GET / — the three lists ────────────────────────────────────────────────
  app.get('/', {
    preHandler: [app.requirePermission('REPORT_REVIEW_READ')],
    schema: {
      tags: ['Report Reviews'],
      summary: 'List requests: queue (for my approval), mine (raised by me or my role), or approved',
      querystring: {
        type: 'object',
        properties: {
          list: { type: 'string', enum: ['queue', 'mine', 'approved'], default: 'queue' },
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, default: 25 },
        },
      },
      response: {
        200: { type: 'object', properties: { data: { type: 'array', items: listRowSchema }, total: { type: 'integer' } } },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const q = req.query as { list?: ReviewList; page?: number; pageSize?: number };
    return reportReviewService.list(buildContext(req), q.list ?? 'queue', q.page ?? 1, resolvePageSize(q.pageSize, 25));
  });

  // ── GET /:id — the full row with its snapshot, parties only ───────────────
  app.get('/:id', {
    preHandler: [app.requirePermission('REPORT_REVIEW_READ')],
    schema: {
      tags: ['Report Reviews'],
      summary: 'One request with its frozen document (parties only; 404 otherwise)',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: { 200: fullSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await reportReviewService.getForParty(buildContext(req), id);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Report request not found.' });
    return row;
  });

  // ── POST /:id/approve | /:id/reject ───────────────────────────────────────
  // Each verb has its OWN permission since 2026-10-26 (operator: "approve and
  // reject reports both should be two different permissions"); APPROVE gated
  // both until then.
  for (const [verb, decision, action, permission] of [
    ['approve', 'APPROVED', 'APPROVE_REPORT', 'REPORT_REVIEW_APPROVE'],
    ['reject', 'REJECTED', 'REJECT_REPORT', 'REPORT_REVIEW_REJECT'],
  ] as const) {
    app.post(`/:id/${verb}`, {
      preHandler: [app.requirePermission(permission)],
      schema: {
        tags: ['Report Reviews'],
        summary: `${verb === 'approve' ? 'Approve' : 'Reject'} a request (approvers in scope only; password re-auth)`,
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: { type: 'object', required: ['remarks'], properties: { remarks: { type: 'string', minLength: 1, maxLength: 500 } } },
        response: { 200: summarySchema, ...errorResponses },
      },
    }, async (req, reply) => {
      const { ok } = await enforceReauth(action, req, reply);
      if (!ok) return;
      const { id } = req.params as { id: string };
      const remarks = requireRemarks((req.body as { remarks?: unknown }).remarks);
      if (!remarks) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'remarks is required and cannot be blank.' });
      return reportReviewService.decide(buildContext(req), id, decision, remarks);
    });
  }

  // ── POST /:id/download-log — written BEFORE the browser saves the file ────
  app.post('/:id/download-log', {
    preHandler: [app.requirePermission('REPORT_REVIEW_READ')],
    schema: {
      tags: ['Report Reviews'],
      summary: 'Record a download of the APPROVED document (parties only)',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } }, ...errorResponses },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    await reportReviewService.logDownload(buildContext(req), id);
    return { success: true };
  });
}
