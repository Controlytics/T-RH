/**
 * Which panels the Tabular | Graphical toggle HIDES in each view.
 *
 * Tabular hides the floorplan. Graphical hides the table AND the alarms widget
 * (operator, 2026-09-22: "in graphical view dont show the alarm widget") — the
 * drawn floor already colours every room and tile by its status, so a list of
 * the same alarms underneath it said the same thing twice. Until then only the
 * two READING panels swapped and the alarms panel showed in both views. The
 * trend still shows in both.
 *
 * HIDDEN, NOT DELETED. A hidden panel keeps its stored position, and the page's
 * `onGridChange` carries it back into the draft: react-grid-layout reports only
 * the items it was GIVEN, so saving while a view is filtered would otherwise
 * persist a layout with the hidden panels MISSING — and a panel absent from the
 * layout never comes back. Anything added to a hidden set here rides that same
 * carry; nothing else needs to change on the page.
 *
 * No toggle (a role missing one of the two reading panels) hides nothing: there
 * is no view to be "in", and a button that blanks the grid is worse than none.
 */
export const READING_PANELS = { table: 'telemetry_table', graphical: 'telemetry_floorplan' } as const;

/** Shown in the Tabular view only — hidden the moment Graphical is chosen. */
export const TABULAR_ONLY_PANELS: readonly string[] = [READING_PANELS.table, 'dashboard_alarms'];

/** Shown in the Graphical view only. */
export const GRAPHICAL_ONLY_PANELS: readonly string[] = [READING_PANELS.graphical];

export type DashboardView = 'table' | 'graphical';

export function hiddenPanelsFor(view: DashboardView, canToggleView: boolean): ReadonlySet<string> {
  if (!canToggleView) return new Set();
  return new Set(view === 'table' ? GRAPHICAL_ONLY_PANELS : TABULAR_ONLY_PANELS);
}
