/**
 * Bar chart — the readings of each key binned into local hours, days or weeks
 * and aggregated on the SERVER, over the dashboard's window (or the widget's own
 * period, exactly as the trend chart follows it). Every bar is COMPUTED, and the
 * face says so: the caption under the title ("Daily average") and, per bar, the
 * readings behind it. The decisions are `bar-chart-model.ts`; this file asks,
 * and draws.
 *
 * A refusal from the server (the 1,000-bucket cap) is printed in its own words,
 * with the caption and the period still on screen so the window can be changed.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { CustomWidget } from '@digilog/shared';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { LazyEChart } from './charts/lazy-echart';
import {
  BAR_DEFAULTS, BAR_HEIGHT, barCaption, barLoadProblem, barModel, barPlan, buildBarOption, legendRows, tooManyBarsText,
} from './bar-chart-model';
import { codeAxis } from './comparison-model';
import { useTelemetryBuckets, type WidgetSelection } from './use-widget-data';
import {
  CapNote, LOAD_FAILED, NO_INSTRUMENTS, NO_KEY_YET, NoReadingsNote, PeriodSelect, WidgetMessage,
  useBoxWidth, useWidgetRange, useWidgetRows,
} from './widget-common';

export function BarChartWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  const { rows, loading, error, empty } = useWidgetRows(widget, selection);
  const { preset, setPreset, range } = useWidgetRange(widget.options.period, selection.window);
  const { formatDate, formatDateTime } = useDatetimeFormat();
  const bucket = widget.options.bucket ?? BAR_DEFAULTS.bucket;
  const agg = widget.options.agg ?? BAR_DEFAULTS.agg;
  const groupBy = widget.options.groupBy ?? BAR_DEFAULTS.groupBy;
  const keys = widget.keys.filter((k) => k.source === 'telemetry');
  const plan = barPlan(rows, keys, groupBy);
  const buckets = useTelemetryBuckets(plan.asked.map((r) => r.instrumentId), keys.map((k) => k.key), range, bucket, agg, groupBy);
  const model = buckets.data ? barModel(buckets.data, keys, plan.asked, groupBy, { formatDate, formatDateTime }) : null;
  // Keyed on the model's CONTENT, never on object identity: every poll (and, in
  // selection mode, every render) hands new objects with the same content, and a
  // new option is a full redraw that also closes an open tooltip.
  const signature = JSON.stringify(model);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const width = useBoxWidth(box);
  // Only how the labels stand and how many rows the legend takes reach the
  // option, so a resize that changes neither does not redraw.
  const { rotate, interval } = codeAxis(model?.labels ?? [], width);
  const legendRowCount = legendRows(model?.series.map((s) => s.legendName) ?? [], width);
  const option = useMemo(
    () => (model ? buildBarOption(model, { rotate, interval }, legendRowCount) : null),
    [signature, rotate, interval, legendRowCount],
  );

  if (loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (error) return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (empty) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;
  if (plan.total === 0) return <WidgetMessage>{NO_KEY_YET}</WidgetMessage>;

  const caption = barCaption(bucket, agg);
  const capped = !plan.tooMany && plan.asked.length < plan.total;
  // While a new window loads, the bars on screen are the previous window's:
  // "No readings" is said only about the answer to the current request.
  const unsent = !plan.tooMany && !buckets.error && !buckets.loading ? model?.unsent ?? [] : [];
  let body: ReactNode = null;
  if (plan.tooMany) {
    body = <WidgetMessage>{tooManyBarsText(plan.tooMany.instruments, plan.tooMany.keys)}</WidgetMessage>;
  } else if (buckets.error) {
    // Never the previous window's bars under a request that failed.
    body = <WidgetMessage tone="error">{barLoadProblem(buckets.error)}</WidgetMessage>;
  } else if (!model || !option) {
    if (buckets.loading) body = <WidgetMessage>Loading…</WidgetMessage>;
  } else if (model.series.length > 0) {
    body = (
      <div ref={setBox}>
        <LazyEChart
          option={option}
          height={BAR_HEIGHT}
          ariaLabel={`${widget.title}: ${caption} of ${model.series.map((s) => s.name).join(', ')}`}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* What the bars are: under the card title, before anything else. */}
        <p data-testid="bar-caption" className="mr-auto text-sm font-semibold text-slate-700">{caption}</p>
        <PeriodSelect name={`widget-period-${widget.id}`} value={preset} onChange={setPreset} withDashboard={selection.window !== undefined} />
      </div>
      {/* The notes share ONE line where they fit: two stacked lines push the
          chart's dates out of the default panel (render check). */}
      {(capped || unsent.length > 0) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {capped && <CapNote shown={plan.asked.length} total={plan.total} noun="instruments" />}
          <NoReadingsNote labels={unsent} />
        </div>
      )}
      {body}
    </div>
  );
}
