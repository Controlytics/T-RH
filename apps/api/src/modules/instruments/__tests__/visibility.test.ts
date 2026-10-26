import { describe, it, expect } from 'vitest';
import { effectiveScope, expandScope, normalizeScope, placeableLocationIds, scopeToWhere, type ScopeNode } from '../visibility.js';

const nodes: ScopeNode[] = [
  { id: 'cwh', name: 'CWH', type: 'BLOCK', parentId: null },
  { id: 'me', name: 'Module-E', type: 'AREA', parentId: 'cwh' },
  { id: 'mf', name: 'Module-F', type: 'AREA', parentId: 'cwh' },
  { id: 'bc', name: 'Block C', type: 'BLOCK', parentId: null },
];

/** The stored shape, written longhand so the tests read like the JSON column. */
const sel = (locationIds: string[], instrumentIds: string[] = []) => ({ locationIds, instrumentIds });
const NONE = sel([], []);

describe('effectiveScope', () => {
  it('gives SUPER_ADMIN everything, whatever is stored', () => {
    expect(effectiveScope('SUPER_ADMIN', NONE, NONE)).toBeNull();
    expect(effectiveScope('SUPER_ADMIN', sel(['cwh']), sel(['bc']))).toBeNull();
  });

  it('is unrestricted when neither scope is set', () => {
    expect(effectiveScope('OPERATOR', null, null)).toBeNull();
    expect(effectiveScope('OPERATOR', undefined, undefined)).toBeNull();
  });

  it('inherits the role scope when the user has none', () => {
    expect(effectiveScope('OPERATOR', sel(['cwh']), null)).toEqual(sel(['cwh']));
  });

  it('lets the user scope REPLACE the role scope', () => {
    // "same role, different users, different instruments" — the requirement.
    expect(effectiveScope('OPERATOR', sel(['cwh']), sel(['bc']))).toEqual(sel(['bc']));
  });

  it('lets a user override WIDEN beyond the role, and that is intended', () => {
    // Documented consequence of replace-not-intersect. If this ever needs to be
    // impossible, effectiveScope is the single place to change.
    expect(effectiveScope('OPERATOR', sel(['bc']), sel(['cwh', 'bc']))).toEqual(sel(['cwh', 'bc']));
  });

  it('treats an EMPTY user scope as "sees nothing", NOT as "inherit"', () => {
    // The core rule. A `length > 0` test here would fall through to the role and
    // silently turn a deny into a grant.
    expect(effectiveScope('OPERATOR', sel(['cwh']), NONE)).toEqual(NONE);
  });

  it('treats an EMPTY role scope as "sees nothing" too', () => {
    expect(effectiveScope('OPERATOR', NONE, null)).toEqual(NONE);
  });

  it('an instrument-only scope is a real scope, not an absent one', () => {
    // No locations at all, one instrument. If this ever inherited instead, naming a
    // single instrument would silently grant the whole estate.
    expect(effectiveScope('OPERATOR', sel(['cwh']), sel([], ['i1']))).toEqual(sel([], ['i1']));
  });
});

/**
 * The column holds TWO shapes: rows written before 2026-08-28 are a bare array of
 * functional-location ids; rows written since are `{locationIds, instrumentIds}`.
 * Old rows are never rewritten, so this function is the only thing standing between
 * a legacy row and being read as "no scope stored" — which means UNRESTRICTED.
 */
describe('normalizeScope', () => {
  it('reads a legacy bare array as locations with no instruments', () => {
    expect(normalizeScope(['cwh', 'bc'])).toEqual(sel(['cwh', 'bc']));
  });

  it('reads a legacy EMPTY array as "sees nothing", not as absent', () => {
    // The single most dangerous case: `[]` is a deny. Returning undefined here would
    // turn every pre-existing "sees nothing" row into "sees everything".
    expect(normalizeScope([])).toEqual(NONE);
  });

  it('reads the new object shape', () => {
    expect(normalizeScope({ locationIds: ['cwh'], instrumentIds: ['i1'] })).toEqual(sel(['cwh'], ['i1']));
  });

  it('fills in a missing half of the object shape rather than rejecting it', () => {
    expect(normalizeScope({ locationIds: ['cwh'] })).toEqual(sel(['cwh']));
    expect(normalizeScope({ instrumentIds: ['i1'] })).toEqual(sel([], ['i1']));
  });

  it('drops non-string members instead of carrying them into a query', () => {
    expect(normalizeScope(['cwh', 7, null])).toEqual(sel(['cwh']));
    expect(normalizeScope({ locationIds: ['cwh'], instrumentIds: [{}] })).toEqual(sel(['cwh']));
  });

  it('treats absent and malformed alike as INHERIT, never as deny', () => {
    // Deliberate: a corrupted value must not blind a user. That is an outage
    // presenting as a permission change, and much harder to diagnose than seeing
    // too much.
    expect(normalizeScope(null)).toBeUndefined();
    expect(normalizeScope(undefined)).toBeUndefined();
    expect(normalizeScope('cwh')).toBeUndefined();
    expect(normalizeScope(42)).toBeUndefined();
    expect(normalizeScope({ nonsense: true })).toBeUndefined();
  });
});

