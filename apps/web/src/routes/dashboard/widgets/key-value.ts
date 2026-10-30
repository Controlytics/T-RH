/**
 * How a built widget prints ONE key's value, and how it colours it.
 *
 * Widget data keys, phase 2 (spec §4). Two kinds of key, and the difference is
 * the SERVER's answer, never re-derived here:
 *
 * - **Measured** (`LatestKeyValue.judged !== null`): the instrument's profile maps
 *   the key to a measurement, so the server sends its unit, its decimals, its
 *   bounds and its fault flags. The verdict is `quantityVerdict` — the band
 *   gauge's rule, in one place.
 * - **Raw** (`judged === null`, and every attribute): shown as received. Nothing
 *   is checking it, so it NEVER takes a status colour — a raw key shown green
 *   would assert a compliance nobody measured (the spec's first anti-goal).
 *
 * `TELEMETRY_DECIMALS_FALLBACK` is never applied to a raw key: it would round a
 * 0.05 kPa reading to 0.1. Only a widget's own stored `decimals` rounds one.
 */
import { clampDecimals, coerceReading, type InstrumentStatus, type LatestKeyValue, type WidgetKey } from '@digilog/shared';
import { statusClasses, type StatusClasses } from '../status';
import { NOT_AVAILABLE, quantityVerdict } from '../set-point';
import type { SensorWords } from '@/hooks/use-failure-text';

/** The neutral look of a value nothing is judging. Never a status palette entry. */
export const UNJUDGED_CLASSES: StatusClasses = {
  dot: 'bg-slate-300',
  text: 'text-slate-600',
  bg: 'bg-white',
  border: 'border-slate-200',
  label: 'Not judged',
};

export function isMeasured(v: LatestKeyValue): boolean {
  return v.judged !== null;
}

function asReceived(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** The value as text: NA, the server's precision, or exactly as received. */
export function formatKeyValue(v: LatestKeyValue | undefined, key: WidgetKey): string {
  if (!v || v.value === null || v.value === undefined) return NOT_AVAILABLE;
  if (v.source === 'attribute') return v.display ?? asReceived(v.value);
  const n = coerceReading(v.value);
  if (isMeasured(v)) {
    return n !== null ? n.toFixed(clampDecimals(v.decimals)) : asReceived(v.value);
  }
  if (n !== null && typeof key.decimals === 'number') return n.toFixed(key.decimals);
  return asReceived(v.value);
}

export interface KeyCell {
  text: string;
  unit: string | null;
  /** Whether a bound-checking verdict applies (a measured telemetry key). */
  judged: boolean;
  label: string;
  classes: StatusClasses;
  /**
   * The status `classes` were drawn from — `NOT_JUDGED` for the neutral look.
   * For a MEASURED key (`judged`) it is that key's verdict, and a chart may colour
   * by it (`STATUS_HEX[tone]`, `charts/chart-colors`) instead of judging the value
   * a second time. For a RAW key it is NOT a verdict: an offline instrument's raw
   * cell is `STALE` (the amber "Offline" look), and a chart that painted a raw key
   * with it would colour a value nothing judges — a raw key is always NEUTRAL_HEX.
   */
  tone: InstrumentStatus | 'NOT_JUDGED';
  /** `text` is the administered fault word, not a reading (a measured key only). */
  fault: boolean;
}

/** Everything a card or a table cell draws for one instrument × key. */
export function keyCell(
  v: LatestKeyValue | undefined,
  reporting: boolean,
  key: WidgetKey,
  words: SensorWords,
): KeyCell {
  const text = formatKeyValue(v, key);
  // A unit belongs to a NUMBER: never beside NA, a fault word, text or true/false.
  const isNumber = v !== undefined && coerceReading(v.value) !== null;
  if (v && v.source === 'telemetry' && v.judged) {
    const verdict = quantityVerdict({
      value: coerceReading(v.value),
      min: v.judged.limitMin,
      max: v.judged.limitMax,
      instrumentStatus: reporting ? null : 'STALE',
      sensorError: v.judged.sensorError,
      rangeError: v.judged.rangeError,
    }, words);
    // Not assessed (a reading, but NO bound in force) takes the neutral look,
    // exactly as the band gauge does — the OK palette would assert a check that
    // is not happening (review 2026-10-29).
    const classes = verdict.assessed ? statusClasses(verdict.status) : UNJUDGED_CLASSES;
    const shown = verdict.fault ?? text;
    return {
      text: shown,
      unit: verdict.fault === null && isNumber ? v.unit : null,
      judged: true,
      label: verdict.assessed ? classes.label : 'Not assessed',
      classes,
      tone: verdict.assessed ? verdict.status : 'NOT_JUDGED',
      fault: verdict.fault !== null,
    };
  }
  return {
    text,
    unit: isNumber ? key.unit ?? null : null,
    judged: false,
    label: reporting ? UNJUDGED_CLASSES.label : statusClasses('STALE').label,
    classes: reporting ? UNJUDGED_CLASSES : statusClasses('STALE'),
    tone: reporting ? 'NOT_JUDGED' : 'STALE',
    fault: false,
  };
}

/**
 * The most fractional digits actually received, capped at 6 — the precision a
 * raw chart axis prints when the widget sets none. It describes the data; it
 * never adds a digit the device did not send.
 */
export function decimalsSeen(values: readonly number[]): number {
  let most = 0;
  for (const n of values) {
    const s = String(n);
    if (s.includes('e')) return 6;
    const dot = s.indexOf('.');
    if (dot >= 0) most = Math.max(most, s.length - dot - 1);
  }
  return Math.min(most, 6);
}
