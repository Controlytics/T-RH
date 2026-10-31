/**
 * A built widget on the dashboard: the site's `PanelCard` around its type's
 * renderer. Moved and sized like any panel; Edit and Remove exist only while
 * arranging (SUPER_ADMIN only — the layout routes' 403 is the control).
 *
 * Nothing imported here may import ECharts: a chart widget draws through
 * `charts/lazy-echart.tsx`, so the library stays out of the main bundle.
 */
import type { CustomWidget, LayoutItem, PanelStyle, WidgetType } from '@digilog/shared';
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

export const WIDGET_EYEBROW: Record<WidgetType, string> = {
  value_cards: 'Value cards',
  latest_table: 'Latest values',
  trend_chart: 'Trend',
  timeseries_table: 'Time series',
  alarm_table: 'Alarms',
  gauge: 'Gauge',
  bar_chart: 'Bar chart',
  comparison_bar: 'Comparison',
  pie_chart: 'Pie',
  alarm_counts: 'Alarm counts',
  status_grid: 'Status grid',
  instrument_list: 'Instruments',
  text_card: 'Text',
  floorplan: 'Floor plan',
};

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

export function WidgetPanel({
  widget, item, selection, trail, editing, onEdit, onRemove, onStyleChange, onSizeChange, autoHeight, onNaturalHeight,
}: {
  widget: CustomWidget;
  item: LayoutItem;
  selection: WidgetSelection;
  /** The host dashboard's breadcrumb as links (see `WidgetBody`). */
  trail?: WidgetTrail;
  editing: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onStyleChange: (next: PanelStyle | undefined) => void;
  onSizeChange: (w: number, h: number) => void;
  autoHeight: boolean;
  onNaturalHeight: (px: number) => void;
}) {
  return (
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
      // A floor plan scales to the card it is given: contained, never scrolled.
      fill={widget.type === 'floorplan'}
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
  );
}
