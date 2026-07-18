import { type FastifyInstance } from 'fastify';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauthAlways } from '../../lib/reauth-check.js';
import { reportReviewService as svc } from './service.js';

// Report Review/Approval workflow — prefix /api/report-reviews
export default async function reportReviewRoutes(app: FastifyInstance) {
  // Submit a generated report for review (snapshot + assign to a user or role).
  app.post('/', {
    preHandler: [app.requirePermission('REPORT_REVIEW_SUBMIT')],
    schema: {
      tags: ['Report Reviews'],
      summary: 'Send a generated report for review',
      body: {
        type: 'object',
        required: ['reportType', 'title', 'dataSnapshot'],
        properties: {
          reportType: { type: 'string' },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          dataSnapshot: {},
          assigneeUserId: { type: 'string' },
          assigneeRole: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const row = await svc.submit(ctx, req.body as any);
    return { id: row.id, status: row.status };
  });

  // My actionable queue (items assigned to me / my role at their current stage).
  app.get('/queue', {
    preHandler: [app.requireAnyPermission('REPORT_REVIEW_SUBMIT', 'REPORT_REVIEW', 'REPORT_APPROVE')],
    schema: { tags: ['Report Reviews'], summary: 'Reports awaiting my review or approval' },
  }, async (req) => {
    const ctx = buildContext(req);
    return { data: await svc.queue(ctx) };
  });

  // Broader list — ?status=APPROVED for the archive, ?mine=true for what I submitted.
  app.get('/', {
    preHandler: [app.requireAnyPermission('REPORT_REVIEW_SUBMIT', 'REPORT_REVIEW', 'REPORT_APPROVE')],
    schema: {
      tags: ['Report Reviews'], summary: 'List report reviews',
      querystring: { type: 'object', properties: { status: { type: 'string' }, mine: { type: 'string' } } },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const q = req.query as { status?: string; mine?: string };
    return { data: await svc.list(ctx, { status: q.status, mine: q.mine === 'true' }) };
  });

  // Full record incl. the data snapshot — used for preview + (re)download.
  app.get('/:id', {
    preHandler: [app.requireAnyPermission('REPORT_REVIEW_SUBMIT', 'REPORT_REVIEW', 'REPORT_APPROVE')],
    schema: { tags: ['Report Reviews'], summary: 'Get a report review (with snapshot)' },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return svc.getById(buildContext(req), id);
  });

  // Stage 2 — reviewer approves (assigns approver) or rejects. Reauth required.
  app.post('/:id/review', {
    preHandler: [app.requirePermission('REPORT_REVIEW')],
    schema: {
      tags: ['Report Reviews'], summary: 'Review a report (approve → approval stage, or reject)',
      body: {
        type: 'object', required: ['action'],
        properties: {
          action: { type: 'string', enum: ['approve', 'reject'] },
          remarks: { type: 'string' },
          assigneeUserId: { type: 'string' },
          assigneeRole: { type: 'string' },
          _currentPassword: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauthAlways('REVIEW_REPORT', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const b = req.body as any;
    const row = await svc.review(buildContext(req), id, b.action, b.remarks, b.assigneeUserId, b.assigneeRole);
    return { id: row.id, status: row.status };
  });

  // Stage 3 — approver approves (→ APPROVED) or rejects. Reauth required.
  app.post('/:id/approve', {
    preHandler: [app.requirePermission('REPORT_APPROVE')],
    schema: {
      tags: ['Report Reviews'], summary: 'Approve a report (→ APPROVED) or reject',
      body: {
        type: 'object', required: ['action'],
        properties: {
          action: { type: 'string', enum: ['approve', 'reject'] },
          remarks: { type: 'string' },
          _currentPassword: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauthAlways('APPROVE_REPORT', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const b = req.body as any;
    const row = await svc.approve(buildContext(req), id, b.action, b.remarks);
    return { id: row.id, status: row.status };
  });
}
