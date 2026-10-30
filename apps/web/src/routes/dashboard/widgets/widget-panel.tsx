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
import { AlarmTableWidget } from './alarm-table-widget';
import { ComparisonBarWidget } from './comparison-bar-widget';
import { GaugeWidget } from './gauge-widget';
import { LatestTableWidget } from './latest-table-widget';
import { TimeseriesTableWidget } from './timeseries-table-widget';
import { TrendChartWidget } from './trend-chart-widget';
import { ValueCardsWidget } from './value-cards-widget';
import { WidgetMessage } from './widget-common';
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
 * The body of a dashboard builder phase 2 type whose renderer has not landed
 * yet (each type's own task replaces its case below). Draws nothing it could be
 * mistaken for.
 */
function PendingWidget() {
  return <WidgetMessage>…</WidgetMessage>;
}

/** The renderer for a widget's type — also the Add widget dialog's live preview. */
export function WidgetBody({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  switch (widget.type) {
    case 'value_cards': return <ValueCardsWidget widget={widget} selection={selection} />;
    case 'latest_table': return <LatestTableWidget widget={widget} selection={selection} />;
    case 'trend_chart': return <TrendChartWidget widget={widget} selection={selection} />;
    case 'timeseries_table': return <TimeseriesTableWidget widget={widget} selection={selection} />;
    case 'alarm_table': return <AlarmTableWidget widget={widget} selection={selection} />;
    case 'gauge': return <GaugeWidget widget={widget} selection={selection} />;
    case 'comparison_bar': return <ComparisonBarWidget widget={widget} selection={selection} />;
    case 'bar_chart':
    case 'pie_chart':
    case 'alarm_counts':
    case 'status_grid':
    case 'instrument_list':
    case 'text_card':
    case 'floorplan':
      return <PendingWidget />;
  }
}

export function WidgetPanel({
  widget, item, selection, editing, onEdit, onRemove, onStyleChange, onSizeChange, autoHeight, onNaturalHeight,
}: {
  widget: CustomWidget;
  item: LayoutItem;
  selection: WidgetSelection;
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
      <WidgetBody widget={widget} selection={selection} />
    </PanelCard>
  );
}
