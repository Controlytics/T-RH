import { type FastifyInstance } from 'fastify';
import { brandingConfigSchema, imageFormatByBytes, BRANDING_LOGO_NOT_PRINTABLE } from '@digilog/shared';
import { enforceReauth } from '../../../lib/reauth-check.js';
import { buildContext } from '../../../lib/build-context.js';
import { configService } from '../config.service.js';

export async function brandingRoutes(app: FastifyInstance) {
  // Public GET for login page
  app.get('/branding', {
    schema: {
      tags: ['Config'],
      summary: 'Get branding configuration',
      description: 'Retrieve the current branding settings (company name, logo, colors). Public endpoint for login page.',
      response: {
        200: { type: 'object', additionalProperties: true, description: 'Branding configuration object' },
      },
    },
  }, async () => {
    return configService.getConfig('branding', brandingConfigSchema);
  });

  app.put('/branding', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Config'],
      summary: 'Update branding configuration',
      description: 'Update branding settings such as company name, logo URL, and theme colors. Requires CONFIG_UPDATE permission.',
      body: { type: 'object', description: 'Branding configuration values' },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            // Declared, or Fastify strips it and the page shows the bare code.
            message: { type: 'string' },
            details: { type: 'object' },
          },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_BRANDING', req, reply);
    if (!ok) return;

    // A NEW uploaded logo must be a PNG or JPEG by its bytes — the only images a
    // report can print; anything else refuses every report download (ruling
    // F-5; a WebP logo did exactly that, 2026-11-20). The page converts other
    // images to PNG before they get here; this stops any other writer.
    // The STORED logo is let through unchanged so a save of the other branding
    // fields is never blocked by a logo uploaded before this check existed —
    // and deliberately NOT in `brandingConfigSchema`: `getConfig` re-parses the
    // stored row with it, and a stricter schema would reset ALL of Branding to
    // the defaults on the public GET while such a logo is stored.
    const body = req.body as Record<string, unknown> | null;
    const logoUrl = body && typeof body.logoUrl === 'string' ? body.logoUrl : '';
    if (logoUrl.startsWith('data:') && imageFormatByBytes(logoUrl) === null) {
      const stored = await configService.getConfig('branding', brandingConfigSchema);
      if (stored.logoUrl !== logoUrl) {
        return reply.code(400).send({ error: 'LOGO_NOT_PRINTABLE', message: BRANDING_LOGO_NOT_PRINTABLE });
      }
    }

    const ctx = buildContext(req);
    const data = await configService.updateConfig('branding', req.body, brandingConfigSchema, 'branding', false, ctx);
    return { success: true, data };
  });
}
