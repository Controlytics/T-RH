import type { ReactElement, ReactNode } from 'react';
import { Check, Clock, Minus, TriangleAlert } from 'lucide-react';
import { formatDecimals, type InstrumentStatus } from '@digilog/shared';
import { formatSetPoint, quantityVerdict } from '@/routes/dashboard/set-point';
import { FAULT_INK, statusClasses } from '@/routes/dashboard/status';
import { bandGaugeState, finite } from './band-gauge-state';

/**
 * The latest-value card — this page's signature element.
 *
 * In GMP monitoring nothing is "a value"; everything is a value INSIDE A BAND.
 * A bare number withholds the one thing an operator actually wants to know —
 * how close to the limit is it — so the reading is drawn as an ARC around its
 * own icon, swept to the reading's position between the two bounds, and those
 * bounds are named in full beneath it.
 *
 * The arc is not a progress bar. A progress bar answers "how much of a whole";
 * this answers "where inside an allowed range", which is the only question this
 * page's subject has. The operator's reference drew an arc that encodes nothing
 * (two disjoint arcs on one card, one on the other, neither matching the
 * reading); an arc around a number in a monitoring product reads as a gauge
 * whether or not it is one, so this one is wired to the band rather than left
 * decorative.
 *
 * Nothing here re-derives a limit or a decimal place. Both arrive resolved on
 * the telemetry-overview payload (instrument attributes, else the room), and
 * the alarm evaluator reads the same resolution — a second derivation in the
 * browser is how a gauge comes to contradict the alarm printed beside it.
 */

export { bandGaugeState, type BandGaugeState } from './band-gauge-state';

/** "4.4" — a headroom figure at the slot's own precision, never a raw float. */
function figure(n: number, decimals: number): string {
  return formatDecimals(Math.abs(n), decimals) ?? '—';
}

const OUT_OF_LIMIT = '#DC2626';

/** The three footer captions, which carry their own colour at each call site. */
const CELL_LABEL = 'flex items-center gap-1.5 text-[0.75rem] font-semibold uppercase tracking-[0.06em]';

/**
 * The reading's three size steps, EXPORTED because the tests assert two of them
 * as absences.
 *
 * `steps the reading down a size` checks that a long value is NOT rendered at
 * `big`. Written as a literal, that assertion silently stops testing anything
 * the moment the sizes change — it would pass against a card whose big size no
 * longer exists. Importing the constant makes the test move with the design.
 *
 * Shrunk 2026-09-01 (operator: decrease the latest-value card size). Every
 * dimension on this card came down together; changing the number alone would
 * have left it crowding an icon and a panel built around the old scale.
 */
export const READING_SIZE = {
  big: 'text-[3.25rem]',
  mid: 'text-[2.25rem]',
  small: 'text-[1.5rem]',
} as const;

/** The arc geometry, in the icon's own 84×84 viewBox. */
const ARC_R = 40;
const ARC_C = 2 * Math.PI * ARC_R;

/** A solid triangle — the reference's bound markers. Lucide's is an outline. */
function Bound({ dir }: { dir: 'up' | 'down' }) {
  return (
    <svg viewBox="0 0 10 8" className="h-2.5 w-3" fill="currentColor" aria-hidden="true">
      <path d={dir === 'up' ? 'M5 0 10 8 0 8Z' : 'M5 8 0 0 10 0Z'} />
    </svg>
  );
}

/**
 * The glyph inside the status disc.
 *
 * Decoration that reinforces the disc's colour — the WORD beside it is what
 * carries the meaning, so this only has to tell "fine" from "look at this"
 * from "nothing to judge".
 */
function StatusGlyph({ status }: { status: InstrumentStatus | null }) {
  if (status === 'OK') return <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />;
  if (status === null || status === 'NO_DATA') return <Minus className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />;
  return <TriangleAlert className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />;
}

