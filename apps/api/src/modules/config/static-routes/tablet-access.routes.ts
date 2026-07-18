import { type FastifyInstance } from 'fastify';
import { buildContext } from '../../../lib/build-context.js';
import { auditLog } from '../../../lib/audit.js';
import { prisma } from '../../../lib/prisma.js';

export async function tabletAccessRoutes(app: FastifyInstance) {
  app.get('/tablet-access', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: { tags: ['Config'], summary: 'Get tablet app access configuration' },
  }, async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'tablet-access' } });
    return (row?.configValue as any) ?? {};
  });

  app.put('/tablet-access', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Config'],
      summary: 'Update tablet app access configuration',
      body: { type: 'object', additionalProperties: true },
    },
  }, async (req) => {
    const body = req.body as any;
    const ctx = buildContext(req);
    await prisma.systemConfig.upsert({
      where: { configKey: 'tablet-access' },
      update: { configValue: body },
      create: { configKey: 'tablet-access', configValue: body, configType: 'security' },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CONFIG_CHANGED',
      targetType: 'system_config', targetId: 'tablet-access',
      afterValue: body,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return { success: true };
  });

  // Authenticated-but-no-specific-permission: mobile app checks its allowed features
  //
  // 2026-05-21 v2 — deny-by-default for unconfigured roles once the admin has
  // configured at least one role. Behaviour matrix:
  //   - SUPER_ADMIN: always allowed everything (hardcoded — admin recovery
  //     route; lets the global owner reach the tablet config UI on the tablet
  //     even if they accidentally locked the role out).
  //   - Tablet-access config doesn't exist OR is empty `{}`:
  //       → fall back to legacy default-allow (`configured: false`) so a fresh
  //         install / never-configured install behaves the same as before.
  //   - Config has at least one role configured AND this role has its own
  //     entry: respect that entry exactly (`configured: true`).
  //   - Config has at least one role configured AND this role has NO entry:
  //     deny everything (`configured: true`, `allowed: []`). This is the bit
  //     operators expect: admin opted into the allowlist UI and only checked
  //     SUPERVISOR — everyone else is locked out, not silently default-allowed.
  app.get('/tablet-access/my-features', {
    schema: { tags: ['Config'], summary: 'Get allowed tablet features for the current user' },
  }, async (req) => {
    const role = req.user?.role;
    if (!role) return { allowed: [], configured: false };

    // SUPER_ADMIN bypass — hardcoded so they cannot be locked out of the
    // tablet by their own (or someone else's) tablet-access config.
    if (role === 'SUPER_ADMIN') {
      return { role, allowed: [
        'login', 'filter_cleaning', 'filter_status', 'my_tasks',
        'approvals', 'rfid_assign', 'logout',
      ], configured: false };
    }

    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'tablet-access' } });
    const config = (row?.configValue as any) ?? {};
    const roleHasEntry = Object.prototype.hasOwnProperty.call(config, role);
    const anyRoleConfigured = Object.keys(config).length > 0;

    if (roleHasEntry) {
      return { role, allowed: config[role] ?? [], configured: true };
    }
    if (anyRoleConfigured) {
      // some role is configured but THIS role isn't → admin opted into the
      // allowlist and didn't include this role; deny everything.
      return { role, allowed: [], configured: true };
    }
    // No tablet-access config at all → legacy default-allow.
    return { role, allowed: [], configured: false };
  });
}
