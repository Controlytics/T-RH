import { type FastifyInstance } from 'fastify';
import { loadAlarmTypeNames } from '../../alarms/load-type-names.js';


/**
 * The type names — read by every operator who can see the Alarms page, not just
 * SUPER_ADMIN.
 *
 * Fifth instance of the narrow-slice pattern (`/alarm-limits/status-texts`,
 * `/inactivity-alarms/display-texts`, `/rs485-alarms/display-text`,
 * `/sensor-range-alarms/display-text`). The def stays SUPER_ADMIN-only; these are
 * pure display wording that every surface needs.
 */
export async function alarmTypeNamesRoutes(app: FastifyInstance) {
  app.get('/alarm-type-names/current', {
    schema: {
      tags: ['Config'],
      summary: 'Get the name of every alarm type',
      description:
        'One name per alarm type, already defaulted server-side. Available to all authenticated users; a blank or unset name falls back to the shipped wording.',
      response: {
        200: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      },
    },
  }, async () => loadAlarmTypeNames());
}
