import fp from 'fastify-plugin';
import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { hasEffectivePermission } from '@digilog/shared';

declare module 'fastify' {
  interface FastifyInstance {
    requirePermission: (permission: string) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAnyPermission: (...permissions: string[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: string[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireSuperAdmin: () => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Audit 2026-05-04 fix (api-supporting M11): role-permission cache.
 *
 * Before: every requirePermission call hit Postgres for the role row.
 * Combined with the auth plugin's session/user/role-scope reads, every
 * authenticated request did 4 sequential queries before the handler ran.
 *
 * Now: 5-second TTL cache keyed by role name. Short enough that role-config
 * edits propagate within 5s; long enough to absorb the typical
 * burst-of-requests pattern (sidebar load = 5+ parallel calls all needing
 * the same role data). Cache miss does the same Prisma read as before.
 *
 * Invalidation: explicitly cleared from role.service.ts when permissions
 * change (see invalidateRolePermsCache export). The 5s TTL is the safety
 * net for paths that don't invalidate (e.g., direct DB edits).
 */
const ROLE_PERMS_CACHE = new Map<string, { perms: string[]; cachedAt: number }>();
const ROLE_PERMS_CACHE_TTL_MS = 5_000;

async function getRolePerms(roleName: string): Promise<string[]> {
  const cached = ROLE_PERMS_CACHE.get(roleName);
  const now = Date.now();
  if (cached && (now - cached.cachedAt) < ROLE_PERMS_CACHE_TTL_MS) {
    return cached.perms;
  }
  const role = await prisma.role.findFirst({
    where: { name: roleName },
    select: { permissions: true },
  });
  const perms = (role?.permissions as string[]) ?? [];
  ROLE_PERMS_CACHE.set(roleName, { perms, cachedAt: now });
  return perms;
}

/** Clear the role-perms cache. Call from role.service.ts after a role
 *  permissions change so the next request picks up the new value
 *  immediately (rather than waiting up to 5s for the TTL to lapse). */
export function invalidateRolePermsCache(roleName?: string): void {
  if (roleName) ROLE_PERMS_CACHE.delete(roleName);
  else ROLE_PERMS_CACHE.clear();
}

async function rbacPlugin(app: FastifyInstance) {
  app.decorate('requirePermission', (permission: string) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const userRole = req.user?.role;
      if (!userRole) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Not authenticated' });
      }

      // SUPER_ADMIN bypasses all permission checks
      if (userRole === 'SUPER_ADMIN') return;

      const perms = await getRolePerms(userRole);

      // Direct match + `*_VIEW <- *_READ` + `*_<suffix> <- *_MANAGE` fallbacks.
      // All three rules + the suffix list live in @digilog/shared so the
      // implication policy is auditable alongside the PERMISSIONS constants,
      // and so requirePermission + requireAnyPermission can't drift.
      const hasPermission = hasEffectivePermission(perms, permission);

      if (!hasPermission) {
        if (process.env.NODE_ENV === 'production') {
          return reply.code(403).send({ error: 'FORBIDDEN', message: 'Insufficient permissions' });
        }
        return reply.code(403).send({
          error: 'FORBIDDEN',
          message: 'Permission denied',
          requiredPermission: permission,
          yourRole: userRole,
        });
      }
    };
  });

  // Allow access if the user has ANY of the listed permissions.
  // Useful for routes that can be gated by either a broad permission (ASSET_UPDATE)
  // or a more granular toggle (EG_EDIT) — whichever the role has.
  app.decorate('requireAnyPermission', (...permissions: string[]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const userRole = req.user?.role;
      if (!userRole) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Not authenticated' });
      }
      if (userRole === 'SUPER_ADMIN') return;

      const perms = await getRolePerms(userRole);

      // Single shared helper for all fallbacks — same rules requirePermission
      // applies, so the two decorators can't disagree on what's allowed.
      const hasAny = permissions.some(permission => hasEffectivePermission(perms, permission));

      if (!hasAny) {
        if (process.env.NODE_ENV === 'production') {
          return reply.code(403).send({ error: 'FORBIDDEN', message: 'Insufficient permissions' });
        }
        return reply.code(403).send({
          error: 'FORBIDDEN',
          message: 'Permission denied',
          requiredPermissions: permissions,
          yourRole: userRole,
        });
      }
    };
  });

  app.decorate('requireRole', (...roles: string[]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const userRole = req.user?.role;
      // SUPER_ADMIN can always pass role checks
      if (userRole === 'SUPER_ADMIN') return;

      if (!userRole || !roles.includes(userRole)) {
        if (process.env.NODE_ENV === 'production') {
          return reply.code(403).send({ error: 'FORBIDDEN', message: 'Insufficient permissions' });
        }
        return reply.code(403).send({
          error: 'FORBIDDEN',
          message: 'Permission denied',
          requiredRoles: roles,
          yourRole: userRole,
        });
      }
    };
  });

  // Convenience: requires SUPER_ADMIN role
  app.decorate('requireSuperAdmin', () => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.user?.role !== 'SUPER_ADMIN') {
        if (process.env.NODE_ENV === 'production') {
          return reply.code(403).send({ error: 'FORBIDDEN', message: 'Insufficient permissions' });
        }
        return reply.code(403).send({
          error: 'FORBIDDEN',
          message: 'Super Admin access required',
          yourRole: req.user?.role,
        });
      }
    };
  });

}

export default fp(rbacPlugin, { name: 'rbac', dependencies: ['auth'] });
