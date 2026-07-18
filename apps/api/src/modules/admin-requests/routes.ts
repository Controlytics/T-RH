import { type FastifyInstance } from 'fastify';
import { enforceReauth } from '../../lib/reauth-check.js';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { adminRequestService } from './admin-request.service.js';
import { prisma } from '../../lib/prisma.js';

export default async function adminRequestRoutes(app: FastifyInstance) {

  // 1. POST / — Submit a new request (PUBLIC, no auth)
  app.post('/', {
    config: {
      skipAuth: true,
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        keyGenerator: (req: any) => req.ip,
      },
    },
    schema: {
      tags: ['Admin Requests'],
      summary: 'Submit an admin request',
      description: 'Public endpoint for users to submit requests to admin (create user, modify, unlock, forgot password).',
      security: [],
      body: {
        type: 'object',
        required: ['requestType', 'requesterName', 'requesterEmployeeId', 'requestData'],
        properties: {
          requestType: { type: 'string', enum: ['CREATE_USER', 'MODIFY_USER', 'UNLOCK', 'FORGOT_PASSWORD'] },
          requesterName: { type: 'string', minLength: 1, maxLength: 100 },
          requesterEmployeeId: { type: 'string', minLength: 1, maxLength: 50 },
          requesterEmail: { type: 'string', format: 'email', maxLength: 100 },
          requestData: { type: 'object', additionalProperties: true },
          remarks: { type: 'string', maxLength: 500 },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            requestId: { type: 'string' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const body = req.body as {
      requestType: string;
      requesterName: string;
      requesterEmployeeId?: string;
      requesterEmail?: string;
      requestData: Record<string, unknown>;
      remarks?: string;
    };

    const request = await adminRequestService.create(body);
    return reply.code(201).send({
      success: true,
      message: 'Your request has been submitted. An administrator will review it shortly.',
      requestId: request.id,
    });
  });

  // 1b. GET /user-lookup — Public lookup by employee ID (for contact-admin form).
  // Delta-audit 2026-05-20 / May 16 H1 fix: pre-fix returned distinguishable
  // 200 (with full PII) vs 404 responses — perfect enumeration oracle for
  // an attacker probing the org's directory. Two changes:
  //   1. Response is uniform — always 200 with { exists, username, fullName? }.
  //      No 404, no distinguishable error code.
  //   2. Sensitive fields (email, department, role, status) are dropped.
  //      They were used for FE auto-fill on MODIFY_USER; FE now asks the
  //      operator to type the new values (safer UX too).
  // Rate limit kept at 20/15min (rate-limiting alone wasn't enough — the
  // shape of the response leaked info even at 1 req/min).
  app.get('/user-lookup', {
    config: {
      skipAuth: true,
      rateLimit: {
        max: 20,
        timeWindow: '15 minutes',
        keyGenerator: (req: any) => req.ip,
      },
    },
    schema: {
      tags: ['Admin Requests'],
      summary: 'Lookup a user by employee ID (username)',
      description: 'Public endpoint used by the contact-admin form to confirm a user exists. Returns minimal info to prevent unauthenticated enumeration of org directory.',
      security: [],
      querystring: {
        type: 'object',
        required: ['username'],
        properties: { username: { type: 'string', minLength: 1, maxLength: 50 } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            exists: { type: 'boolean' },
            username: { type: 'string' },
            fullName: { type: ['string', 'null'] },
          },
        },
      },
    },
  }, async (req) => {
    const { username } = req.query as { username: string };
    const user = await prisma.user.findUnique({
      where: { username: username.trim() },
      select: { username: true, fullName: true },
    });
    if (!user) return { exists: false, username: username.trim(), fullName: null };
    return { exists: true, username: user.username, fullName: user.fullName };
  });

  // 2. GET / — List all requests (admin only)
  app.get('/', {
    preHandler: [app.requireAnyPermission('ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT')],
    schema: {
      tags: ['Admin Requests'],
      summary: 'List admin requests',
      description: 'List all admin requests. Requires ADMIN_REQUEST_APPROVE or ADMIN_REQUEST_REJECT.',
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
            pendingCount: { type: 'number' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { status } = req.query as { status?: string };
    const [data, pendingCount] = await Promise.all([
      adminRequestService.list(status),
      adminRequestService.pendingCount(),
    ]);
    return { data, pendingCount };
  });

  // 3. GET /pending-count — Count pending requests (admin only)
  app.get('/pending-count', {
    preHandler: [app.requireAnyPermission('ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT')],
    schema: {
      tags: ['Admin Requests'],
      summary: 'Count pending admin requests',
      response: {
        200: {
          type: 'object',
          properties: { count: { type: 'number' } },
        },
      },
    },
  }, async () => {
    const count = await adminRequestService.pendingCount();
    return { count };
  });

  // 4. POST /:id/process — Approve or reject a request (admin only, reauth)
  app.post('/:id/process', {
    // 2026-06-30: body-aware gate — approve action requires ADMIN_REQUEST_APPROVE,
    // reject requires ADMIN_REQUEST_REJECT (distinct from the REVIEW/view level).
    // req.body is parsed+validated before preHandler runs; requirePermission 403s
    // (and halts the chain) if the user lacks the action's perm. SUPER_ADMIN bypasses.
    preHandler: [async (req, reply) => {
      const action = (req.body as { action?: string } | undefined)?.action;
      const perm = action === 'reject' ? 'ADMIN_REQUEST_REJECT' : 'ADMIN_REQUEST_APPROVE';
      await app.requirePermission(perm)(req, reply);
    }],
    schema: {
      tags: ['Admin Requests'],
      summary: 'Process (approve/reject) an admin request',
      description: 'Approve or reject a pending admin request. Requires re-authentication.',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['approve', 'reject'] },
          adminRemarks: { type: 'string', maxLength: 500 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
            username: { type: 'string' },
            temporaryPassword: { type: 'string' },
            message: { type: 'string' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // M1 (audit 2026-05-04): use APPROVE_ADMIN_REQUEST instead of CREATE_USER.
    // The admin-request approve/reject flow covers password-reset / unlock /
    // modify-user as well, none of which are user-creation. The dedicated
    // action keeps the audit trail honest about WHICH role action this is.
    const { ok } = await enforceReauth('APPROVE_ADMIN_REQUEST', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const { action, adminRemarks } = req.body as { action: 'approve' | 'reject'; adminRemarks?: string };
    const ctx = buildContext(req);

    const result = await adminRequestService.process(id, action, adminRemarks ?? '', ctx);
    const { username, temporaryPassword, message, ...rest } = result as any;
    return { success: true, data: rest, ...(username && { username }), ...(temporaryPassword && { temporaryPassword }), ...(message && { message }) };
  });
}
