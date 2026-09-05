import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DASHBOARD_LAYOUT, LAYOUT_VERSION, normalizeLayout, resolveLayout,
} from './dashboard-layout.js';
import { PANELS } from './panels.js';
import { PANEL_WIDTHS, PANEL_HEIGHTS, namedWidth, namedHeight } from './dashboard-layout.js';

const item = (i: string, y: number) => ({ i, x: 0, y, w: 12, h: 6 });

describe('normalizeLayout', () => {
  it('reads a stored layout', () => {
    const stored = { version: LAYOUT_VERSION, items: [item('dashboard_alarms', 0)] };
    expect(normalizeLayout(stored)?.items).toEqual([item('dashboard_alarms', 0)]);
  });

  it('DROPS an item whose panel key no longer exists', () => {
    // Same rule normalizePanels follows: a retired key contributes nothing and is
    // never a wildcard.
    const stored = { version: LAYOUT_VERSION, items: [item('total_users', 0), item('dashboard_alarms', 1)] };
    expect(normalizeLayout(stored)?.items.map((i) => i.i)).toEqual(['dashboard_alarms']);
  });

  it('returns undefined for absent or malformed values rather than an empty layout', () => {
    // An empty layout would render a blank dashboard. Falling back to the default
    // is the only safe direction: a corrupted preference must not look like a
    // deliberate "show nothing". This is exactly where layout differs from panel
    // assignment, where an empty list IS a deliberate deny.
    expect(normalizeLayout(null)).toBeUndefined();
    expect(normalizeLayout(undefined)).toBeUndefined();
    expect(normalizeLayout('nonsense')).toBeUndefined();
    expect(normalizeLayout({ items: 'no' })).toBeUndefined();
    expect(normalizeLayout({ version: LAYOUT_VERSION, items: [{ i: 'dashboard_alarms' }] })).toBeUndefined();
    expect(normalizeLayout({ version: LAYOUT_VERSION, items: [{ ...item('dashboard_alarms', 0), w: 'wide' }] }))
      .toBeUndefined();
  });

  it('rejects a layout from a future version rather than guessing', () => {
    // `version` exists so a future grid change can migrate rather than
    // misinterpret. Guessing at an unknown shape would place cards at random.
    expect(normalizeLayout({ version: LAYOUT_VERSION + 1, items: [item('dashboard_alarms', 0)] }))
      .toBeUndefined();
  });

  it('accepts a layout whose every item was retired, as EMPTY', () => {
    // Distinct from malformed: the value was well-formed, it simply no longer
    // names anything. resolveLayout then appends the visible panels, so the
    // dashboard fills rather than blanking.
    expect(normalizeLayout({ version: LAYOUT_VERSION, items: [item('total_users', 0)] })?.items)
      .toEqual([]);
  });
});

describe('resolveLayout', () => {
  const visible = ['telemetry_table', 'dashboard_alarms'];

  it('prefers the user layout over the role default', () => {
    const user = { version: LAYOUT_VERSION, items: [item('dashboard_alarms', 0)] };
    const role = { version: LAYOUT_VERSION, items: [item('telemetry_table', 0)] };
    expect(resolveLayout(user, role, visible).items[0].i).toBe('dashboard_alarms');
  });

  it('falls back to the role default, then to the built-in', () => {
    const role = { version: LAYOUT_VERSION, items: [item('dashboard_alarms', 0)] };
    expect(resolveLayout(undefined, role, visible).items[0].i).toBe('dashboard_alarms');
    expect(resolveLayout(undefined, undefined, visible).items.length).toBeGreaterThan(0);
  });

  it('IGNORES an entry for a panel the viewer may not see', () => {
    // And reserves no space for it. A hole where a hidden panel would be discloses
    // that the panel exists, which is the opposite of hiding it.
    const user = { version: LAYOUT_VERSION, items: [item('trend_alarms', 0), item('dashboard_alarms', 1)] };
    expect(resolveLayout(user, undefined, ['dashboard_alarms']).items.map((i) => i.i))
      .toEqual(['dashboard_alarms']);
  });

  it('APPENDS a visible panel that has no entry, rather than losing it', () => {
    // A newly granted panel must appear. Silently vanishing would look like the
    // grant failed, and the operator would go looking in the wrong place.
    const user = { version: LAYOUT_VERSION, items: [item('dashboard_alarms', 0)] };
    const out = resolveLayout(user, undefined, ['dashboard_alarms', 'telemetry_table']);
    expect(out.items.map((i) => i.i)).toEqual(['dashboard_alarms', 'telemetry_table']);
    // Below everything already placed, so it cannot land on top of something.
    expect(out.items[1].y).toBeGreaterThanOrEqual(out.items[0].y + out.items[0].h);
  });

  it('appends several missing panels without stacking them on each other', () => {
    const user = { version: LAYOUT_VERSION, items: [item('dashboard_alarms', 0)] };
    const out = resolveLayout(user, undefined, ['dashboard_alarms', 'telemetry_table', 'telemetry_floorplan']);
    expect(out.items).toHaveLength(3);
    expect(out.items[2].y).toBeGreaterThanOrEqual(out.items[1].y + out.items[1].h);
  });

  it('returns only visible panels when nothing is stored', () => {
    expect(resolveLayout(undefined, undefined, ['dashboard_alarms']).items.map((i) => i.i))
      .toEqual(['dashboard_alarms']);
  });

  it('returns an empty layout when the viewer may see no panels', () => {
    // Not a crash and not the built-in: someone assigned NO panels, and the grid
    // should render nothing rather than resurrect them.
    expect(resolveLayout(undefined, undefined, []).items).toEqual([]);
  });

  it('the built-in default has no duplicate keys and sane geometry', () => {
    const keys = DEFAULT_DASHBOARD_LAYOUT.items.map((i) => i.i);
    expect(new Set(keys).size).toBe(keys.length);
    for (const it of DEFAULT_DASHBOARD_LAYOUT.items) {
      expect(it.w).toBeGreaterThan(0);
      expect(it.h).toBeGreaterThan(0);
      expect(it.x).toBeGreaterThanOrEqual(0);
      expect(it.x + it.w).toBeLessThanOrEqual(12);
    }
  });
});

