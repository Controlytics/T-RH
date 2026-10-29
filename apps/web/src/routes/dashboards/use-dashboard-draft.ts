import { useState } from 'react';
import {
  widgetIdOf, widgetItemId,
  type CustomWidget, type LayoutItem, type PanelStyle, type StoredDashboardDocument,
} from '@digilog/shared';
import { WIDGET_START_HEIGHT } from '@/hooks/use-dashboard-layout';
import { autoHeightIds, carryStoredFields } from '@/routes/dashboard/panel-auto-height';

/** Structural equality, blind to key order (a grid report rebuilds every item). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * The edit session over ONE built dashboard's document (dashboard builder,
 * phase 1).
 *
 * The DRAFT lives here, not in SWR, so Cancel is a real discard and a
 * background revalidation cannot move someone's cards mid-drag. Outside edit
 * mode there is no draft at all: `draft` is then the stored document, so a save
 * made elsewhere shows as soon as it is fetched.
 *
 * Items and widgets are edited TOGETHER — a widget is never defined without the
 * item placing it, nor placed without its definition (the server's strict
 * parser refuses either). Placement and start size are the home dashboard's
 * (`use-dashboard-layout.ts`): the bottom, full width, `WIDGET_START_HEIGHT`.
 */
export function useDashboardDraft(stored: StoredDashboardDocument) {
  const [draft, setDraft] = useState<StoredDashboardDocument | null>(null);
  const editing = draft !== null;
  const doc = draft ?? stored;

  /** Begin editing from the stored document. While editing, goes back to it. */
  const start = () => setDraft(stored);
  const cancel = () => setDraft(null);

  /**
   * Change the draft — and ONLY a draft. Outside edit mode this is a no-op, as
   * `onGridChange` is: a draft that began without `start()` would have no edit
   * base for the page's Save to send (fix round 1, 2026-10-29).
   */
  const edit = (change: (d: StoredDashboardDocument) => StoredDashboardDocument) =>
    setDraft((d) => (d === null ? null : change(d)));

  const addWidget = (w: CustomWidget) => edit((d) => {
    const bottom = d.items.reduce((max, it) => Math.max(max, it.y + it.h), 0);
    return {
      ...d,
      items: [...d.items, { i: widgetItemId(w.id), x: 0, y: bottom, w: 12, h: WIDGET_START_HEIGHT[w.type] }],
      widgets: [...d.widgets, w],
    };
  });

  const updateWidget = (w: CustomWidget) =>
    edit((d) => ({ ...d, widgets: d.widgets.map((x) => (x.id === w.id ? w : x)) }));

  const removeWidget = (id: string) => edit((d) => ({
    ...d,
    items: d.items.filter((it) => widgetIdOf(it.i) !== id),
    widgets: d.widgets.filter((w) => w.id !== id),
  }));

  /**
   * What react-grid-layout reports, into the draft.
   *
   * `carryStoredFields` keeps each card's STYLE (the grid hands back geometry
   * only) and the stored height of every table widget, whose on-screen height
   * is a measurement that must never be saved. And a report with the geometry
   * already held is DROPPED: the grid re-reports on every layout pass with
   * fresh objects, and writing each one would rewrite the draft forever and
   * mark an untouched dashboard as changed (the home page's same rule).
   */
  const onGridChange = (next: LayoutItem[]) => {
    if (!editing) return;
    const kept = carryStoredFields(next, doc.items, autoHeightIds(doc.widgets));
    const unchanged = kept.length === doc.items.length && kept.every((it) => {
      const prev = doc.items.find((p) => p.i === it.i);
      return prev !== undefined && prev.x === it.x && prev.y === it.y && prev.w === it.w && prev.h === it.h;
    });
    if (unchanged) return;
    setDraft({ ...doc, items: kept });
  };

  /** One card's chrome, edited like a drag and discarded with it. */
  const setStyle = (key: string, style: PanelStyle | undefined) => edit((d) => ({
    ...d,
    items: d.items.map((it) => {
      if (it.i !== key) return it;
      const { style: _dropped, ...rest } = it;
      return style ? { ...rest, style } : rest;
    }),
  }));

  /** One card's size from its edit panel — the same draft a drag writes. */
  const setSize = (key: string, w: number, h: number) =>
    edit((d) => ({ ...d, items: d.items.map((it) => (it.i === key ? { ...it, w, h } : it)) }));

  return {
    draft: doc,
    editing,
    dirty: editing && !same(draft, stored),
    start, cancel, addWidget, updateWidget, removeWidget, onGridChange, setStyle, setSize,
  };
}
