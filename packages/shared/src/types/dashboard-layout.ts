import { PANELS, isPanelKey } from './panels.js';
import { normalizePanelStyle, type PanelStyle } from './panel-style.js';

/**
 * Where each dashboard panel sits, and how big it is.
 *
 * Design: docs/superpowers/specs/2026-08-28-dashboard-layout-design.md
 *
 * **This is a PREFERENCE, not governance.** It never grants or withholds
 * anything: which panels exist is decided by `dashboard_cards` (per role and per
 * user, audited, reauth-gated), and this only says where the ones you may see are
 * drawn. A layout entry for a panel you may not see is ignored entirely.
 *
 * **TWO states, not the three `dashboard_cards` uses.** There, `[]` is a
 * deliberate "no panels" that must never be read as inherit. Here, an absent or
 * unreadable layout simply falls back — an empty layout is not a meaningful
 * instruction, and treating a corrupted value as "show nothing" would blank
 * someone's dashboard over a bad JSON write. Do not unify the two rules later:
 * they answer different questions.
 */

/**
 * Bumped only when the stored SHAPE changes.
 *
 * A layout carrying a version this code does not know is REJECTED rather than
 * interpreted — guessing at an unknown shape would scatter cards at random
 * positions, which looks like a bug in the dragging rather than in the data.
 */
export const LAYOUT_VERSION = 1;

/** The grid is 12 columns wide at the `lg` breakpoint. Only `lg` is ever stored. */
export const GRID_COLUMNS = 12;

export interface LayoutItem {
  /** The panel key. See types/panels.ts. */
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Optional per-card chrome: a palette tint and a custom heading.
   *
   * Carried HERE rather than in a column of its own, so a card's position and its
   * appearance save together, reset together, and follow the same not-audited
   * rule. They are one preference about one card.
   *
   * Optional, so every layout stored before this existed still reads — which is
   * why the version did not need bumping.
   */
  style?: PanelStyle;
}

export interface DashboardLayout {
  version: number;
  items: LayoutItem[];
}

/**
 * The shipped arrangement: everything full width and stacked, in catalogue order.
 *
 * Deliberately close to how the dashboard looked before it became rearrangeable.
 * A default that reorganised the page on upgrade would make an unfamiliar screen
 * the first thing every operator met, and they would have to undo it by hand
 * before they could work.
 */
export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = {
  version: LAYOUT_VERSION,
  items: [
    { i: 'telemetry_table', x: 0, y: 0, w: 12, h: 9 },
    // `dashboard_history` sat here at y:9, h:8 from 2026-09-05 to 2026-09-07,
    // when the Instrument History widget moved to its own page (`/data-report`);
    // the floorplan and the alarms moved back up rather than leaving an 8-row
    // hole — the same call as for `dashboard_trend` below.
    // The floorplan is the tallest by a distance, and deliberately so: it draws
    // rooms to scale, so a short card shrinks every room until the codes inside
    // them stop being readable. 16 rows is ~880px at the grid's 40px row and 16px
    // margin — enough for a floor plan to be a plan rather than a thumbnail.
    // Raised from 11 on 2026-08-28 after the first look at it.
    { i: 'telemetry_floorplan', x: 0, y: 9, w: 12, h: 16 },
    // `dashboard_trend` sat at y:25 until 2026-08-29 and was removed with the panel
    // itself; alarms moved up into the space rather than leaving a 9-row hole.
    { i: 'dashboard_alarms', x: 0, y: 25, w: 12, h: 6 },
  ],
};

/**
 * The panels that live ON THE DASHBOARD.
 *
 * The layout is a dashboard concern; the trend page's panels are assignable too
 * but are laid out by that page, not by this grid.
 */
const DASHBOARD_PANEL_KEYS = new Set(
  PANELS.filter((p) => p.page === 'dashboard').map((p) => p.key),
);

/**
 * Named widths and heights for the per-card size controls.
 *
 * Dragging the card's corner remains the primary way to size it; these exist so a
 * size can be set exactly, and so someone who finds dragging fiddly is not shut
 * out of the feature. The two must agree: a dragged card shows the matching named
 * value, or "Custom" when it sits between two of them — never a wrong name.
 *
 * Widths are fractions of the 12-column grid. Heights are grid rows; the labels
 * quote the approximate pixels because "9 rows" means nothing to the person
 * choosing, and the grid's row height is an implementation detail.
 */
export const PANEL_WIDTHS: readonly { w: number; label: string }[] = [
  { w: 3, label: 'Quarter' },
  { w: 4, label: 'Third' },
  { w: 6, label: 'Half' },
  { w: 8, label: 'Two thirds' },
  { w: 12, label: 'Full width' },
] as const;

export const PANEL_HEIGHTS: readonly { h: number; label: string }[] = [
  { h: 5, label: 'Short (~280px)' },
  { h: 9, label: 'Medium (~490px)' },
  { h: 13, label: 'Tall (~710px)' },
  { h: 16, label: 'Very tall (~880px)' },
  { h: 22, label: 'Huge (~1200px)' },
] as const;

/** The named width/height matching a card exactly, or null when it is in between. */
export function namedWidth(w: number): number | null {
  return PANEL_WIDTHS.some((x) => x.w === w) ? w : null;
}

export function namedHeight(h: number): number | null {
  return PANEL_HEIGHTS.some((x) => x.h === h) ? h : null;
}

