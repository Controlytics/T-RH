/**
 * The colours every ECharts option is built with — passed EXPLICITLY, so no chart
 * ever falls back to ECharts' own palette or theme.
 *
 * Hex, not the `var(--chart-*, #…)` strings the hand-drawn SVG charts use:
 * ECharts parses a colour to derive its hover and opacity shades and writes it
 * into SVG attributes, and a `var()` survives neither. The hex is each
 * variable's own LITERAL FALLBACK, so these charts print exactly what the PDF
 * export prints — and, like the PDF, they will not follow a future theme that
 * redefines `--chart-series-*` (the accepted limitation in apps/web/CLAUDE.md).
 */
import type { InstrumentStatus } from '@digilog/shared';
import { SERIES_COLORS } from '../../time-series-chart';

/** The `#rrggbb` fallback inside `var(--name, #rrggbb)`; a palette entry without one is a defect, not a default. */
function literalFallback(cssColor: string): string {
  const m = /,\s*(#[0-9a-fA-F]{6})\s*\)\s*$/.exec(cssColor);
  if (!m) throw new Error(`chart-colors: no literal fallback in "${cssColor}"`);
  return m[1];
}

/** The series palette, in its order — derived from `SERIES_COLORS`, never a second copy. */
export const SERIES_HEX: readonly string[] = SERIES_COLORS.map(literalFallback);

/**
 * The status palette of `routes/dashboard/status.ts` (each status's `dot` class)
 * and `UNJUDGED_CLASSES` (`widgets/key-value.ts`), as hex: Tailwind v4.1 palette
 * values (oklch in `tailwindcss/theme.css`) converted to sRGB. Source per key:
 * OUT_OF_SPEC red-500, STALE / PARTIAL amber-500, NO_DATA slate-400,
 * OK emerald-500, NOT_JUDGED slate-300. `chart-colors.test.ts` pins each class.
 */
export const STATUS_HEX: Readonly<Record<InstrumentStatus | 'NOT_JUDGED', string>> = {
  OUT_OF_SPEC: '#fb2c36',
  STALE: '#fe9a00',
  PARTIAL: '#fe9a00',
  NO_DATA: '#90a1b9',
  OK: '#00bc7d',
  NOT_JUDGED: '#cad5e2',
};

/** A value nothing judges (a raw key's gauge ring): the "Not judged" colour, never a status one. */
export const NEUTRAL_HEX = STATUS_HEX.NOT_JUDGED;

/**
 * The page's own greys, for a chart's axes, gridlines, legend and tooltip — so a
 * chart's chrome is the app's slate, never ECharts' own. Tailwind v4.1 slate
 * values in sRGB, like STATUS_HEX. None of them is a status colour: the slate
 * the status palette uses for No data (slate-400) is deliberately absent.
 */
export const CHART_INK = {
  /** slate-900 — a tooltip's heading and figures. */
  strong: '#0f172b',
  /** slate-600 — category labels, legend. */
  body: '#45556c',
  /** slate-500 — value-axis labels, the axis name. */
  muted: '#62748e',
  /** slate-200 — gridlines, the tooltip's border. */
  rule: '#e2e8f0',
  /** slate-300 — the category axis line. */
  axis: '#cad5e2',
} as const;

/**
 * The page's font stack (`--font-body` in `app.css`), written out for
 * `textStyle.fontFamily`: ECharts measures its text to lay it out, and a `var()`
 * measures as nothing. Inter is self-hosted, so the SVG text renders in it.
 * `chart-colors.test.ts` reads app.css and pins the two together.
 */
export const CHART_FONT_FAMILY = "'Inter Variable', Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
