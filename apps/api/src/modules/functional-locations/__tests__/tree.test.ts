import { describe, it, expect } from 'vitest';
import { resolveLocationIds, buildCoveringIndex, buildTree, locationPath, type FlNode } from '../tree.js';

const all: FlNode[] = [
  { id: 'cwh', name: 'CWH', type: 'BLOCK', parentId: null },
  { id: 'me', name: 'Module-E', type: 'AREA', parentId: 'cwh' },
  { id: 'mf', name: 'Module-F', type: 'AREA', parentId: 'cwh' },
  { id: 'bc', name: 'Block C', type: 'BLOCK', parentId: null },
];

describe('resolveLocationIds', () => {
  it('returns a Block plus all its Areas', () => {
    // THE bug this feature is most likely to ship: a Block view showing only the
    // instruments linked directly to the Block and silently omitting its Areas'.
    expect(resolveLocationIds('cwh', all).sort()).toEqual(['cwh', 'me', 'mf']);
  });

  it('returns only itself for an Area', () => {
    expect(resolveLocationIds('me', all)).toEqual(['me']);
  });

  it('returns only itself for a Block with no Areas', () => {
    expect(resolveLocationIds('bc', all)).toEqual(['bc']);
  });

  it('returns an empty list for an unknown id, rather than everything', () => {
    // An unknown id must not degrade to "no filter" — that would silently show
    // every instrument to a caller who asked for one location.
    expect(resolveLocationIds('nope', all)).toEqual([]);
  });
});

/**
 * `counts` is now {total, active} per location, not a bare number. The helper
 * keeps the fixtures readable and forces each case to SAY what its active
 * split is — a default of "all active" would have hidden the rollup bug this
 * suite exists to catch.
 */
const c = (total: number, active: number = total) => ({ total, active });

describe('buildTree', () => {
  it('nests Areas under their Block, sorted by name', () => {
    const tree = buildTree(all, new Map([['cwh', c(1, 1)], ['me', c(3, 2)], ['mf', c(0, 0)]]));
    expect(tree.map((n) => n.id)).toEqual(['bc', 'cwh']);
    expect(tree.find((n) => n.id === 'cwh')!.children.map((c) => c.id)).toEqual(['me', 'mf']);
  });

  it('rolls counts up: a Block total is its own plus its Areas', () => {
    const cwh = buildTree(all, new Map([['cwh', c(1, 1)], ['me', c(3, 2)], ['mf', c(0, 0)]])).find((n) => n.id === 'cwh')!;
    expect(cwh.ownCount).toBe(1);
    expect(cwh.totalCount).toBe(4);
    // Active rolls up the same way and from the same children: 1 own + 2 in
    // Module-E + 0 in Module-F. If these two ever came from different
    // populations a card would show "4 instruments, 5 active".
    expect(cwh.activeCount).toBe(3);
  });

  it('gives a location with no counts zero, not undefined', () => {
    const bc = buildTree(all, new Map()).find((n) => n.id === 'bc')!;
    expect(bc.ownCount).toBe(0);
    expect(bc.totalCount).toBe(0);
    expect(bc.activeCount).toBe(0);
  });

  it('drops an Area whose parent is missing rather than losing it silently at the top level', () => {
    // An orphan cannot happen while the FK is RESTRICT, but rendering it as a
    // top-level Block would misrepresent the tree.
    const orphaned: FlNode[] = [...all, { id: 'x', name: 'Ghost', type: 'AREA', parentId: 'gone' }];
    const tree = buildTree(orphaned, new Map());
    expect(tree.map((n) => n.id)).toEqual(['bc', 'cwh']);
  });
});

describe('locationPath', () => {
  it('renders an Area as "Block > Area"', () => {
    expect(locationPath('me', all)).toBe('CWH > Module-E');
  });

  it('renders a Block as just its name', () => {
    expect(locationPath('cwh', all)).toBe('CWH');
  });

  it('returns null for no location and for an unknown one', () => {
    expect(locationPath(null, all)).toBeNull();
    expect(locationPath('nope', all)).toBeNull();
  });
});

describe('buildCoveringIndex', () => {
  it('maps an Area to itself AND its Block', () => {
    // The point of the whole index: selecting the Block covers the Area's
    // instruments, so the scope editor must show them as already included.
    expect([...buildCoveringIndex(all).get('me')!].sort()).toEqual(['cwh', 'me']);
  });

  it('maps a Block to itself only', () => {
    expect(buildCoveringIndex(all).get('cwh')).toEqual(['cwh']);
    expect(buildCoveringIndex(all).get('bc')).toEqual(['bc']);
  });

  it('agrees with resolveLocationIds in both directions', () => {
    // The invariant that makes this safe to ship to a client: L covers X if and
    // only if resolveLocationIds(L) contains X. Written as a property rather than
    // as examples, so a future change to the depth cap breaks it here first.
    const index = buildCoveringIndex(all);
    for (const location of all) {
      for (const covered of resolveLocationIds(location.id, all)) {
        expect(index.get(covered)).toContain(location.id);
      }
    }
    for (const [covered, locations] of index) {
      for (const locationId of locations) {
        expect(resolveLocationIds(locationId, all)).toContain(covered);
      }
    }
  });

  it('has no entry for a location that does not exist', () => {
    expect(buildCoveringIndex(all).get('nope')).toBeUndefined();
  });

  it('is empty for an empty tree', () => {
    expect(buildCoveringIndex([]).size).toBe(0);
  });
});
