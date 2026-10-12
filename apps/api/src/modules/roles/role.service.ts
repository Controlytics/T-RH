import { z } from 'zod';
import { PERMISSIONS } from '@digilog/shared';
import { auditLog } from '../../lib/audit.js';
import { prisma } from '../../lib/prisma.js';
import { AppError, NotFoundError, ConflictError, ValidationError } from '../../lib/errors.js';
import { requireReason, REASON_MAX } from '../../lib/require-reason.js';
import { invalidateUserAuthCache, invalidateSessionAuthCache } from '../../plugins/auth.js';
import type { RequestContext } from '../../types/context.js';
import { roleRepository } from './role.repository.js';

// ---------------------------------------------------------------------------
// Privilege boundary
// ---------------------------------------------------------------------------

/**
 * Guards role create/update against privilege escalation by a non-SUPER_ADMIN
 * caller. Any ROLE_MANAGE holder (ADMIN holds it by default) could otherwise:
 *   - grant its OWN system role permissions it doesn't hold (AUDIT_DELETE,
 *     BACKUP_RESTORE, USER_RESET_PASSWORD, …) and re-login with them,
 *   - create/raise a role at or above its own hierarchy level, or
 *   - edit a higher-privilege role.
 * SUPER_ADMIN is exempt (top of the hierarchy). Only NEWLY-added permissions are
 * subset-checked, so editing a lower role's label/color that already holds a
 * permission the caller lacks is not falsely blocked.
 */
export async function assertRoleWithinCallerPrivilege(
  ctx: RequestContext,
  incoming: { hierarchyLevel?: number; permissions?: string[] },
  target?: { name: string; hierarchyLevel: number; permissions: string[] },
) {
  if (ctx.userRole === 'SUPER_ADMIN') return;
  const caller = await roleRepository.findByName(ctx.userRole);
  if (!caller) throw new AppError(403, 'FORBIDDEN', 'Your role is not recognized');

  if (target) {
    if (target.name === ctx.userRole) {
      throw new AppError(403, 'FORBIDDEN', 'You cannot modify your own role');
    }
    if (target.hierarchyLevel >= caller.hierarchyLevel) {
      throw new AppError(403, 'FORBIDDEN', 'You cannot modify a role at or above your own hierarchy level');
    }
  }
  if (incoming.hierarchyLevel !== undefined && incoming.hierarchyLevel >= caller.hierarchyLevel) {
    throw new AppError(403, 'FORBIDDEN', 'You cannot assign a hierarchy level at or above your own');
  }
  if (incoming.permissions && incoming.permissions.length > 0) {
    const held = new Set((caller.permissions as string[]) ?? []);
    const grandfathered = new Set(target?.permissions ?? []);
    const escalating = incoming.permissions.filter((p) => !held.has(p) && !grandfathered.has(p));
    if (escalating.length > 0) {
      const shown = escalating.slice(0, 5).join(', ');
      throw new AppError(403, 'FORBIDDEN', `You cannot grant permissions your own role does not hold: ${shown}${escalating.length > 5 ? ', …' : ''}`);
    }
  }
}

/**
 * No role other than SUPER_ADMIN may sit at or above SUPER_ADMIN's hierarchy
 * level (application review 2026-10-12, finding 8). The schema allowed 1..10
 * while SUPER_ADMIN is seeded at 6, and every "may X manage Y" rule compares
 * the numbers — so a custom role created at 7 (only a SUPER_ADMIN could, as
 * `assertRoleWithinCallerPrivilege` caps everyone else below their own level)
 * outranked SUPER_ADMIN everywhere a number was compared. Enforced for EVERY
 * caller, SUPER_ADMIN included. SUPER_ADMIN's level is read, not assumed.
 */
