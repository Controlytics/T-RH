import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { enforceReauth, enforceReauthAlways } from '../../lib/reauth-check.js';
import { readSuperAdminApiEnabledUncached, setSuperAdminApiEnabled } from '../../lib/super-admin-lock.js';
import { auditLog } from '../../lib/audit.js';

/**
 * Super Admin routes — SUPER_ADMIN only, platform management
 * Prefix: /api/super-admin
 *
 * 2026-07-18 (compliance-core domain strip): the cleanroom "Filter Data
 * Management" console (retirements/replacements/cleaning-cycles/filter-events/
 * block-change/pm-entries) was removed with the domain. Only the core data
 * surfaces remain — notifications, admin requests, and read-only audit trail.
 *
 * PA-REAUTH-3: every mutation (PUT/POST/DELETE) under this module edits data
 * with NO application-level audit trail, so `requireDataEditReauth` enforces a
 * password step on every mutation; pair with the existing requireRole gate.
 */
async function requireDataEditReauth(req: FastifyRequest, reply: FastifyReply) {
  const { ok } = await enforceReauth('SUPER_ADMIN_DATA_EDIT', req, reply);
  if (!ok) return; // enforceReauth already sent the 401
}

export default async function superAdminRoutes(app: FastifyInstance) {

  // ─── PLATFORM STATS ───────────────────────────────────────────────
  app.get('/stats', {
    preHandler: [app.requireRole('SUPER_ADMIN')],
    schema: {
      tags: ['Super Admin'],
      summary: 'Platform-wide statistics',
    },
  }, async () => {
    const userCount = await prisma.user.count();
    // devices/entities retained as 0 for response-shape backward compat.
    return { users: userCount, devices: 0, entities: 0 };
  });

  // ─── SUPER ADMIN API KILL-SWITCH ──────────────────────────────────
  // Global ON/OFF for "everything the SUPER_ADMIN can do". When OFF, the
  // auth plugin (plugins/auth.ts) freezes every SUPER_ADMIN request except a
  // tiny allowlist that INCLUDES these two endpoints — so the switch can
  // always be read and flipped back ON. Login is public and also unaffected.
  app.get('/api-lock', {
    preHandler: [app.requireRole('SUPER_ADMIN')],
    schema: {
      tags: ['Super Admin'],
      summary: 'Read the Super Admin API access switch (true = APIs enabled)',
    },
  }, async () => {
    const enabled = await readSuperAdminApiEnabledUncached();
    return { enabled };
  });

  app.put('/api-lock', {
    preHandler: [app.requireRole('SUPER_ADMIN')],
    schema: {
      tags: ['Super Admin'],
      summary: 'Enable/disable Super Admin API access (password required)',
      body: {
        type: 'object',
        required: ['enabled'],
        properties: {
          enabled: { type: 'boolean' },
          _currentPassword: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauthAlways('TOGGLE_SUPER_ADMIN_API_ACCESS', req, reply);
    if (!ok) return; // enforceReauthAlways already sent 401

    const { enabled } = req.body as { enabled: boolean };
    const before = await readSuperAdminApiEnabledUncached();
    await setSuperAdminApiEnabled(enabled, req.user.sub);

    await auditLog({
      userId: req.user.sub,
      userName: req.user.username,
      userRole: req.user.role,
      action: 'SUPER_ADMIN_API_ACCESS_CHANGED',
      targetType: 'config',
      targetId: 'super-admin-api-access',
      beforeValue: { enabled: before },
      afterValue: { enabled },
      signatureMeaning: `Super Admin API access ${enabled ? 'ENABLED' : 'DISABLED'}`,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      sessionId: req.user.sessionId,
    });

    return { enabled };
  });

  // ═══════════════════════════════════════════════════════════════════
  // CORE DATA MANAGEMENT — SUPER_ADMIN only, no application audit trail
  // Generic list/edit/delete for the core data tables. GETs keep the
  // role-only gate; PUT/POST/DELETE add the reauth step.
  // ═══════════════════════════════════════════════════════════════════
  const dataPreHandler = [app.requireRole('SUPER_ADMIN')];
  const dataMutationPreHandler = [app.requireRole('SUPER_ADMIN'), requireDataEditReauth];
  const dataSchema = (summary: string) => ({
    tags: ['Super Admin - Data Management'],
    summary: `${summary} (no audit trail)`,
  });

  const paginatedList = async (model: any, query: any, orderBy: any = { createdAt: 'desc' }, include?: any, where?: any) => {
    const page = Number(query.page ?? 1);
    const limit = Math.min(Number(query.limit ?? 25), 100);
    const findArgs: any = { orderBy, skip: (page - 1) * limit, take: limit };
    if (include) findArgs.include = include;
    if (where) findArgs.where = where;
    const countArgs: any = where ? { where } : {};
    const [data, total] = await Promise.all([
      model.findMany(findArgs),
      model.count(countArgs),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  };

  const deleteRecord = async (model: any, id: string, label: string, reply: FastifyReply) => {
    try {
      await model.delete({ where: { id } });
      return { success: true };
    } catch (e: any) {
      if (e?.code === 'P2025') {
        return reply.code(404).send({ error: 'NOT_FOUND', message: `${label} not found.` });
      }
      return reply.code(400).send({ error: 'DELETE_FAILED', message: String(e?.message ?? `Could not delete ${label.toLowerCase()}.`) });
    }
  };

  // ─── Audit Trail (read-only) ──────────────────────────────────────
  // PUT + DELETE are intentionally absent — audit records are immutable per
  // 21 CFR §11.10(e); the DB-level audit_trail_no_delete trigger and
  // verifyAuditChain are the source of truth. Redaction goes through the
  // dedicated REDACT path (audit/routes.ts) which preserves the hash chain.
  app.get('/data/audit-trail', { preHandler: dataPreHandler, schema: dataSchema('List audit trail entries') }, async (req) => {
    return paginatedList(prisma.auditTrail, req.query, { timestamp: 'desc' });
  });

  // ─── Notifications ────────────────────────────────────────────────
  app.get('/data/notifications', { preHandler: dataPreHandler, schema: dataSchema('List notifications') }, async (req) => {
    return paginatedList(prisma.notification, req.query, { createdAt: 'desc' });
  });

  app.put('/data/notifications/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Edit notification'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', additionalProperties: true } } }, async (req, reply) => {
    const { id } = req.params as any;
    const body = req.body as any;
    const data: any = {};
    for (const f of ['type', 'title', 'message', 'forUserId', 'forRole', 'targetUserId', 'createdBy']) { if (body[f] !== undefined) data[f] = body[f]; }
    if (body.isRead !== undefined) data.isRead = body.isRead === true || body.isRead === 'true';
    if (body.readAt !== undefined) data.readAt = body.readAt ? new Date(body.readAt) : null;
    return prisma.notification.update({ where: { id }, data });
  });

  app.post('/data/notifications', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Create notification'), body: { type: 'object', additionalProperties: true } } }, async (req, reply) => {
    const body = req.body as any;
    const data: any = {};
    for (const f of ['type', 'title', 'message', 'forUserId', 'forRole', 'targetUserId', 'createdBy']) { if (body[f] !== undefined && body[f] !== '') data[f] = body[f]; }
    if (body.isRead !== undefined) data.isRead = body.isRead === true || body.isRead === 'true';
    if (body.readAt) data.readAt = new Date(body.readAt);
    if (body.createdAt) data.createdAt = new Date(body.createdAt);
    if (!data.type) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'Type is required.' });
    if (!data.title) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'Title is required.' });
    if (!data.message) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'Message is required.' });
    if (!data.createdBy) data.createdBy = (req.user as any)?.sub;
    data.manualEntry = true;
    try {
      return await prisma.notification.create({ data });
    } catch (e: any) {
      return reply.code(400).send({ error: 'CREATE_FAILED', message: String(e?.message ?? 'Could not create notification.') });
    }
  });

  app.delete('/data/notifications/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Delete notification'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } }, async (req, reply) => {
    const { id } = req.params as any;
    return deleteRecord(prisma.notification, id, 'Notification', reply);
  });

  // ─── Admin Requests ───────────────────────────────────────────────
  app.get('/data/admin-requests', { preHandler: dataPreHandler, schema: dataSchema('List admin requests') }, async (req) => {
    return paginatedList(prisma.adminRequest, req.query, { requestedAt: 'desc' });
  });

  app.put('/data/admin-requests/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Edit admin request'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', additionalProperties: true } } }, async (req) => {
    const { id } = req.params as any;
    const body = req.body as any;
    const data: any = {};
    for (const f of ['requestType', 'status', 'requesterName', 'requesterEmployeeId', 'requesterEmail', 'remarks', 'adminRemarks', 'processedBy']) {
      if (body[f] !== undefined) data[f] = body[f];
    }
    for (const f of ['requestedAt', 'processedAt']) {
      if (body[f] !== undefined) data[f] = body[f] ? new Date(body[f]) : null;
    }
    if (body.requestData !== undefined) data.requestData = body.requestData;
    return prisma.adminRequest.update({ where: { id }, data });
  });

  app.post('/data/admin-requests', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Create admin request'), body: { type: 'object', additionalProperties: true } } }, async (req, reply) => {
    const body = req.body as any;
    const data: any = {};
    for (const f of ['requestType', 'status', 'requesterName', 'requesterEmployeeId', 'requesterEmail', 'remarks', 'adminRemarks', 'processedBy']) { if (body[f] !== undefined && body[f] !== '') data[f] = body[f]; }
    for (const f of ['requestedAt', 'processedAt']) { if (body[f]) data[f] = new Date(body[f]); }
    if (body.requestData !== undefined) data.requestData = body.requestData;
    if (!data.requestType) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'Request type is required.' });
    if (!data.requesterName) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'Requester name is required.' });
    data.manualEntry = true;
    try {
      return await prisma.adminRequest.create({ data });
    } catch (e: any) {
      return reply.code(400).send({ error: 'CREATE_FAILED', message: String(e?.message ?? 'Could not create admin request.') });
    }
  });

  app.delete('/data/admin-requests/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Delete admin request'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } }, async (req, reply) => {
    const { id } = req.params as any;
    return deleteRecord(prisma.adminRequest, id, 'Admin request', reply);
  });
}
