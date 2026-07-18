/**
 * Sync routes — Phase 8.4b (Option D, 2026-05-02).
 *
 * GET /api/sync/since — versioned local-cache hydrator.
 *
 * Auth: the global onRequest hook (plugins/auth.ts) authenticates the bearer
 * token, but authentication is not authorization. Until 2026-07-15 this route
 * carried no permission gate at all, so ANY logged-in account — including one
 * with zero permissions — could pull the whole plant model: every filter with
 * its full attributes JSON, plus templates, checklist profiles, pipelines and
 * equipment groups. The header used to claim the data was "filtered by what the
 * user's templates make visible"; it never was (sync.service.ts filters on
 * template KIND, and its ctx argument is unused).
 *
 * The gate mirrors the endpoints this route duplicates — hierarchy reads
 * (ASSET_VIEW) and checklist-profile reads (which accept FILTER_OPERATE
 * precisely so operating roles can sync; see the 2026-07-10 fix for the tablet
 * bug where a missing perm turned sync into a 403 and left an empty checklist
 * cache). Verified against the live roles: all 8 active roles hold ASSET_VIEW,
 * so no role that syncs today loses access.
 */
import type { FastifyInstance } from 'fastify';
import { SyncService } from './sync.service.js';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';

export default async function syncRoutes(app: FastifyInstance) {
  const service = new SyncService();

  app.get('/since', {
    preHandler: [app.requireAnyPermission('ASSET_VIEW', 'FILTER_OPERATE')],
    schema: {
      tags: ['Sync'],
      summary: 'Versioned local-cache hydrator (Option D, 8.4b)',
      description: 'Returns rows newer than the client cursors. Each entity '
        + 'is capped at 500 rows; if any entity hits the cap, hasMore=true '
        + 'and the FE retries with updated cursors. ChecklistProfile entries '
        + 'inline `questions` (matching the legacy ?expand=questions shape); '
        + 'AssetTemplate entries are returned verbatim (full schema columns).',
      querystring: {
        type: 'object',
        properties: {
          profileVersion: { type: 'integer', minimum: 0, default: 0 },
          filterProfileVersion: { type: 'integer', minimum: 0, default: 0 },
          equipmentGroupVersion: { type: 'integer', minimum: 0, default: 0 },
          checklistVersion: { type: 'integer', minimum: 0, default: 0 },
          assetTemplateVersion: { type: 'integer', minimum: 0, default: 0 },
          filterUpdatedSince: { type: 'string', nullable: true },
        },
      },
      response: {
        // Top-level shape is explicit so Fastify won't strip the entity arrays
        // even when empty. Each entity item uses additionalProperties:true so
        // Prisma row shapes pass through verbatim — same convention as the
        // existing `/:id` and version-history routes (filter-profiles/routes.ts).
        200: {
          type: 'object',
          required: [
            'filterCleaningProfiles',
            'filterProfiles',
            'equipmentGroups',
            'checklistProfiles',
            'assetTemplates',
            'filters',
            'serverTimestamp',
            'hasMore',
          ],
          properties: {
            filterCleaningProfiles: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
            filterProfiles: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
            equipmentGroups: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
            checklistProfiles: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
            assetTemplates: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
            filters: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
            serverTimestamp: { type: 'string' },
            hasMore: { type: 'boolean' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const q = req.query as Record<string, unknown>;
    return service.since(ctx, {
      profileVersion: q.profileVersion as number | undefined,
      filterProfileVersion: q.filterProfileVersion as number | undefined,
      equipmentGroupVersion: q.equipmentGroupVersion as number | undefined,
      checklistVersion: q.checklistVersion as number | undefined,
      assetTemplateVersion: q.assetTemplateVersion as number | undefined,
      filterUpdatedSince: q.filterUpdatedSince as string | undefined,
    });
  });
}
