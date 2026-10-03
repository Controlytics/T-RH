/**
 * Which cards, breadcrumb and scope the dashboard should render for a selection.
 *
 * Pure on purpose: the navigation shape is the part of the drill-down that can
 * actually be tested, and getting it wrong is invisible — a Block that quietly
 * lists no Areas looks like a Block with no Areas.
 */

export type NavType = 'BLOCK' | 'AREA';

export interface NavNode {
  id: string;
  name: string;
  type: NavType;
  /** Instruments linked directly to this node. */
  ownCount: number;
  /** This node's instruments plus every descendant's. */
  totalCount: number;
  /** Of totalCount, how many are active. Inactive is derived, never sent. */
  activeCount: number;
  children: NavNode[];
}

/**
 * Sentinel for the "everything" card. Deliberately not a real id and deliberately
 * never sent to the API — `functionalLocationId` is left undefined for it, because
 * the API would resolve an unknown id to NO rows and the page would look broken.
 */
export const ALL_INSTRUMENTS = '__all__';

/** Suffix marking a Block's own directly-linked instruments. */
const DIRECT = ':direct';

export interface NavCard {
  id: string;
  label: string;
  sublabel: string;
  count: number;
  /**
   * Of `count`, how many are active. Optional because the "directly linked"
   * card is built from a Block's own instruments, where the split is not
   * rolled up separately — a card without it simply shows no breakdown rather
   * than showing a wrong one.
   */
  activeCount?: number;
}

export interface NavCrumb {
  label: string;
  /** null = the top level. */
  id: string | null;
}

export interface Nav {
  level: 0 | 1 | 2;
  cards: NavCard[];
  breadcrumb: NavCrumb[];
  showViews: boolean;
  /** Passed to the API. Undefined means unscoped. */
  functionalLocationId?: string;
  /** True for a Block's "directly linked" view. */
  directOnly: boolean;
}

const flatten = (tree: NavNode[]): NavNode[] => tree.flatMap((b) => [b, ...b.children]);

/**
 * The dashboard's breadcrumb as LINKS, for a page the reader leaves it for —
 * the trend page (2026-10-03, operator: "when i click on its not going to all
 * instruments page its going to instruments page"). A crumb's `id` is the
 * `?fl=` value that selects it (the same param `go()` sets), the root is `/`.
 * Encoded by `URLSearchParams`, as the dashboard encodes it, so following the
 * link lands on byte-for-byte the URL the reader left.
 */
export function trailFor(breadcrumb: readonly NavCrumb[]): { label: string; to: string }[] {
  return breadcrumb.map((c) => ({
    label: c.label,
    to: c.id === null ? '/' : `/?${new URLSearchParams({ fl: c.id })}`,
  }));
}

/**
 * @param totalInstruments every registered instrument, INCLUDING those in no
 *   location. Must be supplied: summing the tree counts only placed instruments, so
 *   the "All Instruments" card would read 5 while its own view showed 20. Omitted,
 *   it falls back to the tree sum and is explicitly wrong for unplaced instruments.
 */
export function resolveNav(
  selected: string | null,
  tree: NavNode[],
  totalInstruments?: number,
  activeInstruments?: number,
): Nav {
  const topLevel = (): Nav => ({
    level: 0,
    cards: [
      {
        id: ALL_INSTRUMENTS,
        label: 'All Instruments',
        sublabel: 'Every registered instrument',
        count: totalInstruments ?? tree.reduce((sum, b) => sum + b.totalCount, 0),
        // Same reasoning as `count` above: the tree only sums PLACED
        // instruments, so an unplaced one would be missing from the split and
        // "active + inactive" would not equal the total on the same card.
        activeCount: activeInstruments ?? tree.reduce((sum, b) => sum + b.activeCount, 0),
      },
      ...tree.map((b) => ({
        id: b.id,
        label: b.name,
        sublabel: 'Block',
        // ROLLED-UP, not own: a card reading "1" for a Block holding 4 would
        // understate it and make the drill-down look pointless.
        count: b.totalCount,
        activeCount: b.activeCount,
      })),
    ],
    breadcrumb: [],
    showViews: false,
    directOnly: false,
  });

  if (!selected) return topLevel();

  if (selected === ALL_INSTRUMENTS) {
    return {
      level: 2,
      cards: [],
      breadcrumb: [{ label: 'Dashboard', id: null }, { label: 'All Instruments', id: ALL_INSTRUMENTS }],
      showViews: true,
      functionalLocationId: undefined,
      directOnly: false,
    };
  }

  const directOnly = selected.endsWith(DIRECT);
  const id = directOnly ? selected.slice(0, -DIRECT.length) : selected;
  const node = flatten(tree).find((n) => n.id === id);

  // Unknown id — a stale bookmark or a deleted location. Land somewhere usable
  // rather than rendering an empty page.
  if (!node) return topLevel();

  if (node.type === 'AREA') {
    const parent = tree.find((b) => b.children.some((c) => c.id === node.id));
    return {
      level: 2,
      cards: [],
      breadcrumb: [
        { label: 'Dashboard', id: null },
        ...(parent ? [{ label: parent.name, id: parent.id }] : []),
        { label: node.name, id: node.id },
      ],
      showViews: true,
      functionalLocationId: node.id,
      directOnly: false,
    };
  }

  // A BLOCK.
  if (directOnly) {
    return {
      level: 2,
      cards: [],
      breadcrumb: [
        { label: 'Dashboard', id: null },
        { label: node.name, id: node.id },
        { label: 'Directly linked', id: selected },
      ],
      showViews: true,
      functionalLocationId: node.id,
      directOnly: true,
    };
  }

  return {
    level: 1,
    cards: [
      // Only when the Block pins instruments to itself. Offering this card on a
      // Block with none would be a dead end.
      ...(node.ownCount > 0
        ? [{
            id: `${node.id}${DIRECT}`,
            label: `${node.name} — direct`,
            sublabel: 'Linked to the Block itself',
            count: node.ownCount,
          }]
        : []),
      ...node.children.map((a) => ({
        id: a.id,
        label: a.name,
        sublabel: 'Area',
        count: a.totalCount,
        activeCount: a.activeCount,
      })),
    ],
    breadcrumb: [{ label: 'Dashboard', id: null }, { label: node.name, id: node.id }],
    // CARDS ONLY at Block level (changed 2026-08-29, operator's call).
    //
    // This used to render the Area cards AND the whole panel grid — telemetry
    // table, floor view, trend charts — on the reasoning that clicking a Block
    // should answer "how is this Block doing?" without a second click. In
    // practice it buried the Areas under a screen of widgets, so the one thing
    // the click was for became the hardest thing to find.
    //
    // The panels are not gone: they still render for an AREA, and for the
    // Block's own directly-linked instruments via the "direct" card above.
    // A Block is now a chooser, and the level below it is where you look at
    // readings.
    showViews: false,
    functionalLocationId: node.id,
    directOnly: false,
  };
}
