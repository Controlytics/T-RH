import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { widgetItemId, type CustomWidget, type StoredDashboardDocument } from '@digilog/shared';
import { useDashboardDraft } from '../use-dashboard-draft';

/**
 * The edit session over ONE built dashboard (2026-10-29, dashboard builder
 * phase 1). The draft is the document on screen while editing; outside edit
 * mode it IS the stored document. Items and widgets move together, a grid
 * report never stores a measured height, and Cancel throws the session away.
 */

const W1 = '11111111-1111-4111-8111-000000000001';
const W2 = '11111111-1111-4111-8111-000000000002';
const W3 = '11111111-1111-4111-8111-000000000003';

const widget = (id: string, type: CustomWidget['type'], title = `W ${id.slice(-1)}`): CustomWidget => ({
  id, type, title, source: { mode: 'selection' }, keys: type === 'alarm_table' ? [] : [{ source: 'telemetry', key: 't' }], options: {},
});

const STORED: StoredDashboardDocument = {
  version: 1,
  source: { mode: 'all' },
  timeWindow: { mode: 'relative', period: '24h' },
  items: [
    { i: widgetItemId(W1), x: 0, y: 0, w: 6, h: 5, style: { tint: 'sky' } as never },
    { i: widgetItemId(W2), x: 6, y: 0, w: 6, h: 9 },
  ],
  widgets: [widget(W1, 'value_cards'), widget(W2, 'latest_table')],
};

/** Every placed item has exactly one widget and every widget one item. */
function paired(doc: StoredDashboardDocument): boolean {
  const placed = doc.items.map((it) => it.i).sort();
  const defined = doc.widgets.map((w) => widgetItemId(w.id)).sort();
  return JSON.stringify(placed) === JSON.stringify(defined);
}

describe('useDashboardDraft', () => {
  it('outside edit mode the draft is the stored document and nothing is dirty', () => {
    const { result } = renderHook(() => useDashboardDraft(STORED));
    expect(result.current.editing).toBe(false);
    expect(result.current.draft).toEqual(STORED);
    expect(result.current.dirty).toBe(false);
  });

  it('add places the widget at the bottom, full width, at the home start height, paired with its item', () => {
    const { result } = renderHook(() => useDashboardDraft(STORED));
    act(() => result.current.start());
    act(() => result.current.addWidget(widget(W3, 'value_cards')));
    const added = result.current.draft.items.find((it) => it.i === widgetItemId(W3));
    // bottom = the lowest edge of what is already there (y 0 + h 9)
    expect(added).toEqual({ i: widgetItemId(W3), x: 0, y: 9, w: 12, h: 5 });
    expect(result.current.draft.widgets.map((w) => w.id)).toEqual([W1, W2, W3]);
    expect(paired(result.current.draft)).toBe(true);
    expect(result.current.dirty).toBe(true);

    // Every other type starts taller (9 rows), as on the home dashboard.
    const W4 = '11111111-1111-4111-8111-000000000004';
    act(() => result.current.addWidget(widget(W4, 'trend_chart')));
    expect(result.current.draft.items.find((it) => it.i === widgetItemId(W4))).toEqual({ i: widgetItemId(W4), x: 0, y: 14, w: 12, h: 9 });
  });

  it('update replaces the definition in place and leaves the placement alone', () => {
    const { result } = renderHook(() => useDashboardDraft(STORED));
    act(() => result.current.start());
    act(() => result.current.updateWidget({ ...widget(W2, 'latest_table'), title: 'Renamed' }));
    expect(result.current.draft.widgets.map((w) => w.title)).toEqual(['W 1', 'Renamed']);
    expect(result.current.draft.items).toEqual(STORED.items);
    expect(paired(result.current.draft)).toBe(true);
  });

  it('remove takes the widget AND the item placing it', () => {
    const { result } = renderHook(() => useDashboardDraft(STORED));
    act(() => result.current.start());
    act(() => result.current.removeWidget(W1));
    expect(result.current.draft.widgets.map((w) => w.id)).toEqual([W2]);
    expect(result.current.draft.items.map((it) => it.i)).toEqual([widgetItemId(W2)]);
    expect(paired(result.current.draft)).toBe(true);
  });

  it('a grid change carries each card style and never stores a measured height', () => {
    const { result } = renderHook(() => useDashboardDraft(STORED));
    act(() => result.current.start());
    // The grid hands back geometry only. W2 is a TABLE widget, so its height is
    // measured at render — the 23 rows here are a measurement, not a drag.
    act(() => result.current.onGridChange([
      { i: widgetItemId(W1), x: 0, y: 23, w: 12, h: 5 },
      { i: widgetItemId(W2), x: 0, y: 0, w: 12, h: 23 },
    ]));
    const [a, b] = result.current.draft.items;
    expect(a).toEqual({ i: widgetItemId(W1), x: 0, y: 23, w: 12, h: 5, style: { tint: 'sky' } });
    expect(b).toEqual({ i: widgetItemId(W2), x: 0, y: 0, w: 12, h: 9 });
  });

  it('a grid report with the same geometry leaves the draft untouched and not dirty', () => {
    // react-grid-layout reports on every layout pass with fresh objects; writing
    // the draft on each one would mark an untouched dashboard as changed.
    const { result } = renderHook(() => useDashboardDraft(STORED));
    act(() => result.current.start());
    const before = result.current.draft;
    act(() => result.current.onGridChange(STORED.items.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))));
    expect(result.current.draft).toBe(before);
    expect(result.current.dirty).toBe(false);
  });

  it('style and size edits change only that card', () => {
    const { result } = renderHook(() => useDashboardDraft(STORED));
    act(() => result.current.start());
    act(() => result.current.setStyle(widgetItemId(W1), undefined));
    act(() => result.current.setSize(widgetItemId(W2), 4, 12));
    expect(result.current.draft.items).toEqual([
      { i: widgetItemId(W1), x: 0, y: 0, w: 6, h: 5 },
      { i: widgetItemId(W2), x: 6, y: 0, w: 4, h: 12 },
    ]);
  });

  it('cancel restores the stored document and leaves edit mode', () => {
    const { result } = renderHook(() => useDashboardDraft(STORED));
    act(() => result.current.start());
    act(() => result.current.addWidget(widget(W3, 'value_cards')));
    act(() => result.current.removeWidget(W1));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.cancel());
    expect(result.current.editing).toBe(false);
    expect(result.current.draft).toEqual(STORED);
    expect(result.current.dirty).toBe(false);
  });

  it('start again while editing goes back to the stored document', () => {
    const { result } = renderHook(() => useDashboardDraft(STORED));
    act(() => result.current.start());
    act(() => result.current.removeWidget(W2));
    act(() => result.current.start());
    expect(result.current.editing).toBe(true);
    expect(result.current.draft).toEqual(STORED);
  });

  it('a new stored document (after a save) shows outside edit mode; a draft in progress is kept', () => {
    const next: StoredDashboardDocument = { ...STORED, widgets: [STORED.widgets[0]], items: [STORED.items[0]] };
    const { result, rerender } = renderHook(({ s }) => useDashboardDraft(s), { initialProps: { s: STORED } });
    rerender({ s: next });
    expect(result.current.draft).toEqual(next);

    act(() => result.current.start());
    act(() => result.current.addWidget(widget(W3, 'value_cards')));
    const editing = result.current.draft;
    rerender({ s: STORED });
    expect(result.current.draft).toBe(editing);
  });
});
