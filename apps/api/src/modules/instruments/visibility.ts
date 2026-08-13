import { prisma } from '../../lib/prisma.js';
import { resolveLocationIds } from '../functional-locations/tree.js';
import type { FlType } from '../functional-locations/validation.js';

/**
 * Which instruments a role or user may see, by functional location.
 *
 * Design: docs/superpowers/specs/2026-08-13-instrument-visibility-design.md
 *
 * The resolution rules live here as PURE functions because they carry the whole
 * risk of the feature: a scope that silently resolves to "everything" is an access
 * failure that looks exactly like working software.
 */

/** null = unrestricted. `[]` = sees nothing. Otherwise: these locations. */
export type InstrumentScope = null | string[];

export interface ScopeNode {
  id: string;
  name: string;
  type: FlType;
  parentId: string | null;
}

export const SUPER_ADMIN = 'SUPER_ADMIN';

/**
 * Pick the effective scope from the role's and the user's.
 *
 * NULL vs `[]` is the whole point and is a DELIBERATE deviation from
 * `config.service.getMyConfig`, which decides whether a user config wins by testing
 * `sidebarItems.length > 0`. Scope has three states, not two:
 *
 *   null   inherit (role, then unrestricted)
 *   []     SEE NOTHING — a real instruction someone may have meant
 *   [ids]  see these locations
 *
 * A `length > 0` test would let `[]` fall through to the role scope, turning "this
 * user sees no instruments" into a grant. That is the wrong direction to fail in.
 *
 * The user's scope REPLACES the role's rather than intersecting it, because the
 * requirement is "same role, different users, different instruments". It can
 * therefore WIDEN as well as narrow — which is why setting one is reauth-gated and
 * audited. Switching to intersect is a change to this function alone.
 */
export function effectiveScope(
  userRole: string,
  roleScope: InstrumentScope | undefined,
  userScope: InstrumentScope | undefined,
): InstrumentScope {
  if (userRole === SUPER_ADMIN) return null;
  if (userScope !== null && userScope !== undefined) return userScope;
  if (roleScope !== null && roleScope !== undefined) return roleScope;
  return null;
}

/**
 * Expand granted location ids to every id whose instruments they cover: a granted
 * BLOCK includes its AREAs.
 *
 * Uses the same `resolveLocationIds` the dashboard uses — granting `CWH` and finding
 * `Module-E` invisible is the obvious bug, and one implementation prevents it.
 *
 * An id that no longer exists contributes NOTHING. It must never be treated as a
 * wildcard: a deleted location in a saved scope would then quietly grant the estate.
 */
export function expandScope(scope: string[], nodes: ScopeNode[]): string[] {
  return [...new Set(scope.flatMap((id) => resolveLocationIds(id, nodes)))];
}

/**
 * The Prisma `where` fragment for an effective scope, or undefined when
 * unrestricted.
 *
 * Instruments with NO functional location are excluded whenever a scope is active —
 * an instrument nobody has placed is in nobody's grant. That is the operator's
 * explicit choice and the safe reading; `{ in: [...] }` gives it for free, since SQL
 * `IN` never matches NULL.
 */
export function scopeToWhere(
  scope: InstrumentScope,
  nodes: ScopeNode[],
): { functionalLocationId: { in: string[] } } | undefined {
  if (scope === null) return undefined;
  return { functionalLocationId: { in: expandScope(scope, nodes) } };
}

// ─── Request-time resolution ─────────────────────────────────────────────────

/**
 * The effective scope for the requesting user, resolved from user_configs then
 * role_configs, and the location tree needed to expand it.
 *
 * Kept beside the pure functions rather than in a route file so there is exactly one
 * answer to "what may this user see" — an endpoint that resolves it a second way is
 * how the two drift apart and one path leaks.
 */
export async function resolveVisibility(
  ctx: { userId: string; userRole: string },
): Promise<{ scope: InstrumentScope; where: ReturnType<typeof scopeToWhere> }> {
  if (ctx.userRole === SUPER_ADMIN) return { scope: null, where: undefined };

  // ctx.userId is the USERNAME (see lib/build-context.ts) while user_configs keys on
  // the user's uuid — resolve it rather than assuming they are the same thing.
  const user = await prisma.user.findUnique({
    where: { username: ctx.userId },
    select: { id: true },
  });
  const [userCfg, roleCfg] = await Promise.all([
    user
      ? prisma.userConfig.findUnique({ where: { userId: user.id }, select: { instrumentScope: true } })
      : Promise.resolve(null),
    prisma.roleConfig.findUnique({ where: { role: ctx.userRole }, select: { instrumentScope: true } }),
  ]);

  /**
   * Absent OR malformed both mean INHERIT, not deny. A corrupted JSON value must not
   * silently blind a user: that is an outage presenting as a permission change, which
   * is much harder to diagnose than seeing too much.
   */
  const asScope = (v: unknown): InstrumentScope | undefined => {
    if (v === null || v === undefined) return undefined;
    return Array.isArray(v) ? (v as string[]) : undefined;
  };

  const scope = effectiveScope(
    ctx.userRole,
    asScope(roleCfg?.instrumentScope),
    asScope(userCfg?.instrumentScope),
  );
  if (scope === null) return { scope: null, where: undefined };

  const rows = await prisma.functionalLocation.findMany({
    select: { id: true, name: true, type: true, parentId: true },
  });
  const nodes: ScopeNode[] = rows.map((r) => ({ ...r, type: r.type as FlType }));
  return { scope, where: scopeToWhere(scope, nodes) };
}

/** Merge a visibility filter into an existing `where`, preserving both. */
export function withVisibility<T extends object>(
  where: T | undefined,
  visibility: ReturnType<typeof scopeToWhere>,
): object | undefined {
  if (!visibility) return where;
  if (!where) return visibility;
  // AND, never spread: a spread would let a same-named key silently replace the
  // visibility filter and widen the result.
  return { AND: [where, visibility] };
}