describe('expandScope', () => {
  it('expands a granted Block to its Areas', () => {
    // Granting CWH and finding Module-E invisible would be the obvious bug.
    expect(expandScope(['cwh'], nodes).sort()).toEqual(['cwh', 'me', 'mf']);
  });

  it('leaves a granted Area as itself', () => {
    expect(expandScope(['me'], nodes)).toEqual(['me']);
  });

  it('de-duplicates when a Block and one of its Areas are both granted', () => {
    expect(expandScope(['cwh', 'me'], nodes).sort()).toEqual(['cwh', 'me', 'mf']);
  });

  it('contributes NOTHING for an id that no longer exists', () => {
    // A deleted location left in a saved scope must not act as a wildcard.
    expect(expandScope(['deleted-id'], nodes)).toEqual([]);
    expect(expandScope(['deleted-id', 'bc'], nodes)).toEqual(['bc']);
  });

  it('returns nothing for an empty scope', () => {
    expect(expandScope([], nodes)).toEqual([]);
  });
});

describe('scopeToWhere', () => {
  it('returns undefined — no filter — when unrestricted', () => {
    expect(scopeToWhere(null, nodes)).toBeUndefined();
  });

  it('matches the expanded location set OR the named instruments', () => {
    const w = scopeToWhere(sel(['cwh'], ['i1']), nodes)!;
    expect([...w.OR[0].functionalLocationId.in].sort()).toEqual(['cwh', 'me', 'mf']);
    expect(w.OR[1].id.in).toEqual(['i1']);
  });

  it('a legacy location-only scope produces the same location filter as before', () => {
    // Unchanged on the half that existed. The only difference is the extra
    // instrument branch, which is empty and therefore matches nothing.
    const w = scopeToWhere(normalizeScope(['cwh'])!, nodes)!;
    expect([...w.OR[0].functionalLocationId.in].sort()).toEqual(['cwh', 'me', 'mf']);
    expect(w.OR[1].id.in).toEqual([]);
  });

  it('an empty scope yields branches that match nothing, not undefined', () => {
    // undefined would mean "no filter" — i.e. see everything — which is the exact
    // inversion of what an empty scope asks for.
    const w = scopeToWhere(NONE, nodes)!;
    expect(w).toBeDefined();
    expect(w.OR[0].functionalLocationId.in).toEqual([]);
    expect(w.OR[1].id.in).toEqual([]);
  });

  it('NEVER emits an empty OR array', () => {
    // `{ OR: [] }` matches NOTHING in Prisma while `{}` matches EVERYTHING, and the
    // two are one refactor apart. Both branches are always present, so neither
    // accident is reachable from here.
    for (const scope of [NONE, sel(['cwh']), sel([], ['i1'])]) {
      expect(scopeToWhere(scope, nodes)!.OR.length).toBe(2);
    }
  });

  it('an explicitly named instrument is granted regardless of its location', () => {
    // Changed 2026-08-28. The location branch still excludes unplaced instruments —
    // `IN (...)` never matches NULL — but naming an instrument by id now grants it
    // even before anyone has placed it in a Block or Area. Assigning a freshly
    // commissioned device must not silently do nothing.
    const w = scopeToWhere(sel([], ['unplaced-1']), nodes)!;
    expect(w.OR[1]).toEqual({ id: { in: ['unplaced-1'] } });
    expect(Object.keys(w.OR[1])).toEqual(['id']);
  });

  it('the location branch alone still cannot reach an unplaced instrument', () => {
    const w = scopeToWhere(sel(['cwh']), nodes)!;
    expect(w.OR[0].functionalLocationId.in).not.toContain(null);
    expect(Object.keys(w.OR[0])).toEqual(['functionalLocationId']);
  });
});

describe('placeableLocationIds — where a new instrument stays visible to its creator', () => {
  it('is unrestricted (null) for an unrestricted scope', () => {
    expect(placeableLocationIds(null, nodes)).toBeNull();
  });

  it('expands a granted Block to its Areas, exactly as the visibility filter does', () => {
    expect(placeableLocationIds(sel(['cwh']), nodes)).toEqual(new Set(['cwh', 'me', 'mf']));
  });

  it('grants an Area alone, not its Block', () => {
    // An instrument placed directly in the Block would be outside a Module-E-only view.
    expect(placeableLocationIds(sel(['me']), nodes)).toEqual(new Set(['me']));
  });

  it('places NOWHERE for an instrument-only scope or an empty one', () => {
    // A brand-new instrument cannot already be in `instrumentIds`.
    expect(placeableLocationIds(sel([], ['i1']), nodes)).toEqual(new Set());
    expect(placeableLocationIds(NONE, nodes)).toEqual(new Set());
  });
});
