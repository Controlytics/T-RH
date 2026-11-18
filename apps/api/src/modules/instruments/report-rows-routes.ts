import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { resolveVisibility, withVisibility } from './visibility.js';
import { getReportSlotReadings } from './report-rows.js';

/**
 * GET /api/instruments/:id/telemetry-report-rows — the readings an INTERVAL Data
 * Report prints (performance audit 2026-11-17, G1-01; the rule is on
 * `getReportSlotReadings`). A child plugin of the instruments routes, so it needs no
 * registration in app.ts or the e2e helper.
 *
 * Same permission and the same visibility as `GET /:id/telemetry`: an instrument
 * outside the caller's scope is a 404, never a 403. Every response field is
 * declared — Fastify strips what the schema does not name.
 */
const readingProps = {
  key: { type: 'string' },
  value: {},
  valueType: { type: 'string' },
  ts: { type: 'string', format: 'date-time' },
};

export default async function reportRowsRoutes(app: FastifyInstance) {
  app.get('/:id/telemetry-report-rows', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'The readings an interval Data Report prints: the first instant of each interval slot',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      querystring: {
        type: 'object',
        required: ['from', 'to', 'intervalMs', 'keys'],
        properties: {
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          intervalMs: { type: 'integer', minimum: 1 },
          /** The report's slot keys, comma-separated (the keys its columns print). */
          keys: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            history: { type: 'array', items: { type: 'object', properties: readingProps } },
            historyTotal: { type: 'integer' },
          },
          required: ['history', 'historyTotal'],
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { from: string; to: string; intervalMs: number; keys: string };
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (from.getTime() > to.getTime()) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '`from` must not be after `to`.' });
    }
    const keys = [...new Set(q.keys.split(',').map((k) => k.trim()).filter(Boolean))];

    const { where: visibility } = await resolveVisibility(buildContext(req));
    const exists = await prisma.instrument.findFirst({
      where: withVisibility({ id }, visibility) as { id: string },
      select: { id: true },
    });
    if (!exists) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const { rows, total } = await getReportSlotReadings({ instrumentId: id, keys, from, to, intervalMs: q.intervalMs });
    return { history: rows, historyTotal: total };
  });
}