/** Default size for a panel the default layout does not place — see appendMissing. */
const FALLBACK_SIZE = { w: 12, h: 8 };

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readItem(v: unknown): LayoutItem | null | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.i !== 'string') return undefined;
  if (!isFiniteNumber(o.x) || !isFiniteNumber(o.y) || !isFiniteNumber(o.w) || !isFiniteNumber(o.h)) {
    return undefined;
  }
  // A well-formed entry naming a panel that no longer exists is DROPPED (null),
  // which is different from the value being unreadable (undefined). The first is
  // ordinary catalogue evolution; the second means fall back to the default.
  if (!isPanelKey(o.i)) return null;
  // A bad STYLE is dropped rather than invalidating the item: the card then
  // renders in its default chrome, which is a cosmetic loss. Rejecting a whole
  // layout because one colour was unreadable would move someone's cards over a
  // styling mistake.
  const style = normalizePanelStyle(o.style);
  return { i: o.i, x: o.x, y: o.y, w: o.w, h: o.h, ...(style ? { style } : {}) };
}

/**
 * Read a stored `dashboard_layout`, or `undefined` when it cannot be trusted.
 *
 * `undefined` means "fall back", never "show nothing". A corrupted preference must
 * not be able to blank a dashboard — that is an outage presenting as a layout
 * change, which is far harder to diagnose than a layout that simply reverted.
 */
export function normalizeLayout(v: unknown): DashboardLayout | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (o.version !== LAYOUT_VERSION) return undefined;
  if (!Array.isArray(o.items)) return undefined;

  const items: LayoutItem[] = [];
  for (const raw of o.items) {
    const item = readItem(raw);
    if (item === undefined) return undefined;
    if (item !== null) items.push(item);
  }
  return { version: LAYOUT_VERSION, items };
}

/** The lowest occupied row, so an appended panel lands below everything placed. */
function bottomOf(items: LayoutItem[]): number {
  return items.reduce((max, it) => Math.max(max, it.y + it.h), 0);
}

/**
 * Everything visible gets a position: the stored one where there is one, appended
 * below otherwise.
 *
 * Appending rather than dropping is what makes a newly granted panel APPEAR. If a
 * panel could be granted and then not shown because no layout mentioned it, the
 * grant would look like it had failed and the admin would go looking in the wrong
 * place.
 */
/**
 * Panels the viewer may see that a STORED layout does not place — a panel added
 * to the product after the layout was saved.
 *
 * Each lands where the SHIPPED layout puts it relative to its neighbours: under
 * the panel that precedes it in `DEFAULT_DASHBOARD_LAYOUT`, with everything from
 * that row down shifted to make room. Until 2026-09-05 a new panel was appended
 * at the bottom, which put the history widget — asked for "below the readings
 * table" — under the floorplan and the alarms on every layout that had ever
 * been saved. When the predecessor is not on the layout (hidden from this
 * viewer, or the panel is first in the shipped order), the bottom is the only
 * honest answer and is still where it goes.
 */
function appendMissing(items: LayoutItem[], visiblePanels: string[]): LayoutItem[] {
  let out = [...items];
  const defaults = DEFAULT_DASHBOARD_LAYOUT.items;
  for (const key of visiblePanels) {
    if (out.some((it) => it.i === key)) continue;
    const size = defaults.find((d) => d.i === key) ?? FALLBACK_SIZE;
    const order = defaults.findIndex((d) => d.i === key);
    const predecessor = order > 0 ? out.find((it) => it.i === defaults[order - 1].i) : undefined;
    if (predecessor) {
      const y = predecessor.y + predecessor.h;
      out = out.map((it) => (it.y >= y ? { ...it, y: it.y + size.h } : it));
      out.push({ i: key, x: 0, y, w: size.w, h: size.h });
    } else {
      out.push({ i: key, x: 0, y: bottomOf(out), w: size.w, h: size.h });
    }
  }
  return out;
}

/**
 * The layout to render: the user's, else the role's default, else the built-in —
 * narrowed to the panels this viewer may actually see.
 *
 * The narrowing is the security-adjacent part, though the layout itself withholds
 * nothing: an entry for a hidden panel is removed AND its space is not reserved. A
 * gap where a hidden panel would sit tells the viewer that something is there,
 * which is precisely what hiding it was meant not to do.
 */
export function resolveLayout(
  userLayout: DashboardLayout | undefined,
  roleLayout: DashboardLayout | undefined,
  visiblePanels: string[],
): DashboardLayout {
  const chosen = userLayout ?? roleLayout ?? DEFAULT_DASHBOARD_LAYOUT;
  // Dashboard panels only. `visiblePanels` answers "what may this person see"
  // across the WHOLE product, and five of those keys belong to the instrument
  // trend page. Placing them here produced empty boxes occupying grid space — the
  // dashboard has no renderer for them — so a viewer with unrestricted panels got
  // four cards and five holes. Caught on the first live run, not by a test.
  const allowed = new Set(visiblePanels.filter((k) => DASHBOARD_PANEL_KEYS.has(k)));
  const ordered = visiblePanels.filter((k) => allowed.has(k));
  const items = chosen.items.filter((it) => allowed.has(it.i));
  return { version: LAYOUT_VERSION, items: appendMissing(items, ordered) };
}
