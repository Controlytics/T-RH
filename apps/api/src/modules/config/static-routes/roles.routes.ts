import { type FastifyInstance } from 'fastify';
import { enforceReauth } from '../../../lib/reauth-check.js';
import { buildContext } from '../../../lib/build-context.js';
import { configService } from '../config.service.js';

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
    const { sidebarItems, homeWidgets, permissions } = req.body as {
      sidebarItems?: string[];
      homeWidgets?: string[];
      permissions?: Record<string, boolean>;
    };
    const ctx = buildContext(req);
    const config = await configService.updateRoleConfig(role, { sidebarItems, homeWidgets, permissions }, ctx);
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
          },
        },
      },
    },
  }, async (req) => {
    return configService.getMyConfig(req.user.username);
  });
}
