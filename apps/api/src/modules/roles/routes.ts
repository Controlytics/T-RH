import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { enforceReauth } from '../../lib/reauth-check.js';
import { buildContext } from '../../lib/build-context.js';
import { AppError } from '../../lib/errors.js';
import { verifyToken } from '../../lib/jwt.js';
import { roleService } from './role.service.js';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';

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

  // ─── Instrument visibility scope (project D) ──────────────────────────────
  //
  // Reads and writes role/user instrument scope. Kept on the roles module rather
  // than instruments: this is an ADMINISTRATIVE surface about who may see what,
  // gated on ROLE_MANAGE, not an instrument read.
  //
  // NULL vs [] is preserved end to end. `scope: null` means inherit; `scope: []`
  // means SEE NOTHING. Collapsing them anywhere turns a deny into a grant — see
  // modules/instruments/visibility.ts.

  const scopeItem = {
    type: 'object',
    properties: {
      role: { type: 'string' },
      scope: { type: 'array', items: { type: 'string' }, nullable: true },
    },
  } as const;

  app.get('/instrument-scope', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Instrument visibility scope for every role and every user override',
      response: {
        200: {
          type: 'object',
          properties: {
            roles: { type: 'array', items: { type: 'object', properties: scopeItem.properties } },
            users: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  userId: { type: 'string' },
                  username: { type: 'string' },
                  fullName: { type: 'string', nullable: true },
                  role: { type: 'string' },
                  scope: { type: 'array', items: { type: 'string' }, nullable: true },
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const [roles, roleCfgs, users, userCfgs] = await Promise.all([
      prisma.role.findMany({ where: { isActive: true }, select: { name: true }, orderBy: { name: 'asc' } }),
      prisma.roleConfig.findMany({ select: { role: true, instrumentScope: true } }),
      prisma.user.findMany({ select: { id: true, username: true, fullName: true, role: true }, orderBy: { username: 'asc' } }),
      prisma.userConfig.findMany({ select: { userId: true, instrumentScope: true } }),
    ]);
    const byRole = new Map(roleCfgs.map((c) => [c.role, c.instrumentScope]));
    const byUser = new Map(userCfgs.map((c) => [c.userId, c.instrumentScope]));
    const asScope = (v: unknown) => (Array.isArray(v) ? (v as string[]) : null);
    return {
      roles: roles.map((r) => ({ role: r.name, scope: asScope(byRole.get(r.name)) })),
      users: users.map((u) => ({
        userId: u.id, username: u.username, fullName: u.fullName, role: u.role,
        scope: asScope(byUser.get(u.id)),
      })),
    };
  });

  app.put('/instrument-scope/role/:name', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Set a role\'s instrument visibility scope',
      params: { type: 'object', properties: { name: { type: 'string' } } },
      body: {
        type: 'object',
        properties: { scope: { type: 'array', items: { type: 'string' }, nullable: true } },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_ROLE_CONFIG', req, reply);
    if (!ok) return;
    const { name } = req.params as { name: string };
    const { scope } = req.body as { scope: string[] | null };
    const ctx = buildContext(req);

    const before = await prisma.roleConfig.findUnique({ where: { role: name }, select: { instrumentScope: true } });
    // upsert: a role may have no config row yet, and setting a scope must not
    // require someone to have visited another tab first.
    await prisma.roleConfig.upsert({
      where: { role: name },
      // Prisma.DbNull writes a real SQL NULL. Prisma.JsonNull would store the JSON
      // value `null`, a DIFFERENT thing — and this feature's contract rests on NULL
      // (inherit) being distinguishable from [] (see nothing).
      create: { role: name, instrumentScope: scope ?? Prisma.DbNull, updatedBy: ctx.userId },
      update: { instrumentScope: scope ?? Prisma.DbNull, updatedBy: ctx.userId },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'CONFIG_CHANGED',
      targetType: 'role_config', targetId: name,
      beforeValue: { instrumentScope: before?.instrumentScope ?? null },
      afterValue: { instrumentScope: scope },
      signatureMeaning: scope === null
        ? `Role "${name}" instrument visibility set to ALL instruments`
        : `Role "${name}" instrument visibility set to ${scope.length} functional location(s)`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return { role: name, scope };
  });

  app.put('/instrument-scope/user/:userId', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Set one user\'s instrument visibility scope, overriding their role',
      params: { type: 'object', properties: { userId: { type: 'string' } } },
      body: {
        type: 'object',
        properties: { scope: { type: 'array', items: { type: 'string' }, nullable: true } },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_ROLE_CONFIG', req, reply);
    if (!ok) return;
    const { userId } = req.params as { userId: string };
    const { scope } = req.body as { scope: string[] | null };
    const ctx = buildContext(req);

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, role: true } });
    if (!user) return reply.code(404).send({ error: 'NOT_FOUND', message: 'User not found.' });

    const before = await prisma.userConfig.findUnique({ where: { userId }, select: { instrumentScope: true } });
    await prisma.userConfig.upsert({
      where: { userId },
      // See the role endpoint above: DbNull, not JsonNull.
      create: { userId, instrumentScope: scope ?? Prisma.DbNull, updatedBy: ctx.userId },
      update: { instrumentScope: scope ?? Prisma.DbNull, updatedBy: ctx.userId },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'CONFIG_CHANGED',
      targetType: 'user_config', targetId: userId,
      beforeValue: { instrumentScope: before?.instrumentScope ?? null },
      afterValue: { instrumentScope: scope },
      // An override REPLACES the role scope and can therefore WIDEN it, so the
      // signature says which user and how many locations rather than just "changed".
      signatureMeaning: scope === null
        ? `User "${user.username}" instrument visibility reset to inherit role "${user.role}"`
        : `User "${user.username}" instrument visibility overridden to ${scope.length} functional location(s)`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return { userId, scope };
  });

}
