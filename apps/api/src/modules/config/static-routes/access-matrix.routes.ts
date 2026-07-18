import { type FastifyInstance } from 'fastify';
import { buildContext } from '../../../lib/build-context.js';
import { auditLog } from '../../../lib/audit.js';
import { prisma } from '../../../lib/prisma.js';

// Stored shape: { [moduleKey: string]: string[] }  — role names allowed to open each module
export async function accessMatrixRoutes(app: FastifyInstance) {
  app.get('/access-matrix', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: { tags: ['Config'], summary: 'Get configuration access matrix' },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'access-matrix' } });
    return (row?.configValue as any) ?? {};
  });

  app.put('/access-matrix', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Config'],
      summary: 'Update configuration access matrix',
      body: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
    },
  }, async (req) => {
    const body = req.body as Record<string, string[]>;
    const ctx = buildContext(req);
    const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'access-matrix' } });
    await prisma.systemConfig.upsert({
      where: { configKey: 'access-matrix' },
      update: { configValue: body },
      create: { configKey: 'access-matrix', configValue: body as any, configType: 'security' },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CONFIG_CHANGED',
      targetType: 'system_config', targetId: 'access-matrix',
      beforeValue: existing?.configValue,
      afterValue: body,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return { success: true };
  });

  app.get('/access-matrix/my-modules', {
    schema: { tags: ['Config'], summary: 'Get modules allowed for the current role' },
  }, async (req) => {
    const role = req.user?.role;
    if (!role) return { role: null, allowed: [] as string[] };
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'access-matrix' } });
    const matrix = (row?.configValue as Record<string, string[]>) ?? {};
    const allowed = Object.entries(matrix)
      .filter(([, roles]) => Array.isArray(roles) && roles.includes(role))
      .map(([moduleKey]) => moduleKey);
    return { role, allowed };
  });
}
