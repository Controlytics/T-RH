import { isPanelKey } from './panels.js';

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
    { i: 'telemetry_floorplan', x: 0, y: 9, w: 12, h: 11 },
    { i: 'dashboard_trend', x: 0, y: 20, w: 12, h: 9 },
    { i: 'dashboard_alarms', x: 0, y: 29, w: 12, h: 6 },
  ],
};

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
  return { i: o.i, x: o.x, y: o.y, w: o.w, h: o.h };
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
function appendMissing(items: LayoutItem[], visiblePanels: string[]): LayoutItem[] {
  const placed = new Set(items.map((it) => it.i));
  const out = [...items];
  let y = bottomOf(items);
  for (const key of visiblePanels) {
    if (placed.has(key)) continue;
    const size = DEFAULT_DASHBOARD_LAYOUT.items.find((d) => d.i === key) ?? FALLBACK_SIZE;
    out.push({ i: key, x: 0, y, w: size.w, h: size.h });
    y += size.h;
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
  const allowed = new Set(visiblePanels);
  const items = chosen.items.filter((it) => allowed.has(it.i));
  return { version: LAYOUT_VERSION, items: appendMissing(items, visiblePanels) };
}
