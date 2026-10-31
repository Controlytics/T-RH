/**
 * Floor plan — the dashboard's own drawn floor (`FloorplanView`) on the ONE
 * plan the widget names, with the live readings of the instruments the widget
 * covers: the dashboard's selection, or its picked instruments
 * (`overviewQueryFor`, the one mapping every status widget asks with). The plan
 * is drawn whole; which instruments' readings sit on it is the selection's.
 * A plan that is gone, or one the viewer may not see, reads
 * `FLOORPLAN_NOT_AVAILABLE` (the view decides that from the plan list).
 *
 * The readings are this request's only (`useWidgetOverview`, I-1): the widget
 * asks the same overview query the view does — one SWR key, one request — and
 * draws the view only when that answer is the current one; a refresh that
 * failed keeps the floor and says so.
 *
 * Its rooms and cards open the trend page with the host's trail, as every way
 * from the dashboard does; with no trail (the Add widget preview, a dashboard
 * being edited, R7-9) nothing in it leads off the page, Full screen included.
 * The server gates the type on `/` (the `telemetry_floorplan` panel); nothing is
 * re-gated here.
 */
import type { CustomWidget } from '@digilog/shared';
import { FloorplanView } from '../floorplan-view';
import type { WidgetTrail } from './trend-link';
import { overviewQueryFor, useWidgetOverview, type WidgetSelection } from './use-widget-data';
import { LOAD_FAILED, NO_INSTRUMENTS, WidgetMessage, WidgetNotes, answerState } from './widget-common';

export function FloorplanWidget({ widget, selection, trail }: {
  widget: CustomWidget;
  selection: WidgetSelection;
  trail?: WidgetTrail;
}) {
  const { rows, loading, error } = useWidgetOverview(widget.source, selection);
  const answer = answerState(rows.length > 0, error);

  if (loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (answer === 'failed') return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (rows.length === 0) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;

  // A flex column filling the card (`PanelCard fill`), the drawing taking what
  // the notes leave: the plan is CONTAINED in the card, as `FloorplanView` is
  // built to be — enlarge the card, or press Full screen, to see it bigger.
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <WidgetNotes refreshFailed={answer === 'stale'} />
      <div className="min-h-0 flex-1">
        <FloorplanView
          // The schema requires a plan; were one ever absent, the widget is a
          // fixed plan that is not there — never the home view's plan switcher.
          planId={widget.options.planId ?? ''}
          {...overviewQueryFor(widget.source, selection)}
          trail={trail}
          interactive={trail !== undefined}
        />
      </div>
    </div>
  );
}
