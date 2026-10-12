/**
 * May a caller hand out this instrument scope? (application review
 * 2026-10-12, follow-up 3.)
 *
 * A ROLE_MANAGE holder whose own visibility is restricted could give a role or
 * a user below it a scope WIDER than its own — "all instruments", or a Block it
 * cannot see — and so grant access it does not hold, the scope equivalent of
 * granting a permission you lack (`assertRoleWithinCallerPrivilege`). The rule:
 * what a non-SUPER_ADMIN grants must be contained in what it can see.
 *
 * Containment is judged on the GRANT, not on today's instrument list, because a
 * location grant is live — an instrument commissioned into it tomorrow is
 * covered too:
 *
 *  - unrestricted (`null`) is within only an unrestricted caller;
 *  - a LOCATION is within when every location it expands to (a Block covers
 *    its Areas) is one the caller's locations expand to;
 *  - an INSTRUMENT is within when the caller names it, or it sits in a
 *    location the caller covers. An id that is not an instrument is refused —
 *    it grants nothing today and nothing it might mean can be checked.
 *
 * Pure: the caller loads the tree and the instruments' locations. The expansion
 * is `expandScope` — the SAME one visibility uses — so "covered" here and
 * "visible" at request time cannot disagree.
 */
import { expandScope, type InstrumentScope, type ScopeNode } from '../instruments/visibility.js';

export interface ScopeWithinResult {
  ok: boolean;
  /** What is outside the caller's own scope, for the 403 message. */
  outside: { all?: true; locationIds: string[]; instrumentIds: string[] };
}

export function scopeWithin(
  proposed: InstrumentScope,
  caller: InstrumentScope,
  nodes: ScopeNode[],
  /** Each proposed instrument id → its functional location (null = unplaced). Absent = no such instrument. */
  instrumentLocation: Map<string, string | null>,
): ScopeWithinResult {
  if (caller === null) return { ok: true, outside: { locationIds: [], instrumentIds: [] } };
  if (proposed === null) return { ok: false, outside: { all: true, locationIds: [], instrumentIds: [] } };

  const covered = new Set(expandScope(caller.locationIds, nodes));
  const named = new Set(caller.instrumentIds);

  const locationIds = proposed.locationIds.filter(
    (id) => !expandScope([id], nodes).every((x) => covered.has(x)),
  );
  const instrumentIds = proposed.instrumentIds.filter((id) => {
    if (named.has(id)) return false;
    if (!instrumentLocation.has(id)) return true;
    const loc = instrumentLocation.get(id);
    return !(loc && covered.has(loc));
  });
  return { ok: locationIds.length === 0 && instrumentIds.length === 0, outside: { locationIds, instrumentIds } };
}
