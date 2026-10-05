import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildContext } from '../../../lib/build-context.js';
import { auditLog } from '../../../lib/audit.js';
import { prisma } from '../../../lib/prisma.js';
import { enforceReauth } from '../../../lib/reauth-check.js';

// Role-wise, per-page export-format config.
// Stored shape: { [roleName: string]: { [surfaceKey: string]: 'NONE'|'PDF'|'EXCEL'|'BOTH' } }
// A missing role or missing surface FAILS OPEN (treated as BOTH) so a config
// gap never silently removes every export button. SUPER_ADMIN always gets BOTH.
//
// Audit 2026-10-03, API-18: the PUT accepted ANY string as a format — and the
// client's `formatToFlags` reads an unrecognised value as BOTH, so a typo
// stored here silently GRANTED every export. The vocabulary is enforced on
// the way in; the client keeps its fail-open reading for a missing entry,
// which is the documented contract above, not a defect. Re-authenticated
// with UPDATE_CONFIG_PAGE, the existing action for a configuration page save.
export const EXPORT_FORMATS = ['NONE', 'PDF', 'EXCEL', 'BOTH'] as const;
const exportOptionsSchema = z.record(
  z.string().min(1).max(50),
  z.record(z.string().min(1).max(100), z.enum(EXPORT_FORMATS)),
);

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
      body: { type: 'object', additionalProperties: true },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_CONFIG_PAGE', req, reply);
    if (!ok) return;
    const parsed = exportOptionsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const body = parsed.data;
    const ctx = buildContext(req);
    await prisma.$transaction(async (tx) => {
      const existing = await tx.systemConfig.findUnique({ where: { configKey: 'export-options' } });
      await tx.systemConfig.upsert({
        where: { configKey: 'export-options' },
        update: { configValue: body, updatedAt: new Date(), updatedBy: ctx.userId },
        create: { configKey: 'export-options', configValue: body, configType: 'security', updatedBy: ctx.userId },
      });
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole, action: 'CONFIG_CHANGED',
        targetType: 'system_config', targetId: 'export-options',
        beforeValue: existing?.configValue,
        afterValue: body,
        signatureMeaning: 'Role-wise export options updated',
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
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
