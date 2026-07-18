import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { enforceReauth } from '../../lib/reauth-check.js';
import { buildContext } from '../../lib/build-context.js';
import { AppError } from '../../lib/errors.js';
import { verifyToken } from '../../lib/jwt.js';
import { roleService } from './role.service.js';

/**
 * Best-effort caller role for the PUBLIC /active endpoint (auth hook skips it,
 * so req.user is never populated). Decodes the Bearer token if one was sent so
 * a SUPER_ADMIN caller still sees the SUPER_ADMIN role; anonymous/other callers
 * resolve to undefined → SUPER_ADMIN is hidden. No session check needed — this
 * only decides whether one role name is included in a read-only list.
 */
async function optionalCallerRole(req: FastifyRequest): Promise<string | undefined> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return undefined;
  try {
    const payload = await verifyToken(auth.slice(7));
    return payload.role;
  } catch {
    return undefined;
  }
}

export default async function roleRoutes(app: FastifyInstance) {
  // GET /api/roles — List all roles
  app.get('/', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'List all roles',
      description: 'Retrieve all roles ordered by hierarchy level. Requires ROLE_MANAGE permission.',
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              displayName: { type: 'string' },
              description: { type: 'string' },
              hierarchyLevel: { type: 'integer' },
              permissions: { type: 'array', items: { type: 'string' } },
              color: { type: 'string' },

              isSystem: { type: 'boolean' },
              isActive: { type: 'boolean' },
            },
          },
        },
      },
    },
  }, async (req) => {
    return roleService.listAll(buildContext(req).userRole);
  });

  // GET /api/roles/active — List only active roles (for dropdowns)
  app.get('/active', {
    schema: {
      tags: ['Roles'],
      summary: 'List active roles',
      description: 'Retrieve only active roles with minimal fields, suitable for dropdown selectors.',
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              displayName: { type: 'string' },
              hierarchyLevel: { type: 'integer' },
              color: { type: 'string' },
            },
          },
        },
      },
    },
  }, async (req) => {
    return roleService.listActive(await optionalCallerRole(req));
  });

  // GET /api/roles/access-matrix — active roles + their permissions + per-role
  // sidebar overrides, for the Module Guide's "which role does which operation"
  // flowcharts. Authenticated (any logged-in user); NOT public and NOT gated on
  // ROLE_MANAGE — it only exposes RBAC structure, which the guide documents.
  app.get('/access-matrix', {
    schema: {
      tags: ['Roles'],
      summary: 'Role access matrix for the Module Guide',
      description: 'Active roles with permissions and per-role sidebar items, so the Module Guide can show which role(s) perform each operation. Any authenticated user.',
      response: {
        200: {
          type: 'object',
          properties: {
            roles: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  displayName: { type: 'string' },
                  hierarchyLevel: { type: 'integer' },
                  color: { type: 'string' },
                  permissions: { type: 'array', items: { type: 'string' } },
                  sidebarItems: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  }, async (req) => {
    return roleService.getAccessMatrix(buildContext(req).userRole);
  });

  // GET /api/roles/permissions/all — Get all available permissions
  app.get('/permissions/all', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'List all available permissions',
      description: 'Return the complete list of available permissions grouped by category. Requires ROLE_MANAGE permission.',
      response: {
        200: {
          type: 'object',
          properties: {
            permissions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  label: { type: 'string' },
                  category: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    return roleService.getAllPermissions();
  });

  // GET /api/roles/:name — Get single role by name
  app.get('/:name', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Get role by name',
      description: 'Retrieve a single role by its unique name. Requires ROLE_MANAGE permission.',
      params: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Role name (e.g. SUPER_ADMIN, ADMIN, OPERATOR)' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            displayName: { type: 'string' },
            description: { type: 'string' },
            hierarchyLevel: { type: 'integer' },
            permissions: { type: 'array', items: { type: 'string' } },
            color: { type: 'string' },
            isSystem: { type: 'boolean' },
            isActive: { type: 'boolean' },
          },
        },
        404: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (req) => {
    const { name } = req.params as { name: string };
    return roleService.getByName(name);
  });

  // POST /api/roles — Create new role (SUPER_ADMIN only)
  app.post('/', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Create a new role',
      description: 'Create a custom role with specified permissions, hierarchy level, and display properties. Requires ROLE_MANAGE permission.',
      body: {
        type: 'object',
        required: ['name', 'displayName', 'hierarchyLevel'],
        properties: {
          name: { type: 'string', description: 'Unique role name (uppercase with underscores, e.g. CUSTOM_ROLE)' },
          displayName: { type: 'string', description: 'Human-readable display name' },
          description: { type: 'string', description: 'Role description' },
          hierarchyLevel: { type: 'integer', minimum: 1, maximum: 10, description: 'Hierarchy level (1=lowest, 10=highest)' },
          permissions: { type: 'array', items: { type: 'string' }, description: 'Permission keys assigned to this role' },
          color: { type: 'string', description: 'Display color (hex code)' },
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
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            details: { type: 'object', additionalProperties: true },
          },
        },
        409: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('CREATE_ROLE', req, reply);
    if (!ok) return;

    const ctx = buildContext(req);
    return roleService.create(req.body, ctx);
  });

  // PUT /api/roles/:name — Update role (SUPER_ADMIN only)
  app.put('/:name', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Update a role',
      description: 'Update role properties. System roles can only have permissions, color, display name, and description updated. Requires ROLE_MANAGE permission.',
      params: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Role name to update' },
        },
      },
      body: {
        type: 'object',
        properties: {
          displayName: { type: 'string', description: 'Updated display name' },
          description: { type: 'string', description: 'Updated description' },
          hierarchyLevel: { type: 'integer', minimum: 1, maximum: 10, description: 'Updated hierarchy level' },
          permissions: { type: 'array', items: { type: 'string' }, description: 'Updated permissions list' },
          color: { type: 'string', description: 'Updated color' },
          isActive: { type: 'boolean', description: 'Enable or disable the role' },
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
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            details: { type: 'object', additionalProperties: true },
          },
        },
        404: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_ROLE', req, reply);
    if (!ok) return;

    const { name } = req.params as { name: string };
    const ctx = buildContext(req);
    return roleService.update(name, req.body, ctx);
  });

  // DELETE /api/roles/:name — Delete role (SUPER_ADMIN only)
  app.delete('/:name', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Delete a role',
      description: 'Permanently delete a custom role. System roles cannot be deleted. Roles with assigned users cannot be deleted. Requires ROLE_MANAGE permission.',
      params: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Role name to delete' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        404: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        409: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            usersCount: { type: 'integer' },
          },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('DELETE_ROLE', req, reply);
    if (!ok) return;

    const { name } = req.params as { name: string };
    const ctx = buildContext(req);

    try {
      return await roleService.delete(name, ctx);
    } catch (err) {
      if (err instanceof AppError && (err as any).usersCount !== undefined) {
        return reply.code(err.statusCode as 409).send({
          error: err.message,
          usersCount: (err as any).usersCount,
        });
      }
      throw err;
    }
  });

  // GET /api/roles/:name/creatable — Get roles that this role can create
  app.get('/:name/creatable', {
    preHandler: [app.requirePermission('USER_CREATE')],
    schema: {
      tags: ['Roles'],
      summary: 'Get creatable roles for a role',
      description: 'Retrieve the list of active roles that a given role is allowed to assign to new users (roles at the same or lower hierarchy level).',
      params: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Role name to check creatable roles for' },
        },
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              displayName: { type: 'string' },
              hierarchyLevel: { type: 'integer' },
              color: { type: 'string' },
            },
          },
        },
        404: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (req) => {
    // Use the authenticated user's actual role instead of the URL parameter
    // to prevent privilege escalation by querying another role's creatable list
    const roleName = req.user.role;
    return roleService.getCreatableRoles(roleName);
  });
}
