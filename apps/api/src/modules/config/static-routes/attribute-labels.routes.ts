import { type FastifyInstance } from 'fastify';
import { ATTRIBUTE_LABELS_CONFIG_KEY, coerceAttributeLabels, coerceSettingsHidden } from '@digilog/shared';
import { prisma } from '../../../lib/prisma.js';

/**
 * The attribute display names — read by every operator who registers an
 * instrument, opens an Attributes panel or the Settings page, not just
 * SUPER_ADMIN.
 *
 * Eighth instance of the narrow-slice pattern (`/alarm-limits/status-texts`,
 * `/inactivity-alarms/display-texts`, `/rs485-alarms/display-text`,
 * `/sensor-range-alarms/display-text`, `/alarm-type-names/current`,
 * `/trend-widgets/current`, `/report-approvers/current`). The def stays
 * SUPER_ADMIN-only; this is pure display wording every surface needs.
 *
 * Returns the COERCED map — trimmed, blanks dropped, one spelling per key — so
 * the browser prints what the server would, and a stale or hand-edited row
 * cannot put an empty heading on a form.
 */
export async function attributeLabelsRoutes(app: FastifyInstance) {
  app.get('/attribute-labels/current', {
    schema: {
      tags: ['Config'],
      summary: 'Get the display name of every instrument attribute key',
      description:
        'A map of attribute key to the name shown for it, already cleaned server-side. Available to all authenticated users; a key with no entry is shown as itself.',
      response: {
        200: {
          type: 'object',
          properties: {
            // Declared with additionalProperties, or Fastify strips every key
            // and the map arrives as `{}` with nothing to say why.
            labels: { type: 'object', additionalProperties: { type: 'string' } },
            // Which fields the Settings page does NOT show (2026-09-21). Both
            // inner keys declared, or the object serialises as `{}` and the
            // page reads it as nothing hidden — silently, with no error.
            settingsHidden: {
              type: 'object',
              properties: {
                instrumentId: { type: 'boolean' },
                keys: { type: 'array', items: { type: 'string' } },
              },
              required: ['instrumentId', 'keys'],
            },
          },
          required: ['labels', 'settingsHidden'],
        },
      },
    },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY } });
    return {
      labels: coerceAttributeLabels(row?.configValue),
      settingsHidden: coerceSettingsHidden(row?.configValue),
    };
  });
}
