import { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { auditLog } from '../../../lib/audit.js';
import { buildContext } from '../../../lib/build-context.js';
import { prisma } from '../../../lib/prisma.js';
import { enforceReauth } from '../../../lib/reauth-check.js';

const CONFIG_KEY = 'report-page-titles';

/**
 * Report Page Titles — the common labels shown on every report's on-screen page
 * view (ReportPageWrapper). Replaces the removed Report Settings config.
 *
 * - GET  /report-page-titles/current — readable by ALL authenticated users so
 *   the report chrome can render for any report viewer (mirrors the old
 *   report-settings/current contract).
 * - GET  /report-page-titles          — editor read (CONFIG_READ).
 * - PUT  /report-page-titles          — editor write (CONFIG_UPDATE), audited.
 *
 * The def declares hasCustomPage:true so the dynamic-routes factory skips it;
 * these explicit routes own the surface instead.
 *
 * Audit 2026-10-03, API-18: the PUT took `additionalProperties: true` and no
 * re-auth, so any JSON at all landed in `system_config` under this key and
 * was served to every authenticated user by `/current`. The two fields the
 * page edits are the two the schema accepts, re-authenticated with
 * UPDATE_CONFIG_PAGE (the existing configuration-page action). The write and
 * its audit row commit together (API-7).
 */
const reportPageTitlesSchema = z.object({
  companyName: z.string().max(200).optional(),
  appName: z.string().max(200).optional(),
}).strict();

export async function reportPageTitlesRoutes(app: FastifyInstance) {
  // Public-to-authenticated read for the report chrome.
  app.get('/report-page-titles/current', {
    schema: {
      tags: ['Config'],
      summary: 'Get current report page titles',
      description: 'Common report-page labels (performed-by, record count, pagination). Available to all authenticated users.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: CONFIG_KEY } });
    return row?.configValue ?? {};
  });

  // Editor read.
  app.get('/report-page-titles', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: { tags: ['Config'], summary: 'Get report page titles configuration' },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: CONFIG_KEY } });
    return row?.configValue ?? {};
  });

  // Editor write.
  app.put('/report-page-titles', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Config'],
      summary: 'Update report page titles configuration',
      body: { type: 'object', additionalProperties: true },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } },
        400: { type: 'object', properties: { error: { type: 'string' }, details: { type: 'object', additionalProperties: true } } },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_CONFIG_PAGE', req, reply);
    if (!ok) return;
    const parsed = reportPageTitlesSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const body = parsed.data;
    const ctx = buildContext(req);
    const configValue = body as Prisma.InputJsonValue;

    await prisma.$transaction(async (tx) => {
      const existing = await tx.systemConfig.findUnique({ where: { configKey: CONFIG_KEY } });
      const beforeValue = (existing?.configValue ?? {}) as Record<string, unknown>;
      await tx.systemConfig.upsert({
        where: { configKey: CONFIG_KEY },
        create: { configKey: CONFIG_KEY, configValue, configType: 'display', requiresReauth: false, updatedBy: ctx.userId },
        update: { configValue, updatedAt: new Date(), updatedBy: ctx.userId },
      });
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'CONFIG_CHANGED',
        targetType: 'config', targetId: CONFIG_KEY,
        beforeValue, afterValue: body,
        signatureMeaning: 'Report Page Titles configuration updated',
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });

    return { success: true, message: 'Report Page Titles updated' };
  });
}
