import { describe, it, expect } from 'vitest';
import { effectiveScope, expandScope, scopeToWhere, type ScopeNode } from '../visibility.js';

const nodes: ScopeNode[] = [
  { id: 'cwh', name: 'CWH', type: 'BLOCK', parentId: null },
  { id: 'me', name: 'Module-E', type: 'AREA', parentId: 'cwh' },
  { id: 'mf', name: 'Module-F', type: 'AREA', parentId: 'cwh' },
  { id: 'bc', name: 'Block C', type: 'BLOCK', parentId: null },
];

describe('effectiveScope', () => {
  it('gives SUPER_ADMIN everything, whatever is stored', () => {
    expect(effectiveScope('SUPER_ADMIN', [], [])).toBeNull();
    expect(effectiveScope('SUPER_ADMIN', ['cwh'], ['bc'])).toBeNull();
  });

  it('is unrestricted when neither scope is set', () => {
    expect(effectiveScope('OPERATOR', null, null)).toBeNull();
    expect(effectiveScope('OPERATOR', undefined, undefined)).toBeNull();
  });

  it('inherits the role scope when the user has none', () => {
    expect(effectiveScope('OPERATOR', ['cwh'], null)).toEqual(['cwh']);
  });

  it('lets the user scope REPLACE the role scope', () => {
    // "same role, different users, different instruments" — the requirement.
    expect(effectiveScope('OPERATOR', ['cwh'], ['bc'])).toEqual(['bc']);
  });

  it('lets a user override WIDEN beyond the role, and that is intended', () => {
    // Documented consequence of replace-not-intersect. If this ever needs to be
    // impossible, effectiveScope is the single place to change.
    expect(effectiveScope('OPERATOR', ['bc'], ['cwh', 'bc'])).toEqual(['cwh', 'bc']);
  });

  it('treats an EMPTY user scope as "sees nothing", NOT as "inherit"', () => {
    // The core rule. A `length > 0` test here would fall through to the role and
    // silently turn a deny into a grant.
    expect(effectiveScope('OPERATOR', ['cwh'], [])).toEqual([]);
  });

  it('treats an EMPTY role scope as "sees nothing" too', () => {
    expect(effectiveScope('OPERATOR', [], null)).toEqual([]);
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

  it('filters to the expanded location set', () => {
    const w = scopeToWhere(['cwh'], nodes)!;
    expect(w.functionalLocationId.in.sort()).toEqual(['cwh', 'me', 'mf']);
  });

  it('an empty scope yields an IN () that matches nothing, not undefined', () => {
    // undefined would mean "no filter" — i.e. see everything — which is the exact
    // inversion of what an empty scope asks for.
    const w = scopeToWhere([], nodes)!;
    expect(w).toBeDefined();
    expect(w.functionalLocationId.in).toEqual([]);
  });

  it('excludes unassigned instruments whenever a scope is active', () => {
    // `IN (...)` never matches NULL, so an instrument with no functional location is
    // invisible to any scoped role — the operator's explicit choice.
    const w = scopeToWhere(['cwh'], nodes)!;
    expect(w.functionalLocationId.in).not.toContain(null);
    expect(Object.keys(w)).toEqual(['functionalLocationId']);
  });
});
