import { type FastifyInstance } from 'fastify';
import { buildContext } from '../../../lib/build-context.js';
import { auditLog } from '../../../lib/audit.js';
import { prisma } from '../../../lib/prisma.js';

// Role-wise, per-page export-format config.
// Stored shape: { [roleName: string]: { [surfaceKey: string]: 'NONE'|'PDF'|'EXCEL'|'BOTH' } }
// A missing role or missing surface FAILS OPEN (treated as BOTH) so a config
// gap never silently removes every export button. SUPER_ADMIN always gets BOTH.
export async function exportOptionsRoutes(app: FastifyInstance) {
  app.get('/export-options', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: { tags: ['Config'], summary: 'Get the role-wise export-format matrix' },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'export-options' } });
    return (row?.configValue as any) ?? {};
  });

  app.put('/export-options', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Config'],
      summary: 'Update the role-wise export-format matrix',
      body: {
        type: 'object',
        additionalProperties: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
  }, async (req) => {
    const body = req.body as Record<string, Record<string, string>>;
    const ctx = buildContext(req);
    const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'export-options' } });
    await prisma.systemConfig.upsert({
      where: { configKey: 'export-options' },
      update: { configValue: body },
      create: { configKey: 'export-options', configValue: body as any, configType: 'security' },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CONFIG_CHANGED',
      targetType: 'system_config', targetId: 'export-options',
      beforeValue: existing?.configValue,
      afterValue: body,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return { success: true };
  });

  // Current user's per-surface formats (any authenticated user). The gating
  // hook reads this; missing surfaces default to BOTH on the client.
  app.get('/export-options/current', {
    schema: { tags: ['Config'], summary: 'Export formats allowed for the current role' },
  }, async (req) => {
    const role = req.user?.role;
    if (!role || role === 'SUPER_ADMIN') return {}; // SUPER_ADMIN / unknown -> all BOTH
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'export-options' } });
    const matrix = (row?.configValue as Record<string, Record<string, string>>) ?? {};
    return matrix[role] ?? {};
  });
}
