import type { FastifyInstance } from 'fastify';
import { templateQuerySchema, TEMPLATE_CATEGORIES } from '@digilog/shared';
import { errorResponses } from '../../../lib/error-schemas.js';
import { templateService } from '../services/template.service.js';

// 2026-05-26 cleanup: the asset-template editing UI was removed in Phase
// 1 (2026-05-16 entity UI removal). Only the GET endpoints remain â€” they
// are still consumed across the FE to identify which template-kind a
// given asset is (filter-list.tsx, mobile-wrapper.tsx, etc. all call
// `/api/assets/templates?limit=1000` to build a kind-lookup map).
//
// The POST /templates, PUT /templates/:id, DELETE /templates/:id routes
// were dead â€” pre-fix they were gated on the undeclared
// ASSET_TEMPLATE_CREATE/UPDATE/DELETE perms (none of which exist in
// PERMISSIONS or seed.ts), and there was no FE consumer. They have been
// removed with the rest of the entity-template editing surface.
//
// Historic audit_trail rows of ASSET_TEMPLATE_CREATED/UPDATED/DELETED
// remain renderable via packages/shared/src/types/audit-actions.ts (per
// 21 CFR Â§11 retention) â€” the entry is preserved even though no new
// records of that type can be created.

export default async function templateRoutes(app: FastifyInstance) {

  // 1. GET /templates â€” List templates with search/pagination
  app.get('/templates', {
    preHandler: [app.requirePermission('ASSET_VIEW')],
    schema: {
      tags: ['Entity Templates'],
      summary: 'List entity templates',
      description: 'List templates with optional search, isActive filter, and pagination.',
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Search by name' },
          isActive: { type: 'string', description: '"true" or "false"' },
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  category: { type: 'string' },
                  icon: { type: 'string' },
                  templateKind: { type: 'string', maxLength: 50 },
                  version: { type: 'integer' },
                  attributeSchema: { type: 'array' },
                  telemetrySchema: { type: 'array' },
                  expectedIdentifiers: { type: 'array' },
                  expectedRelationships: { type: 'array' },
                  statusLifecycle: { type: 'array' },
                  checklistSchema: { type: 'array' },
                  maxParentConnections: { type: 'integer' },
                  maxConnections: { type: 'integer' },
                  dataIngestionEnabled: { type: 'boolean' },
                  transportType: { type: ['string', 'null'] },
                  credentialType: { type: 'string' },
                  inactivityTimeout: { type: 'integer' },
                  defaultMaxDataRate: { type: 'integer' },
                  autoProvision: { type: 'boolean' },
                  isActive: { type: 'boolean' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                  createdBy: { type: 'string' },
                  _count: { type: 'object', properties: { instances: { type: 'integer' } } },
                },
              },
            },
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
    const query = templateQuerySchema.parse(req.query);

    // Inject assignment visibility filter for templates
    const role = req.user?.role;
    const userId = req.user?.sub;

    let visibilityFilter: Record<string, unknown> | undefined;

    if (role === "SUPER_ADMIN" || role === "ADMIN") {
      // No filter â€” see all templates
    } else {
      // Check if user has explicit template assignments
      const { prisma } = await import("../../../lib/prisma.js");
      const templateAssignments = await prisma.templateAssignment.findMany({
        where: {
          OR: [
            { assigneeType: "USER", userId },
          ],
        },
        select: { templateId: true },
      });

      const assignedIds = templateAssignments.map((a: any) => a.templateId);
      if (assignedIds.length > 0) {
        // User has explicit assignments â€” show only those
        visibilityFilter = { id: { in: assignedIds } };
      }
      // If no assignments exist, show all templates (user already passed permission check)
      // Templates are blueprints â€” visibility is gated by permissions, not assignments
    }
    return templateService.list(query, visibilityFilter);
  });

  // 2. GET /templates/:id â€” Get single template by UUID
  app.get('/templates/:id', {
    preHandler: [app.requirePermission('ASSET_VIEW')],
    schema: {
      tags: ['Entity Templates'],
      summary: 'Get entity template by ID',
      description: 'Retrieve a single entity template by its UUID, including instance count.',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            category: { type: 'string' },
            icon: { type: 'string' },
            templateKind: { type: 'string', maxLength: 50 },
            version: { type: 'integer' },
            attributeSchema: { type: 'array' },
            telemetrySchema: { type: 'array' },
            expectedIdentifiers: { type: 'array' },
            expectedRelationships: { type: 'array' },
            statusLifecycle: { type: 'array' },
            checklistSchema: { type: 'array' },
            maxParentConnections: { type: 'integer' },
            maxConnections: { type: 'integer' },
            dataIngestionEnabled: { type: 'boolean' },
            transportType: { type: ['string', 'null'] },
            credentialType: { type: 'string' },
            inactivityTimeout: { type: 'integer' },
            defaultMaxDataRate: { type: 'integer' },
            autoProvision: { type: 'boolean' },
            isActive: { type: 'boolean' },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
            createdBy: { type: 'string' },
            updatedBy: { type: 'string' },
            _count: { type: 'object', properties: { instances: { type: 'integer' } } },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return templateService.getById(id);
  });

  // POST/PUT/DELETE template routes removed 2026-05-26 — see header docblock.

}

