/**
 * "Showing 2,000 of 28,431 readings."
 *
 * Rendered under a chart whose range held more readings than were plotted. Plain
 * text, in the flow, because a chart that is showing a subset must say so where the
 * reader is already looking — a tooltip or an icon lets the page imply a resolution
 * it does not have.
 *
 * Renders NOTHING when nothing was dropped, so a 1-hour view carries no noise.
 */
export function SampledNote({ shown, total }: { shown: number; total: number }) {
  if (total <= 0 || shown >= total) return null;
  const n = (v: number) => v.toLocaleString();
  return (
    <p className="mt-1 text-xs text-slate-500">
      Showing {n(shown)} of {n(total)} readings. Zoom in to see every reading for a shorter period.
    </p>
  );
}
