import { formatDecimals, type InstrumentStatus } from '@digilog/shared';
import { formatSetPoint, outOfSpec } from '@/routes/dashboard/set-point';
import { statusClasses, readingAge } from '@/routes/dashboard/status';

/**
 * The band gauge — this page's signature element.
 *
 * In GMP monitoring nothing is "a value"; everything is a value INSIDE A BAND.
 * A bare number withholds the one thing an operator actually wants to know —
 * how close to the limit is it — so the reading is drawn in position on the
 * band its limits define, with both headroom figures stated in words.
 *
 * This is not a progress bar. A progress bar answers "how much of a whole";
 * this answers "where inside an allowed range", which is the only question
 * this page's subject has.
 *
 * Nothing here re-derives a limit or a decimal place. Both arrive resolved on
 * the telemetry-overview payload (instrument attributes, else the room), and
 * the alarm evaluator reads the same resolution — a second derivation in the
 * browser is how a gauge comes to contradict the alarm printed beside it.
 */

export type BandGaugeState =
  /** No reading at all. NEVER a marker at zero: zero is a measurement. */
  | { kind: 'no-reading' }
  /**
   * There is a reading but no band to place it in. `assessed` says whether the
   * reading is still being judged — a half-open band (NMT/NLT) checks one side
   * and is a real administration, so its status word stays honest even though
   * no track can be drawn. An absent band is STATED, never implied by an empty
   * track, which would draw a band that does not exist.
   */
  | { kind: 'no-track'; note: string; assessed: boolean }
  /** A usable band: both bounds finite, high strictly above low. */
  | {
      kind: 'banded';
      min: number;
      max: number;
      /** 0–1, clamped — the marker's position along the track. */
      position: number;
      breach: 'low' | 'high' | null;
      /** reading − low. Negative on a low breach (that is the excess). */
      aboveLow: number;
      /** high − reading. Negative on a high breach. */
      belowHigh: number;
    };

