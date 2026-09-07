import { type FastifyInstance } from 'fastify';
import { loadApproverRoles } from '../../report-reviews/load-approvers.js';

/**
 * The approver roles — read by every operator who can request a report, not
 * just SUPER_ADMIN, so the Send-to picker can offer only what the server will
 * accept. Seventh instance of the narrow-slice pattern (`/alarm-limits/
 * status-texts`, `/inactivity-alarms/display-texts`, `/rs485-alarms/
 * display-text`, `/sensor-range-alarms/display-text`, `/alarm-type-names/
 * current`, `/trend-widgets/current`). The def stays SUPER_ADMIN-only.
 */
export async function reportApproversRoutes(app: FastifyInstance) {
  app.get('/report-approvers/current', {
    schema: {
      tags: ['Config'],
      summary: 'Get the roles that may approve a report',
      description:
        'The administered approver roles, already coerced (SUPER_ADMIN never included). Available to all authenticated users. An empty list means no report can be requested until a super admin sets one.',
      response: {
        200: {
          type: 'object',
          properties: { approverRoles: { type: 'array', items: { type: 'string' } } },
          required: ['approverRoles'],
        },
      },
    },
  }, async () => ({ approverRoles: await loadApproverRoles() }));
}
