import { type FastifyInstance } from 'fastify';
import { ALARM_STATUS_TEXT_DEFAULT, LIMIT_DISABLED_TEXT_DEFAULT } from '@digilog/shared';
import { prisma } from '../../../lib/prisma.js';

const CONFIG_KEY = 'alarm-limits';

/**
 * Alarm status wording — read by every operator who can see the Alarms page, not
 * just SUPER_ADMIN.
 *
 * `alarm-limits` itself stays SUPER_ADMIN-only (`requiredRole: 'SUPER_ADMIN'` in
 * `defs/alarm-limits.def.ts`, enforced by the `/dynamic/alarm-limits` GET/PUT in
 * `dynamic-routes.ts`) because most of that config is sensitive: the attribute-key
 * mapping and the master switch decide what fires as a regulated alarm. This route does NOT
 * widen that gate — it exposes a narrower slice that is pure display wording, the
 * same way `/report-page-titles/current` exposes report chrome labels to all
 * authenticated users while the editor stays permission-gated.
 *
 * Deliberately excludes `enabled` and every `*Keys` field — those
 * govern whether/how an alarm is raised at all, which stays SUPER_ADMIN-only.
 */
export async function alarmLimitsStatusTextsRoutes(app: FastifyInstance) {
  app.get('/alarm-limits/status-texts', {
    schema: {
      tags: ['Config'],
      summary: 'Get the four alarm status wording strings',
      description: 'Configurable alarm status text (active/cleared × acknowledged/unacknowledged). Available to all authenticated users; blank or unset falls back to the default wording.',
      response: {
        200: {
          type: 'object',
          properties: {
            statusActiveUnack: { type: 'string' },
            statusActiveAck: { type: 'string' },
            statusClearedUnack: { type: 'string' },
            statusClearedAck: { type: 'string' },
            // The switched-off-limit wording rides with the status texts rather
            // than opening a SEVENTH narrow-slice route for one string: it comes
            // from the same def, and every surface that needs it already fetches
            // this endpoint.
            disabledLimitText: { type: 'string' },
          },
          required: [
            'statusActiveUnack', 'statusActiveAck', 'statusClearedUnack', 'statusClearedAck',
            'disabledLimitText',
          ],
        },
      },
    },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: CONFIG_KEY } });
    const cfg = (row?.configValue ?? {}) as Record<string, unknown>;

    // Blank/unset falls back to the shipped default rather than rendering an empty
    // status cell — mirrors alarm-display.ts's own `statusText()` fallback, so an
    // admin clearing a field can never make a status invisible.
    const text = (key: string, fallback: string) => {
      const v = cfg[key];
      return typeof v === 'string' && v.trim() ? v : fallback;
    };

    return {
      statusActiveUnack: text('statusActiveUnack', ALARM_STATUS_TEXT_DEFAULT.activeUnack),
      statusActiveAck: text('statusActiveAck', ALARM_STATUS_TEXT_DEFAULT.activeAck),
      statusClearedUnack: text('statusClearedUnack', ALARM_STATUS_TEXT_DEFAULT.clearedUnack),
      statusClearedAck: text('statusClearedAck', ALARM_STATUS_TEXT_DEFAULT.clearedAck),
      disabledLimitText: text('disabledLimitText', LIMIT_DISABLED_TEXT_DEFAULT),
    };
  });
}