export interface BandGaugeProps {
  label: string;
  unit: string;
  reading: { value: number; ts: string } | null;
  decimals: number;
  min: number | null | undefined;
  max: number | null | undefined;
  /**
   * The attribute's own TEXT for each bound (`60 (For Reference)`), from the
   * server's `limitText` — printed in the bound cell in the number's place,
   * without the unit (the unit belongs to a number; the text may carry its
   * own). Null / absent = the number at the precision (operator, 2026-10-03).
   */
  minText?: string | null;
  maxText?: string | null;
  limitSource: 'INSTRUMENT' | 'ROOM' | null;
  roomCode: string | null;
  /**
   * The INSTRUMENT's server-resolved status, taken as given.
   *
   * Staleness is decided server-side (against `expectedIntervalSec`) and cannot
   * be re-derived here from a timestamp — and the header prints that same word
   * a few rows above this card. Without it, a probe that stopped reporting
   * four hours ago reads "Offline" in the header and "In limit" in the
   * card: two judgements of one instrument on one screen.
   */
  instrumentStatus?: InstrumentStatus | null;
  /** Series identity — the palette slot this quantity owns app-wide. */
  accent: string;
  /** The quantity's glyph, drawn inside the ring. */
  icon?: ReactNode;
  /**
   * This slot reported something that is NOT a number — a broken RS485 probe
   * sending `NA`. Decided on the SERVER, never by inspecting the value here.
   */
  sensorError?: boolean;
  /** This slot reported a number outside the probe's measurable span. */
  rangeError?: boolean;
  /**
   * Renders the reading's timestamp — the page's OWN `useDatetimeFormat`
   * formatter, passed in.
   *
   * The date format, the clock and the TIMEZONE are administered
   * (`/api/config/datetime/current`), so a `toLocaleString` here would be a
   * second opinion about them and would drift the moment somebody changes the
   * setting. Absent, the raw stored ISO string is shown: that is the record
   * itself, and a wrong-but-plausible local format would be worse.
   */
  formatTs?: (ts: string) => string;
  /**
   * The administered words for those two faults. Absent falls back to the
   * SHARED constants inside `faultWord` — never to a literal in this file.
   */
  sensorWords?: { failure: string; outOfRange: string };
  /** Page-load stagger, ms. The sweep itself is in CSS (`.band-arc`). */
  delayMs?: number;
  /**
   * The SUPER_ADMIN edit affordance for this card's administered `label`, passed
   * in rather than rendered here.
   *
   * The card stays what it was — a pure presentation of one slot, with every
   * word handed to it. Reaching for `useAuth` and a config PUT inside it would
   * put a role check and a write path into a component whose whole test suite is
   * built on it having neither.
   */
  settingsButton?: ReactNode;
}