describe('the layout is about the DASHBOARD only', () => {
  it('never places a trend-page panel, even when the viewer may see it', () => {
    // Caught live: an unrestricted viewer resolves to EVERY panel key, five of
    // which belong to the instrument trend page. The dashboard has no renderer for
    // those, so appending them produced empty boxes occupying grid space — a
    // dashboard with four cards and five holes in it.
    const everyPanel = PANELS.map((p) => p.key);
    const out = resolveLayout(undefined, undefined, everyPanel);
    expect(out.items.map((i) => i.i)).toEqual(
      PANELS.filter((p) => p.page === 'dashboard').map((p) => p.key),
    );
  });

  it('drops a trend-page entry someone managed to store', () => {
    const stored = {
      version: LAYOUT_VERSION,
      items: [{ i: 'trend_charts', x: 0, y: 0, w: 12, h: 6 }, { i: 'telemetry_table', x: 0, y: 6, w: 12, h: 6 }],
    };
    expect(resolveLayout(stored, undefined, PANELS.map((p) => p.key)).items.map((i) => i.i))
      .toEqual(['telemetry_table', 'dashboard_history', 'telemetry_floorplan', 'dashboard_alarms']);
  });
});

describe('a panel the stored layout does not know', () => {
  const dashboard = PANELS.filter((p) => p.page === 'dashboard').map((p) => p.key);

  it('lands directly under the panel that precedes it in the shipped layout, and shifts the rest down', () => {
    // A layout saved before the history widget existed: table, floorplan, alarms.
    const stored = {
      version: LAYOUT_VERSION,
      items: [
        { i: 'telemetry_table', x: 0, y: 0, w: 12, h: 9 },
        { i: 'telemetry_floorplan', x: 0, y: 9, w: 12, h: 16 },
        { i: 'dashboard_alarms', x: 0, y: 25, w: 12, h: 6 },
      ],
    };
    const out = resolveLayout(stored, undefined, dashboard);
    const at = (k: string) => out.items.find((i) => i.i === k)!;
    // Under the table — operator, 2026-09-05: "below the all instruments
    // readings table" — not at the bottom, which is where it went before.
    expect(at('dashboard_history').y).toBe(9);
    expect(at('telemetry_floorplan').y).toBe(9 + at('dashboard_history').h);
    expect(at('dashboard_alarms').y).toBe(25 + at('dashboard_history').h);
    expect(at('telemetry_table').y).toBe(0);
  });

  it('goes to the bottom when its predecessor is not on the layout', () => {
    // The table is hidden from this viewer, so "under the table" means nothing.
    const stored = {
      version: LAYOUT_VERSION,
      items: [{ i: 'telemetry_floorplan', x: 0, y: 0, w: 12, h: 16 }, { i: 'dashboard_alarms', x: 0, y: 16, w: 12, h: 6 }],
    };
    const out = resolveLayout(stored, undefined, dashboard.filter((k) => k !== 'telemetry_table'));
    const history = out.items.find((i) => i.i === 'dashboard_history')!;
    expect(history.y).toBe(22);
    expect(out.items.find((i) => i.i === 'telemetry_floorplan')!.y).toBe(0);
  });

  it('the built-in default contains only dashboard panels', () => {
    const dashboardKeys = new Set(PANELS.filter((p) => p.page === 'dashboard').map((p) => p.key));
    for (const it of DEFAULT_DASHBOARD_LAYOUT.items) expect(dashboardKeys.has(it.i)).toBe(true);
  });
});

describe('the named card sizes', () => {
  it('recognises a card that matches a named step', () => {
    expect(namedWidth(6)).toBe(6);
    expect(namedHeight(9)).toBe(9);
  });

  it('returns null for a card dragged BETWEEN two named steps', () => {
    // The editor then shows "Custom". Quoting the nearest name for a card that is
    // not that size would be worse than admitting it has no name — the control
    // would silently lie about the card in front of you.
    expect(namedWidth(7)).toBeNull();
    expect(namedHeight(11)).toBeNull();
  });

  it('every named width fits the grid, and every height is usable', () => {
    for (const w of PANEL_WIDTHS) {
      expect(w.w).toBeGreaterThan(0);
      expect(w.w).toBeLessThanOrEqual(12);
    }
    for (const h of PANEL_HEIGHTS) expect(h.h).toBeGreaterThanOrEqual(3);
  });

  it('offers full width, since that is what the default layout uses', () => {
    expect(PANEL_WIDTHS.some((w) => w.w === 12)).toBe(true);
  });
});
