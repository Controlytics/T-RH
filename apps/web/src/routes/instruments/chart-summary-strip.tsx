import { formatDecimals } from '@digilog/shared';
import type { TelemetrySummary } from './use-trend-data';

/**
 * Current / Minimum / Maximum / Average, under one chart, over the selected range.
 *
 * WHERE EACH NUMBER COMES FROM, because that is the whole point of this strip:
 *
 *  - `Minimum` / `Maximum` / `Average` come from the SERVER's per-key summary,
 *    computed in SQL over EVERY reading in the range. They are never derived
 *    from the plotted points. The plotted series is an LTTB sample of the
 *    range and, when a chart interval is selected, a set of bucket MEANS on top
 *    of that — a maximum taken from it can sit below a limit the same period
 *    breached, which is the §11 defect this strip exists to avoid repeating on
 *    screen after it was fixed in the printed report.
 *
 *  - `Current` cannot come from the summary: the endpoint returns `first`/`last`
 *    as TIMESTAMPS, not value+timestamp pairs. It is therefore the latest STORED
 *    reading in the range, taken from the raw rows — deliberately not the last
 *    plotted point, which is a bucket mean whenever an interval is selected, and
 *    labelling a mean "Current" would be the same misrepresentation in miniature.
 *
 * Renders NOTHING without a server summary for the key. A row of dashes reads as
 * a measurement of an empty period; absence says less and says it truthfully.
 */
export function ChartSummaryStrip({
  summary, current, decimals, unit,
}: {
  summary: TelemetrySummary | undefined;
  /** Latest stored reading in the range, or null when the range holds none. */
  current: number | null;
  decimals: number;
  unit: string;
}) {
  if (!summary) return null;
  const v = (n: number) => `${formatDecimals(n, decimals) ?? '—'}${unit ? ` ${unit}` : ''}`;

  const cells: { label: string; value: string }[] = [
    { label: 'Current', value: current === null ? '—' : v(current) },
    { label: 'Minimum', value: v(summary.min) },
    { label: 'Maximum', value: v(summary.max) },
    { label: 'Average', value: v(summary.avg) },
  ];

  return (
    <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label}>
          <dt className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500">{c.label}</dt>
          <dd className="text-sm font-medium tabular-nums text-slate-800">{c.value}</dd>
        </div>
      ))}
    </dl>
  );
}
