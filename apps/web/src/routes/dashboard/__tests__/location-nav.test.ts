import { describe, it, expect } from 'vitest';
import { resolveNav, trailFor, ALL_INSTRUMENTS, type NavNode } from '../location-nav';

// activeCount is carried alongside totalCount everywhere; the fixtures give a
// MIX of active and inactive so a card that silently reported "all active"
// would fail rather than look plausible.
const tree: NavNode[] = [
  {
    id: 'cwh', name: 'CWH', type: 'BLOCK', ownCount: 1, totalCount: 4, activeCount: 3,
    children: [
      { id: 'me', name: 'Module-E', type: 'AREA', ownCount: 3, totalCount: 3, activeCount: 2, children: [] },
      { id: 'mf', name: 'Module-F', type: 'AREA', ownCount: 0, totalCount: 0, activeCount: 0, children: [] },
    ],
  },
  { id: 'bc', name: 'Block C', type: 'BLOCK', ownCount: 0, totalCount: 1, activeCount: 1,
    children: [{ id: 'sc', name: 'Sterile Core', type: 'AREA', ownCount: 1, totalCount: 1, activeCount: 1, children: [] }] },
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

  // CHANGED 2026-08-29 (operator's call). This asserted showViews === true, on
  // the reasoning that clicking a Block should answer "how is this Block
  // doing?" without a second click. In practice the panel grid — telemetry
  // table, floor view, charts — buried the Area cards, so the one thing the
  // click was for became the hardest thing to find. A Block is now a chooser.
  it('shows ONLY cards at Block level, no panels', () => {
    const nav = resolveNav('cwh', tree);
    expect(nav.showViews).toBe(false);
    expect(nav.cards.length).toBeGreaterThan(0);
    // Still scoped, so the level below inherits the right filter.
    expect(nav.functionalLocationId).toBe('cwh');
  });

  // The panels are not gone — an Area still shows them, which is where you go
  // to look at readings.
  it('still shows the panels for an Area', () => {
    expect(resolveNav('me', tree).showViews).toBe(true);
  });

  it('carries the active split onto the cards', () => {
    const nav = resolveNav(null, tree);
    const cwh = nav.cards.find((c) => c.id === 'cwh');
    expect(cwh?.count).toBe(4);
    expect(cwh?.activeCount).toBe(3);
  });

  it('prefers the supplied totals over the tree sum for All Instruments', () => {
    // The tree only sums PLACED instruments, so an unplaced one would be
    // missing from both halves and the split would not add up to the headline.
    const nav = resolveNav(null, tree, 20, 12);
    const all = nav.cards.find((c) => c.id === ALL_INSTRUMENTS);
    expect(all?.count).toBe(20);
    expect(all?.activeCount).toBe(12);
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

/**
 * 2026-10-03: the trail the dashboard hands the trend page (see
 * trend-breadcrumbs.ts). Each crumb of `nav.breadcrumb` becomes a link back
 * to THAT selection — `/?fl=<id>`, or `/` for the root — so the trend page
 * can return the reader to All Instruments, or a Block's Area, not merely
 * to the top of the dashboard.
 */
describe('trailFor', () => {
  it('maps the breadcrumb to dashboard URLs, the root to /', () => {
    expect(trailFor([{ label: 'Dashboard', id: null }, { label: 'All Instruments', id: '__all__' }]))
      .toEqual([{ label: 'Dashboard', to: '/' }, { label: 'All Instruments', to: '/?fl=__all__' }]);
  });

  it('URL-encodes an id and carries a directly-linked suffix as it is', () => {
    expect(trailFor([{ label: 'CWH', id: 'b 1' }, { label: 'Directly linked', id: 'b-1:direct' }]))
      .toEqual([{ label: 'CWH', to: '/?fl=b+1' }, { label: 'Directly linked', to: '/?fl=b-1%3Adirect' }]);
  });

  it('is empty at the top level, where there is no selection to return to', () => {
    expect(trailFor([])).toEqual([]);
  });
});
