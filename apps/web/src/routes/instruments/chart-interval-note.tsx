import { INTERVALS } from '@digilog/shared';

/**
 * The averaging disclosure for a trend chart.
 *
 * When `intervalMs` bucket-averages a chart's points client-side (see
 * `trend-series.ts`'s `toChartSeries` — no server-side aggregation endpoint
 * exists for this yet), a plotted point is a DERIVED number, not a stored
 * reading, and on screen it is otherwise indistinguishable from one. On a
 * 21 CFR Part 11 surface that is a misrepresentation the operator has no way
 * to see, so it is stated in plain language next to the chart it applies to —
 * not left to a code comment or a tooltip that has to be found.
 *
 * Renders nothing at `intervalMs === null` (raw): every plotted point IS a
 * stored reading, so there is nothing to disclose.
 */
export function ChartIntervalNote({ intervalMs }: { intervalMs: number | null }) {
  if (intervalMs === null) return null;
  const spec = INTERVALS.find((i) => i.seconds !== null && i.seconds * 1000 === intervalMs);
  const label = spec?.label ?? `${intervalMs / 1000}s`;
  return (
    <p className="mb-1.5 text-xs font-medium text-amber-700">
      Averaged over {label} — the table below shows every reading.
    </p>
  );
}
