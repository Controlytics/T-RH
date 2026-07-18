import { type FastifyInstance } from 'fastify';
import { buildContext } from '../../../lib/build-context.js';
import { auditLog } from '../../../lib/audit.js';
import { prisma } from '../../../lib/prisma.js';

// Per-role toggle: may this role see the filters under each AHU on the
// PM Schedule page? Stored shape: { [roleName: string]: boolean }.
// FAIL-CLOSED — a role with no entry does NOT see filters (opt-in per role).
// SUPER_ADMIN always sees them. SEPARATE from replacement-schedule-filters.
export async function pmScheduleFiltersRoutes(app: FastifyInstance) {
  app.get('/pm-schedule-filters', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: { tags: ['Config'], summary: 'Get the per-role "show AHU filters" matrix (PM Schedule)' },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'pm-schedule-filters' } });
    return (row?.configValue as any) ?? {};
  });

  app.put('/pm-schedule-filters', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Config'],
      summary: 'Update the per-role "show AHU filters" matrix (PM Schedule)',
      body: { type: 'object', additionalProperties: { type: 'boolean' } },
    },
  }, async (req) => {
    const body = req.body as Record<string, boolean>;
    const ctx = buildContext(req);
    const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'pm-schedule-filters' } });
    await prisma.systemConfig.upsert({
      where: { configKey: 'pm-schedule-filters' },
      update: { configValue: body },
      create: { configKey: 'pm-schedule-filters', configValue: body as any, configType: 'security' },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CONFIG_CHANGED',
      targetType: 'system_config', targetId: 'pm-schedule-filters',
      beforeValue: existing?.configValue, afterValue: body,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return { success: true };
  });

  // Whether the CURRENT user's role may see AHU filters (any authenticated user).
  app.get('/pm-schedule-filters/current', {
    schema: { tags: ['Config'], summary: 'May the current role see AHU filters on PM Schedule?' },
  }, async (req) => {
    const role = req.user?.role;
    if (!role) return { enabled: false };
    if (role === 'SUPER_ADMIN') return { enabled: true };
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'pm-schedule-filters' } });
    const map = (row?.configValue as Record<string, boolean>) ?? {};
    return { enabled: !!map[role] };
  });
}
