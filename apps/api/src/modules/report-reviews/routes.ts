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
import { enforceReauth } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { resolvePageSize } from '../../lib/page-size.js';
import { reportReviewService, type ReviewList } from './service.js';

const summaryProps = {
  id: { type: 'string' },
  reportType: { type: 'string' },
  title: { type: 'string' },
  subtitle: { type: 'string', nullable: true },
  requestMeta: { type: 'object', additionalProperties: true },
  status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] },
  requestedBy: { type: 'string' },
  requestedByName: { type: 'string' },
  requestedAt: { type: 'string' },
  requestRemarks: { type: 'string' },
  assigneeUserId: { type: 'string', nullable: true },
  assigneeRole: { type: 'string', nullable: true },
  decidedBy: { type: 'string', nullable: true },
  decidedByName: { type: 'string', nullable: true },
  decidedAt: { type: 'string', nullable: true },
  decisionRemarks: { type: 'string', nullable: true },
  createdAt: { type: 'string' },
} as const;

const summarySchema = { type: 'object', properties: summaryProps } as const;
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
        required: ['reportType', 'title', 'requestMeta', 'dataSnapshot', 'remarks'],
        properties: {
          reportType: { type: 'string', minLength: 1, maxLength: 100 },
          title: { type: 'string', minLength: 1, maxLength: 500 },
          subtitle: { type: 'string', maxLength: 1000 },
          requestMeta: { type: 'object', additionalProperties: true },
          dataSnapshot: { type: 'object', additionalProperties: true },
          remarks: { type: 'string', minLength: 1, maxLength: 500 },
          assigneeUserId: { type: 'string' },
          assigneeRole: { type: 'string', maxLength: 50 },
        },
      },
      response: { 201: summarySchema, ...errorResponses },
    },
  }, async (req, reply) => {
    // The request IS the signature event the download used to be.
    const { ok } = await enforceReauth('DOWNLOAD_REPORT', req, reply);
    if (!ok) return;
    const raw = req.body as Record<string, unknown>;
    // Remarks are a free-text reason and exempt from HTML stripping, like every
    // other reason here ("value < 20 per SOP" must survive). The snapshot and
    // the meta are data, not text fields, and are not sanitised either.
    const body = sanitizeStrings(raw, ['remarks', 'dataSnapshot', 'requestMeta']);
    const remarks = requireRemarks(body.remarks);
    if (!remarks) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'remarks is required and cannot be blank.' });
    const row = await reportReviewService.submit(buildContext(req), {
      reportType: String(body.reportType), title: String(body.title),
      subtitle: typeof body.subtitle === 'string' ? body.subtitle : undefined,
      requestMeta: body.requestMeta, dataSnapshot: body.dataSnapshot, remarks,
      assigneeUserId: typeof body.assigneeUserId === 'string' ? body.assigneeUserId : undefined,
      assigneeRole: typeof body.assigneeRole === 'string' ? body.assigneeRole : undefined,
    });
    return reply.code(201).send(row);
  });

  // ── GET / — the three lists ────────────────────────────────────────────────
  app.get('/', {
    preHandler: [app.requirePermission('REPORT_REVIEW_READ')],
    schema: {
      tags: ['Report Reviews'],
      summary: 'List requests: queue (for my approval), mine, or approved',
      querystring: {
        type: 'object',
        properties: {
          list: { type: 'string', enum: ['queue', 'mine', 'approved'], default: 'queue' },
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, default: 25 },
        },
      },
      response: {
        200: { type: 'object', properties: { data: { type: 'array', items: summarySchema }, total: { type: 'integer' } } },
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
  for (const [verb, decision, action] of [
    ['approve', 'APPROVED', 'APPROVE_REPORT'],
    ['reject', 'REJECTED', 'REJECT_REPORT'],
  ] as const) {
    app.post(`/:id/${verb}`, {
      preHandler: [app.requirePermission('REPORT_REVIEW_APPROVE')],
      schema: {
        tags: ['Report Reviews'],
        summary: `${verb === 'approve' ? 'Approve' : 'Reject'} a request (assignee only; password re-auth)`,
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
