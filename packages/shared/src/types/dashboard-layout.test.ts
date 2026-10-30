import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DASHBOARD_LAYOUT, LAYOUT_VERSION, normalizeLayout, resolveLayout, type DashboardLayout,
} from './dashboard-layout.js';
import { PANELS } from './panels.js';
import { PANEL_WIDTHS, PANEL_HEIGHTS, namedWidth, namedHeight, parseLayoutForWrite } from './dashboard-layout.js';
import { PANEL_KEYS } from './panels.js';
import { CUSTOM_WIDGETS_PANEL, widgetItemId, type CustomWidget } from './dashboard-widgets.js';

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
    // `custom_widgets` is a dashboard panel on the Panels tab but a GATE, never a
    // card (2026-10-28) — the same "no holes" rule this test exists for.
    expect(out.items.map((i) => i.i)).toEqual(
      PANELS.filter((p) => p.page === 'dashboard' && p.key !== CUSTOM_WIDGETS_PANEL).map((p) => p.key),
    );
  });

  it('drops a trend-page entry someone managed to store', () => {
    const stored = {
      version: LAYOUT_VERSION,
      items: [{ i: 'trend_charts', x: 0, y: 0, w: 12, h: 6 }, { i: 'telemetry_table', x: 0, y: 6, w: 12, h: 6 }],
    };
    expect(resolveLayout(stored, undefined, PANELS.map((p) => p.key)).items.map((i) => i.i))
      .toEqual(['telemetry_table', 'telemetry_floorplan', 'dashboard_alarms']);
  });
});

