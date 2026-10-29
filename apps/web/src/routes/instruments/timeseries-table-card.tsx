import type { ReactNode } from 'react';
import { Activity } from 'lucide-react';
import { formatDecimals } from '@digilog/shared';
import { outOfSpec } from '@/routes/dashboard/set-point';
import { isOutOfRange } from '@digilog/shared';
import { ExportMenu } from '@/components/ExportMenu';
import { Pagination } from '@/components/ui/pagination';
import type { TableRow as PivotRow } from './trend-series';

/**
 * The trend page's raw history, as a card — "Time Series (Raw Readings)".
 *
 * Restyled 2026-09-01 to an operator reference image (`Timeseries.png` at the
 * repo root): a ringed chart glyph and title, a gradient last-reading band, and
 * a table whose readings sit in tinted pills against a coloured row edge.
 *
 * Extracted from `trend.tsx` rather than grown inside it — that file was past
 * 1,200 lines and this widget carries a judgement (see `pillTone`) that has to
 * be unit-testable on its own.
 *
 * Four rules survive the restyle. Read them before touching this file:
 *
 * - **The colours are the app's own status vocabulary, not the mock's.** Green
 *   is `emerald`, a breach and a FAULT are both `red`, unjudged is `slate` —
 *   the same five-colour map `status.ts` defines and the floor plan, the
 *   dashboard table and the band gauges all print. A sixth palette invented
 *   here would have one reading look "green" on this card and a different green
 *   on the card above it.
 *
 * - **Every colour on a row is DERIVED, never decorative.** The reference image
 *   is arbitrary — it paints 24.2 °C red while 24.5 °C is green on the row
 *   above, and gives one row a red temperature beside a green humidity with no
 *   bound that could explain either. Reproducing that would assert excursions
 *   that never happened, on a §11 record. Each pill is coloured by ITS OWN
 *   slot's verdict against the limits the SERVER resolved.
 *
 * - **The timestamp goes through the page's `useDatetimeFormat` formatter**,
 *   passed in as `formatTs`. The date format, the clock and the TIMEZONE are
 *   administered (`/api/config/datetime/current`); this cell rendered
 *   `new Date(row.ts).toLocaleString()` until 2026-09-01, which silently
 *   ignored all three and printed the browser's own zone beside a page that
 *   printed the administered one everywhere else.
 *
 * - **Two controls in the reference are deliberately NOT here.** Its "Last
 *   Reading" dropdown and its funnel button have no defined semantics, and the
 *   page already carries a period selector and an interval selector a few rows
 *   above. A second range control on the same screen is two answers to one
 *   question. The BAND is what "Last Reading" was showing, so the band is what
 *   was built.
 */

/** Where one reading stands against the bounds actually in force for its slot. */
export type PillTone = 'in' | 'out' | 'unjudged';

/**
 * Colour verdict for a single reading.
 *
 * Pure and exported for the same reason `bandGaugeState` and `chartCardSubtitle`
 * are: the interesting cases are the administered ones, and none of them can be
 * checked by looking at a rendered page on this installation.
 *
 * **`unjudged` means NOTHING is checking this reading**, and it is the honest
 * answer in three situations that all reach here: an extra telemetry key, which
 * has no administered limits at all; an instrument with neither bound set; and
 * the moment before `trend.overview` has loaded, when the page has no limits to
 * judge against yet. Green must never stand in for any of them — "we have no
 * bound" and "checked, and inside it" are different claims.
 *
 * **A half-open band is JUDGED, and a passing reading in one is GREEN.** When
 * `Enable_Temp_NMT` is off the server nulls `tempMax` alone, and the alarm
 * evaluator goes on judging that same reading against `tempMin` — it will raise
 * a CRITICAL on a breach of it. Painting the pill neutral would have this card
 * say "nothing is checking this" about a value the alarm system is checking,
 * which is the browser-contradicts-server drift this codebase forbids. It is
 * also what the three existing readers of these bounds already do:
 * `outOfSpec()` returns false for a passing half-open band, `bandGaugeState()`
 * reports it as `assessed`, and `formatSetPoint()` prints it as a real spec
 * ("NMT 25.0").
 */
