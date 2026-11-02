/**
 * A built widget on the dashboard: the site's `PanelCard` around its type's
 * renderer. Moved and sized like any panel; Edit and Remove exist only while
 * arranging (SUPER_ADMIN only — the layout routes' 403 is the control).
 *
 * Download report (2026-11-02) is in EVERY widget's header, arranging or not,
 * when Configuration → Export Options lets the viewer's role have a PDF on the
 * "Dashboard widgets" surface. It opens `WidgetReportDialog` (kind
 * `widget:<type>`); the body publishes what it is showing for it through
 * `WidgetReportViewProvider` (its range, the alarm table's filters, the floor
 * plan's drawing).
 *
 * Nothing imported here may import ECharts: a chart widget draws through
 * `charts/lazy-echart.tsx`, so the library stays out of the main bundle.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { FileDown } from 'lucide-react';
import { WIDGET_TYPES, WIDGET_TYPE_SPECS, type CustomWidget, type LayoutItem, type PanelStyle, type WidgetType } from '@digilog/shared';
import { useExportOptions } from '@/hooks/use-export-options';
import { PanelCard } from '../panel-card';
import { AlarmCountsWidget } from './alarm-counts-widget';
import { AlarmTableWidget } from './alarm-table-widget';
import { BarChartWidget } from './bar-chart-widget';
import { ComparisonBarWidget } from './comparison-bar-widget';
import { FloorplanWidget } from './floorplan-widget';
import { GaugeWidget } from './gauge-widget';
import { InstrumentListWidget } from './instrument-list-widget';
import { LatestTableWidget } from './latest-table-widget';
import { PieChartWidget } from './pie-chart-widget';
import { StatusGridWidget } from './status-grid-widget';
import { TextCardWidget } from './text-card-widget';
import { TimeseriesTableWidget } from './timeseries-table-widget';
import { TrendChartWidget } from './trend-chart-widget';
import type { WidgetTrail } from './trend-link';
import { ValueCardsWidget } from './value-cards-widget';
import type { WidgetSelection } from './use-widget-data';
import { WidgetReportDialog } from './widget-report-dialog';
import { WidgetReportViewProvider } from './widget-report-view';

/**
 * The panel's eyebrow: what the type is CALLED — `WIDGET_TYPE_SPECS[t].label`,
 * the one vocabulary the Add widget picker, the report kinds and the audit's
 * reportType also use (review m13: three spellings had grown).
 */
export const WIDGET_EYEBROW = Object.fromEntries(
  WIDGET_TYPES.map((t) => [t, WIDGET_TYPE_SPECS[t].label]),
) as Record<WidgetType, string>;

/**
 * The renderer for a widget's type — also the Add widget dialog's live preview.
 *
 * `trail` is the host dashboard's breadcrumb as links, carried by every way from
 * a widget into the trend page (the status grid's tiles, the instrument list's
 * rows, the floor plan's rooms and cards); the home dashboard passes
 * `trailFor(nav.breadcrumb)`, a built dashboard its own two crumbs. The
 * dialog's preview passes none, and nothing in it is a link.
 */
export function WidgetBody({ widget, selection, trail }: { widget: CustomWidget; selection: WidgetSelection; trail?: WidgetTrail }) {
  switch (widget.type) {
    case 'value_cards': return <ValueCardsWidget widget={widget} selection={selection} />;
    case 'latest_table': return <LatestTableWidget widget={widget} selection={selection} />;
    case 'trend_chart': return <TrendChartWidget widget={widget} selection={selection} />;
    case 'timeseries_table': return <TimeseriesTableWidget widget={widget} selection={selection} />;
    case 'alarm_table': return <AlarmTableWidget widget={widget} selection={selection} />;
    case 'gauge': return <GaugeWidget widget={widget} selection={selection} />;
    case 'comparison_bar': return <ComparisonBarWidget widget={widget} selection={selection} />;
    case 'bar_chart': return <BarChartWidget widget={widget} selection={selection} />;
    case 'pie_chart': return <PieChartWidget widget={widget} selection={selection} />;
    case 'alarm_counts': return <AlarmCountsWidget widget={widget} selection={selection} />;
    case 'status_grid': return <StatusGridWidget widget={widget} selection={selection} trail={trail} />;
    case 'instrument_list': return <InstrumentListWidget widget={widget} selection={selection} trail={trail} />;
    case 'text_card': return <TextCardWidget widget={widget} />;
    case 'floorplan': return <FloorplanWidget widget={widget} selection={selection} trail={trail} />;
  }
}

