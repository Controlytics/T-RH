import { type FastifyInstance } from 'fastify';
import { prisma } from '../../../lib/prisma.js';
import { resolveTrendWidgetTexts } from '@digilog/shared';

/**
 * The trend page's widget wording and date/time formats — read by every operator
 * who can open an instrument's trend page, not just SUPER_ADMIN.
 *
 * SIXTH instance of the narrow-slice pattern (`/alarm-limits/status-texts`,
 * `/inactivity-alarms/display-texts`, `/rs485-alarms/display-text`,
 * `/sensor-range-alarms/display-text`, `/alarm-type-names/current`). Same shape
 * and same reason: the def stays SUPER_ADMIN-only to READ through
 * `/api/config/dynamic/trend-widgets` and to write, while this route serves the
 * pure display slice of it to anyone authenticated. Without it every non-admin
 * would see the shipped wording and the admin would see the administered
 * wording — one page, two vocabularies.
 *
 * Resolution happens in `@digilog/shared` rather than here, so the browser
 * resolves the identical thing while this request is still in flight. Nothing
 * outside the browser reads these, so unlike `alarm-type-names` there is no
 * separate loader module for a worker to import.
 */
export async function trendWidgetsRoutes(app: FastifyInstance) {
  app.get('/trend-widgets/current', {
    schema: {
      tags: ['Config'],
      summary: 'Get the trend page widget labels and date/time formats',
      description:
        'Every widget title and column heading, already defaulted server-side, plus each widget’s date/time format override. Available to all authenticated users. A blank or unset label falls back to the shipped wording; a blank, unset or unrecognised format means the widget inherits the site-wide Date/Time Format setting.',
      response: {
        200: {
          type: 'object',
          properties: {
            labels: { type: 'object', additionalProperties: { type: 'string' } },
            formats: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                properties: {
                  dateFormat: { type: 'string' },
                  timeFormat: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'trend-widgets' } });
    return resolveTrendWidgetTexts((row?.configValue ?? {}) as Record<string, unknown>);
  });
}
