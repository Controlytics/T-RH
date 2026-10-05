import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildContext } from '../../../lib/build-context.js';
import { auditLog } from '../../../lib/audit.js';
import { prisma } from '../../../lib/prisma.js';
import { enforceReauth } from '../../../lib/reauth-check.js';

// Stored shape: { [moduleKey: string]: string[] }  — role names allowed to open each module
//
// Validated and re-authenticated like every other config PUT (audit
// 2026-10-03, API-18): until then the body went into `system_config` as sent
// and no password was asked. UPDATE_ROLE_CONFIG is the action the page's own
// save already wraps (`reauth.execute('UPDATE_ROLE_CONFIG', …)`, 2026-05-04) —
// this matrix binds roles to config modules, the same audit bucket as a role
// edit. The write and its audit row commit together (API-7).
const accessMatrixSchema = z.record(
  z.string().min(1).max(100),
  z.array(z.string().min(1).max(50)).max(100),
);

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
      body: { type: 'object', additionalProperties: true },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_ROLE_CONFIG', req, reply);
    if (!ok) return;
    const parsed = accessMatrixSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const body = parsed.data;
    const ctx = buildContext(req);
    await prisma.$transaction(async (tx) => {
      const existing = await tx.systemConfig.findUnique({ where: { configKey: 'access-matrix' } });
      await tx.systemConfig.upsert({
        where: { configKey: 'access-matrix' },
        update: { configValue: body, updatedAt: new Date(), updatedBy: ctx.userId },
        create: { configKey: 'access-matrix', configValue: body, configType: 'security', updatedBy: ctx.userId },
      });
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole, action: 'CONFIG_CHANGED',
        targetType: 'system_config', targetId: 'access-matrix',
        beforeValue: existing?.configValue,
        afterValue: body,
        signatureMeaning: 'Configuration access matrix updated',
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
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
