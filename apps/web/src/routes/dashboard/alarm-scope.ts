/**
 * Which alarms a dashboard surface asks about — the ONE builder of the scope
 * filters, shared by the alarm table (`GET /api/alarms`, `selection-alarms.tsx`)
 * and the alarm counts (`GET /api/alarms/counts`, `useAlarmCounts`), which accept
 * the same filter set: given the same scope, the two ask the same question.
 * One difference is in the SCOPE, not the builder: the home dashboard's alarms
 * panel passes its location alone and never sends `functionalLocationDirect`,
 * while a built widget following a "direct" selection does.
 *
 * The SCOPE only: paging, search, type and status are the table's own
 * (`applyWidgetFilters`).
 */
import type { CustomWidget } from '@digilog/shared';
import type { WidgetSelection } from './widgets/use-widget-data';

export interface AlarmScope {
  functionalLocationId?: string;
  /** This location itself, without its Areas. Meaningless without a location, and not sent. */
  directOnly?: boolean;
  profileId?: string;
  /** A fixed list; `[]` is NOTHING (see `alarmScopeSelectsNothing`), never everything. */
  instrumentIds?: string[];
}

/** How often an alarm surface on the dashboard re-asks. */
export const ALARM_REFRESH_MS = 30_000;

export function applyAlarmScope(qs: URLSearchParams, scope: AlarmScope): void {
  if (scope.functionalLocationId) qs.set('functionalLocationId', scope.functionalLocationId);
  if (scope.functionalLocationId && scope.directOnly) qs.set('functionalLocationDirect', 'true');
  if (scope.profileId) qs.set('profileId', scope.profileId);
  if (scope.instrumentIds && scope.instrumentIds.length > 0) qs.set('instrumentIds', scope.instrumentIds.join(','));
}

/**
 * An EMPTY fixed list selects nothing, and must make no request at all: the
 * server reads an absent `instrumentIds` as everything in view.
 */
export function alarmScopeSelectsNothing(scope: AlarmScope | undefined): boolean {
  return scope?.instrumentIds !== undefined && scope.instrumentIds.length === 0;
}

/** A built widget's alarm scope: its own fixed instruments, else the dashboard's selection. */
export function widgetAlarmScope(source: CustomWidget['source'], selection: WidgetSelection): AlarmScope {
  if (source.mode === 'instruments') return { instrumentIds: source.ids };
  return {
    functionalLocationId: selection.functionalLocationId,
    directOnly: selection.directOnly,
    profileId: selection.profileId,
    instrumentIds: selection.instrumentIds,
  };
}
