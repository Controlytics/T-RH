import type { DashboardSource, DashboardTimeWindow } from '@digilog/shared';
import type { WidgetSelection } from './use-widget-data';

/**
 * What a dashboard's source means to the widgets on it. An unreadable source
 * (`null`) is an EMPTY list, never `all`: widening a dashboard to every
 * instrument because its stored scope was corrupt would show data its author
 * never chose.
 */
export function selectionForSource(source: DashboardSource | null, window: DashboardTimeWindow): WidgetSelection {
  if (source === null) return { directOnly: false, instrumentIds: [], window };
  switch (source.mode) {
    case 'all': return { directOnly: false, window };
    case 'profile': return { directOnly: false, profileId: source.profileId, window };
    case 'location': return { functionalLocationId: source.functionalLocationId, directOnly: source.directOnly, window };
    case 'instruments': return { directOnly: false, instrumentIds: source.ids, window };
  }
}
