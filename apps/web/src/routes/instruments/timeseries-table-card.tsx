import type { ReactNode } from 'react';
import { Activity } from 'lucide-react';
import { formatDecimals } from '@digilog/shared';
import { outOfSpec } from '@/routes/dashboard/set-point';
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
 *   is `emerald`, a breach is `red`, a fault is `amber`, unjudged is `slate` —
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
const PILL_CLASS: Record<PillTone, string> = {
  in: 'bg-emerald-50 text-emerald-700',
  out: 'bg-red-50 text-red-700',
  unjudged: 'bg-slate-100 text-slate-600',
};

/**
 * The row's edge bar AND its dot, from ONE map.
 *
 * Class names, not inline hexes. Two reasons, and the second is why this was
 * changed: the bar and the dot are the same mark in two shapes, so two colour
 * lists could drift and show a row a green bar beside an amber dot; and React
 * serialises an inline `#10b981` to `rgb(16, 185, 129)` in the DOM, which made
 * the "no pass-green on an unjudged row" guard silently unable to see the bar
 * it was supposed to be guarding. A class name appears in the markup verbatim.
 */
const ROW_ACCENT: Record<RowTone, string> = {
  in: 'bg-emerald-500',
  out: 'bg-red-500',
  fault: 'bg-amber-500',
  unjudged: 'bg-slate-300',
};

/** One administered slot, as this card needs it. `null` key = not administered. */
export interface SlotColumn {
  key: string | null;
  /** Column heading, units included — "Temperature (°C)". */
  heading: string;
  /** The unit alone, for the summary band's big number. */
  unit: string;
  /** Server-resolved display precision. Never derived in the browser. */
  decimals: number;
  min: number | null | undefined;
  max: number | null | undefined;
  /** Series identity — the palette slot this quantity owns app-wide. */
  accent: string;
  /** The quantity's glyph, drawn in the band's disc. Passed in rather than
   *  chosen here from `unit`: sniffing the string would hand humidity a
   *  thermometer the day somebody administers "degC" or "°F". */
  icon: ReactNode;
  /** The latest STORED reading in the period, for the band. */
  last: number | null;
}

export interface TimeseriesTableCardProps {
  /** This page of raw history, newest first. */
  rows: PivotRow[];
  /** Temperature then humidity, in that order. A slot with a null `key` is
   *  skipped entirely — the instrument does not report it. */
  slots: SlotColumn[];
  /** User-selected extra telemetry keys, one column each. No administered
   *  limits or precision exist for these, so they render unjudged. */
  extraKeys: string[];
  /** Fallback precision for the extra keys. */
  extraDecimals: number;
  /** The ADMINISTERED word for a reading that arrived and was not a number.
   *  Never defaulted to a literal here — the page resolves it from config. */
  failureWord: string;
  /** The page's own `useDatetimeFormat` formatter. */
  formatTs: (ts: string) => string;
  /** Fires the §11 time-series report download. */
  onExportPdf: () => void;
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
}

