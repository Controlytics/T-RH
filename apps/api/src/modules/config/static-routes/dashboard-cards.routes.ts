import { type FastifyInstance } from 'fastify';
import { errorResponses } from '../../../lib/error-schemas.js';
import { buildContext } from '../../../lib/build-context.js';
import { prisma } from '../../../lib/prisma.js';
import { enforceReauth } from '../../../lib/reauth-check.js';

// Keep in sync with ALL_CARDS in apps/web/src/routes/config/dashboard-cards.tsx
const VALID_CARD_KEYS = new Set([
  'total_users', 'audit_trail', 'notifications', 'filter_analytics',
  'total_filters', 'active_cycles', 'completed_today', 'stage_distribution',
  'cycle_status', 'daily_chart', 'monthly_chart', 'quick_actions',
]);

export async function dashboardCardsRoutes(app: FastifyInstance) {
  app.get('/dashboard-cards/current', {
    schema: {
      tags: ['Config'],
      summary: 'Get dashboard card visibility settings',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'dashboard-cards' } });
    return row?.configValue ?? {};
  });

  app.put('/dashboard-cards', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Config'],
      summary: 'Update dashboard card visibility per role',
      body: {
        type: 'object',
        properties: { configValue: { type: 'object', additionalProperties: true } },
        required: ['configValue'],
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    // Audit 2026-05-04 fix #5 (web-routes review H — lower-blast config
    // surfaces). Routed through the umbrella UPDATE_CONFIG_PAGE action.
    const { ok } = await enforceReauth('UPDATE_CONFIG_PAGE', req, reply);
    if (!ok) return;
    const { configValue } = req.body as { configValue: { roles?: Record<string, string[]> } };
    const ctx = buildContext(req);

    const rolesMap = configValue?.roles ?? {};
    const invalid: string[] = [];
    for (const [role, cards] of Object.entries(rolesMap)) {
      if (!Array.isArray(cards)) {
        return reply.code(400).send({ error: 'INVALID_CARDS', message: `Cards for role ${role} must be an array` });
      }
      for (const k of cards) {
        if (!VALID_CARD_KEYS.has(k)) invalid.push(`${role}:${k}`);
      }
    }
    if (invalid.length > 0) {
      return reply.code(400).send({ error: 'INVALID_CARD_KEY', message: `Unknown card key(s): ${invalid.join(', ')}` });
    }

    await prisma.systemConfig.upsert({
      where: { configKey: 'dashboard-cards' },
      update: { configValue, updatedBy: ctx.userSub },
      create: { configKey: 'dashboard-cards', configValue, configType: 'display', requiresReauth: false, updatedBy: ctx.userSub },
    });
    return { success: true };
  });
}
