import { describe, it, expect } from 'vitest';
import { resolveNav, ALL_INSTRUMENTS, type NavNode } from '../location-nav';

const tree: NavNode[] = [
  {
    id: 'cwh', name: 'CWH', type: 'BLOCK', ownCount: 1, totalCount: 4,
    children: [
      { id: 'me', name: 'Module-E', type: 'AREA', ownCount: 3, totalCount: 3, children: [] },
      { id: 'mf', name: 'Module-F', type: 'AREA', ownCount: 0, totalCount: 0, children: [] },
    ],
  },
  { id: 'bc', name: 'Block C', type: 'BLOCK', ownCount: 0, totalCount: 1,
    children: [{ id: 'sc', name: 'Sterile Core', type: 'AREA', ownCount: 1, totalCount: 1, children: [] }] },
];

describe('resolveNav — level 0', () => {
  it('offers All Instruments plus one card per Block', () => {
    const nav = resolveNav(null, tree);
    expect(nav.level).toBe(0);
    expect(nav.cards.map((c) => c.id)).toEqual([ALL_INSTRUMENTS, 'cwh', 'bc']);
    expect(nav.showViews).toBe(false);
  });

  it('labels each Block with its ROLLED-UP count, not just its own', () => {
    // CWH holds 1 directly and 3 in Module-E. A card reading "1" would understate
    // the Block and make the drill-down look pointless.
    const cwh = resolveNav(null, tree).cards.find((c) => c.id === 'cwh')!;
    expect(cwh.count).toBe(4);
  });

  it('uses the SUPPLIED total for All Instruments, not the tree sum', () => {
    // Regression: summing the tree counts only PLACED instruments. With 20
    // registered and 5 placed, the card read 5 while its own view showed 20.
    const card = resolveNav(null, tree, 20).cards.find((c) => c.id === ALL_INSTRUMENTS)!;
    expect(card.count).toBe(20);
  });

  it('falls back to the tree sum when no total is supplied', () => {
    expect(resolveNav(null, tree).cards.find((c) => c.id === ALL_INSTRUMENTS)!.count).toBe(5);
  });

  it('has an empty breadcrumb at the top level', () => {
    expect(resolveNav(null, tree).breadcrumb).toEqual([]);
  });
});

describe('resolveNav — All Instruments', () => {
  it('goes straight to the views with no cards and no location filter', () => {
    const nav = resolveNav(ALL_INSTRUMENTS, tree);
    expect(nav.showViews).toBe(true);
    expect(nav.cards).toEqual([]);
    // undefined, NOT the sentinel string — the sentinel must never reach the API.
    expect(nav.functionalLocationId).toBeUndefined();
  });
});

describe('resolveNav — a Block', () => {
  it('lists the Block’s Areas', () => {
    const nav = resolveNav('cwh', tree);
    expect(nav.level).toBe(1);
    expect(nav.cards.map((c) => c.id)).toEqual(['cwh:direct', 'me', 'mf']);
  });

  it('adds a “direct” card only when the Block has its own instruments', () => {
    // CWH pins IOTGW_01 to itself, so those instruments need a way in.
    expect(resolveNav('cwh', tree).cards.some((c) => c.id === 'cwh:direct')).toBe(true);
    // Block C pins none — offering an empty view would be a dead end.
    expect(resolveNav('bc', tree).cards.some((c) => c.id === 'bc:direct')).toBe(false);
  });

  it('shows the views as well as the cards, scoped to the whole Block', () => {
    // Clicking a Block must answer "how is this Block doing?" immediately, not
    // force a second click into an Area first.
    const nav = resolveNav('cwh', tree);
    expect(nav.showViews).toBe(true);
    expect(nav.functionalLocationId).toBe('cwh');
  });

  it('breadcrumbs back to the top', () => {
    expect(resolveNav('cwh', tree).breadcrumb.map((b) => b.label)).toEqual(['Dashboard', 'CWH']);
  });
});

describe('resolveNav — an Area', () => {
  it('shows only the views, scoped to the Area', () => {
    const nav = resolveNav('me', tree);
    expect(nav.level).toBe(2);
    expect(nav.cards).toEqual([]);
    expect(nav.showViews).toBe(true);
    expect(nav.functionalLocationId).toBe('me');
  });

  it('breadcrumbs through its Block', () => {
    expect(resolveNav('me', tree).breadcrumb.map((b) => b.label)).toEqual(['Dashboard', 'CWH', 'Module-E']);
  });
});

describe('resolveNav — a Block’s direct-only view', () => {
  it('scopes to the Block id but records that it is the direct view', () => {
    const nav = resolveNav('cwh:direct', tree);
    expect(nav.showViews).toBe(true);
    expect(nav.functionalLocationId).toBe('cwh');
    expect(nav.directOnly).toBe(true);
    expect(nav.breadcrumb.map((b) => b.label)).toEqual(['Dashboard', 'CWH', 'Directly linked']);
  });
});

describe('resolveNav — bad input', () => {
  it('falls back to level 0 for an unknown id rather than rendering nothing', () => {
    // A stale bookmark or a deleted location must land somewhere usable.
    const nav = resolveNav('does-not-exist', tree);
    expect(nav.level).toBe(0);
    expect(nav.cards.map((c) => c.id)).toEqual([ALL_INSTRUMENTS, 'cwh', 'bc']);
    expect(nav.showViews).toBe(false);
  });

  it('handles an empty tree without throwing', () => {
    const nav = resolveNav(null, []);
    expect(nav.cards.map((c) => c.id)).toEqual([ALL_INSTRUMENTS]);
  });
});
