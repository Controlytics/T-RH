import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DASHBOARD_LAYOUT, LAYOUT_VERSION, normalizeLayout, resolveLayout,
} from './dashboard-layout.js';

const item = (i: string, y: number) => ({ i, x: 0, y, w: 12, h: 6 });

describe('normalizeLayout', () => {
  it('reads a stored layout', () => {
    const stored = { version: LAYOUT_VERSION, items: [item('dashboard_trend', 0)] };
    expect(normalizeLayout(stored)?.items).toEqual([item('dashboard_trend', 0)]);
  });

  it('DROPS an item whose panel key no longer exists', () => {
    // Same rule normalizePanels follows: a retired key contributes nothing and is
    // never a wildcard.
    const stored = { version: LAYOUT_VERSION, items: [item('total_users', 0), item('dashboard_trend', 1)] };
    expect(normalizeLayout(stored)?.items.map((i) => i.i)).toEqual(['dashboard_trend']);
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
    expect(normalizeLayout({ version: LAYOUT_VERSION, items: [{ i: 'dashboard_trend' }] })).toBeUndefined();
    expect(normalizeLayout({ version: LAYOUT_VERSION, items: [{ ...item('dashboard_trend', 0), w: 'wide' }] }))
      .toBeUndefined();
  });

  it('rejects a layout from a future version rather than guessing', () => {
    // `version` exists so a future grid change can migrate rather than
    // misinterpret. Guessing at an unknown shape would place cards at random.
    expect(normalizeLayout({ version: LAYOUT_VERSION + 1, items: [item('dashboard_trend', 0)] }))
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
  const visible = ['telemetry_table', 'dashboard_trend'];

  it('prefers the user layout over the role default', () => {
    const user = { version: LAYOUT_VERSION, items: [item('dashboard_trend', 0)] };
    const role = { version: LAYOUT_VERSION, items: [item('telemetry_table', 0)] };
    expect(resolveLayout(user, role, visible).items[0].i).toBe('dashboard_trend');
  });

  it('falls back to the role default, then to the built-in', () => {
    const role = { version: LAYOUT_VERSION, items: [item('dashboard_trend', 0)] };
    expect(resolveLayout(undefined, role, visible).items[0].i).toBe('dashboard_trend');
    expect(resolveLayout(undefined, undefined, visible).items.length).toBeGreaterThan(0);
  });

  it('IGNORES an entry for a panel the viewer may not see', () => {
    // And reserves no space for it. A hole where a hidden panel would be discloses
    // that the panel exists, which is the opposite of hiding it.
    const user = { version: LAYOUT_VERSION, items: [item('trend_alarms', 0), item('dashboard_trend', 1)] };
    expect(resolveLayout(user, undefined, ['dashboard_trend']).items.map((i) => i.i))
      .toEqual(['dashboard_trend']);
  });

  it('APPENDS a visible panel that has no entry, rather than losing it', () => {
    // A newly granted panel must appear. Silently vanishing would look like the
    // grant failed, and the operator would go looking in the wrong place.
    const user = { version: LAYOUT_VERSION, items: [item('dashboard_trend', 0)] };
    const out = resolveLayout(user, undefined, ['dashboard_trend', 'telemetry_table']);
    expect(out.items.map((i) => i.i)).toEqual(['dashboard_trend', 'telemetry_table']);
    // Below everything already placed, so it cannot land on top of something.
    expect(out.items[1].y).toBeGreaterThanOrEqual(out.items[0].y + out.items[0].h);
  });

  it('appends several missing panels without stacking them on each other', () => {
    const user = { version: LAYOUT_VERSION, items: [item('dashboard_trend', 0)] };
    const out = resolveLayout(user, undefined, ['dashboard_trend', 'telemetry_table', 'telemetry_floorplan']);
    expect(out.items).toHaveLength(3);
    expect(out.items[2].y).toBeGreaterThanOrEqual(out.items[1].y + out.items[1].h);
  });

  it('returns only visible panels when nothing is stored', () => {
    expect(resolveLayout(undefined, undefined, ['dashboard_trend']).items.map((i) => i.i))
      .toEqual(['dashboard_trend']);
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