export function pillTone(
  value: number | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
): PillTone {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unjudged';
  // The ONE breach rule in this app, shared with the dashboard table and the
  // floor plan — never a `<`/`>` pair written out again here.
  if (outOfSpec(value, min, max)) return 'out';
  const bounded =
    (typeof min === 'number' && Number.isFinite(min)) ||
    (typeof max === 'number' && Number.isFinite(max));
  return bounded ? 'in' : 'unjudged';
}

/** Row-level verdict: the accent bar and the dot at the row's left edge. */
export type RowTone = PillTone | 'fault';

/**
 * The whole row's tone, from the tones of the cells in it.
 *
 * A breach outranks a fault, which outranks a pass. That order is the point: a
 * row where one probe died and the other genuinely breached its limit is first
 * of all a row with an excursion on it, and the fault must not downgrade how it
 * reads. A row where nothing is judged stays neutral rather than borrowing the
 * colour of a row that passed.
 */
export function rowTone(cells: PillTone[], hasFault: boolean): RowTone {
  if (cells.includes('out')) return 'out';
  if (hasFault) return 'fault';
  if (cells.includes('in')) return 'in';
  return 'unjudged';
}

/** The app's status palette, not a sixth one. See `routes/dashboard/status.ts`. */
export const PILL_CLASS: Record<PillTone, string> = {
  in: 'bg-emerald-50 text-emerald-700',
  out: 'bg-red-50 text-red-700',
  unjudged: 'bg-slate-100 text-slate-600',
};

/**
 * The row's edge bar AND its dot, from ONE map.
 *
 * Class names, not inline hexes. Two reasons, and the second is why this was
 * changed: the bar and the dot are the same mark in two shapes, so two colour
 * lists could drift and show a row a green bar beside a red dot; and React
 * serialises an inline `#10b981` to `rgb(16, 185, 129)` in the DOM, which made
 * the "no pass-green on an unjudged row" guard silently unable to see the bar
 * it was supposed to be guarding. A class name appears in the markup verbatim.
 */
/** Exported (2026-09-05) so the Instruments page's history widget paints a
 *  row's verdict with the SAME classes — one vocabulary for one mark. */
export const ROW_ACCENT: Record<RowTone, string> = {
  in: 'bg-emerald-500',
  out: 'bg-red-500',
  fault: 'bg-red-500',
  unjudged: 'bg-slate-300',
};

/** One administered slot, as this card needs it. `null` key = not administered. */
export interface SlotColumn {
  /**
   * The probe's declared span for this slot, and the word to print instead of a
   * reading that falls outside it.
   *
   * A reading beyond the span is NOT a measurement — `telemetry-overview.ts`
   * withholds it from the dashboard and the limit evaluator for exactly that
   * reason. This table reads the RAW telemetry path, which applies no such
   * filter, so until 2026-09-01 it was the one surface that printed a saturated
   * probe's number as though it were a reading.
   *
   * Null bounds mean the span is not declared, and then nothing is withheld.
   */
  rangeLow?: number | null;
  rangeHigh?: number | null;
  outOfRangeWord?: string;
  key: string | null;
  /**
   * Column heading, units included — "Temperature (°C)". ADMINISTERED, from
   * `trend-widgets`.
   *
   * This is the ONLY place a unit appears on this card. `unit`, `accent`, `icon`
   * and `last` used to sit beside it, feeding the last-reading BAND above the
   * table; the band went on 2026-09-01 and the per-value unit went with it,
   * because the heading already carries it. All four were left behind as props
   * that were passed, threaded and destructured but never rendered — removed
   * here. An unused prop is a decoy: the next reader wires something to it and
   * cannot see why nothing happens.
   */
  heading: string;
  /** Server-resolved display precision. Never derived in the browser. */
  decimals: number;
  min: number | null | undefined;
  max: number | null | undefined;
}

