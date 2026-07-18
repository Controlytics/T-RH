/**
 * Filter Events & Cleaning Cycles Routes — Query events, cycles, reasons.
 */
import type { FastifyInstance } from 'fastify';
import { FilterOperationsService } from './filter-operations.service.js';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { prisma } from '../../lib/prisma.js';

export default async function filterEventsRoutes(app: FastifyInstance) {
  const service = new FilterOperationsService();

  app.get('/events', {
    preHandler: [app.requirePermission('EVENT_READ')],
    schema: {
      tags: ['Filter Events'],
      summary: 'List filter events',
      querystring: {
        type: 'object',
        properties: {
          filterId: { type: 'string', format: 'uuid' },
          cycleId: { type: 'string', format: 'uuid' },
          eventType: { type: 'string' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
        },
      },
      response: { 200: { type: 'object', properties: { data: { type: 'array' }, total: { type: 'integer' } } }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    return service.getEvents(ctx, req.query);
  });

  app.get('/cycles', {
    preHandler: [app.requirePermission('CYCLE_READ')],
    schema: {
      tags: ['Cleaning Cycles'],
      summary: 'List cleaning cycles',
      querystring: {
        type: 'object',
        properties: {
          filterId: { type: 'string', format: 'uuid' },
          // RETIRED / REPLACED = effective statuses (TERMINATED + terminationReason),
          // mapped in getCycles. Accept them so the /cycles route doesn't 400.
          status: { type: 'string', enum: ['IN_PROGRESS', 'COMPLETED', 'TERMINATED', 'RETIRED', 'REPLACED'] },
          cleaningReasonKey: { type: 'string' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
          includeEvents: { type: 'string' },
        },
      },
      response: { 200: { type: 'object', properties: { data: { type: 'array' }, total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' }, totalPages: { type: 'integer' } } }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    return service.getCycles(ctx, req.query);
  });

  // Unified Filter Cleaning Record: cleaning cycles + manual status updates merged
  // into one date-sorted, paginated list (each row tagged _kind: 'cycle' | 'manual').
  app.get('/cleaning-record', {
    preHandler: [app.requirePermission('CYCLE_READ')],
    schema: {
      tags: ['Cleaning Cycles'],
      summary: 'Unified cleaning record (cycles + manual status updates)',
      querystring: {
        type: 'object',
        properties: {
          filterId: { type: 'string', format: 'uuid' },
          // Hierarchy scope (cleaning-record filters). blockId/areaId/ahuId all
          // resolve to the set of descendant FILTER ids via a recursive walk, so
          // 2- or 3-level hierarchies both work. search = filter-name contains.
          blockId: { type: 'string', format: 'uuid' },
          areaId: { type: 'string', format: 'uuid' },
          ahuId: { type: 'string', format: 'uuid' },
          search: { type: 'string' },
          // RETIRED / REPLACED are effective statuses: a TERMINATED cycle whose
          // terminationReason is RETIRED / REPLACED. Accept them here and map in
          // getCycles (was missing → the pills 400'd on schema validation).
          status: { type: 'string', enum: ['IN_PROGRESS', 'COMPLETED', 'TERMINATED', 'RETIRED', 'REPLACED'] },
          cleaningReasonKey: { type: 'string' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
        },
      },
      response: { 200: { type: 'object', properties: { data: { type: 'array' }, total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' }, totalPages: { type: 'integer' } } }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    return service.getCleaningRecord(ctx, req.query);
  });

  app.get('/manual-status-changes', {
    preHandler: [app.requirePermission('CYCLE_READ')],
    schema: {
      tags: ['Cleaning Cycles'],
      summary: 'List manual filter status changes (Edit Filter Status)',
      description: 'STATE_TRANSITION events recorded by manual status updates (cycleId null, attributes.manual=true). Powers the Manual Status Updates tab — these are not cleaning cycles.',
      querystring: {
        type: 'object',
        properties: {
          filterId: { type: 'string', format: 'uuid' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
        },
      },
      response: { 200: { type: 'object', properties: { data: { type: 'array' }, total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' }, totalPages: { type: 'integer' } } }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    return service.getManualStatusChanges(ctx, req.query);
  });

  app.get('/cycles/:id', {
    preHandler: [app.requirePermission('CYCLE_READ')],
    schema: {
      tags: ['Cleaning Cycles'],
      summary: 'Get cleaning cycle detail with events',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.getCycleById(ctx, id);
  });

  // ─── Dashboard Analytics ───
  app.get('/dashboard-stats', {
    preHandler: [app.requirePermission('CYCLE_READ')],
    schema: {
      tags: ['Cleaning Cycles'],
      summary: 'Dashboard analytics for cleaning operations',
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    return service.getDashboardStats(ctx);
  });

  app.get('/reasons', {
    preHandler: [app.requirePermission('FILTER_OPERATE')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Get cleaning reasons',
      querystring: {
        type: 'object',
        properties: {
          profileId: { type: 'string', format: 'uuid' },
        },
      },
      response: { 200: { type: 'object', properties: { reasons: { type: 'array', items: { type: 'object', additionalProperties: true } } }, additionalProperties: false }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { profileId } = req.query as { profileId?: string };
    const reasons = await service.getCleaningReasons(profileId);
    return { reasons };
  });

  // Runtime read of the filter-field-options dropdown values (AHU Type /
  // Filter Type / Micron Size). The admin CRUD endpoint at
  // /api/config/dynamic/filter-field-options is SUPER_ADMIN-gated
  // (filter-field-options.def.ts → requiredRole: 'SUPER_ADMIN'), so it
  // returns 401 for the operator/supervisor/admin roles that open the
  // filter add/edit dialogs and need to populate those dropdowns. This
  // mirrors the established cleaning-reasons pattern: `/api/filters/reasons`
  // (above) is the runtime sibling of the SUPER_ADMIN-only
  // `/api/config/dynamic/filter-cleaning-reasons`. Same dual-endpoint shape.
  app.get('/field-options', {
    preHandler: [app.requirePermission('ASSET_READ')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Get filter field-option dropdown values',
      description: 'Returns AHU Type / Filter Type / Micron Size dropdown value-lists for the filter add/edit dialogs. Lower-priv mirror of the SUPER_ADMIN-only /api/config/dynamic/filter-field-options.',
      response: {
        200: {
          type: 'object',
          properties: {
            value: {
              type: 'object',
              properties: {
                ahuType: { type: 'array', items: { type: 'string' } },
                filterType: { type: 'array', items: { type: 'string' } },
                micronSize: { type: 'array', items: { type: 'string' } },
                filterSize: { type: 'array', items: { type: 'string' } },
              },
              additionalProperties: false,
            },
          },
          required: ['value'],
          additionalProperties: false,
        },
        ...errorResponses,
      },
    },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({
      where: { configKey: 'filter-field-options' },
    });
    // Stored shape is `{ value: { ahuType, filterType, micronSize } }`
    // (the dynamic-config PUT spreads the request body as-is). Return
    // configValue directly so the SWR consumer (filter-list.tsx) reads the
    // same `data.value` path on both endpoints.
    const stored = row?.configValue as { value?: unknown } | undefined;
    const inner = stored && typeof stored === 'object' && 'value' in stored
      ? (stored.value as Record<string, unknown>)
      : {};
    return {
      value: {
        ahuType: Array.isArray((inner as any).ahuType) ? (inner as any).ahuType as string[] : ['Process', 'Non Process'],
        filterType: Array.isArray((inner as any).filterType) ? (inner as any).filterType as string[] : [],
        micronSize: Array.isArray((inner as any).micronSize) ? (inner as any).micronSize as string[] : [],
        filterSize: Array.isArray((inner as any).filterSize) ? (inner as any).filterSize as string[] : [],
      },
    };
  });
}
