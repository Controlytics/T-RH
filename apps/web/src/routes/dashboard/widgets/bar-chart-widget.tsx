/**
 * Bar chart — the readings of each key binned into local hours, days or weeks
 * and aggregated on the SERVER, over the dashboard's window (or the widget's own
 * period, exactly as the trend chart follows it). Every bar is COMPUTED, and the
 * face says so: the caption under the title ("Daily average") and, per bar, the
 * readings behind it. The decisions are `bar-chart-model.ts`; this file asks,
 * and draws.
 *
 * What is drawn is always ONE answer, described by itself (fix round 1):
 *
 * - the bars, the notes and the caption all come from the answer on screen and
 *   the request it answered (`drawnDefinition`), so while a new window or a new
 *   definition loads, the held answer stays drawn as what it is — no note
 *   blinks off and no caption names bars that are not drawn (I-2, m-4);
 * - a REFUSAL (the 1,000-bucket cap) is printed in the server's own words, with
 *   the caption and the period still on screen so the window can be changed;
 * - a FAILED refresh keeps the bars only when the held answer still answers the
 *   widget as it stands (`heldAnswers`), and says so — the hook keeps retrying
 *   at the refresh cadence; any other held answer is not drawn (I-1).
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { CustomWidget } from '@digilog/shared';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { LazyEChart } from './charts/lazy-echart';
import {
  BAR_DEFAULTS, BAR_HEIGHT, barAxis, barCaption, barLoadProblem, barModel, barPlan, buildBarOption, drawnDefinition,
  heldAnswers, legendRows, tooManyBarsText,
} from './bar-chart-model';
import { isRefusal } from './refusal';
import { useTelemetryBuckets, type BucketRequest, type WidgetSelection } from './use-widget-data';
import {
  LOAD_FAILED, NO_INSTRUMENTS, NO_KEY_YET, PeriodSelect, WidgetMessage, WidgetNotes,
  useBoxWidth, useWidgetRange, useWidgetRows,
} from './widget-common';

export function BarChartWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  const { rows, loading, error, empty } = useWidgetRows(widget, selection);
  const { preset, setPreset, range, rolling } = useWidgetRange(widget.options.period, selection.window);
  const { formatDate, formatTime, formatDateTime } = useDatetimeFormat();
  const bucket = widget.options.bucket ?? BAR_DEFAULTS.bucket;
  const agg = widget.options.agg ?? BAR_DEFAULTS.agg;
  const groupBy = widget.options.groupBy ?? BAR_DEFAULTS.groupBy;
  const keys = widget.keys.filter((k) => k.source === 'telemetry');
  const plan = barPlan(rows, keys, groupBy);
  const askedIds = plan.asked.map((r) => r.instrumentId);
  const buckets = useTelemetryBuckets(askedIds, keys.map((k) => k.key), range, bucket, agg, groupBy);
  // The answer on hand, built in the terms of the request it ANSWERED — which,
  // while a new one loads, is not the widget as it stands (I-2).
  const drawn = buckets.data && buckets.request ? drawnDefinition(buckets.request, keys, rows) : null;
  const model = buckets.data && drawn
    ? barModel(buckets.data, drawn.keys, drawn.asked, drawn.groupBy, { formatDate, formatTime, formatDateTime })
    : null;
  // Keyed on the model's CONTENT, never on object identity: every poll (and, in
  // selection mode, every render) hands new objects with the same content, and a
  // new option is a full redraw that also closes an open tooltip.
  const signature = JSON.stringify(model);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const width = useBoxWidth(box);
  // Only how the labels stand and how many rows the legend takes reach the
  // option, so a resize that changes neither does not redraw.
  const { rotate, interval } = model ? barAxis(model, width) : { rotate: 0 as const, interval: 0 };
  const legendRowCount = legendRows(model?.series.map((s) => s.legendName) ?? [], width);
  const option = useMemo(
    () => (model ? buildBarOption(model, { rotate, interval }, legendRowCount) : null),
    [signature, rotate, interval, legendRowCount],
  );

  if (loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (error) return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (empty) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;
  if (plan.total === 0) return <WidgetMessage>{NO_KEY_YET}</WidgetMessage>;

  // What the widget asks now — the held answer is compared with this.
  const current: BucketRequest = {
    instrumentIds: askedIds, keys: keys.map((k) => k.key), from: range.from, to: range.to, bucket, agg, groupBy,
  };
  const failed = buckets.error !== undefined && buckets.error !== null;
  // A refusal never keeps bars; a failed refresh keeps them only for the widget as it stands.
  const holding = failed && !isRefusal(buckets.error) && buckets.request !== undefined && heldAnswers(buckets.request, current, rolling);
  const drawing = model !== null && option !== null && !plan.tooMany && (!failed || holding);
  // The caption describes the DRAWN bars (m-4); with none, what is being asked.
  const caption = drawing ? barCaption(model.bucket, model.agg) : barCaption(bucket, agg);

  let body: ReactNode = null;
  if (plan.tooMany) {
    body = <WidgetMessage>{tooManyBarsText(plan.tooMany.instruments, plan.tooMany.keys)}</WidgetMessage>;
  } else if (failed && !holding) {
    body = <WidgetMessage tone="error">{barLoadProblem(buckets.error)}</WidgetMessage>;
  } else if (drawing && model.series.length > 0) {
    body = (
      <div ref={setBox}>
        <LazyEChart
          option={option}
          height={BAR_HEIGHT}
          ariaLabel={`${widget.title}: ${caption} of ${model.series.map((s) => s.name).join(', ')}`}
        />
      </div>
    );
  } else if (!drawing && buckets.loading) {
    body = <WidgetMessage>Loading…</WidgetMessage>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* What the bars are: under the card title, before anything else. */}
        <p data-testid="bar-caption" className="mr-auto text-sm font-semibold text-slate-700">{caption}</p>
        <PeriodSelect name={`widget-period-${widget.id}`} value={preset} onChange={setPreset} withDashboard={selection.window !== undefined} />
      </div>
      {/* The notes describe the answer drawn, so they hold steady while the next one loads. */}
      <WidgetNotes
        cap={plan.tooMany ? undefined : { shown: plan.asked.length, total: plan.total, noun: 'instruments' }}
        unsent={drawing ? model.unsent : []}
        refreshFailed={holding}
      />
      {body}
    </div>
  );
}
