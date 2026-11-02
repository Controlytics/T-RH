import { useCallback } from 'react';
import type { CustomWidget } from '@digilog/shared';
import type { AlarmWidgetFilterValue } from '@/routes/alarms/alarm-widget-filters';
import { SelectionAlarms } from '../selection-alarms';
import { widgetAlarmScope } from '../alarm-scope';
import type { WidgetSelection } from './use-widget-data';
import { useWidgetReportViewRegistry } from './widget-report-view';

/**
 * A built alarm table: the dashboard's SHARED alarm panel over this widget's
 * instruments. Nothing here is an alarm decision - the rows, the counts and the
 * acknowledge flow are `SelectionAlarms`' own, from the server. Its scope is
 * `widgetAlarmScope`, the same one the alarm counts widget asks with.
 *
 * The panel's filters are published for the widget's Download report
 * (2026-11-02, `widget-report-view.tsx`): the report prints the alarms the
 * viewer is filtering to, not the stored default.
 */
export function AlarmTableWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  const registry = useWidgetReportViewRegistry();
  const widgetId = widget.id;
  const onFiltersChange = useCallback(
    (alarmFilters: AlarmWidgetFilterValue) => registry?.publish(widgetId, { alarmFilters }),
    [registry, widgetId],
  );
  return (
    <SelectionAlarms
      scope={{ ...widgetAlarmScope(widget.source, selection), initialStatus: widget.options.status }}
      onFiltersChange={onFiltersChange}
    />
  );
}
