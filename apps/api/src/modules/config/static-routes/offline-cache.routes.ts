import { type FastifyInstance } from 'fastify';
import { offlineCacheConfigSchema } from '@digilog/shared';
import { enforceReauth } from '../../../lib/reauth-check.js';
import { errorResponses } from '../../../lib/error-schemas.js';
import { buildContext } from '../../../lib/build-context.js';
import { configService } from '../config.service.js';
import { prisma } from '../../../lib/prisma.js';

/**
 * Offline-cache config routes. Two ways to read this config:
 *
 *   GET  /offline-cache         — SUPER_ADMIN, returns full payload for the
 *                                  config page editor.
 *   PUT  /offline-cache         — SUPER_ADMIN-only write, with re-auth gate.
 *   GET  /offline-cache/current — public for any authenticated user. The
 *                                  client reads this on app boot to learn
 *                                  the configured staleness + hard-cutoff
 *                                  windows. Returns just the two values; no
 *                                  reason to gate it behind SUPER_ADMIN
 *                                  since the client has to honor them
 *                                  regardless of who is logged in.
 *
 * Why SUPER_ADMIN-only writes: the hard-cutoff window is a 21 CFR Part 11
 * compliance dial. Anyone with CONFIG_UPDATE could otherwise extend the
 * lockout window to a year and effectively disable the safeguard. SuperAdmin
 * is the only role whose audit trail of config changes is intentionally
 * spotlit (see audit/routes.ts hash-chain verification).
 */
export async function offlineCacheRoutes(app: FastifyInstance) {
  // GET /offline-cache — SUPER_ADMIN read for the editor page.
  app.get('/offline-cache', {
    preHandler: [app.requireSuperAdmin()],
    schema: {
      tags: ['Config'],
      summary: 'Get offline cache settings',
      description: 'Retrieve the SUPER_ADMIN-only offline cache + hard-cutoff config. Returns defaults if not yet persisted.',
      response: {
        200: { type: 'object', additionalProperties: true },
        ...errorResponses,
      },
    },
  }, async () => {
    return configService.getConfig('offline-cache', offlineCacheConfigSchema);
  });

  // PUT /offline-cache — SUPER_ADMIN write with reauth.
  app.put('/offline-cache', {
    preHandler: [app.requireSuperAdmin()],
    schema: {
      tags: ['Config'],
      summary: 'Update offline cache settings',
      description: 'Update the SUPER_ADMIN-only offline cache + hard-cutoff config. Requires re-authentication (UPDATE_OFFLINE_CACHE_CONFIG).',
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
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_OFFLINE_CACHE_CONFIG', req, reply);
    if (!ok) return;

    const ctx = buildContext(req);
    const body = req.body as Record<string, unknown>;
    delete body._currentPassword;
    const data = await configService.updateConfig('offline-cache', body, offlineCacheConfigSchema, 'advanced', true, ctx);
    return { success: true, data };
  });

  // GET /offline-cache/current — public read so the client can apply the TTL
  // and hard-cutoff. No SUPER_ADMIN gate; the values inform client-side
  // behavior for every authenticated user.
  app.get('/offline-cache/current', {
    schema: {
      tags: ['Config'],
      summary: 'Get current offline cache settings (public)',
      description: 'Retrieve current cacheStalenessHours + cacheHardCutoffHours so the client can apply them. Available to all authenticated users.',
      response: {
        200: {
          type: 'object',
          properties: {
            cacheStalenessHours: { type: 'number' },
            cacheHardCutoffHours: { type: 'number' },
          },
        },
      },
    },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'offline-cache' } });
    const value = (row?.configValue ?? {}) as Partial<{ cacheStalenessHours: number; cacheHardCutoffHours: number }>;
    return {
      cacheStalenessHours: value.cacheStalenessHours ?? 24,
      cacheHardCutoffHours: value.cacheHardCutoffHours ?? 24,
    };
  });
}
