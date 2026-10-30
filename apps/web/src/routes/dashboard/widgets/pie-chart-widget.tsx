/**
 * Pie chart — a ring of either the selection's instruments by status, or its
 * active alarms by type (`options.of`). What each slice is, and its colour, is
 * `pie-model.ts`; this file asks, and draws. Present state only: no period, no
 * window. Nothing is counted or judged here: the status is `instrumentLook` over
 * the server's overview rows, the alarm counts are `GET /api/alarms/counts`
 * asked with `widgetAlarmScope` (the alarm table's scope).
 *
 * An empty pie is said in words ("Nothing to show"), never drawn as an empty
 * ring; no instruments in view is said as every widget says it. The data is only
 * ever the current request's (`THIS_REQUEST_ONLY`), so a drill-down never draws
 * the previous scope's ring (fix round 1, I-1).
 */
import { useMemo, useState } from 'react';
import type { CustomWidget } from '@digilog/shared';
import { useAlarmTypeNames } from '@/hooks/use-failure-text';
import { alarmScopeSelectsNothing, widgetAlarmScope } from '../alarm-scope';
import { LazyEChart } from './charts/lazy-echart';
import { alarmTypePieModel, buildPieOption, piePlan, plural, statusPieModel, type PieSlice, type PieSubject } from './pie-model';
import { useAlarmCounts, useWidgetOverview, type WidgetSelection } from './use-widget-data';
import {
  LOAD_FAILED, NO_INSTRUMENTS, WidgetMessage, WidgetNotes, answerState, useBoxWidth, type RefreshNoun,
} from './widget-common';

export const NOTHING_TO_SHOW = 'Nothing to show';

export function PieChartWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  // Two subjects, two data sources — hooks cannot be conditional, components can.
  return widget.options.of === 'alarm_types'
    ? <AlarmTypePie widget={widget} selection={selection} />
    : <StatusPie widget={widget} selection={selection} />;
}

function StatusPie({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  const { rows, loading, error } = useWidgetOverview(widget.source, selection);
  const answer = answerState(rows.length > 0, error);
  const slices = statusPieModel(rows);
  if (loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (answer === 'failed') return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (rows.length === 0) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;
  return (
    <Ring
      slices={slices}
      about={{ subject: 'status', total: rows.length }}
      ariaLabel={`${widget.title}: ${plural(rows.length, 'instrument', 'instruments')}`}
      refreshFailed={answer === 'stale'}
      refreshNoun="readings"
    />
  );
}

function AlarmTypePie({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  const scope = widgetAlarmScope(widget.source, selection);
  const { data, error } = useAlarmCounts(scope);
  const names = useAlarmTypeNames();
  const answer = answerState(data !== undefined, error);
  if (alarmScopeSelectsNothing(scope)) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;
  if (answer === 'failed') return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (!data) return <WidgetMessage>Loading…</WidgetMessage>;
  return (
    <Ring
      slices={alarmTypePieModel(data.byType, names)}
      about={{ subject: 'alarm_types' }}
      ariaLabel={`${widget.title}: active alarms by type`}
      refreshFailed={answer === 'stale'}
      refreshNoun="alarms"
    />
  );
}

function Ring({ slices, about, ariaLabel, refreshFailed, refreshNoun }: {
  slices: PieSlice[];
  about: PieSubject;
  ariaLabel: string;
  refreshFailed: boolean;
  refreshNoun: RefreshNoun;
}) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const width = useBoxWidth(box);
  const plan = piePlan(slices, width);
  // Keyed on CONTENT, never on object identity: every poll hands new rows with
  // (usually) the same counts, and a new option is a full redraw that also
  // closes an open tooltip. Only what the legend does with the width reaches it.
  const signature = JSON.stringify([slices, about, plan]);
  const option = useMemo(() => buildPieOption(slices, about, plan), [signature]);

  if (slices.length === 0) return <WidgetMessage>{NOTHING_TO_SHOW}</WidgetMessage>;
  return (
    <div className="space-y-2">
      <WidgetNotes refreshFailed={refreshFailed} refreshNoun={refreshNoun} />
      <div ref={setBox}>
        <LazyEChart
          option={option}
          height={plan.height}
          ariaLabel={`${ariaLabel} — ${slices.map((s) => `${s.label} ${s.count}`).join(', ')}`}
        />
      </div>
    </div>
  );
}
