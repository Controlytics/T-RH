/**
 * Config-card access predicate (extracted from config/index.tsx so it is unit-testable).
 *
 * DEFAULT-DENY (Phase 2, gap S1): a config module the caller's role is NOT granted in
 * the access-matrix is HIDDEN. Previously this was fail-OPEN — an unconfigured module
 * was visible to every role that reached /config, so a newly-added config card leaked
 * to all roles until someone restricted it. Now access must be explicitly granted.
 *
 * SUPER_ADMIN always passes. A card with no moduleKey (malformed/href-less) passes —
 * that is a rendering fallback, not a security surface.
 *
 * NOTE: this only governs CARD VISIBILITY in the config index. It is not the security
 * boundary — each config endpoint is independently permission-gated server-side.
 */
export interface ConfigAccessOpts {
  isSuperAdmin: boolean;
  role?: string;
  /** { [moduleKey]: roleNames[] } from /api/config/access-matrix. */
  accessMatrix?: Record<string, string[]>;
}

export function canAccessConfigModule(
  moduleKey: string | undefined,
  opts: ConfigAccessOpts,
): boolean {
  if (!moduleKey) return true;
  if (opts.isSuperAdmin) return true;
  const assigned = opts.accessMatrix?.[moduleKey];
  if (!assigned) return false; // default-DENY (was: allow-unless-EXPLICIT_GRANT)
  return opts.role ? assigned.includes(opts.role) : false;
}
