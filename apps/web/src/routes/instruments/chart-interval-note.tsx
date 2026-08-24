import { INTERVALS } from '@digilog/shared';

/**
 * The name of a client-side aggregation bucket, or `null` at raw.
 *
 * ONE source for this wording, shared by the on-screen note and the exported
 * PDF's disclosure. A screen saying "Averaged over 5 minutes" above a printout
 * that says something else — or says nothing — is the disagreement the
 * disclosure exists to prevent.
 */
export function intervalLabel(intervalMs: number | null): string | null {
  if (intervalMs === null) return null;
  return INTERVALS.find((i) => i.seconds !== null && i.seconds * 1000 === intervalMs)?.label
    ?? `${intervalMs / 1000}s`;
}

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
 * stored reading, so there is nothing to disclose. Since 2026-08-24 that is
 * also the DEFAULT (`DEFAULT_INTERVAL`), because the page used to open with an
 * averaged chart beside a raw table and no disclosure at all.
 */
export function ChartIntervalNote({ intervalMs }: { intervalMs: number | null }) {
  const label = intervalLabel(intervalMs);
  if (label === null) return null;
  return (
    <p className="mb-1.5 text-xs font-medium text-amber-700">
      Averaged over {label} — the table below shows every reading.
    </p>
  );
}
