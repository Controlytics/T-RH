/**
 * Floor plan — the dashboard's own drawn floor (`FloorplanView`) on the ONE
 * plan the widget names, with the live readings of the instruments the widget
 * covers: the dashboard's selection, or its picked instruments
 * (`overviewQueryFor`, the one mapping every status widget asks with). The plan
 * is drawn whole; which instruments' readings sit on it is the selection's.
 *
 * ONE floor-plan behaviour app-wide (fix round 1, I-1): drawn exactly as the
 * home floor panel draws it — fitted to the card's WIDTH, the card's body
 * scrolling — so its readings are the home panel's size at the same width. A
 * new one starts at the home panel's default size (`WIDGET_START_HEIGHT`).
 * Full screen is the enlargement.
 *
 * The PLAN is decided first (`fixedPlanState`, M-4): a plan that is gone, or
 * one the viewer may not see, reads `FLOORPLAN_NOT_AVAILABLE` whatever the
 * readings are doing. Then the readings, this request's only
 * (`useWidgetOverview`, I-1 of Task 7): the widget asks the same overview query
 * the view does — one SWR key, one request — and draws the view only when that
 * answer is the current one; a refresh that failed keeps the floor and says so.
 * An empty selection draws the plan with no readings on it.
 *
 * Its rooms and cards open the trend page with the host's trail, as every way
 * from the dashboard does; with no trail (the Add widget preview, a dashboard
 * being edited, R7-9) nothing in it leads off the page, Full screen included.
 * The server gates the type on `/` (the `telemetry_floorplan` panel); nothing is
 * re-gated here.
 */
import type { CustomWidget } from '@digilog/shared';
import { FloorplanNotAvailable, FloorplanView, fixedPlanState } from '../floorplan-view';
import { useFloorplans } from '../use-telemetry';
import type { WidgetTrail } from './trend-link';
import { overviewQueryFor, useWidgetOverview, type WidgetSelection } from './use-widget-data';
import { LOAD_FAILED, WidgetMessage, WidgetNotes, answerState } from './widget-common';

export function FloorplanWidget({ widget, selection, trail }: {
  widget: CustomWidget;
  selection: WidgetSelection;
  trail?: WidgetTrail;
}) {
  // The schema requires a plan; were one ever absent, the widget is a fixed
  // plan that is not there — never the home view's plan switcher.
  const planId = widget.options.planId ?? '';
  // The view's own plan list (one SWR key): read here only to decide the plan first.
  const { plans, isLoading: plansLoading, error: plansError } = useFloorplans();
  const { rows, loading, error } = useWidgetOverview(widget.source, selection);
  const answer = answerState(rows.length > 0, error);

  const plan = fixedPlanState(plans, plansLoading, plansError, planId);
  if (plan === 'gone') return <FloorplanNotAvailable />;
  if (plan === 'loading' || loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (answer === 'failed') return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;

  return (
    <div className="space-y-2">
      <WidgetNotes refreshFailed={answer === 'stale'} />
      <FloorplanView
        planId={planId}
        {...overviewQueryFor(widget.source, selection)}
        trail={trail}
        interactive={trail !== undefined}
      />
    </div>
  );
}