async function assertBelowSuperAdmin(hierarchyLevel: number | undefined, roleName: string) {
  if (hierarchyLevel === undefined || roleName === 'SUPER_ADMIN') return;
  const top = await roleRepository.findByName('SUPER_ADMIN');
  const ceiling = top?.hierarchyLevel ?? 6;
  if (hierarchyLevel >= ceiling) {
    throw new ValidationError(
      `Hierarchy level must be below Super Admin's (${ceiling})`,
      { fieldErrors: { hierarchyLevel: [`Must be less than ${ceiling}`] } },
    );
  }
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const createRoleSchema = z.object({
  name: z.string().min(2).max(50).regex(/^[A-Z][A-Z0-9_]*$/, 'Name must be uppercase with underscores only'),
  displayName: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  hierarchyLevel: z.number().int().min(1).max(10),
  permissions: z.array(z.string()).default([]),
  color: z.string().max(100).default('#6366f1'),
  // Stored on the ROLE_CREATED row when given (audit 2026-10-03, DATA-11).
  reason: z.string().max(REASON_MAX).optional(),
});

const updateRoleSchema = z.object({
  displayName: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
  hierarchyLevel: z.number().int().min(1).max(10).optional(),
  permissions: z.array(z.string()).optional(),
  color: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
  // REQUIRED when the permission set changes — see update() (DATA-11).
  reason: z.string().max(REASON_MAX).optional(),
});

/** Same permission SET, order ignored. */
function samePermissions(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((p) => s.has(p));
}

// ---------------------------------------------------------------------------
// Permission metadata — labels and categories for each PERMISSIONS key
// ---------------------------------------------------------------------------

const PERMISSION_META: Record<string, { label: string; category: string }> = {
  // User management
  [PERMISSIONS.USER_CREATE]: { label: 'Create Users', category: 'User Management' },
  [PERMISSIONS.USER_READ]: { label: 'View Users', category: 'User Management' },
  [PERMISSIONS.USER_UPDATE]: { label: 'Update Users', category: 'User Management' },
  [PERMISSIONS.USER_DELETE]: { label: 'Delete Users', category: 'User Management' },
  [PERMISSIONS.USER_ENABLE_DISABLE]: { label: 'Enable/Disable Users', category: 'User Management' },
  [PERMISSIONS.USER_UNLOCK]: { label: 'Unlock Users', category: 'User Management' },
  [PERMISSIONS.USER_RESET_PASSWORD]: { label: 'Reset Passwords', category: 'User Management' },
  // Configuration
  [PERMISSIONS.CONFIG_READ]: { label: 'View Configuration', category: 'Configuration' },
  [PERMISSIONS.CONFIG_UPDATE]: { label: 'Update Configuration', category: 'Configuration' },
  [PERMISSIONS.FIELD_ID_UPDATE]: { label: 'Update Field Labels', category: 'Configuration' },
  [PERMISSIONS.ROLE_MANAGE]: { label: 'Manage Roles', category: 'Configuration' },
  [PERMISSIONS.BACKUP_MANAGE]: { label: 'Manage Backups', category: 'Configuration' },
  [PERMISSIONS.BACKUP_RESTORE]: { label: 'Restore Backups', category: 'Configuration' },
  // Audit
  [PERMISSIONS.AUDIT_READ]: { label: 'View Audit Trail', category: 'Audit' },
  [PERMISSIONS.AUDIT_EXPORT]: { label: 'Export Audit Trail', category: 'Audit' },
  [PERMISSIONS.AUDIT_DELETE]: { label: 'Delete Audit Record (permanent)', category: 'Audit' },
  // Notifications
  [PERMISSIONS.NOTIFICATION_VIEW]: { label: 'View Notifications', category: 'Notifications' },
  [PERMISSIONS.NOTIFICATION_CREATE]: { label: 'Create Notifications', category: 'Notifications' },
  [PERMISSIONS.NOTIFICATION_UPDATE]: { label: 'Update Notifications', category: 'Notifications' },
  [PERMISSIONS.NOTIFICATION_DELETE]: { label: 'Delete Notifications', category: 'Notifications' },
  [PERMISSIONS.NOTIFICATION_MANAGE]: { label: 'Manage Notifications', category: 'Notifications' },
  // Dashboards
  [PERMISSIONS.DASHBOARD_CREATE]: { label: 'Create Dashboards', category: 'Dashboards' },
  [PERMISSIONS.DASHBOARD_MANAGE]: { label: 'Manage Dashboards', category: 'Dashboards' },
  [PERMISSIONS.DASHBOARD_VIEW]: { label: 'View Dashboards', category: 'Dashboards' },
  [PERMISSIONS.DASHBOARD_ASSIGN]: { label: 'Assign Dashboards', category: 'Dashboards' },
  // Debug
  [PERMISSIONS.READ_DEBUG_TRACE]: { label: 'View Debug Traces', category: 'Debug' },
  [PERMISSIONS.MANAGE_DEBUG_TRACE]: { label: 'Manage Debug Traces', category: 'Debug' },
  // Version history + admin-request review
  [PERMISSIONS.ADMIN_REQUEST_APPROVE]: { label: 'Approve Admin Requests', category: 'User Management' },
  [PERMISSIONS.ADMIN_REQUEST_REJECT]: { label: 'Reject Admin Requests', category: 'User Management' },
};

// Derive ALL_PERMISSIONS from the shared PERMISSIONS constant (single source of truth)
const ALL_PERMISSIONS = Object.values(PERMISSIONS).map(key => ({
  key,
  label: PERMISSION_META[key]?.label ?? key,
  category: PERMISSION_META[key]?.category ?? 'Other',
}));

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

// Only a SUPER_ADMIN caller may see the SUPER_ADMIN role in any role list /
// dropdown / matrix. Every other caller (and anonymous callers on the public
// /active endpoint) gets it filtered out — SUPER_ADMIN is invisible to lower
// roles across the whole app (mirrors the Users-page hiding in user.service).
function hideSuperAdminFor<T extends { name: string }>(rows: T[], callerRole?: string): T[] {
  return callerRole === 'SUPER_ADMIN' ? rows : rows.filter((r) => r.name !== 'SUPER_ADMIN');
}

export const roleService = {
  /** List all roles ordered by hierarchy level. SUPER_ADMIN hidden from non-SA callers. */
  async listAll(callerRole?: string) {
    return hideSuperAdminFor(await roleRepository.findAll(), callerRole);
  },

  /** List only active roles (minimal fields for dropdowns). SUPER_ADMIN hidden from non-SA callers. */
  async listActive(callerRole?: string) {
    return hideSuperAdminFor(await roleRepository.findActive(), callerRole);
  },

  /** Get a single role by name. Throws NotFoundError if missing. */
  async getByName(name: string) {
    const role = await roleRepository.findByName(name);
    if (!role) {
      throw new NotFoundError('Role not found');
    }
    return role;
  },

  /** Create a new role. Validates input, checks uniqueness, audits. */
  async create(data: unknown, ctx: RequestContext) {
    const parsed = createRoleSchema.safeParse(data);
    if (!parsed.success) {
      throw new ValidationError('VALIDATION_ERROR', parsed.error.flatten());
    }

    // Check if role name already exists
    const existing = await roleRepository.findByName(parsed.data.name);
    if (existing) {
      throw new ConflictError('Role name already exists');
    }

    await assertRoleWithinCallerPrivilege(ctx, { hierarchyLevel: parsed.data.hierarchyLevel, permissions: parsed.data.permissions });
    await assertBelowSuperAdmin(parsed.data.hierarchyLevel, parsed.data.name);

    // The row and its audit row commit together (audit 2026-10-03, API-7).
    const role = await prisma.$transaction(async (tx) => {
      const created = await roleRepository.create({
        name: parsed.data.name,
        displayName: parsed.data.displayName,
        description: parsed.data.description,
        hierarchyLevel: parsed.data.hierarchyLevel,
        permissions: parsed.data.permissions,
        color: parsed.data.color,
        createdBy: ctx.userId,
      }, tx);

      await auditLog({
        userId: ctx.userId,
        userRole: ctx.userRole,
        action: 'ROLE_CREATED',
        targetType: 'role',
        targetId: created.name,
        afterValue: created,
        reason: parsed.data.reason?.trim() || undefined,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        sessionId: ctx.sessionId,
      }, tx);
      return created;
    });

    return { success: true, data: role };
  },

  /** Update an existing role. System roles have restricted updates. */
  async update(name: string, data: unknown, ctx: RequestContext) {
    const parsed = updateRoleSchema.safeParse(data);
    if (!parsed.success) {
      throw new ValidationError('VALIDATION_ERROR', parsed.error.flatten());
    }

    const existing = await roleRepository.findByName(name);
    if (!existing) {
      throw new NotFoundError('Role not found');
    }

    await assertRoleWithinCallerPrivilege(
      ctx,
      { hierarchyLevel: parsed.data.hierarchyLevel, permissions: parsed.data.permissions },
      { name: existing.name, hierarchyLevel: (existing as any).hierarchyLevel, permissions: ((existing as any).permissions as string[]) ?? [] },
    );
    // Only a CHANGE of level is checked, so a legacy row already above the
    // ceiling can still have its label edited (the Roles page echoes the level).
    if (parsed.data.hierarchyLevel !== existing.hierarchyLevel) {
      await assertBelowSuperAdmin(parsed.data.hierarchyLevel, existing.name);
    }

    const { reason: rawReason, ...fields } = parsed.data;
    const existingPerms = ((existing as any).permissions as string[]) ?? [];

    // A CHANGE to the permission set needs the operator's reason (audit
    // 2026-10-03, DATA-11). A change, not a mention: the Roles page sends the
    // whole form on every save, so a display-name edit carries the unchanged
    // permission list — demanding a reason for that would demand one for
    // nothing. The reason is stored on the ROLE_UPDATED row.
    const permissionsChange = fields.permissions !== undefined && !samePermissions(fields.permissions, existingPerms);
    const reason = permissionsChange
      ? requireReason(rawReason, "Changing a role's permissions")
      : (rawReason?.trim() || undefined);

    // System roles can only have permissions, color, displayName, and
    // description updated. A request to CHANGE one of the other two is refused
    // loudly (audit 2026-10-03, API-15): it used to be dropped on the floor
    // with `success: true`, so an administrator "switching off" ADMIN was told
    // it had worked. Echoing the stored value back is not a change and passes
    // — the Roles page sends `hierarchyLevel` on every save.
    if (existing.isSystem) {
      const refused: string[] = [];
      if (fields.hierarchyLevel !== undefined && fields.hierarchyLevel !== existing.hierarchyLevel) refused.push('hierarchyLevel');
      if (fields.isActive !== undefined && fields.isActive !== existing.isActive) refused.push('isActive');
      if (refused.length > 0) {
        throw new ValidationError(
          `${refused.join(' and ')} cannot be changed on the system role ${existing.name}`,
          { fieldErrors: Object.fromEntries(refused.map((f) => [f, ['Cannot be changed on a system role']])) },
        );
      }
      delete fields.hierarchyLevel;
      delete fields.isActive;
    }

    const deactivating = fields.isActive === false && existing.isActive === true;

    let endedSessionIds: string[] = [];
    const role = await prisma.$transaction(async (tx) => {
      const updated = await roleRepository.update(name, {
        ...fields,
        updatedBy: ctx.userId,
      }, tx);

      // Deactivating a role revokes access NOW (API-15): every live session of
      // a user holding it is ended in the same transaction, and the rbac
      // plugin answers [] permissions for an inactive role. Until then the
      // flag changed nothing — every request still authorised.
      let sessionsEnded = 0;
      if (deactivating) {
        const ended = await roleRepository.terminateSessionsForRole(name, 'role_deactivated', tx);
        sessionsEnded = ended.count;
        endedSessionIds = ended.sessionIds;
      }

      await auditLog({
        userId: ctx.userId,
        userRole: ctx.userRole,
        action: 'ROLE_UPDATED',
        targetType: 'role',
        targetId: updated.name,
        beforeValue: existing,
        afterValue: deactivating ? { ...updated, sessionsTerminated: sessionsEnded } : updated,
        reason,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        sessionId: ctx.sessionId,
      }, tx);
      return updated;
    });

    if (deactivating) {
      // The auth plugin caches sessions (by session id) and users (by user id)
      // for 30 s, and the two caches are evicted separately — a session ended
      // in the database keeps answering until its cache entry goes. Both are
      // dropped here, after commit, so the next request from any holder is
      // refused at once.
      for (const id of endedSessionIds) invalidateSessionAuthCache(id);
      const holders = await prisma.user.findMany({ where: { role: name }, select: { id: true } });
      for (const u of holders) invalidateUserAuthCache(u.id);
    }

    return { success: true, data: role };
  },

  /** Delete a role. The "no assigned users" check runs inside the delete's transaction. */
  async delete(name: string, ctx: RequestContext, rawReason?: string) {
    const existing = await roleRepository.findByName(name);
    if (!existing) {
      throw new NotFoundError('Role not found');
    }
    const reason = rawReason?.trim() || undefined;

    // Count, delete and audit row in ONE transaction (API-7, API-20): the
    // repository counts immediately before the delete and throws
    // ROLE_HAS_USERS (409) — which rolls the whole thing back.
    await prisma.$transaction(async (tx) => {
      await roleRepository.delete(name, tx);
      await auditLog({
        userId: ctx.userId,
        userRole: ctx.userRole,
        action: 'ROLE_DELETED',
        targetType: 'role',
        targetId: name,
        beforeValue: {
          name: existing.name,
          displayName: existing.displayName,
          hierarchyLevel: existing.hierarchyLevel,
          permissions: existing.permissions,
        },
        afterValue: { deleted: true },
        reason,
        signatureMeaning: `Custom role "${existing.displayName}" permanently deleted`,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        sessionId: ctx.sessionId,
      }, tx);
    });

    return { success: true };
  },

  /** Return the static list of all available permissions. */
  async getAllPermissions() {
    return { permissions: ALL_PERMISSIONS };
  },

  /** Get roles that a given role is allowed to create/assign. */
  async getCreatableRoles(name: string) {
    const currentRole = await roleRepository.findByName(name);
    if (!currentRole) {
      throw new NotFoundError('Role not found');
    }
    const isSuperAdmin = name === 'SUPER_ADMIN';
    return roleRepository.findCreatableRoles(currentRole.hierarchyLevel, isSuperAdmin);
  },
};
