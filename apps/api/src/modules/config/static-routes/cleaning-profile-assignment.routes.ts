import { type FastifyInstance } from 'fastify';
import { buildContext } from '../../../lib/build-context.js';
import { auditLog } from '../../../lib/audit.js';
import { prisma } from '../../../lib/prisma.js';
import { enforceReauth } from '../../../lib/reauth-check.js';

export async function cleaningProfileAssignmentRoutes(app: FastifyInstance) {
  app.get('/cleaning-profile-assignment', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Config'],
      summary: 'Get cleaning profile assignment configuration',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'cleaning-profile-assignment' } });
    return row?.configValue ?? { mode: 'BY_ENTITY', rules: [] };
  });

  app.put('/cleaning-profile-assignment', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Config'],
      summary: 'Update cleaning profile assignment configuration',
      body: {
        type: 'object',
        required: ['mode', 'rules'],
        properties: {
          mode: { type: 'string', enum: ['BY_FILTER_SIZE', 'BY_ENTITY', 'BY_AHU', 'BY_BLOCK', 'BY_FILTER_SET'] },
          rules: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } } },
    },
  }, async (req, reply) => {
    // Audit 2026-05-04 fix #5 (web-routes review H — lower-blast config
    // surfaces). Routed through the umbrella UPDATE_CONFIG_PAGE action.
    const { ok } = await enforceReauth('UPDATE_CONFIG_PAGE', req, reply);
    if (!ok) return;
    const body = req.body as { mode: string; rules: any[] };
    const ctx = buildContext(req);

    const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'cleaning-profile-assignment' } });

    await prisma.systemConfig.upsert({
      where: { configKey: 'cleaning-profile-assignment' },
      update: { configValue: body },
      create: { configKey: 'cleaning-profile-assignment', configValue: body as any, configType: 'filter' },
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CONFIG_CHANGED',
      targetType: 'system_config', targetId: 'cleaning-profile-assignment',
      beforeValue: existing?.configValue,
      afterValue: body,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return { success: true };
  });
}
