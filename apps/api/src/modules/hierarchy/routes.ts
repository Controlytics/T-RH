/**
 * hierarchy routes — Wave 2 of the asset-removal programme (2026-05-17).
 *
 * Read-only Fastify plugin exposing the new typed-hierarchy tables under
 * /api/hierarchy. Writes still go through /api/assets/instances (Wave 1's
 * `fn_mirror_asset_instance` trigger mirrors them into blocks/areas/ahus/
 * filters automatically), so we only expose GETs here.
 *
 * Auth: ASSET_VIEW (chosen over ASSET_READ for consistency with the rest of
 * the assets module — instance.routes.ts gates every GET on ASSET_VIEW;
 * `*_VIEW <- *_READ` fallback in `hasEffectivePermission` lets ASSET_READ
 * also satisfy this gate, so we don't strand any role).
 *
 * Pagination: page ≥ 1, default limit 50, hard cap 500 (audit §1.8). The
 * JSON-schema `maximum: 500` is the wire gate; the handler still defensively
 * clamps via `normalizeLimit` so any Zod/schema bypass path still can't dump
 * the table.
 */

import type { FastifyInstance } from 'fastify';
import { errorResponses } from '../../lib/error-schemas.js';
import { hierarchyService, type CreateFilterInput } from './hierarchy.service.js';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauth } from '../../lib/reauth-check.js';

// Shared building blocks for response schemas. Block/Area/Ahu share most
// fields; Filter adds the legacy FilterDetails columns inlined by Step 6.
const commonNodeProps = {
  id: { type: 'string' },
  name: { type: 'string' },
  description: { type: ['string', 'null'], nullable: true },
  status: { type: 'string' },
  attributes: { type: 'object', additionalProperties: true },
  customAttributes: { type: 'object', additionalProperties: true },

  isActive: { type: 'boolean' },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
  createdBy: { type: ['string', 'null'], nullable: true },
  updatedBy: { type: ['string', 'null'], nullable: true },
} as const;

const filterExtraProps = {
  ahuId: { type: ['string', 'null'], nullable: true },
  filterProfileId: { type: ['string', 'null'], nullable: true },
  currentLifecycleState: { type: ['string', 'null'], nullable: true },
  currentCycleId: { type: ['string', 'null'], nullable: true },
  filterSet: { type: ['string', 'null'], nullable: true },
  // Server-derived effective "last cleaned" date — GREATEST(latest completed
  // cycle, manual lastCleaningDate seed). Single source of truth so the web
  // Filters page and the tablet can never disagree. See zipLastCleaned().
  lastCleanedAt: { type: ['string', 'null'], nullable: true },
} as const;

const filterSchema = {
  type: 'object' as const,
  properties: { ...commonNodeProps, ...filterExtraProps },
  additionalProperties: false,
};

const ahuSchema = {
  type: 'object' as const,
  properties: {
    ...commonNodeProps,
    areaId: { type: ['string', 'null'], nullable: true },
    // An AHU sits directly under a block (blockId set, areaId null) or under an
    // area (areaId set). The Module Guide / Dry-In block scoping needs blockId
    // for the direct-under-block case — it was being stripped by the schema.
    blockId: { type: ['string', 'null'], nullable: true },
    filters: { type: 'array', items: filterSchema },
  },
  additionalProperties: false,
};

const areaSchema = {
  type: 'object' as const,
  properties: {
    ...commonNodeProps,
    blockId: { type: ['string', 'null'], nullable: true },
    ahus: { type: 'array', items: ahuSchema },
  },
  additionalProperties: false,
};

const blockSchema = {
  type: 'object' as const,
  properties: {
    ...commonNodeProps,
    areas: { type: 'array', items: areaSchema },
    // A-01 T2.2: AHUs parented directly by the block (no area level).
    ahus: { type: 'array', items: ahuSchema },
  },
  additionalProperties: false,
};

const paginatedEnvelope = (itemSchema: object) => ({
  type: 'object' as const,
  properties: {
    data: { type: 'array', items: itemSchema },
    total: { type: 'integer' },
    page: { type: 'integer' },
    limit: { type: 'integer' },
    totalPages: { type: 'integer' },
  },
  required: ['data', 'total', 'page', 'limit', 'totalPages'],
});

const pageQueryProps = {
  page: { type: 'integer', minimum: 1, default: 1 },
  // 2026-07-03: record lists uncapped per user request. NO default — an omitted
  // limit reaches the handler as undefined → returns ALL rows. `maximum` is only
  // a sanity gate for an explicitly-provided value.
  limit: { type: 'integer', minimum: 1, maximum: 1_000_000 },
} as const;

