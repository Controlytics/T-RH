import type { RequestContext } from '../../types/context.js';
import { auditLog } from '../../lib/audit.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { configRepository } from './config.repository.js';
import { getActionReauthConfig, invalidateReauthCache, isReauthRequired } from '../../lib/reauth-check.js';
import { getDefaultTemplates, FEATURE_TO_PERMISSION_MAP, FEATURE_PRIVILEGES, SIDEBAR_PRIVILEGE_MAP } from '@digilog/shared';
import { validateUserId } from '../../lib/user-id-validator.js';
import { prisma } from '../../lib/prisma.js';
import { invalidateRolePermsCache } from '../../plugins/rbac.js';
import { invalidatePasswordPolicyCache } from '../../plugins/auth.js';
import { sanitizeAuditValue } from '../../lib/audit-diff.js';
import { configRegistry } from '../../lib/config-registry.js';

/** Drop top-level keys named in `secretKeys` from a config value (for audit snapshots). */
export function redactConfigSecrets(value: any, secretKeys: Set<string>): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (!secretKeys.has(k)) out[k] = v;
  return out;
}

/**
 * Reverse-map a role's permission constants to feature privilege booleans.
 * Used to populate the Role Privileges page when role_configs has no data.
 */
function reverseMapPermissions(rolePermissions: string[]): Record<string, boolean> {
  const featurePerms: Record<string, boolean> = {};
  for (const feature of FEATURE_PRIVILEGES) {
    const requiredPerms = FEATURE_TO_PERMISSION_MAP[feature.id];
    if (requiredPerms) {
      // Feature is enabled if ANY of its mapped permissions exist in the role
      featurePerms[feature.id] = requiredPerms.some(p => rolePermissions.includes(p));
    }
  }
  return featurePerms;
}

/**
 * The PRIMARY (first-listed) permission(s) for a sidebar item — the minimal
 * grant that makes the item visible in the sidebar AND its page usable at a
 * baseline level. Backs the "link sidebar ↔ permissions" behaviour (2026-06-15):
 * enabling a menu for a role auto-grants this so the admin no longer has to
 * separately hand-grant the matching feature permission in the Permissions tab.
 * Returns [] for items with no privilege requirement (e.g. dashboard,
 * system-health) — those are always visible regardless of permissions.
 */
function primaryPermsForSidebarItem(sidebarId: string): string[] {
  // 2026-06-30: admin-requests has NO view-only/primary perm — its only perms are the ACTION
  // perms (ADMIN_REQUEST_APPROVE / ADMIN_REQUEST_REJECT). Auto-granting an action perm on
  // menu-enable would make it un-revokable (the "unselect doesn't take effect" bug). So
  // admin-requests opts OUT of sidebar auto-grant; APPROVE/REJECT are granted explicitly per role.
  if (sidebarId === 'admin-requests') return [];
  const section = SIDEBAR_PRIVILEGE_MAP.find(s => s.sidebarId === sidebarId);
  if (!section || section.privilegeIds.length === 0) return [];
  return FEATURE_TO_PERMISSION_MAP[section.privilegeIds[0]] ?? [];
}