export function BandGauge({
  label, unit, reading, decimals, min, max, minText = null, maxText = null, limitSource, roomCode,
  instrumentStatus = null, accent, icon = null,
  sensorError = false, rangeError = false, sensorWords, formatTs, delayMs = 0,
  settingsButton = null,
}: BandGaugeProps) {
  const state = bandGaugeState(reading?.value, min, max, decimals);

  /**
   * The verdict is `quantityVerdict` (`routes/dashboard/set-point.ts`) — lifted
   * out of this card on 2026-10-28 so the dashboard's built widgets judge a
   * measured key by the SAME rule. Its precedence and the reasons for each step
   * live there; in short:
   *
   * - "Not assessed" belongs to exactly one case: a reading arrived and NOTHING
   *   is checking it. An absent reading keeps its own word ("No data").
   * - The breach decision is `outOfSpec`, the ONE implementation shared with the
   *   dashboard table and the floor plan.
   * - Only STALE is inherited from the instrument. `computeInstrumentStatus`
   *   judges BOTH slots together, so its OUT_OF_SPEC / PARTIAL say nothing about
   *   THIS slot — the live case was CWH/RDU/001-00 printing "Out of limit" over a
   *   24.5 °C inside 18–27 while its humidity breached.
   *
   * **The header WILL disagree with this card, and that is correct.** The page's
   * hero band (`PageHero` in trend.tsx) prints the instrument-level status; this
   * card judges one slot of it. Different subjects.
   */
  const verdict = quantityVerdict(
    { value: reading?.value, min, max, instrumentStatus, sensorError, rangeError },
    sensorWords,
  );
  const { status, assessed, fault } = verdict;
  const sc = statusClasses(status);

  const sourceText = limitSource === 'INSTRUMENT'
    ? 'from this instrument'
    : limitSource === 'ROOM'
      ? `from room ${roomCode ?? '—'}`
      : 'no limits set';

  // A failed or saturated probe leaves the numeric slot null, so without the
  // fault word (from the verdict above) the card would print "No readings in
  // this instrument's history" over an instrument that is talking — a false
  // statement about a §11 record.
  const valueText = fault ?? (reading ? formatDecimals(reading.value, decimals) ?? '—' : '—');
  // The unit belongs to a number. "Error °C" is not a measurement.
  const showUnit = fault === null && reading !== null;
  // The reference's number is four characters wide, and 68px is measured off
  // it. Two things can be much wider and neither is under this file's control:
  // an operator-typed fault word, and a probe administered to `clampDecimals`'
  // ceiling of 10. Stepping the size down is the only option that neither wraps
  // the line nor clips digits off a §11 reading.
  const valueSize = valueText.length <= 6
    ? READING_SIZE.big
    : valueText.length <= 9 ? READING_SIZE.mid : READING_SIZE.small;

  // Same problem in the third of a card each bound gets, and ONE size for both:
  // two bounds of one quantity set at different sizes would read as different
  // kinds of number.
  // A bound's own text wins over its number (operator, 2026-10-03); the unit
  // is then withheld, since it belongs to a number.
  const hiHasText = finite(max) && typeof maxText === 'string' && maxText.trim() !== '';
  const loHasText = finite(min) && typeof minText === 'string' && minText.trim() !== '';
  const hiText = hiHasText ? maxText! : (formatDecimals(max, decimals) ?? '—');
  const loText = loHasText ? minText! : (formatDecimals(min, decimals) ?? '—');
  const boundLen = Math.max(hiText.length, loText.length);
  const boundSize = boundLen <= 6 ? 'text-2xl' : boundLen <= 9 ? 'text-lg' : 'text-sm';

  const subline = rangeError
    ? 'Outside this sensor’s measurable range'
    : sensorError
      ? 'Sensor did not report a number'
      : reading
        // The absolute instant, not "6d ago" (operator, 2026-08-31). A relative
        // age re-reads differently every time the page is opened; when a reading
        // ARRIVED is a fixed fact about the record, which is what this line is
        // for.
        ? (formatTs ? formatTs(reading.ts) : reading.ts)
        : 'No readings in this instrument’s history';

  const breached = state.kind === 'banded' && state.breach !== null;

  const boundCell = (dir: 'up' | 'down', label: string, text: string, show: boolean) => ({
    key: label,
    gap: 'gap-1.5',
    body: (
      <>
        {/* The low bound is the same series colour, lightened — it is the same
            quantity, read from the other end. */}
        <span className={CELL_LABEL} style={{ color: accent, opacity: dir === 'down' ? 0.65 : 1 }}>
          <Bound dir={dir} /> {label}
        </span>
        <span className={`whitespace-nowrap font-bold tabular-nums ${boundSize}`} style={{ color: accent }}>
          {text}
          {show && <span className="ml-1.5 text-[0.75em] font-semibold">{unit}</span>}
        </span>
      </>
    ),
  });

  const cells = [
    finite(max) ? boundCell('up', 'High limit', hiText, !hiHasText) : null,
    {
      key: 'status',
      gap: 'gap-1',
      body: (
        <>
          <span
            className={`grid h-6 w-6 place-items-center rounded-full text-white ${assessed ? sc.dot : 'bg-slate-400'}`}
            aria-hidden="true"
          >
            <StatusGlyph status={assessed ? status : null} />
          </span>
          <span className={CELL_LABEL + ' text-slate-500'}>Status</span>
          <span
            data-testid="band-status-word"
            className={`text-[0.75rem] font-bold uppercase tracking-[0.04em] ${assessed ? sc.text : 'text-slate-500'}`}
          >
            {assessed ? sc.label : 'Not assessed'}
          </span>
        </>
      ),
    },
    finite(min) ? boundCell('down', 'Low limit', loText, !loHasText) : null,
  ].filter((c): c is { key: string; gap: string; body: ReactElement } => c !== null);
  // Red the moment the reading leaves the band, so a low breach — whose arc has
  // no length to see — still reads as one from the ring alone.
  const arcColor = breached ? OUT_OF_LIMIT : accent;

  return (
    <section className="relative overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-1)]">
      {/* The accent rail. A fixed proportion, not a second gauge: one indicator
          per quantity, and the arc below is it. */}
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ backgroundColor: accent, opacity: 0.2 }} aria-hidden="true" />
      <span className="absolute left-0 top-0 h-[3px] w-1/5 rounded-r-full" style={{ backgroundColor: accent }} aria-hidden="true" />

      <div className="relative p-3 pt-5">
        {/* The reading block, bled back out to the card edges so the hills can
            reach them. `overflow-hidden` is what stops those hills running on
            under the footer panel, which in the reference sits on clean white. */}
        {/* Tinted with the quantity's own series colour (2026-09-25, operator:
            "do it same for trends page … should colorful") — a wash, not a
            band: the figure and the status pill on it are dark ink. */}
        <div
          className="relative -mx-3 -mt-5 overflow-hidden px-3 pb-4 pt-5"
          style={{ background: `linear-gradient(135deg, color-mix(in srgb, ${accent} 16%, #ffffff), color-mix(in srgb, ${accent} 6%, #ffffff))` }}
        >
          {/* Two soft hills in the series colour, from the reference. */}
          <svg
            viewBox="0 0 200 100" preserveAspectRatio="none" aria-hidden="true"
            className="pointer-events-none absolute bottom-0 right-0 h-1/2 w-2/3"
            style={{ color: accent }}
          >
            <path d="M0,100 C30,98 55,66 90,54 C125,42 152,30 200,22 L200,100 Z" fill="currentColor" fillOpacity={0.12} />
            <path d="M0,100 C45,100 75,80 110,66 C140,54 158,64 200,52 L200,100 Z" fill="currentColor" fillOpacity={0.16} />
          </svg>

          <div className="relative flex items-start gap-5">
            {/* The ring: a full track, and an arc swept from the low bound to
                where this reading sits between the two. */}
            <span className="relative grid h-[64px] w-[64px] shrink-0 place-items-center">
              <svg viewBox="0 0 84 84" className="absolute inset-0 h-full w-full" aria-hidden="true">
                <circle cx="42" cy="42" r="37" fill={accent} fillOpacity={0.06} />
                <circle
                  cx="42" cy="42" r={ARC_R} fill="none" strokeWidth="4"
                  stroke={arcColor} strokeOpacity={0.18}
                />
                {state.kind === 'banded' && (
                  <circle
                    data-testid="band-arc"
                    data-breach={state.breach ?? 'none'}
                    data-position={(state.position * 100).toFixed(2)}
                    className="band-arc"
                    cx="42" cy="42" r={ARC_R} fill="none" strokeWidth="4" strokeLinecap="round"
                    stroke={arcColor}
                    // From 12 o'clock, clockwise — the direction a dial is read.
                    transform="rotate(-90 42 42)"
                    strokeDasharray={ARC_C.toFixed(2)}
                    style={{
                      // The keyframe's `to` is this same value, so the reading's
                      // position is correct with the animation absent, disabled
                      // or already finished.
                      ['--band-arc-full' as string]: ARC_C.toFixed(2),
                      ['--band-arc-offset' as string]: (ARC_C * (1 - state.position)).toFixed(2),
                      strokeDashoffset: 'var(--band-arc-offset)',
                      animationDelay: `${delayMs}ms`,
                    }}
                  />
                )}
              </svg>
              <span className="relative" style={{ color: accent }}>{icon}</span>
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <span className="text-sm font-bold uppercase tracking-[0.06em]" style={{ color: accent }}>{label}</span>
                {/* Status colour NEVER carries meaning alone — the word travels
                    with it. ONE status word per card: the pill and the footer
                    panel below print the same `statusClasses` label, because a
                    card saying "Offline" and "In limit" at once is two
                    judgements of one instrument on one screen. */}
                {/* The pill and the (SUPER_ADMIN-only) pencil share the corner.
                    `items-center`, so a 36px button does not drag the pill's
                    baseline off the title's. */}
                <span className="flex shrink-0 items-center gap-2">
                  <span
                    data-testid="band-status"
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[0.75rem] font-semibold ${
                      assessed ? `${sc.bg} ${sc.text} ${sc.border}` : 'border-slate-200 bg-slate-50 text-slate-500'
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${assessed ? sc.dot : 'bg-slate-400'}`} aria-hidden="true" />
                    {assessed ? sc.label : 'Not assessed'}
                  </span>
                  {settingsButton}
                </span>
              </div>

              {/* Tabular figures: a number that changes in place must not reflow.
                  Proportional (not mono) to match the reference's weight —
                  `tabular-nums` is a font feature and holds on the sans stack. */}
              {/* RED when the value is a fault word (operator, 2026-09-01): `Error` or
                  `OL` in the same ink as a healthy reading understates a probe
                  that is measuring nothing. */}
              <p
                data-testid="band-reading"
                className={`mt-2 whitespace-nowrap font-extrabold leading-none tracking-tight tabular-nums ${fault ? FAULT_INK : 'text-slate-900'} ${valueSize}`}
              >
                <span data-testid="band-value">{valueText}</span>
                {showUnit && <span className="ml-2 text-2xl font-semibold text-slate-400">{unit}</span>}
              </p>
              <p className="mt-3 flex items-center gap-1.5 text-[0.8125rem] text-slate-500">
                <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
                {subline}
              </p>
            </div>
          </div>
        </div>

        {/* The bounds, and the one status word, side by side — what the reading
            above is judged against. Opaque, so it sits over the hills. */}
        {/* Only the bounds actually IN FORCE are named, and the columns follow
            them: a bound the instrument switches off arrives as a null, and a
            cell reading "—" would give a withheld bound the same weight on
            screen as a live one. Status keeps the middle whatever survives. */}
        <div
          className="relative grid overflow-hidden rounded-lg border border-slate-200 bg-white py-3"
          style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
          title={`Limits ${formatSetPoint(min, max, decimals, { min: minText, max: maxText })} (${sourceText})`}
        >
          {cells.map((cell, i) => (
            <div
              key={cell.key}
              // Divider between cells, never against the panel edge — which is
              // what `border-x` on a fixed middle cell would draw once a
              // neighbour is gone.
              className={`flex flex-col items-center px-2 text-center ${cell.gap} ${i > 0 ? 'border-l border-slate-200' : ''}`}
            >
              {cell.body}
            </div>
          ))}
        </div>

        {/* The excess, in words. A breach is the one thing worth more than the
            two bounds above, and the reference never drew this state. */}
        {breached && state.kind === 'banded' && (
          <p className="mt-2 text-center text-xs font-semibold" style={{ color: OUT_OF_LIMIT }}>
            {state.breach === 'low'
              ? `${figure(state.aboveLow, decimals)} ${unit} below the low limit`
              : `${figure(state.belowHigh, decimals)} ${unit} above the high limit`}
          </p>
        )}

      </div>
    </section>
  );
}
