import { type FastifyInstance } from 'fastify';
import { buildContext } from '../../../lib/build-context.js';
import { auditLog } from '../../../lib/audit.js';
import { prisma } from '../../../lib/prisma.js';

/**
 * Report Labels config — admin-editable titles, subtitles and table column
 * headers for every report (view + PDF). Stored as a free-form override map in
 * systemConfig key 'report-labels':
 *   { [reportKey]: { title?, subtitle?, columns?: { [colKey]: label } } }
 * The web merges this over the built-in defaults (lib/report-labels.ts), so an
 * empty/missing config means "use the built-in labels".
 */
export async function reportLabelsRoutes(app: FastifyInstance) {
  app.get('/report-labels/current', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Config'],
      summary: 'Get report label overrides (titles / subtitles / column headers)',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'report-labels' } });
    return row?.configValue ?? {};
  });

  app.put('/report-labels', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Config'],
      summary: 'Update report label overrides',
      // Free-form override map; the web validates shape against the defaults.
      body: { type: 'object', additionalProperties: true },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } } },
    },
  }, async (req) => {
    const body = req.body as Record<string, unknown>;
    const ctx = buildContext(req);

    const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'report-labels' } });

    await prisma.systemConfig.upsert({
      where: { configKey: 'report-labels' },
      update: { configValue: body as any },
      create: { configKey: 'report-labels', configValue: body as any, configType: 'display' },
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CONFIG_CHANGED',
      targetType: 'system_config', targetId: 'report-labels',
      beforeValue: existing?.configValue,
      afterValue: body,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return { success: true };
  });
}
