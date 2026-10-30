import type { CustomWidget } from '@digilog/shared';
import { SelectionAlarms } from '../selection-alarms';
import { widgetAlarmScope } from '../alarm-scope';
import type { WidgetSelection } from './use-widget-data';

/**
 * A built alarm table: the dashboard's SHARED alarm panel over this widget's
 * instruments. Nothing here is an alarm decision - the rows, the counts and the
 * acknowledge flow are `SelectionAlarms`' own, from the server. Its scope is
 * `widgetAlarmScope`, the same one the alarm counts widget asks with.
 */
export function AlarmTableWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  return (
    <SelectionAlarms
      scope={{ ...widgetAlarmScope(widget.source, selection), initialStatus: widget.options.status }}
    />
  );
}