describe('a panel the stored layout does not know', () => {
  const dashboard = PANELS.filter((p) => p.page === 'dashboard').map((p) => p.key);

  it('lands directly under the panel that precedes it in the shipped layout, and shifts the rest down', () => {
    // A layout saved without the floorplan: table, then alarms. The rule was
    // written for the history widget (operator, 2026-09-05: "below the all
    // instruments readings table" — not at the bottom, where a new panel went
    // before); that widget left the dashboard on 2026-09-07, and the rule
    // stays, exercised here on the floorplan.
    const stored = {
      version: LAYOUT_VERSION,
      items: [
        { i: 'telemetry_table', x: 0, y: 0, w: 12, h: 9 },
        { i: 'dashboard_alarms', x: 0, y: 9, w: 12, h: 6 },
      ],
    };
    const out = resolveLayout(stored, undefined, dashboard);
    const at = (k: string) => out.items.find((i) => i.i === k)!;
    expect(at('telemetry_floorplan').y).toBe(9);
    expect(at('dashboard_alarms').y).toBe(9 + at('telemetry_floorplan').h);
    expect(at('telemetry_table').y).toBe(0);
  });

  it('goes to the bottom when its predecessor is not on the layout', () => {
    // The table is hidden from this viewer, so "under the table" means nothing.
    const stored = {
      version: LAYOUT_VERSION,
      items: [{ i: 'dashboard_alarms', x: 0, y: 0, w: 12, h: 6 }],
    };
    const out = resolveLayout(stored, undefined, dashboard.filter((k) => k !== 'telemetry_table'));
    const floorplan = out.items.find((i) => i.i === 'telemetry_floorplan')!;
    expect(floorplan.y).toBe(6);
    expect(out.items.find((i) => i.i === 'dashboard_alarms')!.y).toBe(0);
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

// ── Built widgets (widget data keys phase 2, 2026-10-28) ─────────────────────

const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const widget = (id: string, title = 'Pressures'): CustomWidget => ({
  id, type: 'value_cards', title, source: { mode: 'selection' },
  keys: [{ source: 'telemetry', key: 'p' }], options: {},
});
const wItem = (id: string, y: number, w = 12, h = 5) => ({ i: widgetItemId(id), x: 0, y, w, h });
const dashboardKeys = PANELS.filter((p) => p.page === 'dashboard').map((p) => p.key);

describe('a layout that carries widgets', () => {
  it('keeps every other item when one widget is malformed', () => {
    const stored = {
      version: LAYOUT_VERSION,
      items: [item('telemetry_table', 0), item('telemetry_floorplan', 6), item('dashboard_alarms', 12), wItem(W1, 18), wItem(W2, 23)],
      widgets: [widget(W1), { ...widget(W2), type: 'pie' }],
    };
    const out = normalizeLayout(stored);
    expect(out?.items.map((i) => i.i)).toEqual(['telemetry_table', 'telemetry_floorplan', 'dashboard_alarms', widgetItemId(W1)]);
    expect(out?.widgets).toEqual([widget(W1)]);
  });

  it('drops a w: item with no definition, not the layout', () => {
    const out = normalizeLayout({ version: LAYOUT_VERSION, items: [item('dashboard_alarms', 0), wItem(W1, 6)] });
    expect(out?.items.map((i) => i.i)).toEqual(['dashboard_alarms']);
    expect(out && 'widgets' in out).toBe(false);
  });

  it('drops a widget nothing places', () => {
    const out = normalizeLayout({ version: LAYOUT_VERSION, items: [item('dashboard_alarms', 0)], widgets: [widget(W1)] });
    expect(out && 'widgets' in out).toBe(false);
  });

  it('drops an item named custom_widgets — the panel is a gate, never a card', () => {
    const out = normalizeLayout({ version: LAYOUT_VERSION, items: [item(CUSTOM_WIDGETS_PANEL, 0), item('dashboard_alarms', 6)] });
    expect(out?.items.map((i) => i.i)).toEqual(['dashboard_alarms']);
  });

  it('places no custom_widgets card when every panel is visible', () => {
    expect(resolveLayout(undefined, undefined, [...PANEL_KEYS]).items.map((i) => i.i)).not.toContain(CUSTOM_WIDGETS_PANEL);
    const user = { version: LAYOUT_VERSION, items: [item('dashboard_alarms', 0)] };
    expect(resolveLayout(user, undefined, [...PANEL_KEYS]).items.map((i) => i.i)).not.toContain(CUSTOM_WIDGETS_PANEL);
  });

  it('shows w: items only when the custom_widgets panel is visible', () => {
    const user = { version: LAYOUT_VERSION, items: [item('dashboard_alarms', 0), wItem(W1, 6)], widgets: [widget(W1)] };
    const without = resolveLayout(user, undefined, dashboardKeys.filter((k) => k !== CUSTOM_WIDGETS_PANEL));
    expect(without.items.map((i) => i.i)).not.toContain(widgetItemId(W1));
    expect('widgets' in without).toBe(false);
    const withPanel = resolveLayout(user, undefined, dashboardKeys);
    expect(withPanel.items.map((i) => i.i)).toContain(widgetItemId(W1));
    expect(withPanel.widgets).toEqual([widget(W1)]);
  });

  it("a non-super-admin's own layout still shows the role's widgets", () => {
    // Arrange is SUPER_ADMIN-only since 2026-08-29, so a user layout saved
    // before then can never be reset by its owner. Without this rule the
    // role's widgets would never reach them.
    const user = { version: LAYOUT_VERSION, items: [item('telemetry_table', 0), item('dashboard_alarms', 6)] };
    const role = { version: LAYOUT_VERSION, items: [item('telemetry_table', 0), wItem(W1, 0, 6, 5)], widgets: [widget(W1)] };
    const visible = ['telemetry_table', 'dashboard_alarms', CUSTOM_WIDGETS_PANEL];
    const out = resolveLayout(user, role, visible, { viewerIsSuperAdmin: false });
    expect(out.items.map((i) => i.i)).toEqual(['telemetry_table', 'dashboard_alarms', widgetItemId(W1)]);
    expect(out.items[2]).toEqual({ i: widgetItemId(W1), x: 0, y: 12, w: 6, h: 5 });
    expect(out.widgets).toEqual([widget(W1)]);

    const sa = resolveLayout(user, role, visible, { viewerIsSuperAdmin: true });
    expect(sa.items.map((i) => i.i)).toEqual(['telemetry_table', 'dashboard_alarms']);
    expect('widgets' in sa).toBe(false);
  });

  it('a layout without widgets keeps its old shape', () => {
    const stored = { version: LAYOUT_VERSION, items: [item('dashboard_alarms', 0)] };
    expect(normalizeLayout(stored)).toEqual(stored);
    expect(resolveLayout(stored, undefined, ['dashboard_alarms'])).toEqual(stored);
  });
});

describe('an alarm table in a layout', () => {
  it('an alarm table needs the dashboard_alarms panel', () => {
    const alarm: CustomWidget = { ...widget(W1, 'Alarms'), type: 'alarm_table', keys: [], options: {} };
    const cards = widget(W2, 'Cards');
    const role = {
      version: LAYOUT_VERSION,
      items: [wItem(W1, 0), wItem(W2, 5)],
      widgets: [alarm, cards],
    };
    const base = ['custom_widgets', 'telemetry_table'];
    const without = resolveLayout(undefined, role, base, { viewerIsSuperAdmin: true });
    expect(without.items.map((i) => i.i)).toContain(widgetItemId(W2));
    expect(without.items.map((i) => i.i)).not.toContain(widgetItemId(W1));
    expect(without.widgets?.map((w) => w.id)).toEqual([W2]);
    const withPanel = resolveLayout(undefined, role, [...base, 'dashboard_alarms'], { viewerIsSuperAdmin: true });
    expect(withPanel.items.map((i) => i.i)).toEqual(expect.arrayContaining([widgetItemId(W1), widgetItemId(W2)]));
  });
});

describe('parseLayoutForWrite', () => {
  const placed = { version: LAYOUT_VERSION, items: [item('dashboard_alarms', 0), wItem(W1, 6)] };

  it('keeps the stored widgets when the key is omitted', () => {
    const r = parseLayoutForWrite(placed, [widget(W1)]);
    expect(r.ok && r.layout.widgets).toEqual([widget(W1)]);
  });

  it('accepts an explicit empty list with no w: items', () => {
    const r = parseLayoutForWrite({ version: LAYOUT_VERSION, items: [item('dashboard_alarms', 0)], widgets: [] }, [widget(W1)]);
    expect(r.ok).toBe(true);
    expect(r.ok && 'widgets' in r.layout).toBe(false);
  });

  it('refuses a malformed widget, naming it', () => {
    const r = parseLayoutForWrite({ ...placed, widgets: [{ ...widget(W1, 'Bad one'), keys: [] }] }, undefined);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('Bad one');
  });

  it('refuses a w: item with no widget, and a widget with no item', () => {
    expect(parseLayoutForWrite({ ...placed, widgets: [] }, undefined).ok).toBe(false);
    const unplaced = parseLayoutForWrite(
      { version: LAYOUT_VERSION, items: [item('dashboard_alarms', 0)], widgets: [widget(W1, 'Loose')] }, undefined,
    );
    expect(!unplaced.ok && unplaced.message).toBe('Widget "Loose" is not placed');
  });

  it('refuses more than 20 widgets and a duplicate id', () => {
    const ids = Array.from({ length: 21 }, (_, n) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`);
    const many = { version: LAYOUT_VERSION, items: ids.map((id, n) => wItem(id, n * 5)), widgets: ids.map((id) => widget(id)) };
    expect(parseLayoutForWrite(many, undefined).ok).toBe(false);
    const dup = { version: LAYOUT_VERSION, items: [wItem(W1, 0)], widgets: [widget(W1), widget(W1, 'Again')] };
    expect(parseLayoutForWrite(dup, undefined).ok).toBe(false);
  });

  it('drops a retired panel key and refuses an unreadable item, as the reader always has', () => {
    const r = parseLayoutForWrite({ version: LAYOUT_VERSION, items: [item('total_users', 0), item('dashboard_alarms', 6)] }, undefined);
    expect(r.ok && r.layout.items.map((i) => i.i)).toEqual(['dashboard_alarms']);
    expect(parseLayoutForWrite({ version: LAYOUT_VERSION, items: [{ i: 'dashboard_alarms' }] }, undefined).ok).toBe(false);
    expect(parseLayoutForWrite({ version: LAYOUT_VERSION + 1, items: [] }, undefined).ok).toBe(false);
  });
});

describe('the panel a built widget needs on `/`', () => {
  const W3 = '33333333-3333-4333-8333-333333333333';
  const W4 = '44444444-4444-4444-8444-444444444444';
  const alarmCounts: CustomWidget = { ...widget(W1, 'Counts'), type: 'alarm_counts', keys: [], options: {} };
  const pieAlarms: CustomWidget = { ...widget(W2, 'Pie'), type: 'pie_chart', keys: [], options: { of: 'alarm_types' } };
  const pieStatus: CustomWidget = { ...widget(W3, 'Pie status'), type: 'pie_chart', keys: [], options: { of: 'status' } };
  const plan: CustomWidget = {
    ...widget(W4, 'Plan'), type: 'floorplan', keys: [], options: { planId: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d' },
  };
  const role = {
    version: LAYOUT_VERSION,
    items: [wItem(W1, 0), wItem(W2, 5), wItem(W3, 10), wItem(W4, 15)],
    widgets: [alarmCounts, pieAlarms, pieStatus, plan],
  };
  const resolved = (panels: string[]) => resolveLayout(undefined, role, panels, { viewerIsSuperAdmin: true });
  const ids = (panels: string[]) => (resolved(panels).widgets ?? []).map((w) => w.id);

  it('drops alarm counts and an alarm-types pie without dashboard_alarms, keeps them with it', () => {
    const base = ['custom_widgets', 'telemetry_floorplan'];
    expect(ids(base)).toEqual([W3, W4]);
    expect(ids([...base, 'dashboard_alarms'])).toEqual([W1, W2, W3, W4]);
  });

  it('keeps a status pie without dashboard_alarms', () => {
    expect(ids(['custom_widgets'])).toContain(W3);
  });

  it('drops a floor plan without telemetry_floorplan', () => {
    expect(ids(['custom_widgets', 'dashboard_alarms'])).not.toContain(W4);
    expect(ids(['custom_widgets', 'dashboard_alarms', 'telemetry_floorplan'])).toContain(W4);
  });

  it('drops the items of the dropped widgets too', () => {
    expect(resolved(['custom_widgets']).items.map((i) => i.i)).toEqual([widgetItemId(W3)]);
  });
});

describe('a stored home layout from before phase 2', () => {
  const W = '66666666-6666-4666-8666-666666666666';
  const T = '77777777-7777-4777-8777-777777777777';
  const stored: DashboardLayout = {
    version: LAYOUT_VERSION,
    items: [item('telemetry_table', 0), wItem(W, 6), wItem(T, 11)],
    widgets: [
      { id: W, type: 'value_cards', title: 'Cards', source: { mode: 'selection' }, keys: [{ source: 'telemetry', key: 'p' }], options: {} },
      { id: T, type: 'trend_chart', title: 'Trend', source: { mode: 'selection' }, keys: [{ source: 'telemetry', key: 'p', color: 2 }], options: { period: '24h' } },
    ],
  };

  it('resolves to exactly itself', () => {
    expect(normalizeLayout(stored)).toEqual(stored);
    expect(resolveLayout(undefined, stored, ['telemetry_table', 'custom_widgets'], { viewerIsSuperAdmin: true })).toEqual(stored);
  });
});
