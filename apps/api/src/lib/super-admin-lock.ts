/**
 * super-admin-lock.ts — the "Super Admin API access" kill-switch.
 *
 * A single global flag (system_config key `super-admin-api-access`,
 * value `{ enabled: boolean }`). When `enabled` is FALSE, the auth plugin
 * freezes every request made by a SUPER_ADMIN user to a tiny allowlist
 * (login + stay-logged-in + change-password + logout + the toggle itself).
 * Regular ADMIN users are never affected — enforcement keys on the caller's
 * role, not on which endpoint is hit.
 *
 * Safety posture: **fail-OPEN**. A missing row, a malformed value, or a DB
 * error all resolve to `enabled = true`. The switch only engages when there is
 * an explicit `{ enabled: false }` row. This guarantees an infra blip can never
 * lock the SUPER_ADMIN out of his own platform; the lock is only ever a
 * deliberate choice that someone with the password made.
 *
 * Caching: `isSuperAdminApiEnabled()` is called on every authenticated
 * SUPER_ADMIN request, so it caches the flag in-process with a short TTL and is
 * invalidated immediately on write (so a flip takes effect on the very next
 * request, not after the TTL).
 */
import { prisma } from './prisma.js';

export const SUPER_ADMIN_API_CONFIG_KEY = 'super-admin-api-access';

const CACHE_TTL_MS = 5_000;
let cache: { enabled: boolean; at: number } | null = null;

function parseEnabled(configValue: unknown): boolean {
  // Default ON: only an explicit boolean `false` disables.
  if (configValue && typeof configValue === 'object' && 'enabled' in configValue) {
    const v = (configValue as { enabled: unknown }).enabled;
    if (typeof v === 'boolean') return v;
  }
  return true;
}

/** Uncached read straight from the DB. Used by the read endpoint so the UI
 *  always reflects the true persisted state. Fail-open on any error. */
export async function readSuperAdminApiEnabledUncached(): Promise<boolean> {
  try {
    const row = await prisma.systemConfig.findUnique({
      where: { configKey: SUPER_ADMIN_API_CONFIG_KEY },
    });
    return row ? parseEnabled(row.configValue) : true;
  } catch {
    return true; // fail-open — never brick the SA on a DB hiccup
  }
}

/** Cached read used by the per-request auth gate. */
export async function isSuperAdminApiEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.enabled;
  const enabled = await readSuperAdminApiEnabledUncached();
  cache = { enabled, at: now };
  return enabled;
}

export function invalidateSuperAdminApiCache(): void {
  cache = null;
}

/** Persist the flag and bust the cache so the change is effective immediately. */
export async function setSuperAdminApiEnabled(enabled: boolean, updatedBy: string): Promise<void> {
  await prisma.systemConfig.upsert({
    where: { configKey: SUPER_ADMIN_API_CONFIG_KEY },
    create: {
      configKey: SUPER_ADMIN_API_CONFIG_KEY,
      configValue: { enabled },
      configType: 'security',
      requiresReauth: true,
      updatedBy,
    },
    update: { configValue: { enabled }, updatedBy, updatedAt: new Date() },
  });
  invalidateSuperAdminApiCache();
}
