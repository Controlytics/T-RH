/**
 * Filter Profile Routes — CRUD + assign for filter profiles.
 */
import type { FastifyInstance } from 'fastify';
import { FilterProfileService } from './filter-profile.service.js';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { enforceReauth } from '../../lib/reauth-check.js';

export default async function filterProfileRoutes(app: FastifyInstance) {
  const service = new FilterProfileService();

  app.get('/', {
    preHandler: [app.requireAnyPermission('FP_READ', 'VERSION_HISTORY_VIEW')],
    schema: {
      tags: ['Filter Profiles'],
      summary: 'List filter profiles',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
        },
      },
      response: {
        200: { type: 'object', properties: { data: { type: 'array' }, total: { type: 'integer' } } },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    return service.list(ctx, req.query as any);
  });

  app.get('/:id', {
    preHandler: [app.requireAnyPermission('FP_READ', 'VERSION_HISTORY_VIEW')],
    schema: {
      tags: ['Filter Profiles'],
      summary: 'Get filter profile detail',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.getById(ctx, id);
  });

  // Phase A.3: list archived versions for audit replay / admin history.
  app.get('/:id/versions', {
    preHandler: [app.requireAnyPermission('FP_READ', 'VERSION_HISTORY_VIEW')],
    schema: {
      tags: ['Filter Profiles'],
      summary: 'List archived versions of a filter profile (Phase A.3)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.getVersions(ctx, id);
  });

  // Phase A.3: read a frozen historical version of a filter profile.
  app.get('/:id/versions/:versionNumber', {
    preHandler: [app.requireAnyPermission('FP_READ', 'VERSION_HISTORY_VIEW')],
    schema: {
      tags: ['Filter Profiles'],
      summary: 'Get frozen snapshot of filter profile at a specific version (Phase A.3)',
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

  app.post('/', {
    preHandler: [app.requirePermission('FP_CREATE')],
    schema: {
      tags: ['Filter Profiles'],
      summary: 'Create filter profile',
      body: {
        type: 'object',
        required: ['name', 'cleaningProfileId'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          description: { type: 'string' },
          cleaningProfileId: { type: 'string', format: 'uuid' },
          applicableTemplates: { type: 'array', items: { type: 'string' } },
          blockRestriction: { type: 'string', enum: ['OWN_BLOCK_ONLY', 'ANY_BLOCK', 'SPECIFIC_BLOCKS'] },
          allowedBlocks: { type: 'array', nullable: true },
          maxCleaningCycles: { type: 'integer', nullable: true },
        },
      },
      response: { 201: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('CREATE_FILTER_PROFILE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const result = await service.create(ctx, req.body);
    return reply.code(201).send(result);
  });

  app.put('/:id', {
    preHandler: [app.requirePermission('FP_UPDATE')],
    schema: {
      tags: ['Filter Profiles'],
      summary: 'Update filter profile',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          cleaningProfileId: { type: 'string' },
          applicableTemplates: { type: 'array' },
          blockRestriction: { type: 'string' },
          allowedBlocks: { type: 'array', nullable: true },
          maxCleaningCycles: { type: 'integer', nullable: true },
          isActive: { type: 'boolean' },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FILTER_PROFILE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.update(ctx, id, req.body);
  });

  app.delete('/:id', {
    preHandler: [app.requirePermission('FP_DELETE')],
    schema: {
      tags: ['Filter Profiles'],
      summary: 'Delete filter profile',
      description: 'Deletes a filter profile. Fails if filters are still assigned.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('DELETE_FILTER_PROFILE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.delete(ctx, id);
  });

  app.post('/:id/assign', {
    preHandler: [app.requirePermission('FP_ASSIGN')],
    schema: {
      tags: ['Filter Profiles'],
      summary: 'Assign filter profile to filter instances',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['filterInstanceIds'],
        properties: {
          filterInstanceIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
        },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, assignedCount: { type: 'integer' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('ASSIGN_FILTER_PROFILE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    const { filterInstanceIds } = req.body as { filterInstanceIds: string[] };
    return service.assign(ctx, id, filterInstanceIds);
  });
}
