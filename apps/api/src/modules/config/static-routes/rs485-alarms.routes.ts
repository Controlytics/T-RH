import { type FastifyInstance } from 'fastify';
import { failureText } from '@digilog/shared';
import { prisma } from '../../../lib/prisma.js';

const CONFIG_KEY = 'rs485-alarms';

/**
 * The word shown in place of a failed sensor's reading — read by every operator
 * who can see the dashboard or the Alarms page, not just SUPER_ADMIN.
 *
 * Third instance of the same narrow-slice pattern as
 * `/alarm-limits/status-texts` and `/inactivity-alarms/display-texts`, and for
 * the same reason: the `rs485-alarms` def stays SUPER_ADMIN-only because
 * `enabled` decides what fires as a regulated alarm, while this one
 * field is pure display wording that every surface needs.
 *
 * It matters that this is served rather than defaulted in the browser: a literal
 * `'Error'` in web code is a second opinion about a value the server
 * administers, and the two would disagree the moment somebody edited the
 * setting. The shipped constant is the fallback for "not loaded yet" only.
 */
export async function rs485DisplayTextRoutes(app: FastifyInstance) {
  app.get('/rs485-alarms/display-text', {
    schema: {
      tags: ['Config'],
      summary: 'Get the word shown in place of a failed sensor reading',
      description:
        'Configurable text rendered wherever a non-numeric sensor reading would otherwise appear. Available to all authenticated users; blank or unset falls back to the shipped default.',
      response: {
        200: {
          type: 'object',
          properties: { failureText: { type: 'string' } },
          required: ['failureText'],
        },
      },
    },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: CONFIG_KEY } });
    const cfg = (row?.configValue ?? {}) as Record<string, unknown>;
    return { failureText: failureText(cfg.failureText as string | undefined) };
  });
}