export function TimeseriesTableCard({
  rows, slots, extraKeys, extraDecimals, failureWord, formatTs,
  onExportPdf, page, pageSize, totalItems, onPageChange,
}: TimeseriesTableCardProps) {
  const columns = slots.filter((s): s is SlotColumn & { key: string } => s.key !== null);
  const bandSlots = columns.filter((s) => s.last !== null);

  const th = 'px-4 py-3 text-left text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-slate-600';

  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-1)]">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3.5">
          {/* The pastel disc, tinted from the active theme rather than the
              reference's fixed lilac — this card is not about one quantity, so
              it takes the site's own accent the way every other neutral
              chrome element on the page does. */}
          <span
            className="grid h-12 w-12 shrink-0 place-items-center rounded-full"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--theme-primary, #4f46e5) 14%, #ffffff)',
              color: 'var(--theme-primary, #4f46e5)',
            }}
            aria-hidden="true"
          >
            <Activity className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-lg font-bold tracking-tight text-slate-900">
              Time Series (Raw Readings)
            </h3>
            <p className="mt-0.5 truncate text-[0.8125rem] text-slate-500">
              Detailed list of raw sensor readings
            </p>
          </div>
        </div>
        {/* The EXISTING export, icon-only for a header with no room for a
            label. Its `reportType` is untouched: three downloads on this page
            logged as one would leave a §11 audit trail that cannot say which
            report a given row was. */}
        <div className="flex shrink-0 items-center gap-2">
          <ExportMenu surface="instrument-trend" iconOnly onExportPdf={onExportPdf} />
        </div>
      </header>

      {/* The last-reading band. It is what the reference's "Last Reading"
          control was displaying, and it reads the SAME `latestValueForKey`
          value the chart cards' "Last Reading" box does — never `rows[0]`,
          which is only the newest row of the page currently shown and would
          make this band change when the operator turns to page 2. */}
      {bandSlots.length > 0 && (
        <div
          data-testid="ts-last-reading-band"
          className={
            'mx-5 mb-4 grid items-center gap-y-6 rounded-[var(--radius-card)] px-6 py-5'
            // Each quantity takes half the band, with the rule between them —
            // the two are peers and a packed-left pair reads as one block with
            // an afterthought beside it. One slot keeps the full width.
            + (bandSlots.length > 1 ? ' sm:grid-cols-2' : '')
          }
          style={{
            backgroundImage:
              `linear-gradient(100deg,`
              + ` color-mix(in srgb, ${bandSlots[0].accent} 10%, #ffffff),`
              + ` color-mix(in srgb, ${bandSlots[bandSlots.length - 1].accent} 12%, #ffffff))`,
          }}
        >
          {bandSlots.map((slot, i) => (
            <div
              key={slot.key}
              className={
                'flex items-center gap-4'
                + (i > 0 ? ' sm:border-l sm:border-slate-300/80 sm:pl-10' : '')
              }
            >
              <span
                className="grid h-14 w-14 shrink-0 place-items-center rounded-full"
                style={{
                  backgroundColor: `color-mix(in srgb, ${slot.accent} 16%, #ffffff)`,
                  color: slot.accent,
                }}
                aria-hidden="true"
              >
                {slot.icon}
              </span>
              <div>
                <p
                  className="text-[0.6875rem] font-bold uppercase tracking-[0.08em]"
                  style={{ color: slot.accent }}
                >
                  {slot.heading.replace(/\s*\(.*\)$/, '')}
                </p>
                <p className="mt-0.5 text-[1.75rem] font-bold leading-none tracking-tight text-slate-900 tabular-nums">
                  {formatDecimals(slot.last, slot.decimals)}
                  <span className="ml-1.5 text-base font-semibold" style={{ color: slot.accent }}>
                    {slot.unit}
                  </span>
                </p>
                <p className="mt-1.5 text-[0.8125rem] text-slate-500">Last Reading</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="px-6 pb-4 text-sm text-slate-500">No readings in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              {/* A tint of the active theme, not the reference's fixed lavender,
                  so the band follows all ten colour presets — the same call the
                  Alarms page's table banner makes. */}
              <tr style={{ backgroundColor: 'color-mix(in srgb, var(--theme-primary, #4f46e5) 8%, #ffffff)' }}>
                <th scope="col" className={`${th} pl-6`}>Timestamp</th>
                {columns.map((s) => <th key={s.key} scope="col" className={th}>{s.heading}</th>)}
                {extraKeys.map((k) => <th key={k} scope="col" className={th}>{k}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const tones = columns.map((s) => pillTone(row.values[s.key], s.min, s.max));
                const faulted = [...columns.map((s) => s.key), ...extraKeys]
                  .some((k) => row.errors?.[k]);
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
                        unit={s.unit}
                        tone={tones[i]}
                        faulted={row.errors?.[s.key] === true}
                        failureWord={failureWord}
                      />
                    ))}
                    {extraKeys.map((k) => (
                      <ValueCell
                        key={k}
                        columnKey={k}
                        value={row.values[k]}
                        decimals={extraDecimals}
                        unit=""
                        // An extra key carries no administered bound, so nothing
                        // is judging it and it is never painted as a pass.
                        tone="unjudged"
                        faulted={row.errors?.[k] === true}
                        failureWord={failureWord}
                      />
                    ))}
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

interface ValueCellProps {
  columnKey: string;
  value: number | null | undefined;
  decimals: number;
  unit: string;
  tone: PillTone;
  faulted: boolean;
  failureWord: string;
}

/**
 * One reading, in its pill.
 *
 * A fault is NOT a pill: the administered word stands in for a number that
 * never arrived, and putting it in the same rounded tint as a measurement would
 * dress a missing reading as a taken one. It keeps the amber the rest of the
 * app gives "cannot confirm this".
 */
function ValueCell({ columnKey, value, decimals, unit, tone, faulted, failureWord }: ValueCellProps) {
  if (faulted) {
    return (
      <td className="px-4 py-3.5">
        <span data-testid={`ts-value-${columnKey}`} data-tone="fault" className="text-sm font-semibold text-amber-700">
          {failureWord}
        </span>
      </td>
    );
  }
  if (value == null) {
    return (
      <td className="px-4 py-3.5">
        <span data-testid={`ts-value-${columnKey}`} data-tone="none" className="text-sm text-slate-400">—</span>
      </td>
    );
  }
  return (
    <td className="px-4 py-3.5">
      <span
        data-testid={`ts-value-${columnKey}`}
        data-tone={tone}
        className={`inline-flex rounded-lg px-3 py-1.5 text-sm font-semibold tabular-nums ${PILL_CLASS[tone]}`}
      >
        {formatDecimals(value, decimals)}{unit ? ` ${unit}` : ''}
      </span>
    </td>
  );
}
