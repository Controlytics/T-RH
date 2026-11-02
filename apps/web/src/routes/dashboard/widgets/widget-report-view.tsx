/**
 * WHAT A WIDGET IS SHOWING, for its Download report (2026-11-02).
 *
 * The panel owns the Download report button; the widget body owns what it is
 * showing — the period a viewer picked or zoomed to (`useWidgetRange`), the
 * alarm table's search / type / status (`SelectionAlarms`). Both are the
 * body's session state, so the body PUBLISHES them here and the report dialog
 * reads them when it opens: the dialog's period starts at the range on screen,
 * and an alarm table's report prints the alarms the viewer is filtering to.
 *
 * Ruling T4 (the brief's `WidgetChartRegistry`): the registry carries this
 * VIEW, keyed by widget id, and NOT chart instances. ECharts here draws SVG, so
 * `getDataURL()` hands back an SVG jsPDF cannot print; and a chart on screen
 * shows the widget's window while the report prints the dialog's period. A
 * report's picture is drawn from the report's own data instead
 * (`widget-report-data.ts`).
 *
 * Writes go to a ref, never state: publishing re-renders nothing, and the
 * dialog reads the latest value at the moment it opens. With no registry (the
 * Add widget preview, a widget rendered alone in a test) publishing is a no-op.
 */
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import type { AlarmWidgetFilterValue } from '@/routes/alarms/alarm-widget-filters';
import type { WidgetRange } from './use-widget-data';

export interface WidgetReportView {
  /** The range a window-following widget is drawing now (its period, the dashboard window, or a zoom). */
  range?: WidgetRange;
  /** The alarm table's filters as the viewer has them. */
  alarmFilters?: AlarmWidgetFilterValue;
  /** The drawing a floor plan widget is showing, on the page (its report's picture); null when none is drawn. */
  floorplanSvg?: () => SVGSVGElement | null;
}

export interface WidgetReportViewRegistry {
  publish: (widgetId: string, view: WidgetReportView) => void;
  read: (widgetId: string) => WidgetReportView;
}

const Registry = createContext<WidgetReportViewRegistry | null>(null);

/** A registry for the widgets beneath it — `WidgetPanel` provides one per panel. */
export function WidgetReportViewProvider({ children }: { children: ReactNode }) {
  const views = useRef(new Map<string, WidgetReportView>());
  const registry = useRef<WidgetReportViewRegistry>({
    publish: (id, view) => { views.current.set(id, { ...views.current.get(id), ...view }); },
    read: (id) => views.current.get(id) ?? {},
  });
  return <Registry.Provider value={registry.current}>{children}</Registry.Provider>;
}

export function useWidgetReportViewRegistry(): WidgetReportViewRegistry | null {
  return useContext(Registry);
}

/**
 * Publish the range this widget is drawing. Keyed on the range's two instants,
 * so a re-render with the same range writes nothing new.
 */
export function usePublishWidgetRange(widgetId: string, range: WidgetRange): void {
  const registry = useContext(Registry);
  useEffect(() => {
    registry?.publish(widgetId, { range: { from: range.from, to: range.to } });
  }, [registry, widgetId, range.from, range.to]);
}
