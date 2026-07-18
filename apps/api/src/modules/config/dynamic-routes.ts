import { type FastifyInstance } from 'fastify';
import { configRegistry } from '../../lib/config-registry.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { sanitizeAuditValue } from '../../lib/audit-diff.js';
import { redactConfigSecrets } from './config.service.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { buildContext } from '../../lib/build-context.js';

export default async function dynamicConfigRoutes(app: FastifyInstance) {

  // ── Manifest endpoint — frontend reads this to build config UI ──
  app.get('/registry/manifest', {
    schema: {
      tags: ['Configuration'],
      summary: 'Get config module manifest for dynamic UI rendering',
      description: 'Returns all registered config modules visible to the current user, including their settings schema for dynamic form generation.',
    },
  }, async (req) => {
    const role = req.user.role;
    let perms: string[] = [];
    if (role !== 'SUPER_ADMIN') {
      const roleData = await prisma.role.findUnique({
        where: { name: role }, select: { permissions: true },
      });
      perms = (roleData?.permissions as string[]) ?? [];
    }
    return configRegistry.getManifest(role, perms);
  });

  // ── Dynamic GET/PUT for configs WITHOUT custom pages ──
  // Configs with hasCustomPage=true keep their existing hardcoded routes
  // This only generates routes for NEW configs added via definitions
  for (const def of configRegistry.getAll()) {
    if (def.hasCustomPage) continue; // Skip — existing routes handle this

    // GET /api/config/dynamic/:moduleKey
    app.get(`/dynamic/${def.moduleKey}`, {
      preHandler: def.requiredRole
        ? [app.requireRole(def.requiredRole)]
        : [app.requirePermission(def.permissions.read)],
      schema: {
        tags: ['Configuration'],
        summary: `Get ${def.moduleName} config`,
      },
    }, async (req) => {
      const row = await prisma.systemConfig.findUnique({
        where: { configKey: def.moduleKey },
      });
      let value = (row?.configValue ?? {}) as Record<string, any>;

      // Mask secrets
      for (const s of def.settings) {
        if (s.maskedInApi && value[s.key]) {
          value[s.key] = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
        }
      }

      if (def.hooks?.onRead) value = def.hooks.onRead(value);
      return value;
    });

    // PUT /api/config/dynamic/:moduleKey
    app.put(`/dynamic/${def.moduleKey}`, {
      preHandler: def.requiredRole
        ? [app.requireRole(def.requiredRole)]
        : [app.requirePermission(def.permissions.write)],
      schema: {
        tags: ['Configuration'],
        summary: `Update ${def.moduleName} config`,
      },
    }, async (req, reply) => {
      // Reauth check
      if (def.requiresReauth || def.reauthAction) {
        const action = def.reauthAction ?? `UPDATE_${def.moduleKey.toUpperCase().replace(/-/g, '_')}`;
        const { ok } = await enforceReauth(action, req, reply);
        if (!ok) return;
      }

      const body = req.body as Record<string, unknown>;

      // Validate with Zod if schema provided
      if (def.zodSchema) {
        const parsed = def.zodSchema.safeParse(body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i: any) => i.message).join(', '),
          });
        }
      }

      // Custom validation hook
      if (def.hooks?.validate) {
        const result = await def.hooks.validate(body);
        if (!result.valid) {
          return reply.code(400).send({
            error: 'VALIDATION_ERROR',
            message: result.errors?.join(', ') ?? 'Validation failed',
          });
        }
      }

      // Preserve masked secret fields
      const existing = await prisma.systemConfig.findUnique({
        where: { configKey: def.moduleKey },
      });
      const oldValue = (existing?.configValue ?? {}) as Record<string, any>;
      const newValue = { ...body } as Record<string, any>;

      for (const s of def.settings) {
        if (s.maskedInApi && newValue[s.key] === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022') {
          newValue[s.key] = oldValue[s.key];
        }
      }

      const ctx = buildContext(req);

      await prisma.systemConfig.upsert({
        where: { configKey: def.moduleKey },
        create: {
          configKey: def.moduleKey,
          configValue: newValue,
          configType: def.category,
          requiresReauth: def.requiresReauth,
          updatedBy: ctx.userId,
        },
        update: {
          configValue: newValue,
          updatedAt: new Date(),
          updatedBy: ctx.userId,
        },
      });

      // Strip declared-secret fields (def type:'secret') so credentials on
      // dynamically-rendered config pages are never persisted in the audit
      // trail or shown in the now-all-roles before/after view.
      const secretKeys = new Set(
        (def.settings ?? []).filter((s) => s.type === 'secret').map((s) => s.key),
      );
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'CONFIG_CHANGED',
        targetType: 'config', targetId: def.moduleKey,
        beforeValue: sanitizeAuditValue(redactConfigSecrets(oldValue, secretKeys)) as any,
        afterValue: sanitizeAuditValue(redactConfigSecrets(newValue, secretKeys)),
        signatureMeaning: `${def.moduleName} configuration updated`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
        sessionId: ctx.sessionId,
      });

      if (def.hooks?.afterUpdate) {
        await def.hooks.afterUpdate(oldValue, newValue, ctx);
      }

      return { success: true, message: `${def.moduleName} updated` };
    });
  }
}
