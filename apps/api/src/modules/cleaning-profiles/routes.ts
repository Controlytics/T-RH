/**
 * Cleaning Profile Routes — CRUD + validate + toggle status for filter cleaning profiles.
 */
import type { FastifyInstance } from 'fastify';
import { CleaningProfileService } from './cleaning-profile.service.js';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { enforceReauth } from '../../lib/reauth-check.js';

export default async function cleaningProfileRoutes(app: FastifyInstance) {
  const service = new CleaningProfileService();

  // GET / — List cleaning profiles
  app.get('/', {
    // FILTER_OPERATE is a READ alternate for the same reason it was added to
    // checklist-profiles on 2026-07-10: the offline sync engine GETs this, and
    // operating roles hold FILTER_OPERATE but NONE of FCP_READ / CP_TOGGLE /
    // VERSION_HISTORY_VIEW (verified against the live roles). Without it every
    // OPERATOR/SUPERVISOR sync 403'd here and reported "Synced with warnings",
    // every time. That fix landed on /checklist-profiles + /stage-approvals and
    // missed this sibling. Sync calls BOTH the list and the per-id detail
    // (offline-sync-service.ts:243,250) — hence both, and ONLY these two. The
    // /versions routes stay VERSION_HISTORY_VIEW-gated: sync never reads them
    // and operating roles have no business in version history.
    preHandler: [app.requireAnyPermission('FCP_READ', 'CP_TOGGLE', 'VERSION_HISTORY_VIEW', 'FILTER_OPERATE')],
    schema: {
      tags: ['Cleaning Profiles'],
      summary: 'List cleaning profiles',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
            total: { type: 'integer' },
            page: { type: 'integer' },
            limit: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    return service.list(ctx, req.query as any);
  });

  // GET /:id — Get cleaning profile with stages and connections
  app.get('/:id', {
    // FILTER_OPERATE is a READ alternate for the same reason it was added to
    // checklist-profiles on 2026-07-10: the offline sync engine GETs this, and
    // operating roles hold FILTER_OPERATE but NONE of FCP_READ / CP_TOGGLE /
    // VERSION_HISTORY_VIEW (verified against the live roles). Without it every
    // OPERATOR/SUPERVISOR sync 403'd here and reported "Synced with warnings",
    // every time. That fix landed on /checklist-profiles + /stage-approvals and
    // missed this sibling. Sync calls BOTH the list and the per-id detail
    // (offline-sync-service.ts:243,250) — hence both, and ONLY these two. The
    // /versions routes stay VERSION_HISTORY_VIEW-gated: sync never reads them
    // and operating roles have no business in version history.
    preHandler: [app.requireAnyPermission('FCP_READ', 'CP_TOGGLE', 'VERSION_HISTORY_VIEW', 'FILTER_OPERATE')],
    schema: {
      tags: ['Cleaning Profiles'],
      summary: 'Get cleaning profile detail',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.getById(ctx, id);
  });

  // POST / — Create cleaning profile
  app.post('/', {
    preHandler: [app.requireAnyPermission('FCP_CREATE', 'CP_PAGE_CREATE')],
    schema: {
      tags: ['Cleaning Profiles'],
      summary: 'Create cleaning profile',
      body: {
        type: 'object',
        required: ['name', 'stages'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          description: { type: 'string' },
          flowMode: { type: 'string', enum: ['STRICT', 'BYPASS_ENABLED'] },
          alarmOnForwardSkip: { type: 'boolean' },
          alarmOnBackwardJump: { type: 'boolean' },
          alarmOnOutOfSequence: { type: 'boolean' },
          cleaningReasons: { type: 'array', nullable: true },
          stages: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              required: ['nodeType'],
              properties: {
                stateKey: { type: 'string', nullable: true },
                nodeType: { type: 'string' },
                configuration: { type: 'object' },
                positionX: { type: 'number' },
                positionY: { type: 'number' },
                sortOrder: { type: 'integer' },
              },
            },
          },
          connections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                fromIndex: { type: 'integer' },
                toIndex: { type: 'integer' },
                fromStageId: { type: 'string' },
                toStageId: { type: 'string' },
                label: { type: 'string' },
              },
            },
          },
        },
      },
      response: {
        201: { type: 'object', additionalProperties: true },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('CREATE_CLEANING_PROFILE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const result = await service.create(ctx, req.body);
    return reply.code(201).send(result);
  });

  // PUT /:id — Update (creates new version)
  app.put('/:id', {
    preHandler: [app.requireAnyPermission('FCP_UPDATE', 'CP_PAGE_EDIT')],
    schema: {
      tags: ['Cleaning Profiles'],
      summary: 'Update cleaning profile (new version)',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          flowMode: { type: 'string', enum: ['STRICT', 'BYPASS_ENABLED'] },
          alarmOnForwardSkip: { type: 'boolean' },
          alarmOnBackwardJump: { type: 'boolean' },
          alarmOnOutOfSequence: { type: 'boolean' },
          cleaningReasons: { type: 'array', nullable: true },
          stages: { type: 'array' },
          connections: { type: 'array' },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_CLEANING_PROFILE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.update(ctx, id, req.body);
  });

  // PATCH /:id/toggle-status — Toggle active/inactive
  app.patch('/:id/toggle-status', {
    preHandler: [app.requireAnyPermission('FCP_UPDATE', 'CP_PAGE_EDIT')],
    schema: {
      tags: ['Cleaning Profiles'],
      summary: 'Toggle cleaning profile active/inactive',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      body: { type: 'object', additionalProperties: true },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, status: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.toggleStatus(ctx, id);
  });

  // DELETE /:id — Archive
  app.delete('/:id', {
    preHandler: [app.requireAnyPermission('FCP_DELETE', 'CP_PAGE_DELETE')],
    schema: {
      tags: ['Cleaning Profiles'],
      summary: 'Archive cleaning profile',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('DELETE_CLEANING_PROFILE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.archive(ctx, id);
  });

  // Audit 2026-05-09 fix: removed 3 orphan endpoints that had no FE caller:
  //
  //   - POST /:id/validate    — FE validates client-side; service method
  //                             validatePipeline() stays as the internal
  //                             helper called by create + update at lines
  //                             88, 152.
  //   - GET  /:id/assigned-assets — no UI rendered the asset list. Removed
  //                             with the unused service method.
  //   - POST /:id/assign-assets   — no UI surfaced bulk-assign. Asset →
  //                             filter-profile binding happens through the
  //                             FilterProfile.cleaningProfileId field set
  //                             at filter-profile create time. Removed with
  //                             the unused service method.
  //
  // Dead routes are still attack surface (auth-only but unmaintained).
  // Keeping them would require equivalent reauth review on every audit
  // pass even though no operator can reach them.

  // GET /:id/versions — List all versions in this profile's lineage (Phase A.2)
  app.get('/:id/versions', {
    preHandler: [app.requireAnyPermission('FCP_READ', 'CP_TOGGLE', 'VERSION_HISTORY_VIEW')],
    schema: {
      tags: ['Cleaning Profiles'],
      summary: 'List all historical versions of this cleaning profile lineage',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            lineageId: { type: 'string', format: 'uuid' },
            versions: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.getVersions(ctx, id);
  });

  // GET /:id/versions/:versionNumber — Frozen snapshot of a specific version (Phase A.2)
  app.get('/:id/versions/:versionNumber', {
    preHandler: [app.requireAnyPermission('FCP_READ', 'CP_TOGGLE', 'VERSION_HISTORY_VIEW')],
    schema: {
      tags: ['Cleaning Profiles'],
      summary: 'Fetch a specific historical version (frozen snapshot)',
      params: {
        type: 'object',
        required: ['id', 'versionNumber'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          versionNumber: { type: 'integer', minimum: 1 },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { id, versionNumber } = req.params as { id: string; versionNumber: number };
    return service.getVersion(ctx, id, Number(versionNumber));
  });

  // POST /:id/validate route removed (audit 2026-05-09 cleanup).
  // The internal validatePipeline() helper is still called by create + update.
}
