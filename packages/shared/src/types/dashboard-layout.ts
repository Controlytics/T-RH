import { PANELS, isPanelKey } from './panels.js';
import { normalizePanelStyle, type PanelStyle } from './panel-style.js';
import {
  CUSTOM_WIDGETS_PANEL, WIDGETS_PER_LAYOUT_MAX, customWidgetSchema, widgetIdOf, type CustomWidget,
} from './dashboard-widgets.js';

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
  /**
   * Built widgets (widget data keys phase 2, 2026-10-28), each placed by an item
   * `w:<id>`. Present ONLY when there is at least one, so every layout stored
   * before widgets existed keeps its exact shape and `LAYOUT_VERSION` stays 1.
   */
  widgets?: CustomWidget[];
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
  PANELS
    // `custom_widgets` is a dashboard panel on the Panels tab, but it is the GATE
    // for built widgets, not a card: placing it would append an empty 12x8 box
    // to every dashboard (the "holes" bug resolveLayout's comment records).
    .filter((p) => p.page === 'dashboard' && p.key !== CUSTOM_WIDGETS_PANEL)
    .map((p) => p.key),
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
  // A `w:<id>` item places a built widget; whether its widget exists is decided
  // by the caller, which holds the widget list. `custom_widgets` itself is a
  // gate, never a card, so an item naming it is dropped like a retired key.
  if (widgetIdOf(o.i) === null && (!isPanelKey(o.i) || o.i === CUSTOM_WIDGETS_PANEL)) return null;
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
  // Widgets are read FORGIVINGLY: a malformed one is dropped with its item and
  // everything else stays where it is. Falling back to the default over one bad
  // widget would rearrange the whole dashboard for a mistake in one card — the
  // anti-goal "one unreadable widget resetting somebody's whole dashboard".
  return { version: LAYOUT_VERSION, ...pairWidgets(items, readWidgets(o.widgets)) };
}

function readWidgets(v: unknown): CustomWidget[] {
  if (!Array.isArray(v)) return [];
  const out: CustomWidget[] = [];
  const ids = new Set<string>();
  for (const raw of v) {
    if (out.length >= WIDGETS_PER_LAYOUT_MAX) break;
    const r = customWidgetSchema.safeParse(raw);
    if (!r.success || ids.has(r.data.id)) continue;
    ids.add(r.data.id);
    out.push(r.data);
  }
  return out;
}

/**
 * Keep only items and widgets that agree: a `w:` item whose widget is missing
 * goes, a second item placing the same widget goes, and a widget nothing places
 * goes. `widgets` is present only when non-empty, so a layout without any keeps
 * its pre-widget shape.
 */
function pairWidgets(items: LayoutItem[], widgets: readonly CustomWidget[]): Pick<DashboardLayout, 'items' | 'widgets'> {
  const defined = new Set(widgets.map((w) => w.id));
  const placed = new Set<string>();
  const kept = items.filter((it) => {
    const id = widgetIdOf(it.i);
    if (id === null) return true;
    if (!defined.has(id) || placed.has(id)) return false;
    placed.add(id);
    return true;
  });
  const used = widgets.filter((w) => placed.has(w.id));
  return used.length > 0 ? { items: kept, widgets: used } : { items: kept };
}

const UNSTORABLE = 'Layout is not in a form this server can store.';

/**
 * The STRICT reader for the two layout PUT routes.
 *
 * `normalizeLayout` forgives on purpose; a write must not, or a save reports
 * success and silently loses the operator's work (the trap `layoutBody`'s comment
 * records). A bad widget is refused with a message naming it.
 *
 * An OMITTED `widgets` key keeps `storedWidgets` — the widgets of the row being
 * overwritten. An old cached browser saves `{version, items}` only, and the role
 * route is open to ROLE_MANAGE holders who never see widgets; neither may delete
 * them by leaving the key out (the `doors` precedent). `widgets: []` is the
 * explicit "remove them all".
 */