/** What a widget's report says about where it was downloaded from (`{dashboard}`, `{selection}`). */
export interface WidgetReportHost {
  /** The built dashboard's name, or "Dashboard" on `/`. */
  dashboard: string;
  /** The dashboard's drill-down or source, as its header says it. */
  selection: string;
}

export function WidgetPanel({
  widget, item, selection, trail, reportHost, editing, onEdit, onRemove, onStyleChange, onSizeChange, autoHeight, onNaturalHeight,
}: {
  widget: CustomWidget;
  item: LayoutItem;
  selection: WidgetSelection;
  /** The host dashboard's breadcrumb as links (see `WidgetBody`). */
  trail?: WidgetTrail;
  /** The host, for the widget's Download report. */
  reportHost: WidgetReportHost;
  editing: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onStyleChange: (next: PanelStyle | undefined) => void;
  onSizeChange: (w: number, h: number) => void;
  autoHeight: boolean;
  onNaturalHeight: (px: number) => void;
}) {
  // Configuration → Export Options' "Dashboard widgets" surface: fail-open,
  // hidden only when the viewer's role is allowed no PDF there. Presentation —
  // the download's own policy (Direct / Request) is the kind's, on the server.
  const { pdf } = useExportOptions('dashboard-widgets');
  const [reporting, setReporting] = useState(false);
  return (
    <WidgetReportViewProvider>
    <PanelCard
      title={widget.title}
      eyebrow={WIDGET_EYEBROW[widget.type]}
      editing={editing}
      style={item.style}
      width={item.w}
      height={item.h}
      onStyleChange={onStyleChange}
      onSizeChange={onSizeChange}
      autoHeight={autoHeight}
      onNaturalHeight={onNaturalHeight}
      actions={pdf ? (
        <button
          type="button"
          onClick={() => setReporting(true)}
          aria-label="Download report"
          title="Download report"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-300 bg-white/90 text-slate-700 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--theme-primary,#2a78d6)]"
        >
          <FileDown aria-hidden="true" className="h-4 w-4" />
        </button>
      ) : null}
      menu={(
        <>
          <button
            type="button"
            onClick={onEdit}
            className="shrink-0 rounded-md border border-slate-300 bg-white/90 px-2 py-0.5 text-[0.6875rem] font-semibold text-slate-700 hover:bg-white"
          >
            Edit widget
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 rounded-md border border-red-300 bg-white/90 px-2 py-0.5 text-[0.6875rem] font-semibold text-red-700 hover:bg-red-50"
          >
            Remove
          </button>
        </>
      )}
    >
      {/* While the dashboard is being EDITED a widget is handed no trail, so
          nothing in it leads to the trend page, as in the Add widget preview: a
          click there would leave a page holding an unsaved draft (R7-9). */}
      <WidgetBody widget={widget} selection={selection} trail={editing ? undefined : trail} />
    </PanelCard>
    {/* PORTALLED to the body: a grid item is positioned by `transform`, which
        makes it the containing block of every `position: fixed` inside it, so
        the dialog's full-screen overlay would be boxed into this card
        (the floor plan's full screen portals for the same reason). Context —
        the registry, the router, the toasts — crosses a portal. */}
    {reporting && createPortal(
      <WidgetReportDialog
        open
        widget={widget}
        selection={selection}
        dashboardTitle={reportHost.dashboard}
        selectionLabel={reportHost.selection}
        onClose={() => setReporting(false)}
      />,
      document.body,
    )}
    </WidgetReportViewProvider>
  );
}
