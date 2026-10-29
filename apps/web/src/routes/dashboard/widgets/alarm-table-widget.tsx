import type { CustomWidget } from '@digilog/shared';
import { SelectionAlarms } from '../selection-alarms';
import type { WidgetSelection } from './use-widget-data';

/**
 * A built alarm table: the dashboard's SHARED alarm panel over this widget's
 * instruments. Nothing here is an alarm decision - the rows, the counts and the
 * acknowledge flow are `SelectionAlarms`' own, from the server.
 */
export function AlarmTableWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  const initialStatus = widget.options.status;
  if (widget.source.mode === 'instruments') {
    return <SelectionAlarms scope={{ instrumentIds: widget.source.ids, initialStatus }} />;
  }
  return (
    <SelectionAlarms
      scope={{
        functionalLocationId: selection.functionalLocationId,
        directOnly: selection.directOnly,
        profileId: selection.profileId,
        instrumentIds: selection.instrumentIds,
        initialStatus,
      }}
    />
  );
}
