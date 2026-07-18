import { type FastifyInstance } from 'fastify';
import { auditTemplatesSchema } from '@digilog/shared';
import { errorResponses } from '../../../lib/error-schemas.js';
import { buildContext } from '../../../lib/build-context.js';
import { configService } from '../config.service.js';

export async function auditTemplatesRoutes(app: FastifyInstance) {
  app.get('/audit-templates', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Config'],
      summary: 'Get audit text templates',
      description: 'Retrieve the full audit text templates configuration. Returns saved templates merged with defaults.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    return configService.getAuditTemplates();
  });

  app.put('/audit-templates', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Config'],
      summary: 'Update audit text templates',
      description: 'Save custom audit text templates. Pass an object mapping action keys to template strings.',
      body: { type: 'object', additionalProperties: true },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const data = await configService.updateAuditTemplates(req.body, auditTemplatesSchema, ctx);
    return { success: true, data };
  });

  app.get('/audit-templates/current', {
    schema: {
      tags: ['Config'],
      summary: 'Get effective audit text templates',
      description: 'Retrieve the effective audit text templates (saved merged with defaults). Available to all authenticated users for rendering audit trail descriptions.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    return configService.getAuditTemplates();
  });
}
