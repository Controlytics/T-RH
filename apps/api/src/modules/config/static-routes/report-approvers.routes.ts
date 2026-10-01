import { type FastifyInstance } from 'fastify';
import { loadReportApprovers } from '../../report-reviews/load-approvers.js';
import { prisma } from '../../../lib/prisma.js';

/**
 * The approvers — read by every operator who can request a report, so the
 * dialog can say who a request will go to (and refuses to send one when nobody
 * is configured). Seventh instance of the narrow-slice pattern
 * (`/alarm-limits/status-texts`, `/inactivity-alarms/display-texts`,
 * `/rs485-alarms/display-text`, `/sensor-range-alarms/display-text`,
 * `/alarm-type-names/current`, `/trend-widgets/current`). The def stays
 * SUPER_ADMIN-only.
 */
export async function reportApproversRoutes(app: FastifyInstance) {
  app.get('/report-approvers/current', {
    schema: {
      tags: ['Config'],
      summary: 'Get the roles and users that approve report requests',
      description:
        'The administered approvers, already coerced (SUPER_ADMIN never an approver role). Available to all authenticated users. Both lists empty means no report can be requested until a super admin sets one.',
      response: {
        200: {
          type: 'object',
          properties: {
            approverRoles: { type: 'array', items: { type: 'string' } },
            // Declared (2026-10-01), or Fastify strips it silently.
            approverUserIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['approverRoles', 'approverUserIds'],
        },
      },
    },
  }, async () => loadReportApprovers());

  /**
   * The options for the "Approver users" setting (2026-10-01): enabled users,
   * SUPER_ADMIN excluded, as `{value: id, label: "username (role)"}` — the shape
   * the dynamic config page maps. `/api/users` would label each by its id.
   * CONFIG_READ: it lists usernames, and only the config page asks.
   */
  app.get('/report-approvers/candidates', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Config'],
      summary: 'Users who can be named as report approvers',
      response: {
        200: {
          type: 'array',
          items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' } }, required: ['value', 'label'] },
        },
      },
    },
  }, async () => {
    const users = await prisma.user.findMany({
      where: { status: 'ENABLED', role: { not: 'SUPER_ADMIN' } },
      select: { id: true, username: true, fullName: true, role: true },
      orderBy: { username: 'asc' },
    });
    return users.map((u) => ({ value: u.id, label: `${u.username}${u.fullName ? ` — ${u.fullName}` : ''} (${u.role})` }));
  });
}
