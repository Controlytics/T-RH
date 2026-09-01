import { type FastifyInstance } from 'fastify';
import { rangeText } from '@digilog/shared';
import { prisma } from '../../../lib/prisma.js';

const CONFIG_KEY = 'sensor-range-alarms';

/**
 * The word shown in place of an out-of-range reading — read by every operator
 * who can see the dashboard or the Alarms page, not just SUPER_ADMIN.
 *
 * Fourth instance of the narrow-slice pattern (`/alarm-limits/status-texts`,
 * `/inactivity-alarms/display-texts`, `/rs485-alarms/display-text`), and for the
 * same reason each time: the def stays SUPER_ADMIN-only because `enabled` and
 * the attribute-key mapping decide what fires as a regulated
 * alarm, while this one field is pure display wording every surface needs.
 */
export async function sensorRangeDisplayTextRoutes(app: FastifyInstance) {
  app.get('/sensor-range-alarms/display-text', {
    schema: {
      tags: ['Config'],
      summary: 'Get the word shown in place of an out-of-range reading',
      description:
        'Configurable text rendered wherever a reading outside the sensor\'s measurable range would otherwise appear. Available to all authenticated users; blank or unset falls back to the shipped default.',
      response: {
        200: {
          type: 'object',
          properties: { rangeText: { type: 'string' } },
          required: ['rangeText'],
        },
      },
    },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: CONFIG_KEY } });
    const cfg = (row?.configValue ?? {}) as Record<string, unknown>;
    return { rangeText: rangeText(cfg.rangeText as string | undefined) };
  });
}