export default async function hierarchyRoutes(app: FastifyInstance) {
  // ─── BLOCKS ─────────────────────────────────────────────────────────────
  app.get('/blocks', {
    preHandler: [app.requirePermission('ASSET_VIEW')],
    schema: {
      tags: ['Hierarchy'],
      summary: 'List blocks',
      description:
        'List blocks. `?expand=areas` / `?expand=areas.ahus` / `?expand=areas.ahus.filters` includes nested rows.',
      querystring: {
        type: 'object',
        properties: {
          ...pageQueryProps,
          expand: {
            type: 'string',
            enum: ['areas', 'areas.ahus', 'areas.ahus.filters'],
          },
        },
      },
      response: { 200: paginatedEnvelope(blockSchema), ...errorResponses },
    },
  }, async (req) => {
    const q = req.query as { page?: number; limit?: number; expand?: string };
    return hierarchyService.listBlocks(q);
  });

  app.get('/blocks/:id', {
    preHandler: [app.requirePermission('ASSET_VIEW')],
    schema: {
      tags: ['Hierarchy'],
      summary: 'Get a single block',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      querystring: {
        type: 'object',
        properties: {
          expand: {
            type: 'string',
            enum: ['areas', 'areas.ahus', 'areas.ahus.filters'],
          },
        },
      },
      response: { 200: blockSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { expand } = req.query as { expand?: string };
    const block = await hierarchyService.getBlock(id, expand);
    if (!block) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Block not found' });
    return block;
  });

  // ─── AREAS ──────────────────────────────────────────────────────────────
  app.get('/areas', {
    preHandler: [app.requirePermission('ASSET_VIEW')],
    schema: {
      tags: ['Hierarchy'],
      summary: 'List areas',
      description:
        'List areas. `?blockId=` scopes to one block. `?expand=ahus` / `?expand=ahus.filters` includes nested rows.',
      querystring: {
        type: 'object',
        properties: {
          ...pageQueryProps,
          blockId: { type: 'string', format: 'uuid' },
          expand: { type: 'string', enum: ['ahus', 'ahus.filters'] },
        },
      },
      response: { 200: paginatedEnvelope(areaSchema), ...errorResponses },
    },
  }, async (req) => {
    const q = req.query as {
      page?: number; limit?: number; blockId?: string; expand?: string;
    };
    return hierarchyService.listAreas(q);
  });

  app.get('/areas/:id', {
    preHandler: [app.requirePermission('ASSET_VIEW')],
    schema: {
      tags: ['Hierarchy'],
      summary: 'Get a single area',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      querystring: {
        type: 'object',
        properties: {
          expand: { type: 'string', enum: ['ahus', 'ahus.filters'] },
        },
      },
      response: { 200: areaSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { expand } = req.query as { expand?: string };
    const area = await hierarchyService.getArea(id, expand);
    if (!area) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Area not found' });
    return area;
  });

  // ─── AHUS ───────────────────────────────────────────────────────────────
  app.get('/ahus', {
    preHandler: [app.requirePermission('ASSET_VIEW')],
    schema: {
      tags: ['Hierarchy'],
      summary: 'List AHUs',
      description:
        'List AHUs. `?areaId=` scopes to one area. `?expand=filters` includes filter children.',
      querystring: {
        type: 'object',
        properties: {
          ...pageQueryProps,
          areaId: { type: 'string', format: 'uuid' },
          expand: { type: 'string', enum: ['filters'] },
        },
      },
      response: { 200: paginatedEnvelope(ahuSchema), ...errorResponses },
    },
  }, async (req) => {
    const q = req.query as {
      page?: number; limit?: number; areaId?: string; expand?: string;
    };
    return hierarchyService.listAhus(q);
  });

  app.get('/ahus/:id', {
    preHandler: [app.requirePermission('ASSET_VIEW')],
    schema: {
      tags: ['Hierarchy'],
      summary: 'Get a single AHU',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      querystring: {
        type: 'object',
        properties: { expand: { type: 'string', enum: ['filters'] } },
      },
      response: { 200: ahuSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { expand } = req.query as { expand?: string };
    const ahu = await hierarchyService.getAhu(id, expand);
    if (!ahu) return reply.code(404).send({ error: 'NOT_FOUND', message: 'AHU not found' });
    return ahu;
  });

  // ─── FILTERS ────────────────────────────────────────────────────────────
  app.get('/filters', {
    preHandler: [app.requirePermission('ASSET_VIEW')],
    schema: {
      tags: ['Hierarchy'],
      summary: 'List filters',
      description: 'List filters. `?ahuId=` scopes to one AHU.',
      querystring: {
        type: 'object',
        properties: {
          ...pageQueryProps,
          ahuId: { type: 'string', format: 'uuid' },
        },
      },
      response: { 200: paginatedEnvelope(filterSchema), ...errorResponses },
    },
  }, async (req) => {
    const q = req.query as { page?: number; limit?: number; ahuId?: string };
    return hierarchyService.listFilters(q);
  });

  app.get('/filters/:id', {
    preHandler: [app.requirePermission('ASSET_VIEW')],
    schema: {
      tags: ['Hierarchy'],
      summary: 'Get a single filter',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      response: { 200: filterSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const filter = await hierarchyService.getFilter(id);
    if (!filter) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Filter not found' });
    return filter;
  });

  app.post('/filters', {
    // FILTER_HIERARCHY_CREATE is deliberately NOT accepted here. Its toggle is
    // labelled "Create Block / Area / AHU" (permission-tree.ts) — a SEPARATE
    // grant from "Create Filters". Accepting it on a filter-specific route let a
    // role granted only the hierarchy toggle create filters via the API while
    // useCan() correctly hid the button: frontend-gated only. It remains valid on
    // POST /api/assets/instances, which is the generic create a Block actually
    // goes through.
    preHandler: [app.requireAnyPermission('ASSET_CREATE', 'FILTER_CREATE')],
    schema: {
      tags: ['Hierarchy'],
      summary: 'Create a filter (typed)',
      description: 'Create a filter from concrete fields. No templateId/attributes — dropdown values are validated against the live filter-field-options config.',
      body: {
        type: 'object',
        required: ['name', 'ahuId'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          ahuId: { type: 'string', format: 'uuid' },
          filterSet: { type: 'string', enum: ['A', 'B'] },
          ahuType: { type: 'string' },
          filterType: { type: 'string' },
          micronSize: { type: 'string' },
          filterSize: { type: 'string' },
          lastCleaningDate: { type: 'string' },
          filterProfileId: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
      response: {
        201: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth(['CREATE_ASSET', 'CREATE_FILTER'], req, reply);
    if (!ok) return;
    const data = await hierarchyService.createFilter(req.body as CreateFilterInput, buildContext(req));
    return reply.code(201).send({ success: true, data });
  });

  app.put('/filters/:id', {
    // See POST /filters above — the hierarchy toggle must not edit filters.
    preHandler: [app.requireAnyPermission('ASSET_UPDATE', 'FILTER_EDIT')],
    schema: {
      tags: ['Hierarchy'],
      summary: 'Update a filter (typed)',
      description: 'Update a filter\'s name / filterSet / field-option values directly on the typed tables. No templateId/attributes.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          filterSet: { type: 'string', enum: ['A', 'B'] },
          ahuType: { type: 'string' },
          filterType: { type: 'string' },
          micronSize: { type: 'string' },
          filterSize: { type: 'string' },
          lastCleaningDate: { type: 'string' },
        },
        additionalProperties: false,
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth(['UPDATE_ASSET', 'EDIT_FILTER'], req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const data = await hierarchyService.updateFilter(id, req.body as any, buildContext(req));
    return reply.send({ success: true, data });
  });

  app.delete('/filters/:id', {
    // See POST /filters above — the hierarchy toggle must not delete filters.
    preHandler: [app.requireAnyPermission('ASSET_DELETE', 'FILTER_DELETE')],
    schema: {
      tags: ['Hierarchy'],
      summary: 'Soft-delete a filter (typed)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth(['DELETE_ASSET', 'DELETE_FILTER'], req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    await hierarchyService.deleteFilter(id, buildContext(req));
    return reply.send({ success: true });
  });

  // ─── FULL TREE ──────────────────────────────────────────────────────────
  app.get('/tree', {
    preHandler: [app.requirePermission('ASSET_VIEW')],
    schema: {
      tags: ['Hierarchy'],
      summary: 'Full nested hierarchy tree',
      description:
        'Returns all active blocks with nested areas → ahus → filters. Intended '
        + 'for the FE preview page; production currently has ~4 blocks so this '
        + 'is bounded by data shape.',
      response: {
        200: { type: 'array', items: blockSchema },
        ...errorResponses,
      },
    },
  }, async () => {
    return hierarchyService.getTree();
  });
}