/**
 * An extra key's column (widget data keys phase 3): the profile's display key,
 * printed from the RAW stored value by `cell` — never through the slot rules
 * above, so a text reading is shown as text and never as the failure word.
 */
export interface ExtraColumn {
  key: string;
  heading: string;
  cell: (raw: unknown) => { text: string; tone: PillTone };
}

export interface TimeseriesTableCardProps {
  /** This page of raw history, newest first. */
  rows: PivotRow[];
  /** The profile's extra keys, after the slot columns. They do not set the row's tone. */
  extraColumns?: ExtraColumn[];
  /** The RAW stored value of `key` at `ts`; undefined / null prints `—`. */
  extraRaw?: (ts: string, key: string) => unknown;
  /** Temperature then humidity, in that order. A slot with a null `key` is
   *  skipped entirely — the instrument does not report it. */
  slots: SlotColumn[];
  /** User-selected extra telemetry keys, one column each. No administered
   *  limits or precision exist for these, so they render unjudged. */
  /** Fallback precision for the extra keys. */
  /** The ADMINISTERED word for a reading that arrived and was not a number.
   *  Never defaulted to a literal here — the page resolves it from config. */
  failureWord: string;
  /** The page's own `useDatetimeFormat` formatter, already carrying this
   *  widget's administered format override. */
  formatTs: (ts: string) => string;
  /**
   * This card's ADMINISTERED wording — title, the line under it, and the first
   * column's heading.
   *
   * Passed in, never defaulted here. `trendWidgetLabel()` has already resolved a
   * blank field to the shipped wording, so these are guaranteed non-empty and a
   * `?? 'Timestamp'` in this file would be a second, drifting definition of the
   * default. The two slot columns carry their own `heading`, administered the
   * same way.
   */
  title: string;
  subtitle: string;
  timestampHeading: string;
  /** The SUPER_ADMIN edit affordance for the wording above. Rendered by the
   *  page, so this card keeps no role check and no write path. */
  settingsButton?: ReactNode;
  /** Fires the §11 time-series report download. */
  onExportPdf: () => void;
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
}

