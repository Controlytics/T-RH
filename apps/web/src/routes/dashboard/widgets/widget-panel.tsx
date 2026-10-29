/**
 * A built widget on the dashboard: the site's `PanelCard` around one of the four
 * renderers. Moved and sized like any panel; Edit and Remove exist only while
 * arranging (SUPER_ADMIN only — the layout routes' 403 is the control).
 */
import type { CustomWidget, LayoutItem, PanelStyle, WidgetType } from '@digilog/shared';
import { PanelCard } from '../panel-card';
import { LatestTableWidget } from './latest-table-widget';
import { TimeseriesTableWidget } from './timeseries-table-widget';
import { TrendChartWidget } from './trend-chart-widget';
import { ValueCardsWidget } from './value-cards-widget';
import type { WidgetSelection } from './use-widget-data';

export const WIDGET_EYEBROW: Record<WidgetType, string> = {
  value_cards: 'Value cards',
  latest_table: 'Latest values',
  trend_chart: 'Trend',
  timeseries_table: 'Time series',
};

/** The renderer for a widget's type — also the Add widget dialog's live preview. */
export function WidgetBody({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  switch (widget.type) {
    case 'value_cards': return <ValueCardsWidget widget={widget} selection={selection} />;
    case 'latest_table': return <LatestTableWidget widget={widget} selection={selection} />;
    case 'trend_chart': return <TrendChartWidget widget={widget} selection={selection} />;
    case 'timeseries_table': return <TimeseriesTableWidget widget={widget} selection={selection} />;
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
