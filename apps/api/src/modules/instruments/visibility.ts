import { prisma } from '../../lib/prisma.js';
import { resolveLocationIds } from '../functional-locations/tree.js';
import type { FlType } from '../functional-locations/validation.js';

/**
 * Which instruments a role or user may see: by functional location, by explicit
 * instrument, or both.
 *
 * Design: docs/superpowers/specs/2026-08-13-instrument-visibility-design.md
 * Extended 2026-08-28 to carry explicit instrument ids alongside the locations.
 *
 * The resolution rules live here as PURE functions because they carry the whole
 * risk of the feature: a scope that silently resolves to "everything" is an access
 * failure that looks exactly like working software.
 */

/**
 * A live scope. BOTH arrays empty means SEES NOTHING — never everything. That
 * asymmetry is deliberate and matches `alarm-webhooks/target-scope.ts`: a surface
 * that shows too little is a bug someone reports; one that shows too much is a
 * §11 access failure nobody notices.
 */
export interface ScopeSelection {
  /** Functional locations. A granted Block expands to its Areas. */
  locationIds: string[];
  /** Instruments named outright, whatever location they are in — or none at all. */
  instrumentIds: string[];
}

/** null = unrestricted. Otherwise: this selection, which may be empty = sees nothing. */
export type InstrumentScope = null | ScopeSelection;

/** The Prisma fragment a live scope compiles to. Both branches always present. */
export interface ScopeWhere {
  OR: [{ functionalLocationId: { in: string[] } }, { id: { in: string[] } }];
}

export interface ScopeNode {
  id: string;
  name: string;
  type: FlType;
  parentId: string | null;
}

export const SUPER_ADMIN = 'SUPER_ADMIN';

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Read the `instrument_scope` JSON column into a scope, or `undefined` for "nothing
 * stored here".
 *
 * THE COLUMN HOLDS TWO SHAPES and always will. Rows written before 2026-08-28 are a
 * bare `string[]` of functional-location ids; rows written since are
 * `{locationIds, instrumentIds}`. Legacy rows are deliberately NOT migrated — a
 * rewrite of every access-control row is a bigger risk than a reader that accepts
 * both — so this function is the only thing standing between an old row and being
 * read as "no scope", which means UNRESTRICTED.
 *
 * That is also why there must be exactly ONE of these. Before this existed there
 * were two independent `Array.isArray(v)` readers (here and in the admin GET), and
 * either one left behind would have reported a restricted user as unrestricted.
 *
 * Absent OR malformed both return `undefined` = INHERIT, not deny. A corrupted JSON
 * value must not silently blind a user: that is an outage presenting as a permission
 * change, and much harder to diagnose than seeing too much.
 */
export function normalizeScope(v: unknown): ScopeSelection | undefined {
  if (v === null || v === undefined) return undefined;
  // Legacy: a bare array IS the location list. `[]` stays a deny, not an absence.
  if (Array.isArray(v)) return { locationIds: strings(v), instrumentIds: [] };
  if (typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const hasLocations = Array.isArray(o.locationIds);
  const hasInstruments = Array.isArray(o.instrumentIds);
  if (!hasLocations && !hasInstruments) return undefined;
  return { locationIds: strings(o.locationIds), instrumentIds: strings(o.instrumentIds) };
}

/**
 * Pick the effective scope from the role's and the user's.
 *
 * NULL vs an empty selection is the whole point and is a DELIBERATE deviation from
 * `config.service.getMyConfig`, which decides whether a user config wins by testing
 * `sidebarItems.length > 0`. Scope has three states, not two:
 *
 *   null                       inherit (role, then unrestricted)
 *   {loc: [], inst: []}        SEE NOTHING — a real instruction someone may have meant
 *   {loc/inst populated}       see these locations and/or these instruments
 *
 * A "is anything selected" test would let the empty selection fall through to the
 * role scope, turning "this user sees no instruments" into a grant. That is the
 * wrong direction to fail in.
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
 * A UNION, not an intersection: an instrument is visible if it sits in a granted
 * location OR if it was named outright. Same shape as an alarm webhook target's
 * scope, deliberately — there is no fourth grouping concept here.
 *
 * BOTH BRANCHES ARE ALWAYS EMITTED, even when empty. `{ OR: [] }` matches NOTHING in
 * Prisma while `{}` matches EVERYTHING, and a "tidy up the empty branch" refactor is
 * one step from the second. Two always-present `in` lists make both accidents
 * unreachable: an empty selection compiles to two impossible branches, which is
 * exactly "sees nothing".
 *
 * Instruments with NO functional location remain invisible to the LOCATION branch —
 * `IN (...)` never matches NULL, and an instrument nobody has placed is in nobody's
 * location grant. **The instrument branch overrides that (changed 2026-08-28):**
 * naming an instrument by id grants it even before it has been placed, because
 * assigning a freshly commissioned device must not silently do nothing.
 */
export function scopeToWhere(scope: InstrumentScope, nodes: ScopeNode[]): ScopeWhere | undefined {
  if (scope === null) return undefined;
  return {
    OR: [
      { functionalLocationId: { in: expandScope(scope.locationIds, nodes) } },
      { id: { in: scope.instrumentIds } },
    ],
  };
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
): Promise<{ scope: InstrumentScope; where: ScopeWhere | undefined }> {
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

  const scope = effectiveScope(
    ctx.userRole,
    normalizeScope(roleCfg?.instrumentScope),
    normalizeScope(userCfg?.instrumentScope),
  );
  if (scope === null) return { scope: null, where: undefined };

  // Only the location half needs the tree; an instrument-only scope still pays for
  // this read. Left as-is rather than made conditional: the branch would be a second
  // path through the one function that decides what a user may see.
  const rows = await prisma.functionalLocation.findMany({
    select: { id: true, name: true, type: true, parentId: true },
  });
  const nodes: ScopeNode[] = rows.map((r) => ({ ...r, type: r.type as FlType }));
  return { scope, where: scopeToWhere(scope, nodes) };
}

/** Merge a visibility filter into an existing `where`, preserving both. */
export function withVisibility<T extends object>(
  where: T | undefined,
  visibility: ScopeWhere | undefined,
): object | undefined {
  if (!visibility) return where;
  if (!where) return visibility;
  // AND, never spread: a spread would let a same-named key silently replace the
  // visibility filter and widen the result. It also keeps the scope's own OR
  // bracketed — a spread would drop a sibling `OR` key from `where` on the floor.
  return { AND: [where, visibility] };
}
