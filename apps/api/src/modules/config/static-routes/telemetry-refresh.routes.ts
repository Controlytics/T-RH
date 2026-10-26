import { type FastifyInstance } from 'fastify';
import { prisma } from '../../../lib/prisma.js';

const CONFIG_KEY = 'telemetry-slots';

/** The def's bounds (`telemetry-slots.def.ts`): a hand-edited row cannot poll every 0 s. */
const MIN_SECONDS = 2;
const MAX_SECONDS = 600;
const clamp = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), MIN_SECONDS), MAX_SECONDS) : fallback;

/**
 * How often the dashboard and an open chart re-poll — read by EVERY role that
 * can see the dashboard, not just SUPER_ADMIN (2026-10-26).
 *
 * The same narrow-slice pattern as `/alarm-limits/status-texts`: the
 * `telemetry-slots` def ("Dashboard Refresh") stays SUPER_ADMIN to EDIT, while
 * these two numbers are needed by everyone. Until this route existed the browser
 * read the whole def through `/dynamic/telemetry-slots`, which 403s for every
 * other role, so they silently polled on the hardcoded 5 s / 10 s whatever a
 * super admin had set.
 */
export async function telemetryRefreshRoutes(app: FastifyInstance) {
  app.get('/telemetry-slots/refresh', {
    schema: {
      tags: ['Config'],
      summary: 'Get the dashboard and chart refresh intervals',
      description: 'Seconds between polls of the dashboard and of an open time-series chart. Available to all authenticated users.',
      response: {
        200: {
          type: 'object',
          properties: {
            overviewRefreshSeconds: { type: 'integer' },
            chartRefreshSeconds: { type: 'integer' },
          },
          required: ['overviewRefreshSeconds', 'chartRefreshSeconds'],
        },
      },
    },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: CONFIG_KEY } });
    const cfg = (row?.configValue ?? {}) as Record<string, unknown>;
    return {
      overviewRefreshSeconds: clamp(cfg.overviewRefreshSeconds, 5),
      chartRefreshSeconds: clamp(cfg.chartRefreshSeconds, 10),
    };
  });
}
