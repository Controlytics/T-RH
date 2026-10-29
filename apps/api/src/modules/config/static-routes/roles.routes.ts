import { type FastifyInstance } from 'fastify';
import { enforceReauth } from '../../../lib/reauth-check.js';
import { buildContext } from '../../../lib/build-context.js';
import { configService } from '../config.service.js';
import { resolvePanelsFor } from '../panel-access.js';
import { resolveLayoutFor, checkLayoutWrite, WIDGETS_JSON_SCHEMA } from '../dashboard-layout.js';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { errorResponses } from '../../../lib/error-schemas.js';

export async function rolesConfigRoutes(app: FastifyInstance) {
  app.get('/roles', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Config'],
      summary: 'List all role configurations',
      description: 'Retrieve configuration (sidebar items, home widgets, permissions) for all roles.',
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              sidebarItems: { type: 'array', items: { type: 'string' } },
              homeWidgets: { type: 'array', items: { type: 'string' } },
              permissions: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
  }, async () => {
    return configService.listRoleConfigs();
  });

  app.get('/roles/:role', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Config'],
      summary: 'Get role configuration',
      description: 'Retrieve configuration for a specific role. Returns defaults if not yet configured.',
      params: {
        type: 'object',
        required: ['role'],
        properties: { role: { type: 'string', description: 'Role name (e.g. SUPER_ADMIN, ADMIN, OPERATOR)' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            role: { type: 'string' },
            sidebarItems: { type: 'array', items: { type: 'string' } },
            homeWidgets: { type: 'array', items: { type: 'string' } },
            permissions: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (req) => {
    const { role } = req.params as { role: string };
    return configService.getRoleConfig(role);
  });

  app.put('/roles/:role', {
    preHandler: [app.requirePermission('ROLE_MANAGE')], // M6 (2026-06-30): editing role/user permission+sidebar config is role admin, not generic config
    schema: {
      tags: ['Config'],
      summary: 'Update role configuration',
      description: 'Update sidebar items, home widgets, and permissions for a specific role. Requires ROLE_MANAGE permission.',
      params: {
        type: 'object',
        required: ['role'],
        properties: { role: { type: 'string', description: 'Role name to update' } },
      },
      body: {
        type: 'object',
        properties: {
          sidebarItems: { type: 'array', items: { type: 'string' } },
          homeWidgets: { type: 'array', items: { type: 'string' } },
          permissions: { type: 'object', additionalProperties: { type: 'boolean' } },
          // Required by the service when the permission SET changes (DATA-11).
          reason: { type: 'string', maxLength: 500 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_ROLE_CONFIG', req, reply);
    if (!ok) return;

    const { role } = req.params as { role: string };
    const { sidebarItems, homeWidgets, permissions, reason } = req.body as {
      sidebarItems?: string[];
      homeWidgets?: string[];
      permissions?: Record<string, boolean>;
      reason?: string;
    };
    const ctx = buildContext(req);
    const config = await configService.updateRoleConfig(role, { sidebarItems, homeWidgets, permissions, reason }, ctx);
    return { success: true, data: config };
  });

  // User-specific overrides
  app.get('/users/:userId', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Config'],
      summary: 'Get user-specific configuration',
      description: 'Retrieve sidebar items, home widgets, and permissions configured for a specific user.',
      params: {
        type: 'object',
        required: ['userId'],
        properties: { userId: { type: 'string', description: 'User ID' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            userId: { type: 'string' },
            sidebarItems: { type: 'array', items: { type: 'string' } },
            homeWidgets: { type: 'array', items: { type: 'string' } },
            permissions: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (req) => {
    const { userId } = req.params as { userId: string };
    return configService.getUserConfig(userId);
  });

  app.put('/users/:userId', {
    preHandler: [app.requirePermission('ROLE_MANAGE')], // M6 (2026-06-30): editing role/user permission+sidebar config is role admin, not generic config
    schema: {
      tags: ['Config'],
      summary: 'Update user-specific configuration',
      description: 'Update sidebar items, home widgets, and permissions for a specific user. Overrides role-level configuration.',
      params: {
        type: 'object',
        required: ['userId'],
        properties: { userId: { type: 'string', description: 'User ID' } },
      },
      body: {
        type: 'object',
        properties: {
          sidebarItems: { type: 'array', items: { type: 'string' } },
          homeWidgets: { type: 'array', items: { type: 'string' } },
          permissions: { type: 'object', additionalProperties: { type: 'boolean' } },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_USER_CONFIG', req, reply);
    if (!ok) return;
    const { userId } = req.params as { userId: string };
    const { sidebarItems, homeWidgets, permissions } = req.body as {
      sidebarItems?: string[];
      homeWidgets?: string[];
      permissions?: Record<string, boolean>;
    };
    const ctx = buildContext(req);
    const config = await configService.updateUserConfig(userId, { sidebarItems, homeWidgets, permissions }, ctx);
    return { success: true, data: config };
  });

  app.get('/my-config', {
    schema: {
      tags: ['Config'],
      summary: 'Get current user effective configuration',
      description: 'Retrieve the effective configuration for the authenticated user. Checks user-specific config first, then falls back to role config.',
      response: {
        200: {
          type: 'object',
          properties: {
            sidebarItems: { type: 'array', items: { type: 'string' } },
            homeWidgets: { type: 'array', items: { type: 'string' } },
            permissions: { type: 'object', additionalProperties: true },
            // Which dashboard / trend-page panels this user may SEE; null = every
            // panel. Resolved server-side (see modules/config/panel-access.ts) so
            // the browser applies the answer rather than re-deriving it.
            //
            // Fastify STRIPS any field absent from this response block, silently,
            // so a field added to the handler without a line here never reaches
            // the wire — the same trap the trend-page work hit in August.
            panels: { type: 'array', items: { type: 'string' }, nullable: true },
            // Where those panels sit. Resolved server-side (user -> role ->
            // built-in) so the browser arranges what it is given rather than
            // re-deriving the fallback.
            layout: {
              type: 'object',
              properties: {
                version: { type: 'integer' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      i: { type: 'string' },
                      x: { type: 'integer' },
                      y: { type: 'integer' },
                      w: { type: 'integer' },
                      h: { type: 'integer' },
                      // Fastify STRIPS undeclared response fields, silently. The
                      // card's tint and custom heading would never reach the
                      // browser without these four lines.
                      style: {
                        type: 'object',
                        properties: {
                          tint: { type: 'string' },
                          title: { type: 'string' },
                          size: { type: 'string' },
                          pad: { type: 'string' },
                        },
                      },
                    },
                  },
                },
                // Built widgets (2026-10-28). Without this line Fastify drops
                // them between the handler and the wire, with no error.
                widgets: WIDGETS_JSON_SCHEMA,
              },
            },
          },
        },
      },
    },
  }, async (req) => {
    const [config, panels, layout] = await Promise.all([
      configService.getMyConfig(req.user.username),
      resolvePanelsFor(req.user.username),
      resolveLayoutFor(req.user.username),
    ]);
    return { ...config, panels, layout };
  });

  // ── The caller's OWN dashboard layout ──────────────────────────────────────
  //
  // Authenticated only: no permission, no re-authentication, and DELIBERATELY NO
  // auditLog CALL.
  //
  // A layout grants nothing — panel assignment decides what a user may see, and
  // that surface is audited and reauth-gated. This is where someone's cards sit
  // on their own screen. Writing a hash-chained, immutable §11 audit row every
  // time an operator nudges a card would fill the trail with noise and make the
  // records that matter harder to find.
  //
  // If you are here because the missing auditLog looks like an oversight: it is
  // not, and `src/e2e/dashboard-layout.test.ts` asserts the absence in both
  // directions. Setting a ROLE's default IS audited — see
  // `PUT /api/roles/dashboard-layout/role/:name`.
  const layoutBody = {
    type: 'object',
    required: ['layout'],
    properties: {
      layout: {
        type: 'object',
        required: ['version', 'items'],
        properties: {
          version: { type: 'integer' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['i', 'x', 'y', 'w', 'h'],
              properties: {
                i: { type: 'string' },
                x: { type: 'integer' },
                y: { type: 'integer' },
                w: { type: 'integer' },
                h: { type: 'integer' },
                // Fastify's ajv REMOVES properties a body schema does not
                // declare. Verified against the running server: an undeclared
                // `style` returned 200 and stored nothing — a save that reports
                // success and silently loses the operator's work.
                style: {
                  type: 'object',
                  properties: {
                    tint: { type: 'string' },
                    title: { type: 'string' },
                    size: { type: 'string' },
                    pad: { type: 'string' },
                  },
                },
              },
            },
          },
          // Built widgets (2026-10-28); zod validates the inner shape. OMITTED
          // keeps what is stored — see checkLayoutWrite.
          widgets: WIDGETS_JSON_SCHEMA,
        },
      },
    },
  } as const;

  app.put('/my-dashboard-layout', {
    schema: {
      tags: ['Config'],
      summary: "Save the caller's own dashboard arrangement",
      description: 'A personal preference. Not audited, and it grants nothing — panel assignment decides what a user may see.',
      body: layoutBody,
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { layout } = req.body as { layout: unknown };

    const user = await prisma.user.findUnique({ where: { username: req.user.username }, select: { id: true } });
    if (!user) return reply.code(404).send({ error: 'NOT_FOUND', message: 'User not found.' });

    // The STRICT writer (a value the reader would drop can never be stored), and
    // the super-admin-only rule for widgets, judged against the row this
    // overwrites. ONE rule, shared with the role-default route.
    const stored = await prisma.userConfig.findUnique({ where: { userId: user.id }, select: { dashboardLayout: true } });
    const checked = checkLayoutWrite(layout, stored?.dashboardLayout, req.user.role);
    if (!checked.ok) return reply.code(checked.status).send({ error: checked.error, message: checked.message });
    const parsed = checked.layout;

    await prisma.userConfig.upsert({
      where: { userId: user.id },
      create: { userId: user.id, dashboardLayout: parsed as unknown as Prisma.InputJsonObject, updatedBy: req.user.username },
      update: { dashboardLayout: parsed as unknown as Prisma.InputJsonObject, updatedBy: req.user.username },
    });
    return { success: true };
  });

  app.delete('/my-dashboard-layout', {
    schema: {
      tags: ['Config'],
      summary: "Reset the caller's dashboard to their role's default",
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { username: req.user.username }, select: { id: true } });
    if (!user) return reply.code(404).send({ error: 'NOT_FOUND', message: 'User not found.' });
    // DbNull, not JsonNull: NULL is what "inherit the role default" means here,
    // and the JSON value `null` is a different stored thing.
    await prisma.userConfig.updateMany({
      where: { userId: user.id },
      data: { dashboardLayout: Prisma.DbNull, updatedBy: req.user.username },
    });
    return { success: true };
  });
}
