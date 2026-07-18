/**
 * PM Execution Routes — start a PM execution.
 *
 * Lifecycle note: a `PmExecution` row is created in IN_PROGRESS state when an
 * operator clicks "Start PM" from the schedule detail page. PM completion is
 * derived from the underlying cleaning-cycle records by `pm-due-tasks.ts`
 * (`cleanedInWindow` lookup against `cleaning_cycles.completedAt`), not from
 * `PmExecution.status`. There is therefore no FE need to mutate the row's
 * status — the prior `PUT /:id` endpoint had no caller and was removed during
 * the H3 cleanup (2026-05-04 audit). Kept the POST: it is what the detail page
 * `startPm()` handler hits.
 */
import type { FastifyInstance } from 'fastify';
import { PmScheduleService } from './pm-schedule.service.js';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { enforceReauth } from '../../lib/reauth-check.js';

export default async function pmExecutionRoutes(app: FastifyInstance) {
  const service = new PmScheduleService();

  app.post('/', {
    preHandler: [app.requirePermission('PM_EXECUTE')],
    schema: {
      tags: ['PM Executions'],
      summary: 'Start PM execution',
      body: {
        type: 'object',
        required: ['scheduleEntryId', 'entityId'],
        properties: {
          scheduleEntryId: { type: 'string', format: 'uuid' },
          entityId: { type: 'string', format: 'uuid' },
          filterSet: { type: 'string', enum: ['SET_A', 'SET_B'] },
        },
      },
      response: { 201: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    // Audit 2026-05-09 fix: starting a PM task creates the immutable
    // PmExecution row — comparable to start-cycle (which IS reauth-gated).
    // Tablet-left-unlocked attack surface: anyone walking by could stamp
    // PM-task starts.
    const { ok } = await enforceReauth('START_PM_TASK', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const result = await service.createExecution(ctx, req.body);
    return reply.code(201).send(result);
  });
}