function finite(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Which of the gauge's states this slot is in.
 *
 * Pure, and exported, because the four states named in the design brief plus
 * the three mis-administration cases the schema actually permits (one bound
 * only, low === high, low > high) are where this will break, and none of them
 * can be checked by looking at the rendered page from this dev environment.
 */
export function bandGaugeState(
  value: number | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
  decimals: number,
): BandGaugeState {
  if (!finite(value)) return { kind: 'no-reading' };

  const hasMin = finite(min);
  const hasMax = finite(max);

  if (!hasMin && !hasMax) {
    return { kind: 'no-track', note: 'No limits set — not assessed', assessed: false };
  }
  if (!hasMin || !hasMax) {
    // One side is checked, so the status word below stays real; there is simply
    // no interval to draw a marker inside.
    return {
      kind: 'no-track',
      note: `Only one limit is set (${formatSetPoint(min, max, decimals)}) — no band to draw`,
      assessed: true,
    };
  }
  if (max <= min) {
    // Reachable: both bounds are operator-typed instrument attributes. Dividing
    // by a zero-width band would put every reading at the same place, which is
    // indistinguishable from a broken gauge.
    return {
      kind: 'no-track',
      note: `Limits are not a usable band (${formatSetPoint(min, max, decimals)}) — no band to draw`,
      assessed: true,
    };
  }

  const span = max - min;
  const raw = (value - min) / span;
  return {
    kind: 'banded',
    min,
    max,
    position: Math.min(1, Math.max(0, raw)),
    breach: value < min ? 'low' : value > max ? 'high' : null,
    aboveLow: value - min,
    belowHigh: max - value,
  };
}

/** "4.4" — a headroom figure at the slot's own precision, never a raw float. */
function figure(n: number, decimals: number): string {
  return formatDecimals(Math.abs(n), decimals) ?? '—';
}

const IN_LIMIT = '#15803D';
const OUT_OF_LIMIT = '#DC2626';
const MUTED_INK = '#64748B';

/** The instrument-panel label idiom. Tracking is what makes it read as a panel
 *  rather than as a web form, so it appears on labels and nowhere else. */
const FIELD_LABEL = 'text-[0.6875rem] font-semibold uppercase tracking-[0.09em] text-slate-500';

export interface BandGaugeProps {
  label: string;
  unit: string;
  reading: { value: number; ts: string } | null;
  decimals: number;
  min: number | null | undefined;
  max: number | null | undefined;
  limitSource: 'INSTRUMENT' | 'ROOM' | null;
  roomCode: string | null;
  /**
   * The INSTRUMENT's server-resolved status, taken as given.
   *
   * Staleness is decided server-side (against `expectedIntervalSec`) and cannot
   * be re-derived here from a timestamp — and the header prints that same word
   * a few rows above this gauge. Without it, a probe that stopped reporting
   * four hours ago reads "Not reporting" in the header and "In spec" in the
   * gauge: two judgements of one instrument on one screen.
   */
  instrumentStatus?: InstrumentStatus | null;
  /** Series identity — the palette slot this quantity owns app-wide. */
  accent: string;
  /** Page-load stagger, ms. The travel itself is in CSS (`.band-marker`). */
  delayMs?: number;
}

export function BandGauge({
  label, unit, reading, decimals, min, max, limitSource, roomCode,
  instrumentStatus = null, accent, delayMs = 0,
}: BandGaugeProps) {
  const state = bandGaugeState(reading?.value, min, max, decimals);

  // "Not assessed" belongs to exactly one case: a reading arrived and NOTHING
  // is checking it. An absent reading is a fact about the record and keeps its
  // own status word ("No data") — calling that "not assessed" would blame the
  // administration for a silence the instrument is responsible for.
  const assessed = !(state.kind === 'no-track' && !state.assessed);

  // The breach decision comes from `outOfSpec` — the ONE implementation, shared
  // with the dashboard table and the floor plan. A second copy here is how two
  // views of one instrument come to disagree about the same reading.
  const breachesLimits = outOfSpec(reading?.value, min, max);
  const status: InstrumentStatus = state.kind === 'no-reading'
    ? 'NO_DATA'
    // A breach is a breach: the stored numbers decide that, and they are the
    // one thing this gauge is authoritative about.
    : breachesLimits ? 'OUT_OF_SPEC'
      // Otherwise the instrument's own status wins over a local "In limit".
      // Asserting compliance over a reading the server has already called
      // stale is exactly the contradiction this page must not print.
      : instrumentStatus && instrumentStatus !== 'OK' && instrumentStatus !== 'NO_DATA'
        ? instrumentStatus
        : 'OK';
  const sc = statusClasses(status);

  const sourceText = limitSource === 'INSTRUMENT'
    ? 'from this instrument'
    : limitSource === 'ROOM'
      ? `from room ${roomCode ?? '—'}`
      : 'no limits set';

  const valueText = reading ? formatDecimals(reading.value, decimals) ?? '—' : '—';
  const breached = state.kind === 'banded' && state.breach !== null;

  return (
    <section className="rounded-[var(--radius-card)] border border-slate-200 bg-white p-5 shadow-[var(--elev-1)]">
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2">
          {/* Series identity — the colour that means this quantity everywhere in
              the app. It is a swatch, never the status, and never the text. */}
          <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: accent }} aria-hidden="true" />
          <span className={FIELD_LABEL}>{label}</span>
        </span>
        {/* Status colour NEVER carries meaning alone — the word travels with it. */}
        {assessed ? (
          <span
            data-testid="band-status"
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold ${sc.bg} ${sc.text} ${sc.border}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${sc.dot}`} aria-hidden="true" />
            {sc.label}
          </span>
        ) : (
          <span data-testid="band-status" className="text-xs font-medium" style={{ color: MUTED_INK }}>
            Not assessed
          </span>
        )}
      </div>

      {/* Mono, tabular figures: a number that changes in place must not reflow,
          which tabular figures guarantee and proportional figures do not. */}
      <p className="mt-2 font-mono text-[2.5rem] font-bold leading-none tabular-nums text-slate-900">
        {valueText}
        <span className="ml-1.5 font-sans text-base font-medium text-slate-400">{unit}</span>
      </p>
      <p className="mt-1.5 text-xs text-slate-500">
        {reading ? readingAge(reading.ts) : 'No readings in this instrument’s history'}
      </p>

      {state.kind === 'banded' ? (
        <div className="mt-5">
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-slate-500">
              {formatDecimals(state.min, decimals) ?? '—'}
            </span>

            <span className="relative h-6 flex-1">
              {/* The track IS the in-limit region — the whole point of drawing it. */}
              <span
                className="absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full border"
                style={{ backgroundColor: `${IN_LIMIT}1a`, borderColor: `${IN_LIMIT}59` }}
                aria-hidden="true"
              />
              {/* Both ends stopped, so the band reads as a bounded interval
                  rather than an axis that continues off the card. */}
              <span className="absolute left-0 top-1/2 h-4 w-px -translate-y-1/2" style={{ backgroundColor: IN_LIMIT }} aria-hidden="true" />
              <span className="absolute right-0 top-1/2 h-4 w-px -translate-y-1/2" style={{ backgroundColor: IN_LIMIT }} aria-hidden="true" />
              {/* The marker. A breach puts it hard against the breached end and
                  OUTSIDE the track, in the breach red — the geometry shows it. */}
              <span
                data-testid="band-marker"
                data-breach={state.breach ?? 'none'}
                className="band-marker absolute top-1/2 h-4 w-4 rounded-full border-2 border-white shadow"
                style={{
                  ['--band-marker-left' as string]: `${(state.position * 100).toFixed(2)}%`,
                  left: 'var(--band-marker-left)',
                  transform: state.breach === 'low'
                    ? 'translate(-150%, -50%)'
                    : state.breach === 'high'
                      ? 'translate(50%, -50%)'
                      : 'translate(-50%, -50%)',
                  backgroundColor: state.breach ? OUT_OF_LIMIT : IN_LIMIT,
                  animationDelay: `${delayMs}ms`,
                }}
              />
            </span>

            <span className="w-14 shrink-0 font-mono text-xs tabular-nums text-slate-500">
              {formatDecimals(state.max, decimals) ?? '—'}
            </span>
          </div>

          {/* The headroom figures — the thing a bare number withholds. */}
          {breached ? (
            <p className="mt-2 text-center text-xs font-semibold" style={{ color: OUT_OF_LIMIT }}>
              {state.breach === 'low'
                ? `${figure(state.aboveLow, decimals)} ${unit} below the low limit`
                : `${figure(state.belowHigh, decimals)} ${unit} above the high limit`}
            </p>
          ) : (
            <p className="mt-2 flex justify-between px-14 text-xs text-slate-500">
              <span className="tabular-nums">{figure(state.aboveLow, decimals)} above low</span>
              <span className="tabular-nums">{figure(state.belowHigh, decimals)} below high</span>
            </p>
          )}
        </div>
      ) : state.kind === 'no-track' ? (
        <p data-testid="band-note" className="mt-5 text-xs text-slate-500">{state.note}</p>
      ) : (
        <p data-testid="band-note" className="mt-5 text-xs text-slate-500">
          No reading to place — nothing has arrived for this slot.
        </p>
      )}

      <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
        <span className={FIELD_LABEL}>Limits</span>{' '}
        <span className="font-mono font-medium tabular-nums text-slate-700">{formatSetPoint(min, max, decimals)}</span>{' '}
        <span className="text-slate-400">({sourceText})</span>
      </p>
    </section>
  );
}
