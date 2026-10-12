import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { offsetKeyTest } from '../instruments/load-offsets.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { buildContext } from '../../lib/build-context.js';
import { AppError } from '../../lib/errors.js';
import { requireReason } from '../../lib/require-reason.js';
import { verifyToken } from '../../lib/jwt.js';
import { roleService, assertRoleWithinCallerPrivilege, assertUserWithinCallerPrivilege } from './role.service.js';
import { scopeWithin } from './scope-within.js';
import type { RequestContext } from '../../types/context.js';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { normalizeScope, resolveVisibility, type InstrumentScope, type ScopeNode, type ScopeSelection } from '../instruments/visibility.js';
import { normalizeLayout } from '@digilog/shared';
import { buildCoveringIndex, type FlNode } from '../functional-locations/tree.js';
import {
  ATTRIBUTE_ACCESS_MODES,
  PANELS,
  PANEL_KEYS,
  normalizePanels,
  parseAttributeAccess,
  parseInstrumentAttributeKeys,
} from '@digilog/shared';

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
              // `Role.description` is `String?`; without `nullable` a NULL
              // serialised as "" (audit 2026-10-03, API-14).
              description: { type: 'string', nullable: true },
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
            description: { type: 'string', nullable: true },
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
          reason: { type: 'string', maxLength: 500, description: 'Why the role is being created (stored on the audit row)' },
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
            message: { type: 'string' },
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
          isActive: { type: 'boolean', description: 'Enable or disable the role. Deactivating ends every session of its users.' },
          // REQUIRED when the permission set changes — 400 REASON_REQUIRED
          // otherwise (audit 2026-10-03, DATA-11). Stored on the ROLE_UPDATED row.
          reason: { type: 'string', maxLength: 500, description: 'Why the role is being changed. Required when permissions change.' },
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
            message: { type: 'string' },
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
      // No body schema: a bare DELETE (no body at all) must stay a valid
      // request, and a body schema on a DELETE makes Fastify refuse one. An
      // optional `{ reason }` JSON body is read leniently by the handler and
      // stored on the ROLE_DELETED row when given.
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
            // Declared, or Fastify strips WHY the delete was refused (finding 5).
            message: { type: 'string' },
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
    const { reason } = (req.body ?? {}) as { reason?: string };

    try {
      return await roleService.delete(name, ctx, reason);
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
  // NULL vs an empty selection is preserved end to end. `scope: null` means
  // inherit; a selection with both lists empty means SEE NOTHING. Collapsing them
  // anywhere turns a deny into a grant — see modules/instruments/visibility.ts.
  //
  // The wire shape is `{locationIds, instrumentIds}` (2026-08-28). Rows written
  // before that date hold a bare array of location ids and are NOT migrated —
  // `normalizeScope` reads both, and it is the only reader on this path for the
  // same reason it is the only one in visibility.ts: a second `Array.isArray`
  // test here would report a legacy restricted row as unrestricted.

  const scopeShape = {
    type: 'object',
    nullable: true,
    properties: {
      locationIds: { type: 'array', items: { type: 'string' } },
      instrumentIds: { type: 'array', items: { type: 'string' } },
    },
    required: ['locationIds', 'instrumentIds'],
  } as const;

  const scopeItem = {
    type: 'object',
    properties: {
      role: { type: 'string' },
      scope: scopeShape,
    },
  } as const;

  /**
   * The §11 signature line. Bounded on purpose: `signature_meaning` is
   * VARCHAR(255) and auditLog does not truncate, so this must stay short however
   * many ids were picked. It names BOTH counts — saying "N functional location(s)"
   * became a false statement the moment instruments could be named, the same way
   * the trend PDF's banner did when its data path was fixed.
   */
  const describeScope = (s: { locationIds: string[]; instrumentIds: string[] }) =>
    s.locationIds.length === 0 && s.instrumentIds.length === 0
      ? 'NO instruments at all'
      : `${s.locationIds.length} functional location(s) and ${s.instrumentIds.length} instrument(s)`;

  /**
   * Every role-keyed upsert below answers 404 for a role that does not exist
   * (audit 2026-10-03, API-20). `roleConfig.upsert` on an unknown name used to
   * create an orphan `role_configs` row — and audit it — for a typo in the
   * URL; the row then resurfaced as that role's config if the name was ever
   * created. The user-keyed routes already 404 the same way.
   */

  /**
   * The role exists AND the caller may configure it (application review
   * 2026-10-12, finding 6): the same rule the Roles page's own create/update
   * applies — SUPER_ADMIN exempt; otherwise not your own role, not one at or
   * above your level, never SUPER_ADMIN. Until then a restricted ROLE_MANAGE
   * holder could set its OWN role's instrument scope to "all instruments" or
   * its attribute access to "edit everything". Returns false for no such role
   * (the caller answers 404); throws 403 for a role it may not touch.
   */
  const assertCanConfigureRole = async (ctx: RequestContext, name: string): Promise<boolean> => {
    const row = await prisma.role.findUnique({ where: { name }, select: { name: true, hierarchyLevel: true } });
    if (!row) return false;
    await assertRoleWithinCallerPrivilege(ctx, {}, { name: row.name, hierarchyLevel: row.hierarchyLevel, permissions: [] });
    return true;
  };

  /**
   * A per-USER override is refused for the caller's own account and for any
   * account whose role is at or above the caller's (finding 6) — an override
   * REPLACES the role's rule, so it is the shortest way round the check above.
   * SUPER_ADMIN exempt. Returns the user, or null (the caller answers 404).
   */
  const assertCanConfigureUser = async (ctx: RequestContext, userId: string) => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, role: true } });
    if (!user) return null;
    await assertUserWithinCallerPrivilege(ctx, user);
    return user;
  };

  /**
   * A non-SUPER_ADMIN may hand out only scope it can see itself (application
   * review 2026-10-12, follow-up 3) — see `scope-within.ts` for the rule.
   * `proposed` is the scope the target would END UP with: for a user override
   * of `null` that is the user's role scope, not "unrestricted".
   */
  const assertScopeWithinCaller = async (ctx: RequestContext, proposed: InstrumentScope) => {
    if (ctx.userRole === 'SUPER_ADMIN') return;
    const { scope: callerScope } = await resolveVisibility(ctx);
    if (callerScope === null) return;
    const ids = proposed?.instrumentIds ?? [];
    const [rows, instruments] = await Promise.all([
      prisma.functionalLocation.findMany({ select: { id: true, name: true, type: true, parentId: true } }),
      ids.length ? prisma.instrument.findMany({ where: { id: { in: ids } }, select: { id: true, functionalLocationId: true } }) : Promise.resolve([]),
    ]);
    const result = scopeWithin(
      proposed, callerScope, rows as ScopeNode[],
      new Map(instruments.map((i) => [i.id, i.functionalLocationId])),
    );
    if (!result.ok) {
      const what = result.outside.all
        ? 'all instruments'
        : `${result.outside.locationIds.length} location(s) and ${result.outside.instrumentIds.length} instrument(s)`;
      throw new AppError(403, 'FORBIDDEN', `You cannot grant visibility wider than your own: ${what} outside your scope`);
    }
  };

  // The scope PUTs carry the operator's reason, stored on the CONFIG_CHANGED
  // row (audit 2026-10-03, DATA-11): a visibility change signs with a
  // password and used to record no "why". `requireReason` is the control.
  const scopeBody = {
    type: 'object',
    required: ['scope', 'reason'],
    properties: {
      scope: scopeShape,
      reason: { type: 'string', minLength: 1, maxLength: 500 },
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
                  scope: scopeShape,
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
    // normalizeScope, NOT a local Array.isArray: this endpoint feeds the admin
    // screen, and a legacy row read as "nothing stored" would render as "All
    // instruments" beside a user who is in fact restricted — and then be saved
    // back that way.
    const asScope = (v: unknown) => normalizeScope(v) ?? null;
    return {
      roles: roles.map((r) => ({ role: r.name, scope: asScope(byRole.get(r.name)) })),
      users: users.map((u) => ({
        userId: u.id, username: u.username, fullName: u.fullName, role: u.role,
        scope: asScope(byUser.get(u.id)),
      })),
    };
  });

  /**
   * Every instrument, for the scope picker. DELIBERATELY NOT visibility-scoped.
   *
   * An admin configuring someone else's scope is themselves subject to
   * `instrument_scope`. A scoped listing here would show them only their own
   * instruments, so they would build a scope that silently omitted the rest and
   * have no way to tell — the same reasoning already recorded for why the alarm
   * webhook CONFIG routes are unscoped. ROLE_MANAGE is the gate; anyone holding it
   * can already grant themselves the whole estate through this very screen.
   *
   * Returns identity and placement only — no credentials, no readings.
   */
  app.get('/instrument-scope/instruments', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Every instrument, for building a visibility scope',
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  code: { type: 'string' },
                  name: { type: 'string' },
                  isActive: { type: 'boolean' },
                  functionalLocationId: { type: 'string', nullable: true },
                  functionalLocationName: { type: 'string', nullable: true },
                  coveringLocationIds: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const [rows, locations] = await Promise.all([
      prisma.instrument.findMany({
        select: {
          id: true, code: true, name: true, isActive: true, functionalLocationId: true,
          functionalLocation: { select: { name: true } },
        },
        orderBy: { code: 'asc' },
      }),
      prisma.functionalLocation.findMany({ select: { id: true, name: true, type: true, parentId: true } }),
    ]);

    /**
     * `coveringLocationIds` answers "which locations, if selected, already grant
     * this instrument" — an Area's instruments are covered by that Area AND by its
     * Block. It is computed HERE, from the same `resolveLocationIds` the query
     * uses, and shipped to the client.
     *
     * The editor needs it to show a location's instruments as already included.
     * The browser must NOT work it out from the tree: that is the containment
     * rule, it is a policy decision, and a second copy of it in the client is the
     * exact drift this repo has been bitten by before.
     */
    const covering = buildCoveringIndex(locations as FlNode[]);
    return {
      data: rows.map((r) => ({
        id: r.id, code: r.code, name: r.name, isActive: r.isActive,
        functionalLocationId: r.functionalLocationId,
        functionalLocationName: r.functionalLocation?.name ?? null,
        // An instrument with no location is covered by nothing — it can only be
        // reached by being named outright.
        coveringLocationIds: r.functionalLocationId ? covering.get(r.functionalLocationId) ?? [] : [],
      })),
    };
  });

  app.put('/instrument-scope/role/:name', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Set a role\'s instrument visibility scope',
      params: { type: 'object', properties: { name: { type: 'string' } } },
      body: scopeBody,
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_ROLE_CONFIG', req, reply);
    if (!ok) return;
    const { name } = req.params as { name: string };
    const { scope, reason } = req.body as { scope: ScopeSelection | null; reason?: string };
    const ctx = buildContext(req);
    const why = requireReason(reason, "Changing a role's instrument visibility");
    if (!(await assertCanConfigureRole(ctx, name))) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Role not found.' });
    // A role's `null` is unrestricted (nothing above a role to inherit from).
    await assertScopeWithinCaller(ctx, scope);

    // The write and its audit row commit together (§11; auditLog(entry, tx)).
    await prisma.$transaction(async (tx) => {
    const before = await tx.roleConfig.findUnique({ where: { role: name }, select: { instrumentScope: true } });
    // upsert: a role may have no config row yet, and setting a scope must not
    // require someone to have visited another tab first.
    await tx.roleConfig.upsert({
      where: { role: name },
      // Prisma.DbNull writes a real SQL NULL. Prisma.JsonNull would store the JSON
      // value `null`, a DIFFERENT thing — and this feature's contract rests on NULL
      // (inherit) being distinguishable from [] (see nothing).
      create: { role: name, instrumentScope: (scope as Prisma.InputJsonObject | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
      update: { instrumentScope: (scope as Prisma.InputJsonObject | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'CONFIG_CHANGED',
      targetType: 'role_config', targetId: name,
      beforeValue: { instrumentScope: before?.instrumentScope ?? null },
      afterValue: { instrumentScope: scope },
      reason: why,
      signatureMeaning: scope === null
        ? `Role "${name.slice(0, 60)}" instrument visibility set to ALL instruments`
        : `Role "${name.slice(0, 60)}" instrument visibility set to ${describeScope(scope)}`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    }, tx);
    });
    return { role: name, scope };
  });

  // ── Instrument attribute access, per role ──────────────────────────────────
  //
  // Same shape as instrument-scope beside it, for the same reason: a per-role
  // rule stored on `role_configs`, read as a whole and written one role at a
  // time, each write audited. Deliberately NOT part of the Permissions tab's
  // bulk save — this rule names attribute keys, and a matrix of checkboxes
  // saved wholesale would make an accidental clear indistinguishable from a
  // deliberate one.
  app.get('/attribute-access', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Instrument attribute access for every role, and the keys in use',
      response: {
        200: {
          type: 'object',
          properties: {
            roles: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string' },
                  /** null = not configured = inherit today's behaviour. */
                  mode: { type: 'string', nullable: true },
                  keys: { type: 'array', items: { type: 'string' } },
                  requireReauth: { type: 'boolean' },
                  /** Does the role hold INSTRUMENT_UPDATE at all? A role without
                   *  it is read-only whatever mode is stored, and the tab has to
                   *  be able to say so rather than showing a rule that does
                   *  nothing. */
                  canUpdateInstruments: { type: 'boolean' },
                },
              },
            },
            /** Every attribute key recorded anywhere, plus every key any profile
             *  asks for — so SELECTED can be ticked from a list rather than typed
             *  from memory. */
            availableKeys: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }, async () => {
    const [roles, cfgs, recorded, profiles] = await Promise.all([
      prisma.role.findMany({
        where: { isActive: true },
        select: { name: true, permissions: true },
        orderBy: { name: 'asc' },
      }),
      prisma.roleConfig.findMany({ select: { role: true, attributeAccess: true } }),
      prisma.instrumentAttribute.findMany({ select: { key: true }, distinct: ['key'] }),
      prisma.instrumentProfile.findMany({ select: { attributeKeys: true } }),
    ]);
    const byRole = new Map(cfgs.map((c) => [c.role, parseAttributeAccess(c.attributeAccess)]));

    // Folded case-insensitively, first spelling kept — the same rule
    // parseInstrumentAttributeKeys applies, so the picker cannot offer `Room`
    // and `room` as two different things to protect.
    const seen = new Set<string>();
    const availableKeys: string[] = [];
    const offer = (k: string) => {
      const key = k.trim();
      const fold = key.toLowerCase();
      if (!key || seen.has(fold)) return;
      seen.add(fold);
      availableKeys.push(key);
    };
    // Sensor offsets are SUPER_ADMIN-only whatever a role's Attribute Access
    // says (2026-10-01), so they are not offered as keys to protect.
    const isOffset = await offsetKeyTest();
    for (const r of recorded) if (!isOffset(r.key)) offer(r.key);
    for (const p of profiles) for (const k of parseInstrumentAttributeKeys(p.attributeKeys)) if (!isOffset(k)) offer(k);
    availableKeys.sort((a, b) => a.localeCompare(b));

    return {
      roles: roles.map((r) => {
        const access = byRole.get(r.name) ?? null;
        const perms = (r.permissions as string[]) ?? [];
        return {
          role: r.name,
          mode: access?.mode ?? null,
          keys: access?.keys ?? [],
          requireReauth: access?.requireReauth ?? false,
          canUpdateInstruments: r.name === 'SUPER_ADMIN' || perms.includes('INSTRUMENT_UPDATE'),
        };
      }),
      availableKeys,
    };
  });

  app.put('/attribute-access/:name', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: "Set a role's instrument attribute access",
      params: { type: 'object', properties: { name: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          // null clears the rule back to "inherit".
          mode: { type: 'string', nullable: true, enum: [...ATTRIBUTE_ACCESS_MODES, null] as never },
          keys: { type: 'array', items: { type: 'string' } },
          requireReauth: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_ROLE_CONFIG', req, reply);
    if (!ok) return;
    const { name } = req.params as { name: string };
    const body = req.body as { mode?: string | null; keys?: string[]; requireReauth?: boolean };
    const ctx = buildContext(req);
    if (!(await assertCanConfigureRole(ctx, name))) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Role not found.' });

    // Built through the SAME parser the enforcement reads with, so a value this
    // endpoint accepts cannot be one the gate then treats as unconfigured.
    const next = body.mode === null || body.mode === undefined
      ? null
      : parseAttributeAccess({
          mode: body.mode,
          // Dropped unless the mode uses them. Stored under ALL_EDIT/ALL_VIEW they
          // are inert until someone switches the role back to SELECTED, at which
          // point a list nobody has looked at in months quietly becomes the rule.
          // Enforced HERE and not only in the tab: a client-side tidy-up is not a
          // rule, it is a habit the next caller does not have.
          keys: body.mode === 'SELECTED' ? (body.keys ?? []) : [],
          requireReauth: body.requireReauth === true,
        });
    if (body.mode && !next) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: `mode must be one of: ${ATTRIBUTE_ACCESS_MODES.join(', ')}`,
      });
    }

    // The write and its audit row commit together (§11; auditLog(entry, tx)).
    await prisma.$transaction(async (tx) => {
    const before = await tx.roleConfig.findUnique({
      where: { role: name }, select: { attributeAccess: true },
    });
    await tx.roleConfig.upsert({
      where: { role: name },
      // Prisma.DbNull writes a real SQL NULL. JsonNull would store the JSON value
      // `null`, a different thing — and "not configured" versus "configured as
      // nothing" is the whole contract here.
      // The cast is structural only: `AttributeAccess` has no index signature,
      // which is what Prisma's InputJsonObject asks for. Every field it carries
      // is a JSON scalar or an array of them.
      create: { role: name, attributeAccess: (next as Prisma.InputJsonObject | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
      update: { attributeAccess: (next as Prisma.InputJsonObject | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
    });

    // Bounded: `signature_meaning` is VARCHAR(255) and auditLog does not
    // truncate, so a role name plus a key count must not be able to overflow it.
    const describe = next === null
      ? 'not configured (inherits Edit Instruments)'
      : next.mode === 'SELECTED'
        ? `${next.keys.length} attribute(s) editable`
        : next.mode === 'ALL_EDIT' ? 'all attributes editable' : 'all attributes view-only';
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'CONFIG_CHANGED',
      targetType: 'role_config', targetId: name,
      beforeValue: { attributeAccess: before?.attributeAccess ?? null },
      afterValue: { attributeAccess: next },
      signatureMeaning:
        `Role "${name.slice(0, 60)}" attribute access set to ${describe}` +
        (next?.requireReauth ? ', password required' : ''),
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    }, tx);
    });
    return { role: name, mode: next?.mode ?? null, keys: next?.keys ?? [], requireReauth: next?.requireReauth ?? false };
  });

  app.put('/instrument-scope/user/:userId', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Set one user\'s instrument visibility scope, overriding their role',
      params: { type: 'object', properties: { userId: { type: 'string' } } },
      body: scopeBody,
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_ROLE_CONFIG', req, reply);
    if (!ok) return;
    const { userId } = req.params as { userId: string };
    const { scope, reason } = req.body as { scope: ScopeSelection | null; reason?: string };
    const ctx = buildContext(req);
    const why = requireReason(reason, "Changing a user's instrument visibility");

    const user = await assertCanConfigureUser(ctx, userId);
    if (!user) return reply.code(404).send({ error: 'NOT_FOUND', message: 'User not found.' });
    // What the user would SEE: an override of `null` inherits the role's scope.
    const roleCfg = scope === null
      ? await prisma.roleConfig.findUnique({ where: { role: user.role }, select: { instrumentScope: true } })
      : null;
    await assertScopeWithinCaller(ctx, scope ?? normalizeScope(roleCfg?.instrumentScope) ?? null);

    // The write and its audit row commit together (§11; auditLog(entry, tx)).
    await prisma.$transaction(async (tx) => {
    const before = await tx.userConfig.findUnique({ where: { userId }, select: { instrumentScope: true } });
    await tx.userConfig.upsert({
      where: { userId },
      // See the role endpoint above: DbNull, not JsonNull.
      create: { userId, instrumentScope: (scope as Prisma.InputJsonObject | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
      update: { instrumentScope: (scope as Prisma.InputJsonObject | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'CONFIG_CHANGED',
      targetType: 'user_config', targetId: userId,
      beforeValue: { instrumentScope: before?.instrumentScope ?? null },
      afterValue: { instrumentScope: scope },
      reason: why,
      // An override REPLACES the role scope and can therefore WIDEN it, so the
      // signature says which user and what they were given rather than just "changed".
      signatureMeaning: scope === null
        ? `User "${user.username.slice(0, 60)}" instrument visibility reset to inherit role "${user.role.slice(0, 60)}"`
        : `User "${user.username.slice(0, 60)}" instrument visibility overridden to ${describeScope(scope)}`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    }, tx);
    });
    return { userId, scope };
  });


  // --- Panel assignment (2026-08-28) ----------------------------------------
  //
  // Same module, permission, reauth action and audit action as instrument scope
  // above, deliberately: panels and instruments are assigned on one screen, so a
  // second set of conventions would give "why does this user see nothing?" two
  // answers instead of one.
  //
  // A hidden panel is a DISPLAY decision, NOT an access control - it does not stop
  // the data being fetched. instrument_scope is what restricts data, and the editor
  // screen says so.

  const panelsShape = {
    type: 'array',
    nullable: true,
    items: { type: 'string', enum: [...PANEL_KEYS] },
  } as const;

  /**
   * The 21 CFR Part 11 signature line. Bounded on purpose: `signature_meaning` is
   * VARCHAR(255) and auditLog does not truncate, so this must stay short however
   * many panels were picked. "NO panels" is spelled out rather than rendered as
   * "0 of 7", which invites the reader to wonder whether the save failed.
   */
  const describePanels = (panels: string[] | null) =>
    panels === null ? 'ALL panels'
      : panels.length === 0 ? 'NO panels'
        : `${panels.length} of ${PANELS.length}`;

  app.get('/panel-access', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Panel assignment for every role and every user override',
      response: {
        200: {
          type: 'object',
          properties: {
            roles: {
              type: 'array',
              items: { type: 'object', properties: { role: { type: 'string' }, panels: panelsShape } },
            },
            users: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  userId: { type: 'string' },
                  username: { type: 'string' },
                  fullName: { type: 'string', nullable: true },
                  role: { type: 'string' },
                  panels: panelsShape,
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
      prisma.roleConfig.findMany({ select: { role: true, dashboardCards: true } }),
      prisma.user.findMany({ select: { id: true, username: true, fullName: true, role: true }, orderBy: { username: 'asc' } }),
      prisma.userConfig.findMany({ select: { userId: true, dashboardCards: true } }),
    ]);
    const byRole = new Map(roleCfgs.map((c) => [c.role, c.dashboardCards]));
    const byUser = new Map(userCfgs.map((c) => [c.userId, c.dashboardCards]));
    // normalizePanels, never a local Array.isArray: this endpoint feeds the admin
    // screen, and a stored row read as "nothing set" would render as "All panels"
    // beside a role that is in fact restricted - and then be saved back that way.
    const read = (v: unknown) => normalizePanels(v) ?? null;
    return {
      roles: roles.map((r) => ({ role: r.name, panels: read(byRole.get(r.name)) })),
      users: users.map((u) => ({
        userId: u.id, username: u.username, fullName: u.fullName, role: u.role,
        panels: read(byUser.get(u.id)),
      })),
    };
  });

  app.put('/panel-access/role/:name', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: "Set a role's assignable panels",
      params: { type: 'object', properties: { name: { type: 'string' } } },
      body: { type: 'object', required: ['panels'], properties: { panels: panelsShape } },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_ROLE_CONFIG', req, reply);
    if (!ok) return;
    const { name } = req.params as { name: string };
    const { panels } = req.body as { panels: string[] | null };
    const ctx = buildContext(req);
    // Same own-role / hierarchy rule as scope and attribute access (review
    // 2026-10-12, follow-up 1). Display-only, but it is still one administrator
    // acting on other people, and a role may not rearrange its own or a peer's.
    if (!(await assertCanConfigureRole(ctx, name))) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Role not found.' });

    // The write and its audit row commit together (§11; auditLog(entry, tx)).
    await prisma.$transaction(async (tx) => {
    const before = await tx.roleConfig.findUnique({ where: { role: name }, select: { dashboardCards: true } });
    await tx.roleConfig.upsert({
      where: { role: name },
      // Prisma.DbNull writes a real SQL NULL. Prisma.JsonNull would store the JSON
      // value `null`, a DIFFERENT thing - and this feature rests on NULL (inherit)
      // being distinguishable from [] (no panels).
      create: { role: name, dashboardCards: (panels as Prisma.InputJsonValue | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
      update: { dashboardCards: (panels as Prisma.InputJsonValue | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'CONFIG_CHANGED',
      targetType: 'role_config', targetId: name,
      beforeValue: { dashboardCards: before?.dashboardCards ?? null },
      afterValue: { dashboardCards: panels },
      signatureMeaning: `Role "${name.slice(0, 60)}" panels set to ${describePanels(panels)}`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    }, tx);
    });
    return { role: name, panels };
  });

  app.put('/panel-access/user/:userId', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: "Set one user's assignable panels, overriding their role",
      params: { type: 'object', properties: { userId: { type: 'string' } } },
      body: { type: 'object', required: ['panels'], properties: { panels: panelsShape } },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_ROLE_CONFIG', req, reply);
    if (!ok) return;
    const { userId } = req.params as { userId: string };
    const { panels } = req.body as { panels: string[] | null };
    const ctx = buildContext(req);

    const user = await assertCanConfigureUser(ctx, userId);
    if (!user) return reply.code(404).send({ error: 'NOT_FOUND', message: 'User not found.' });

    // The write and its audit row commit together (§11; auditLog(entry, tx)).
    await prisma.$transaction(async (tx) => {
    const before = await tx.userConfig.findUnique({ where: { userId }, select: { dashboardCards: true } });
    await tx.userConfig.upsert({
      where: { userId },
      // See the role endpoint above: DbNull, not JsonNull.
      create: { userId, dashboardCards: (panels as Prisma.InputJsonValue | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
      update: { dashboardCards: (panels as Prisma.InputJsonValue | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'CONFIG_CHANGED',
      targetType: 'user_config', targetId: userId,
      beforeValue: { dashboardCards: before?.dashboardCards ?? null },
      afterValue: { dashboardCards: panels },
      // An override REPLACES the role's list and can therefore WIDEN it, so the
      // signature names the user and what they were given, not just "changed".
      signatureMeaning: panels === null
        ? `User "${user.username.slice(0, 60)}" panels reset to inherit role "${user.role.slice(0, 60)}"`
        : `User "${user.username.slice(0, 60)}" panels overridden to ${describePanels(panels)}`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    }, tx);
    });
    return { userId, panels };
  });


  // ─── A role's DEFAULT dashboard layout (2026-08-28) ────────────────────────
  //
  // AUDITED, unlike a user saving their own arrangement, because this is an
  // administrator acting on other people — the line this codebase draws
  // everywhere else. Same permission and reauth action as the panel assignment
  // routes above.
  //
  // It is a DEFAULT, not an enforcement: any user's own layout overrides it, and
  // they can return to it with DELETE /api/config/my-dashboard-layout.
  app.put('/dashboard-layout/role/:name', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: "Set a role's default dashboard arrangement",
      params: { type: 'object', properties: { name: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['layout'],
        properties: {
          layout: {
            type: 'object',
            nullable: true,
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
                    // See the same block on /api/config/my-dashboard-layout:
                    // ajv strips undeclared body properties.
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
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_ROLE_CONFIG', req, reply);
    if (!ok) return;
    const { name } = req.params as { name: string };
    const { layout } = req.body as { layout: unknown };
    const ctx = buildContext(req);
    if (!(await assertCanConfigureRole(ctx, name))) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Role not found.' });

    // null clears the default; anything else must pass the SAME normalizer the
    // reader uses, so an unreadable value cannot be stored.
    const parsed = layout === null ? null : normalizeLayout(layout) ?? null;
    if (layout !== null && parsed === null) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Layout is not in a form this server can store.' });
    }

    // The write and its audit row commit together (§11; auditLog(entry, tx)).
    await prisma.$transaction(async (tx) => {
    const before = await tx.roleConfig.findUnique({ where: { role: name }, select: { dashboardLayout: true } });
    await tx.roleConfig.upsert({
      where: { role: name },
      create: { role: name, dashboardLayout: (parsed as Prisma.InputJsonObject | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
      update: { dashboardLayout: (parsed as Prisma.InputJsonObject | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'CONFIG_CHANGED',
      targetType: 'role_config', targetId: name,
      beforeValue: { dashboardLayout: before?.dashboardLayout ?? null },
      afterValue: { dashboardLayout: parsed },
      signatureMeaning: parsed === null
        ? `Role "${name.slice(0, 60)}" default dashboard layout cleared`
        : `Role "${name.slice(0, 60)}" default dashboard layout set, ${parsed.items.length} panel(s) placed`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    }, tx);
    });
    return { role: name, layout: parsed };
  });

}