export function TimeseriesTableCard({
  rows, slots, failureWord, formatTs, title, subtitle, timestampHeading,
  settingsButton = null, extraColumns = [], extraRaw,
  onExportPdf, page, pageSize, totalItems, onPageChange,
}: TimeseriesTableCardProps) {
  const columns = slots.filter((s): s is SlotColumn & { key: string } => s.key !== null);

  const th = 'px-4 py-3 text-left text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-slate-600';

  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-1)]">
      {/* The site band (2026-09-25, operator: "time series in other pages …
          all pages should colorful"): white words on `--band-gradient`, the
          table below stays white. */}
      <header className="widget-band flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3.5">
          {/* The disc: glass on the band, the theme's own primary on the icon. */}
          <span
            className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white/90 ring-1 ring-white/40"
            style={{ color: 'var(--theme-primary, #4f46e5)' }}
            aria-hidden="true"
          >
            <Activity className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-lg font-bold tracking-tight text-white">
              {title}
            </h3>
            <p className="mt-0.5 truncate text-[0.8125rem] text-white/80">
              {subtitle}
            </p>
          </div>
        </div>
        {/* The EXISTING export, icon-only for a header with no room for a
            label. Its `reportType` is untouched: three downloads on this page
            logged as one would leave a §11 audit trail that cannot say which
            report a given row was. */}
        <div className="flex shrink-0 items-center gap-2">
          <ExportMenu surface="instrument-trend" iconOnly onExportPdf={onExportPdf} />
          {settingsButton}
        </div>
      </header>

      {/* The separate last-reading band was REMOVED 2026-09-01 (operator).
          The table below already opens with the newest row, so the band
          restated the same two numbers directly above them. */}

      {rows.length === 0 ? (
        <p className="px-6 pb-4 text-sm text-slate-500">No readings in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl-grid w-full border-collapse text-[0.9375rem]">
            <thead>
              {/* A tint of the active theme, not the reference's fixed lavender,
                  so the band follows all ten colour presets — the same call the
                  Alarms page's table banner makes. */}
              <tr style={{ backgroundColor: 'color-mix(in srgb, var(--theme-primary, #4f46e5) 8%, #ffffff)' }}>
                <th scope="col" className={`${th} pl-6`}>{timestampHeading}</th>
                {/* Value columns are CENTRED, heading and cells together
                    (operator, 2026-09-01). A reading, a fault word and an
                    out-of-range word share one column and must sit on the same
                    axis — centring only the fault left `OL` off-line from the
                    numbers above and below it. The timestamp stays left: it is
                    read as text, not compared down the column. */}
                {columns.map((s) => (
                  <th key={s.key} scope="col" className={`${th} !text-center`}>{s.heading}</th>
                ))}
                {extraColumns.map((c) => (
                  <th key={`extra-${c.key}`} scope="col" className={`${th} !text-center`}>{c.heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                // Out of span FIRST: such a reading is withheld everywhere else,
                // so it must not be judged against the spec limits here either —
                // that would paint a saturated probe red for a breach nobody can
                // act on, when the honest answer is that there is no measurement.
                const outOfSpan = columns.map((s) => {
                  const v = row.values[s.key];
                  return typeof v === 'number'
                    && isOutOfRange(v, s.rangeLow ?? null, s.rangeHigh ?? null);
                });
                const tones = columns.map((s, i) => (
                  outOfSpan[i] ? 'unjudged' as const : pillTone(row.values[s.key], s.min, s.max)
                ));
                const faulted = columns.some((s, i) => outOfSpan[i] || row.errors?.[s.key]);
                const tone = rowTone(tones, faulted);
                return (
                  <tr
                    key={row.ts}
                    data-testid="ts-row"
                    data-tone={tone}
                    className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/70"
                  >
                    <td className="relative py-3.5 pl-6 pr-4">
                      {/* Inset rather than a `border-left`, so consecutive rows
                          of the same verdict stay separate marks instead of
                          fusing into one continuous stripe down the table —
                          which on a page of all-green rows reads as a single
                          decorative rule and stops saying anything per row. */}
                      <span
                        className={`absolute bottom-1 left-0 top-1 w-1 rounded-r-sm ${ROW_ACCENT[tone]}`}
                        aria-hidden="true"
                      />
                      <span className="flex items-center gap-3">
                        <span
                          className={`h-2.5 w-2.5 shrink-0 rounded-full ${ROW_ACCENT[tone]}`}
                          aria-hidden="true"
                        />
                        <span data-testid="ts-timestamp" className="text-sm text-slate-700">
                          {formatTs(row.ts)}
                        </span>
                      </span>
                    </td>
                    {columns.map((s, i) => (
                      <ValueCell
                        key={s.key}
                        columnKey={s.key}
                        value={row.values[s.key]}
                        decimals={s.decimals}
                        tone={tones[i]}
                        faulted={row.errors?.[s.key] === true}
                        outOfRangeWord={outOfSpan[i] ? s.outOfRangeWord : null}
                        failureWord={failureWord}
                      />
                    ))}
                    {extraColumns.map((c) => {
                      const raw = extraRaw?.(row.ts, c.key);
                      if (raw === undefined || raw === null) {
                        return (
                          <td key={`extra-${c.key}`} className="px-4 py-3.5 text-center">
                            <span data-testid={`ts-extra-${c.key}`} className="text-sm text-slate-400">—</span>
                          </td>
                        );
                      }
                      const { text, tone: extraTone } = c.cell(raw);
                      return (
                        <td key={`extra-${c.key}`} className="px-4 py-3.5 text-center">
                          <span
                            data-testid={`ts-extra-${c.key}`}
                            data-tone={extraTone}
                            className={`inline-flex rounded-lg px-3 py-1.5 text-sm font-semibold tabular-nums ${PILL_CLASS[extraTone]}`}
                          >
                            {text}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} pageSize={pageSize} totalItems={totalItems} onPageChange={onPageChange} />
    </section>
  );
}

/**
 * The fault pill. ONE definition, so `Error` and `OL` cannot drift apart in
 * shape or tint — they are the same statement and must look the same.
 * `justify-center` on the cell is what centres them.
 */
export const FAULT_PILL = 'inline-flex rounded-lg px-3 py-1.5 text-sm font-semibold bg-red-50 text-red-700';

interface ValueCellProps {
  columnKey: string;
  value: number | null | undefined;
  decimals: number;
  tone: PillTone;
  faulted: boolean;
  failureWord: string;
  /** Set when this reading falls outside the probe's declared span. Carries the
   *  administered word to print in place of it. */
  outOfRangeWord?: string | null;
}

/**
 * One reading, in its pill.
 *
 * A FAULT IS A PILL TOO, and the same pill for both words (operator,
 * 2026-09-01). `Error` and `OL` now render identically — one box, one colour,
 * centred — because they are one class of answer: this probe is not measuring.
 *
 * This REVERSES the rule that stood here before, which kept a fault unpilled so
 * that "a word standing in for a number" could not be mistaken for a reading.
 * That distinction is now carried by the WORD rather than the shape: no number
 * appears, and both words are administered. Recorded because the reasoning was
 * deliberate and someone will otherwise reinstate it.
 *
 * Red, not amber: a dead or saturated probe is not a caution — nothing is being
 * measured, and on a monitoring screen that ranks with a breach, not below it.
 */
function ValueCell({
  columnKey, value, decimals, tone, faulted, failureWord, outOfRangeWord,
}: ValueCellProps) {
  /**
   * OUT OF SPAN BEATS THE NUMBER, and is checked before the fault branch is
   * reached for the same reason `faultWord()` puts range ahead of failure: an
   * out-of-range value IS a number, it is simply not a measurement.
   *
   * Printing it would make this table the one surface disagreeing with the rest
   * of the app — `telemetry-overview.ts` withholds such a reading from the
   * dashboard, the tiles and the limit evaluator, and the alarm raised for it
   * says the probe was saturated. A row showing `60.0` beside an alarm saying
   * the same instant was out of range is a §11 record contradicting itself.
   *
   * Amber and unpilled, like a fault: both stand in for a reading that cannot
   * be trusted, and a rounded tint is reserved for values that can.
   */
  if (outOfRangeWord) {
    return (
      <td className="px-4 py-3.5 text-center">
        <span data-testid={`ts-value-${columnKey}`} data-tone="fault" className={FAULT_PILL}>
          {outOfRangeWord}
        </span>
      </td>
    );
  }
  if (faulted) {
    return (
      <td className="px-4 py-3.5 text-center">
        <span data-testid={`ts-value-${columnKey}`} data-tone="fault" className={FAULT_PILL}>
          {failureWord}
        </span>
      </td>
    );
  }
  if (value == null) {
    return (
      <td className="px-4 py-3.5 text-center">
        <span data-testid={`ts-value-${columnKey}`} data-tone="none" className="text-sm text-slate-400">—</span>
      </td>
    );
  }
  return (
    <td className="px-4 py-3.5 text-center">
      <span
        data-testid={`ts-value-${columnKey}`}
        data-tone={tone}
        className={`inline-flex rounded-lg px-3 py-1.5 text-sm font-semibold tabular-nums ${PILL_CLASS[tone]}`}
      >
        {/* No unit here (operator, 2026-09-01): the column HEADING already
            carries it — "Temperature (°C)" — and repeating it on every row
            states one fact once per reading. It also crowds the pill, which now
            has to hold a fault word of the operator's own length. */}
        {formatDecimals(value, decimals)}
      </span>
    </td>
  );
}
