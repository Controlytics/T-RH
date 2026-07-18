import { type FastifyInstance } from 'fastify';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauthAlways } from '../../lib/reauth-check.js';
import { stageApprovalService as svc } from './service.js';

// Cleaning Stage Interlock — approver side. Prefix /api/stage-approvals
export default async function stageApprovalRoutes(app: FastifyInstance) {
  // My actionable queue — PENDING approvals routed to my role.
  app.get('/queue', {
    preHandler: [app.requirePermission('STAGE_APPROVAL_VIEW')],
    schema: { tags: ['Stage Approvals'], summary: 'Cleaning stages awaiting my approval' },
  }, async (req) => {
    return { data: await svc.queue(buildContext(req)) };
  });

  // Broader list — ?status=APPROVED|REJECTED|PENDING.
  // FILTER_OPERATE is accepted so any operating role can see the status of the
  // stage-approval requests IT raised (svc.list scopes non-SA to
  // approverRole=role OR requestedBy=self). Without it, operating roles that
  // lack STAGE_APPROVAL_VIEW (e.g. SUPERVISOR on live) got a 403 and the tablet
  // Approvals screen was empty even for their own requests.
  app.get('/', {
    preHandler: [app.requireAnyPermission('STAGE_APPROVAL_VIEW', 'FILTER_OPERATE')],
    schema: {
      tags: ['Stage Approvals'], summary: 'List stage approvals',
      querystring: { type: 'object', properties: { status: { type: 'string' } } },
    },
  }, async (req) => {
    const q = req.query as { status?: string };
    return { data: await svc.list(buildContext(req), { status: q.status }) };
  });

  // Full record incl. the frozen details snapshot.
  app.get('/:id', {
    preHandler: [app.requirePermission('STAGE_APPROVAL_VIEW')],
    schema: { tags: ['Stage Approvals'], summary: 'Get a stage approval (with snapshot)' },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return svc.getById(id);
  });

  // Approve — releases the operator. Reauth password = the digital signature.
  app.post('/:id/approve', {
    preHandler: [app.requirePermission('STAGE_APPROVAL_DECIDE')],
    schema: {
      tags: ['Stage Approvals'], summary: 'Approve a cleaning stage (release the operator)',
      body: {
        type: 'object',
        properties: { remarks: { type: 'string' }, _currentPassword: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauthAlways('APPROVE_CLEANING_STAGE', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const b = req.body as { remarks?: string };
    const row = await svc.approve(buildContext(req), id, b.remarks);
    return { id: row.id, status: row.status };
  });

  // Reject — moves the filter back; remarks mandatory. Reauth = digital signature.
  app.post('/:id/reject', {
    preHandler: [app.requirePermission('STAGE_APPROVAL_DECIDE')],
    schema: {
      tags: ['Stage Approvals'], summary: 'Reject a cleaning stage (send the filter back)',
      body: {
        type: 'object', required: ['remarks'],
        properties: { remarks: { type: 'string' }, _currentPassword: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauthAlways('REJECT_CLEANING_STAGE', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const b = req.body as { remarks?: string };
    const row = await svc.reject(buildContext(req), id, b.remarks);
    return { id: row.id, status: row.status };
  });

  // Bulk approve/reject — ONE request + ONE signature covers the whole selection,
  // instead of N sequential POSTs. Loops the existing approve/reject per id
  // (own tx + own audit e-signature each); PARTIAL SUCCESS. Reauth-always
  // enforced once for the batch, exactly as the single routes.
  app.post('/bulk-decide', {
    preHandler: [app.requirePermission('STAGE_APPROVAL_DECIDE')],
    schema: {
      tags: ['Stage Approvals'], summary: 'Batch approve/reject cleaning stages (partial success)',
      body: {
        type: 'object', required: ['ids', 'action'],
        properties: {
          ids: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', format: 'uuid' } },
          action: { type: 'string', enum: ['approve', 'reject'] },
          remarks: { type: 'string' },
          _currentPassword: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const b = req.body as { ids: string[]; action: 'approve' | 'reject'; remarks?: string };
    // Rejection remarks are mandatory, min 3 chars — match reject()'s own bar so
    // a short-remarks batch fails fast (400) instead of burning the reauth
    // signature and then failing every item inside bulkDecide.
    if (b.action === 'reject' && (b.remarks?.trim().length ?? 0) < 3) {
      return reply.code(400).send({ error: 'REMARKS_REQUIRED', message: 'Rejection remarks are required (min 3 characters).' });
    }
    const { ok } = await enforceReauthAlways(
      b.action === 'approve' ? 'APPROVE_CLEANING_STAGE' : 'REJECT_CLEANING_STAGE', req, reply);
    if (!ok) return;
    return svc.bulkDecide(buildContext(req), b.ids, b.action, b.remarks);
  });
}