export function parseLayoutForWrite(
  v: unknown,
  storedWidgets: readonly CustomWidget[] | undefined,
): { ok: true; layout: DashboardLayout } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (typeof v !== 'object' || v === null) return bad(UNSTORABLE);
  const o = v as Record<string, unknown>;
  if (o.version !== LAYOUT_VERSION || !Array.isArray(o.items)) return bad(UNSTORABLE);

  const items: LayoutItem[] = [];
  for (const raw of o.items) {
    const item = readItem(raw);
    if (item === undefined) return bad(UNSTORABLE);
    if (item !== null) items.push(item);
  }

  let widgets: CustomWidget[];
  if (o.widgets === undefined) {
    widgets = [...(storedWidgets ?? [])];
  } else {
    if (!Array.isArray(o.widgets)) return bad('`widgets` must be a list.');
    if (o.widgets.length > WIDGETS_PER_LAYOUT_MAX) return bad(`At most ${WIDGETS_PER_LAYOUT_MAX} widgets on one dashboard.`);
    widgets = [];
    for (const [n, raw] of o.widgets.entries()) {
      const r = customWidgetSchema.safeParse(raw);
      if (!r.success) return bad(`Widget "${titleOf(raw, n)}": ${r.error.issues[0]?.message ?? 'not a widget'}`);
      widgets.push(r.data);
    }
  }

  const ids = new Set<string>();
  for (const w of widgets) {
    if (ids.has(w.id)) return bad(`Widget "${w.title}" appears twice`);
    ids.add(w.id);
  }
  const placements = new Map<string, number>();
  for (const it of items) {
    const id = widgetIdOf(it.i);
    if (id === null) continue;
    if (!ids.has(id)) return bad('A placed widget has no definition');
    placements.set(id, (placements.get(id) ?? 0) + 1);
  }
  for (const w of widgets) {
    const n = placements.get(w.id) ?? 0;
    if (n === 0) return bad(`Widget "${w.title}" is not placed`);
    if (n > 1) return bad(`Widget "${w.title}" is placed twice`);
  }
  return {
    ok: true,
    layout: widgets.length > 0 ? { version: LAYOUT_VERSION, items, widgets } : { version: LAYOUT_VERSION, items },
  };
}

function titleOf(raw: unknown, n: number): string {
  const t = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).title : undefined;
  return typeof t === 'string' && t.trim() ? t.trim().slice(0, 80) : `#${n + 1}`;
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
  /**
   * Who is looking. Omitted = the pre-widget behaviour (the chosen layout's own
   * widgets). The server always passes it.
   */
  opts: { viewerIsSuperAdmin?: boolean } = {},
): DashboardLayout {
  const chosen = userLayout ?? roleLayout ?? DEFAULT_DASHBOARD_LAYOUT;
  // Dashboard panels only. `visiblePanels` answers "what may this person see"
  // across the WHOLE product, and five of those keys belong to the instrument
  // trend page. Placing them here produced empty boxes occupying grid space — the
  // dashboard has no renderer for them — so a viewer with unrestricted panels got
  // four cards and five holes. Caught on the first live run, not by a test.
  const allowed = new Set(visiblePanels.filter((k) => DASHBOARD_PANEL_KEYS.has(k)));
  const ordered = visiblePanels.filter((k) => allowed.has(k));

  // Built widgets need the `custom_widgets` panel — governance, like any panel.
  if (!visiblePanels.includes(CUSTOM_WIDGETS_PANEL)) {
    const items = chosen.items.filter((it) => allowed.has(it.i));
    return { version: LAYOUT_VERSION, items: appendMissing(items, ordered) };
  }

  /**
   * WHOSE widgets. Only a SUPER_ADMIN builds widgets, and shares them through a
   * role's default. A non-super-admin's OWN layout is a leftover from before
   * Arrange became SUPER_ADMIN-only (2026-08-29) — they can no longer reach Reset
   * — so it keeps their panel positions but takes the ROLE's widgets, placed below
   * their panels in the role's own arrangement. Otherwise the role's widgets would
   * never reach anyone holding such a layout.
   */
  const fromRole = opts.viewerIsSuperAdmin === false && userLayout !== undefined;
  if (!fromRole) {
    const defined = new Set((chosen.widgets ?? []).map((w) => w.id));
    const items = chosen.items.filter((it) => {
      const id = widgetIdOf(it.i);
      return id === null ? allowed.has(it.i) : defined.has(id);
    });
    return { version: LAYOUT_VERSION, ...pairWidgets(appendMissing(items, ordered), chosen.widgets ?? []) };
  }

  const panels = appendMissing(userLayout.items.filter((it) => allowed.has(it.i)), ordered);
  const roleWidgets = roleLayout?.widgets ?? [];
  const defined = new Set(roleWidgets.map((w) => w.id));
  const roleItems = (roleLayout?.items ?? []).filter((it) => {
    const id = widgetIdOf(it.i);
    return id !== null && defined.has(id);
  });
  const top = roleItems.reduce((min, it) => Math.min(min, it.y), Number.POSITIVE_INFINITY);
  const offset = bottomOf(panels);
  const shifted = roleItems.map((it) => ({ ...it, y: it.y - top + offset }));
  return { version: LAYOUT_VERSION, ...pairWidgets([...panels, ...shifted], roleWidgets) };
}
