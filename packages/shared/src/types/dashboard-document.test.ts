import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_DOCUMENT_VERSION, DEFAULT_DASHBOARD_WINDOW, emptyDashboardDocument,
  parseDashboardDocument, readDashboardDocument, diffWidgets,
} from './dashboard-document.js';
import { WIDGET_TYPES, widgetItemId, type CustomWidget } from './dashboard-widgets.js';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const PROFILE = '99999999-9999-4999-8999-999999999999';

const widget = (n: number, over: Partial<CustomWidget> = {}): CustomWidget => ({
  id: uuid(n), type: 'value_cards', title: `W${n}`, source: { mode: 'selection' },
  keys: [{ source: 'telemetry', key: 'p' }], options: {}, ...over,
});
const place = (w: CustomWidget, y = 0) => ({ i: widgetItemId(w.id), x: 0, y, w: 6, h: 5 });
const doc = (widgets: CustomWidget[], over: Record<string, unknown> = {}) => ({
  version: DASHBOARD_DOCUMENT_VERSION,
  source: { mode: 'all' },
  timeWindow: { mode: 'relative', period: '24h' },
  items: widgets.map((w, n) => place(w, n * 5)),
  widgets,
  ...over,
});
const refusal = (v: unknown) => {
  const r = parseDashboardDocument(v);
  return r.ok ? null : r.message;
};

describe('parseDashboardDocument', () => {
  it('accepts one widget of each of the five types, a profile source and a fixed window', () => {
    const ws = WIDGET_TYPES.map((type, n) => widget(n + 1, type === 'alarm_table' ? { type, keys: [] } : { type }));
    expect(ws).toHaveLength(5);
    const r = parseDashboardDocument(doc(ws, {
      source: { mode: 'profile', profileId: PROFILE },
      timeWindow: { mode: 'fixed', from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.source).toEqual({ mode: 'profile', profileId: PROFILE });
      expect(r.document.widgets).toHaveLength(5);
    }
  });

  it('defaults directOnly to false and deduplicates instrument ids', () => {
    const r = parseDashboardDocument(doc([], { source: { mode: 'location', functionalLocationId: PROFILE } }));
    expect(r.ok && r.document.source).toEqual({ mode: 'location', functionalLocationId: PROFILE, directOnly: false });
    const d = parseDashboardDocument(doc([], { source: { mode: 'instruments', ids: [PROFILE, PROFILE] } }));
    expect(d.ok && d.document.source).toEqual({ mode: 'instruments', ids: [PROFILE] });
  });

  it('refuses a non-object or a wrong version', () => {
    expect(refusal('x')).toBe('Dashboard is not in a form this server can store.');
    expect(refusal(null)).toBe('Dashboard is not in a form this server can store.');
    expect(refusal(doc([], { version: 2 }))).toBe('Dashboard is not in a form this server can store.');
  });

  it('refuses an empty instrument list', () => {
    expect(refusal(doc([], { source: { mode: 'instruments', ids: [] } }))).toMatch(/^Dashboard instruments:/);
  });

  it('refuses a fixed window that ends before it starts', () => {
    const m = refusal(doc([], { timeWindow: { mode: 'fixed', from: '2026-10-02T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' } }));
    expect(m).toBe('Time window: The window must end after it starts');
  });

  it('refuses a panel item', () => {
    expect(refusal(doc([], { items: [{ i: 'telemetry_table', x: 0, y: 0, w: 6, h: 5 }] })))
      .toBe('Only widgets can be placed on a dashboard');
  });

  it('refuses a bad widget, naming it', () => {
    const bad = { ...widget(1), keys: [] };
    expect(refusal(doc([bad]))).toBe('Widget "W1": Choose at least one key');
  });

  it('refuses 21 widgets', () => {
    const ws = Array.from({ length: 21 }, (_, n) => widget(n + 1));
    expect(refusal(doc(ws))).toBe('At most 20 widgets on one dashboard.');
  });

  it('refuses a widget that is not placed, a double placement, and an item with no widget', () => {
    const w = widget(1);
    expect(refusal(doc([w], { items: [] }))).toBe('Widget "W1" is not placed');
    expect(refusal(doc([w], { items: [place(w, 0), place(w, 5)] }))).toBe('Widget "W1" is placed twice');
    expect(refusal(doc([w], { items: [place(w, 0), place(widget(2), 5)] }))).toBe('A placed widget has no definition');
  });

  it('refuses an unreadable item', () => {
    expect(refusal(doc([], { items: [{ i: 'w:x' }] }))).toBe('Dashboard is not in a form this server can store.');
  });
});

describe('readDashboardDocument', () => {
  it('keeps the good widget, its item and the source when another widget is bad', () => {
    const good = widget(1);
    const bad = { ...widget(2), type: 'pie' };
    const r = readDashboardDocument({
      ...doc([good], { source: { mode: 'profile', profileId: PROFILE } }),
      items: [place(good, 0), place(widget(2), 5)],
      widgets: [good, bad],
    });
    expect(r.source).toEqual({ mode: 'profile', profileId: PROFILE });
    expect(r.widgets).toEqual([good]);
    expect(r.items.map((i) => i.i)).toEqual([widgetItemId(good.id)]);
  });

  it('reads a bad source as null, not as all', () => {
    expect(readDashboardDocument(doc([], { source: { mode: 'profile', profileId: 'nope' } })).source).toBeNull();
    expect(readDashboardDocument(doc([], { source: undefined })).source).toBeNull();
  });

  it('reads a bad window as the default window', () => {
    expect(readDashboardDocument(doc([], { timeWindow: { mode: 'fixed', from: 'x' } })).timeWindow).toEqual(DEFAULT_DASHBOARD_WINDOW);
  });

  it('reads {} as an empty document with an unreadable source', () => {
    expect(readDashboardDocument({})).toEqual({ ...emptyDashboardDocument(), source: null });
  });
});

describe('diffWidgets', () => {
  it('reports one created, one updated and one deleted', () => {
    const a = widget(1);
    const b = widget(2);
    const c = widget(3);
    const d = diffWidgets([a, b], [{ ...a, title: 'Renamed' }, c]);
    expect(d.created).toEqual([c]);
    expect(d.deleted).toEqual([b]);
    expect(d.updated).toEqual([{ before: a, after: { ...a, title: 'Renamed' } }]);
  });

  it('reports nothing for an equal widget with its keys in another order', () => {
    const a = widget(1);
    const reordered = { options: a.options, keys: a.keys, source: a.source, title: a.title, type: a.type, id: a.id } as CustomWidget;
    expect(diffWidgets([a], [reordered])).toEqual({ created: [], updated: [], deleted: [] });
  });
});