export const configService = {
  async getConfig(key: string, schema: any, def?: { defaults?: any }) {
    const config = await configRepository.getSystemConfig(key);
    const parsed = schema.safeParse(config?.configValue ?? {});
    if (!parsed.success) {
      console.warn(`[Config] Validation failed for ${key}, using defaults`);
      // #low-batch: a corrupt stored value (bad manual edit / older restore /
      // schema tightening) must fall back to the SCHEMA's own defaults, not `{}`.
      // `def` is never actually passed by any caller, so the old `?? {}` meant a
      // bad `password-policy` returned {} → minLength/requireUppercase undefined
      // → password rules silently disabled (fail-OPEN). Re-parse {} to fill the
      // schema's `.default()`s (mirrors getNextUserId below).
      if (def?.defaults) return def.defaults;
      const fallback = schema.safeParse({});
      return fallback.success ? fallback.data : {};
    }
    return parsed.data;
  },

  async updateConfig(key: string, data: any, schema: any, configType: string, requiresReauth: boolean, ctx: RequestContext) {
    // Security fix 2026-05-25: strip the reauth password and any other
    // underscore-prefixed transport fields before validating + persisting.
    // api-client.withReauth() injects `_currentPassword` into the body so
    // the server-side enforceReauth() can verify it. Pre-fix that field
    // survived the schema parse (configs use additionalProperties: true)
    // and got persisted into system_config.config_value as plaintext — a
    // /api/config/cleaning-profile-assignment GET as any CONFIG_READ user
    // would then echo the SUPER_ADMIN's password back. Found in the
    // 5/25 cleaning-profile-assignment update audit.
    const sanitized: Record<string, any> = {};
    if (data && typeof data === 'object') {
      for (const k of Object.keys(data)) {
        if (k.startsWith('_')) continue; // transport-only field
        sanitized[k] = (data as any)[k];
      }
    }
    // Merge incoming fields over the EXISTING config before validating, so a
    // PARTIAL save (a config tab sending only its own fields) preserves the
    // rest. Without this, the Zod schema fills every unsent field with its
    // DEFAULT — e.g. a `{companyName}` branding save would reset logo/theme.
    // Only merge when both sides are plain objects; array-shaped configs are
    // full replacements.
    const existing = await configRepository.getSystemConfig(key);
    const beforeValue = existing?.configValue;
    const isPlainObject = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
    const toValidate = isPlainObject(beforeValue) && isPlainObject(sanitized)
      ? { ...beforeValue, ...sanitized }
      : sanitized;
    const parsed = schema.safeParse(toValidate);
    if (!parsed.success) throw new ValidationError('VALIDATION_ERROR', parsed.error.flatten());

    await configRepository.upsertSystemConfig(key, parsed.data, configType, requiresReauth, ctx.userId);

    // Bust the auth-plugin's policy cache so new passwordExpiryDays takes
    // effect on the next request instead of after up to 60s of TTL lag.
    if (key === 'password-policy') invalidatePasswordPolicyCache();

    const secretKeys = new Set(
      (configRegistry.get(key)?.settings ?? [])
        .filter((s) => s.type === 'secret')
        .map((s) => s.key),
    );
    const auditBefore = sanitizeAuditValue(redactConfigSecrets(beforeValue, secretKeys));
    const auditAfter = sanitizeAuditValue(redactConfigSecrets(parsed.data, secretKeys));

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CONFIG_CHANGED',
      targetType: 'config', targetId: key,
      beforeValue: auditBefore as any, afterValue: auditAfter,
      signatureMeaning: `System configuration modified: ${key}`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return parsed.data;
  },

  // Role Configuration
  async listRoleConfigs() {
    return configRepository.findAllRoleConfigs();
  },

  async getRoleConfig(role: string) {
    const config = await configRepository.findRoleConfig(role);
    const permissions = (config?.permissions as Record<string, boolean>) ?? {};

    // If role_configs has no feature privileges, reverse-map from roles.permissions
    const hasFeaturePerms = Object.keys(permissions).length > 0;
    if (!hasFeaturePerms) {
      const roleRecord = await prisma.role.findUnique({ where: { name: role }, select: { permissions: true } });
      const rolePerms = (roleRecord?.permissions as string[]) ?? [];
      if (rolePerms.length > 0) {
        const mapped = reverseMapPermissions(rolePerms);
        return {
          role,
          sidebarItems: (config?.sidebarItems as string[]) ?? [],
          homeWidgets: (config?.homeWidgets as string[]) ?? [],
          permissions: mapped,
        };
      }
    }

    return config ?? { role, sidebarItems: [], homeWidgets: [], permissions: {} };
  },

  async updateRoleConfig(role: string, data: { sidebarItems?: string[]; homeWidgets?: string[]; permissions?: Record<string, boolean> }, ctx: RequestContext) {
    const existing = await configRepository.findRoleConfig(role);
    const beforeValue = existing ? { sidebarItems: existing.sidebarItems, homeWidgets: existing.homeWidgets, permissions: existing.permissions } : null;

    const config = await configRepository.upsertRoleConfig(role, data, existing, ctx.userId);

    // Sync feature privileges + sidebar selections to the role's permissions
    // array. Runs whenever EITHER tab saves so the two stay linked (2026-06-15,
    // user request): enabling a sidebar item for a role now also grants that
    // item's PRIMARY permission, so the menu actually appears without separately
    // hand-granting the matching feature permission. Two sources feed the rebuild:
    //   (1) Feature-privilege toggles (Permissions tab) — granular.
    //   (2) Enabled sidebar items (Sidebar tab) — each grants its primary perm.
    // Permissions NOT covered by any feature toggle are preserved (manual grants).
    if (data.permissions || data.sidebarItems) {
      const allMappedPerms = new Set<string>();
      for (const perms of Object.values(FEATURE_TO_PERMISSION_MAP)) {
        for (const p of perms) allMappedPerms.add(p);
      }

      const currentRole = await prisma.role.findFirst({ where: { name: role }, select: { permissions: true } });
      const currentPerms = (currentRole?.permissions as string[]) || [];

      // Primary permissions implied by the role's effective sidebar selection
      // (the just-saved list, or the existing one on a permissions-only save).
      const effectiveSidebar = (data.sidebarItems ?? (existing?.sidebarItems as string[] | undefined) ?? []);
      const sidebarPerms = effectiveSidebar.flatMap(primaryPermsForSidebarItem);

      let permissionSet: Set<string>;
      if (data.permissions) {
        // Permissions tab save → full rebuild from the toggle map, preserving
        // non-feature perms, then re-add sidebar-implied perms so a permissions
        // save can't strip access the Sidebar tab granted.
        permissionSet = new Set<string>(currentPerms.filter(p => !allMappedPerms.has(p)));
        for (const [featureId, enabled] of Object.entries(data.permissions)) {
          if (enabled && FEATURE_TO_PERMISSION_MAP[featureId]) {
            for (const perm of FEATURE_TO_PERMISSION_MAP[featureId]) permissionSet.add(perm);
          }
        }
      } else {
        // Sidebar-only save → additive. Keep every current permission and just
        // grant the primary perms for the enabled items. (Disabling a menu hides
        // it via the sidebar allow-list; it does NOT revoke the permission, so a
        // sidebar edit can never silently strip access granted elsewhere.)
        permissionSet = new Set<string>(currentPerms);
      }
      for (const perm of sidebarPerms) permissionSet.add(perm);

      const permissionsArray = Array.from(permissionSet);
      await prisma.role.updateMany({
        where: { name: role },
        data: { permissions: permissionsArray },
      });
      // Audit 2026-05-04 fix (api-supporting M11): rbac plugin caches role
      // permissions for 5s; invalidate so the new config takes effect on the
      // very next request rather than waiting up to 5s.
      invalidateRolePermsCache(role);
    }

    // Link the Quality Notifications (QNN) report. Unlike the other reports it
    // has NO feature permission — visibility is governed by its own config
    // `qnn-notifications.visibleRoles`, which ALSO gates the backend QNN data
    // route (canSeeQnn). So granting a permission can't reveal it; the role must
    // be in that list. When a Sidebar save enables the QNN report for a role,
    // add the role to visibleRoles so the report (and its data) are reachable —
    // matching the sidebar↔permission link for every other report. Additive:
    // disabling the menu hides it via the allow-list but does not remove the
    // role here (mirrors the no-revoke permission behaviour above).
    if (data.sidebarItems !== undefined && role !== 'SUPER_ADMIN') {
      const effectiveSidebar = data.sidebarItems ?? [];
      if (effectiveSidebar.includes('quality-notifications')) {
        const row = await configRepository.getSystemConfig('qnn-notifications');
        const val = (row?.configValue as Record<string, unknown> | null) ?? {};
        const roles = Array.isArray(val.visibleRoles) ? (val.visibleRoles as string[]) : ['ADMIN'];
        if (!roles.includes(role)) {
          await configRepository.upsertSystemConfig(
            'qnn-notifications',
            { ...val, visibleRoles: [...roles, role] },
            (row?.configType as string) ?? 'notification',
            row?.requiresReauth ?? false,
            ctx.userId,
          );
        }
      }
    }

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CONFIG_CHANGED',
      targetType: 'role_config', targetId: role,
      beforeValue: beforeValue as any,
      afterValue: { sidebarItems: config.sidebarItems, homeWidgets: config.homeWidgets, permissions: config.permissions },
      signatureMeaning: `Role configuration updated for ${role}`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return config;
  },

  // User Configuration
  async getUserConfig(userId: string) {
    const config = await configRepository.findUserConfig(userId);
    return config ?? { userId, sidebarItems: [], homeWidgets: [], permissions: {} };
  },

  async updateUserConfig(userId: string, data: { sidebarItems?: string[]; homeWidgets?: string[]; permissions?: Record<string, boolean> }, ctx: RequestContext) {
    const existing = await configRepository.findUserConfig(userId);
    const beforeValue = existing ? { sidebarItems: existing.sidebarItems, homeWidgets: existing.homeWidgets, permissions: existing.permissions } : null;

    const config = await configRepository.upsertUserConfig(userId, data, existing, ctx.userId);

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CONFIG_CHANGED',
      targetType: 'user_config', targetId: userId,
      beforeValue: beforeValue as any,
      afterValue: { sidebarItems: config.sidebarItems, homeWidgets: config.homeWidgets, permissions: config.permissions },
      signatureMeaning: `User-specific configuration updated for ${userId}`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return config;
  },

  async getMyConfig(username: string) {
    const user = await configRepository.findUserByUsername(username);
    if (!user) return { sidebarItems: [], homeWidgets: [], permissions: {} };

    const userConfig = await configRepository.findUserConfig(user.id);
    if (userConfig && ((userConfig.sidebarItems as any[]).length > 0 || Object.keys(userConfig.permissions as any).length > 0)) {
      return userConfig;
    }

    const roleConfig = await configRepository.findRoleConfig(user.role);
    return roleConfig ?? { sidebarItems: [], homeWidgets: [], permissions: {} };
  },

  // Field IDs
  async listFieldIds() {
    return configRepository.findAllFieldIds();
  },

  async updateFieldId(fieldId: string, displayName: string, ctx: RequestContext) {
    if (!displayName || displayName.trim().length === 0) throw new ValidationError('displayName is required');

    const field = await configRepository.findFieldId(fieldId);
    if (!field) throw new NotFoundError('Field ID not found');

    const beforeValue = { displayName: field.displayName };
    await configRepository.updateFieldId(fieldId, displayName, ctx.userId);

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CONFIG_CHANGED',
      targetType: 'field_id_config', targetId: fieldId,
      beforeValue, afterValue: { displayName: displayName.trim() },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
  },

  // Action Reauth
  async getActionReauth() {
    return getActionReauthConfig();
  },

  async updateActionReauth(data: any, schema: any, ctx: RequestContext) {
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new ValidationError('VALIDATION_ERROR', parsed.error.flatten());

    const existing = await configRepository.getSystemConfig('action-reauth');
    const beforeValue = existing?.configValue;

    await configRepository.upsertSystemConfig('action-reauth', parsed.data, 'security', false, ctx.userId);
    invalidateReauthCache();

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CONFIG_CHANGED',
      targetType: 'config', targetId: 'action-reauth',
      beforeValue: beforeValue as any, afterValue: parsed.data,
      signatureMeaning: 'Action re-authentication configuration modified',
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return parsed.data;
  },

  async checkReauth(action: string, role: string) {
    const needed = await isReauthRequired(action, role);
    return { action, required: needed };
  },

  async getMyActions(role: string) {
    const config = await getActionReauthConfig();
    const actions: string[] = [];
    for (const [action, roles] of Object.entries(config)) {
      if (roles.includes(role)) actions.push(action);
    }
    return { actions };
  },

  // Audit Templates
  async getAuditTemplates() {
    const defaults = getDefaultTemplates();
    const config = await configRepository.getSystemConfig('audit-templates');
    const saved = (config?.configValue ?? {}) as Record<string, string>;
    return { ...defaults, ...saved };
  },

  async updateAuditTemplates(data: any, schema: any, ctx: RequestContext) {
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new ValidationError('VALIDATION_ERROR', parsed.error.flatten());

    const existing = await configRepository.getSystemConfig('audit-templates');
    const beforeValue = existing?.configValue;

    await configRepository.upsertSystemConfig('audit-templates', parsed.data, 'display', false, ctx.userId);

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CONFIG_CHANGED',
      targetType: 'config', targetId: 'audit-templates',
      beforeValue: beforeValue as any, afterValue: parsed.data,
      signatureMeaning: 'Audit text templates configuration modified',
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return parsed.data;
  },

  // User ID
  async getNextUserId(schema: any) {
    const config = await configRepository.getSystemConfig('user-id');
    const settings = schema.safeParse(config?.configValue ?? {});
    const cfg = settings.success ? settings.data : schema.parse({});

    if (!cfg.autoGenerate) return { autoGenerate: false, nextId: null };

    const prefix = cfg.prefix + cfg.prefixSeparator;
    let maxNum = cfg.startNumber - 1;

    if (cfg.prefix) {
      const result = await configRepository.getMaxUserIdNum(prefix);
      if (result[0]?.max_num && result[0].max_num > maxNum) maxNum = result[0].max_num;
    } else {
      const result = await configRepository.getMaxUserIdNumAll();
      if (result[0]?.max_num && result[0].max_num > maxNum) maxNum = result[0].max_num;
    }

    const nextNum = maxNum + 1;
    const numStr = String(nextNum).padStart(cfg.length - (cfg.prefix?.length ?? 0) - (cfg.prefixSeparator?.length ?? 0), '0');
    const nextId = cfg.prefix ? `${cfg.prefix}${cfg.prefixSeparator}${numStr}` : numStr;

    return { autoGenerate: true, nextId };
  },

  async validateUserId(userId: string) {
    if (!userId) throw new ValidationError('User ID is required');
    const result = await validateUserId(userId);
    return result.valid ? { valid: true } : { valid: false, errors: result.errors };
  },

};
