/**
 * Equipment Groups Routes — CRUD for equipment groups assigned to blocks.
 */
import type { FastifyInstance } from 'fastify';
import { EquipmentGroupsService } from './equipment-groups.service.js';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { enforceReauth } from '../../lib/reauth-check.js';

const instrumentSchema = {
  type: 'object' as const,
  required: ['instrumentId', 'uom', 'instrumentMin', 'instrumentMax', 'operatingMin', 'operatingMax', 'leastCount'],
  properties: {
    serialNumber: { type: 'string' as const },
    instrumentId: { type: 'string' as const },
    uom: { type: 'string' as const },
    instrumentMin: { type: 'number' as const },
    instrumentMax: { type: 'number' as const },
    operatingMin: { type: 'number' as const },
    operatingMax: { type: 'number' as const },
    leastCount: { type: 'number' as const },
    // Auto-fetch (2026-06-13): the JSON key for this instrument in the group's
    // reading endpoint. MUST be listed or Fastify strips it from the body.
    responseKey: { type: 'string' as const },
  },
};

export default async function equipmentGroupRoutes(app: FastifyInstance) {
  const service = new EquipmentGroupsService();

  app.get('/', {
    preHandler: [app.requireAnyPermission('ASSET_READ', 'EG_VIEW', 'VERSION_HISTORY_VIEW')],
    schema: {
      tags: ['Equipment Groups'],
      summary: 'List equipment groups',
      querystring: {
        type: 'object',
        properties: {
          blockId: { type: 'string', format: 'uuid' },
          includeInactive: { type: 'boolean' },
        },
      },
      response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { blockId, includeInactive } = req.query as { blockId?: string; includeInactive?: boolean };
    return service.list(ctx, blockId, includeInactive === true);
  });

  app.get('/:id', {
    preHandler: [app.requireAnyPermission('ASSET_READ', 'EG_VIEW', 'VERSION_HISTORY_VIEW')],
    schema: {
      tags: ['Equipment Groups'],
      summary: 'Get equipment group by ID',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.getById(ctx, id);
  });

  // Phase A.4: list archived versions for audit replay / admin history.
  app.get('/:id/versions', {
    preHandler: [app.requireAnyPermission('ASSET_READ', 'EG_VIEW', 'VERSION_HISTORY_VIEW')],
    schema: {
      tags: ['Equipment Groups'],
      summary: 'List archived versions of an equipment group (Phase A.4)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.getVersions(ctx, id);
  });

  // Phase A.4: read a frozen historical version of an equipment group composite.
  app.get('/:id/versions/:versionNumber', {
    preHandler: [app.requireAnyPermission('ASSET_READ', 'EG_VIEW', 'VERSION_HISTORY_VIEW')],
    schema: {
      tags: ['Equipment Groups'],
      summary: 'Get frozen snapshot of equipment group at a specific version (Phase A.4)',
      params: {
        type: 'object',
        required: ['id', 'versionNumber'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          versionNumber: { type: 'integer', minimum: 1 },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { id, versionNumber } = req.params as { id: string; versionNumber: number };
    return service.getVersion(ctx, id, Number(versionNumber));
  });

  app.get('/by-block/:blockId', {
    preHandler: [app.requireAnyPermission('ASSET_READ', 'EG_VIEW')],
    schema: {
      tags: ['Equipment Groups'],
      summary: 'Get equipment groups for a block',
      params: { type: 'object', required: ['blockId'], properties: { blockId: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { blockId } = req.params as { blockId: string };
    return service.getByBlock(ctx, blockId);
  });

  // Server-proxied instrument auto-fetch (Phase 2). Read-only: fetches each
  // auto-fetch-enabled instrument for the filter's in-progress cycle + stage
  // from its configured URL (SSRF-hardened in instrument-fetch.ts). The client
  // owns the retry loop; this is one attempt per instrument. Gated by
  // FILTER_OPERATE (the operator running the cycle); no reauth (no DB mutation,
  // no signature — the signed write happens later at /advance).
  app.post('/fetch-readings', {
    preHandler: [app.requirePermission('FILTER_OPERATE')],
    schema: {
      tags: ['Equipment Groups'],
      summary: 'Server-proxied fetch of auto-fetch instrument readings for a cycle stage',
      body: {
        type: 'object',
        required: ['stageKey'],
        properties: {
          filterId: { type: 'string', format: 'uuid' },
          // groupId is the cycle-start fallback (no cycle to resolve yet).
          groupId: { type: 'string', format: 'uuid' },
          stageKey: { type: 'string', enum: ['WASH_IN', 'DRY_IN'] },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { filterId, groupId, stageKey } = req.body as { filterId?: string; groupId?: string; stageKey: string };
    return service.fetchStageReadings(ctx, filterId, stageKey, groupId);
  });

  // Admin "Get Latest Values" — test a typed URL (SSRF-hardened) before saving.
  app.post('/test-url', {
    preHandler: [app.requireAnyPermission('ASSET_UPDATE', 'EG_EDIT')],
    schema: {
      tags: ['Equipment Groups'],
      summary: 'Test-fetch a single instrument URL (admin config helper)',
      body: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { url } = req.body as { url: string };
    return service.testUrl(ctx, url);
  });

  app.post('/', {
    preHandler: [app.requireAnyPermission('ASSET_CREATE', 'EG_CREATE')],
    schema: {
      tags: ['Equipment Groups'],
      summary: 'Create equipment group with 3 instruments',
      body: {
        type: 'object',
        required: ['name', 'blockId', 'instruments'],
        properties: {
          name: { type: 'string' },
          blockId: { type: 'string', format: 'uuid' },
          readingUrl: { type: 'string' },
          instruments: { type: 'array', items: instrumentSchema, minItems: 3, maxItems: 3 },
        },
      },
      response: { 201: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('CREATE_EQUIPMENT_GROUP', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const result = await service.create(ctx, req.body);
    return reply.code(201).send(result);
  });

  app.put('/:id', {
    preHandler: [app.requireAnyPermission('ASSET_UPDATE', 'EG_EDIT')],
    schema: {
      tags: ['Equipment Groups'],
      summary: 'Update equipment group and instruments',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['instruments'],
        properties: {
          name: { type: 'string' },
          readingUrl: { type: 'string' },
          instruments: { type: 'array', items: instrumentSchema, minItems: 3, maxItems: 3 },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_EQUIPMENT_GROUP', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.update(ctx, id, req.body);
  });

  // 2026-07-16: `PATCH /:id/active` (Enable/Disable) removed — a block may now
  // have multiple active equipment groups; there is no enable/disable toggle.
  // Deletion (soft-delete) is the only removal path — see `DELETE /:id` below.

  app.delete('/:id', {
    preHandler: [app.requireAnyPermission('ASSET_DELETE', 'EG_DELETE')],
    schema: {
      tags: ['Equipment Groups'],
      summary: 'Delete (deactivate) equipment group',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('DELETE_EQUIPMENT_GROUP', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.delete(ctx, id);
  });
}
