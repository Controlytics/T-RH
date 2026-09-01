import { type FastifyInstance } from 'fastify';
import { INACTIVITY_TEXT_DEFAULT, INACTIVITY_MINUTES_TOKEN } from '@digilog/shared';
import { prisma } from '../../../lib/prisma.js';

const CONFIG_KEY = 'inactivity-alarms';

/**
 * The three column wordings an inactivity alarm renders with — read by every
 * operator who can see the Alarms page, not just SUPER_ADMIN.
 *
 * Same shape and the same reasoning as `/alarm-limits/status-texts`: the
 * `inactivity-alarms` def stays SUPER_ADMIN-only (`requiredRole: 'SUPER_ADMIN'`,
 * enforced by `/dynamic/inactivity-alarms`) because `enabled` and `graceMinutes`
 * decide what fires as a regulated alarm. This route does NOT widen
 * that gate — it exposes only the display wording.
 *
 * **Deliberately a second route rather than three more keys on
 * `/alarm-limits/status-texts`.** That endpoint's contract is "a narrow slice of
 * the alarm-limits row"; making it read a second config row and return keys that
 * have nothing to do with limits breaks the one property its doc comment is
 * defending. One extra fetch on the three surfaces that render alarm rows is the
 * cheaper price.
 */
export async function inactivityDisplayTextsRoutes(app: FastifyInstance) {
  app.get('/inactivity-alarms/display-texts', {
    schema: {
      tags: ['Config'],
      summary: 'Get the three inactivity-alarm column wordings',
      description:
        'Configurable text for the Generated Value, Limit and Cleared Value cells on an inactivity alarm. Available to all authenticated users; blank or unset falls back to the shipped wording, and a Limit wording missing the {minutes} placeholder is rejected in favour of the default.',
      response: {
        200: {
          type: 'object',
          properties: {
            textGeneratedValue: { type: 'string' },
            textLimit: { type: 'string' },
            textClearedValue: { type: 'string' },
          },
          required: ['textGeneratedValue', 'textLimit', 'textClearedValue'],
        },
      },
    },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: CONFIG_KEY } });
    const cfg = (row?.configValue ?? {}) as Record<string, unknown>;

    // Blank/unset falls back to the shipped wording rather than rendering an empty
    // cell — an admin clearing a field must not be able to put a bare gap back into
    // the column this feature exists to fill.
    const text = (key: string, fallback: string) => {
      const v = cfg[key];
      return typeof v === 'string' && v.trim() ? v.trim() : fallback;
    };

    // The Limit wording carries the ONE piece of regulated data in this payload:
    // the threshold the alarm fired against, substituted from its frozen snapshot
    // by the browser. A wording with no placeholder to substitute into would
    // delete that threshold from the table, so it is refused HERE as well as in
    // `inactivityLimitText()` — a caller that reads this payload without going
    // through that helper still cannot be handed a wording that drops it.
    const limitRaw = text('textLimit', INACTIVITY_TEXT_DEFAULT.limit);
    const textLimit = limitRaw.includes(INACTIVITY_MINUTES_TOKEN)
      ? limitRaw
      : INACTIVITY_TEXT_DEFAULT.limit;

    return {
      textGeneratedValue: text('textGeneratedValue', INACTIVITY_TEXT_DEFAULT.generatedValue),
      textLimit,
      textClearedValue: text('textClearedValue', INACTIVITY_TEXT_DEFAULT.clearedValue),
    };
  });
}
