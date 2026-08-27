/**
 * The TIME PERIOD and AGGREGATION INTERVAL vocabulary — one definition, shared by
 * every screen that shows telemetry and by the endpoints that serve it.
 *
 * Why this is shared rather than a `window=` enum on each route (as
 * `floorplans/room-history.ts` does it): the gated download dialog has to offer a
 * CUSTOM range, so the wire contract must be `from`/`to` + `interval`. Presets are
 * UI sugar that resolve to a range — they are not the contract. A route taking
 * `window=24h` cannot express "23 Aug 09:00 to 24 Aug 17:30", which is exactly what
 * an inspector asks for.
 *
 * INTERVAL IS AN AGGREGATION BUCKET, not a poll rate (operator, 2026-08-24). At
 * `5m` the server returns one averaged point per five minutes. Poll rate remains
 * the site-wide `telemetry-slots` config (`overviewRefreshSeconds` /
 * `chartRefreshSeconds`); the two are unrelated and must not be conflated in the UI.
 */

export type PeriodPreset = '15m' | '1h' | '6h' | '12h' | '24h' | '7d' | '30d' | 'custom';

export interface PeriodPresetSpec {
  value: Exclude<PeriodPreset, 'custom'>;
  label: string;
  ms: number;
}

export const PERIOD_PRESETS: PeriodPresetSpec[] = [
  { value: '15m', label: 'Last 15 minutes', ms: 15 * 60_000 },
  { value: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { value: '6h', label: 'Last 6 hours', ms: 6 * 3_600_000 },
  { value: '12h', label: 'Last 12 hours', ms: 12 * 3_600_000 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 3_600_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
];

export type IntervalKey = 'raw' | '1m' | '5m' | '15m' | '1h' | '1d';

export interface IntervalSpec {
  value: IntervalKey;
  label: string;
  /** Bucket width in seconds. `null` = return every stored reading, unaveraged. */
  seconds: number | null;
}

export const INTERVALS: IntervalSpec[] = [
  { value: 'raw', label: 'Raw (every reading)', seconds: null },
  { value: '1m', label: '1 minute', seconds: 60 },
  { value: '5m', label: '5 minutes', seconds: 300 },
  { value: '15m', label: '15 minutes', seconds: 900 },
  { value: '1h', label: '1 hour', seconds: 3_600 },
  { value: '1d', label: '1 day', seconds: 86_400 },
];

export const DEFAULT_PERIOD: PeriodPreset = '24h';

/**
 * `raw`, NOT a bucket — a screen must not OPEN disagreeing with itself.
 *
 * This was `5m` until 2026-08-24. The trend page charts at the interval and
 * tables the raw readings, so on first load the chart plotted a five-minute
 * MEAN (22.4) beside a table showing the stored reading for that same instant
 * (22.5). Neither number was wrong, but an operator had no way to tell which
 * one was the record — and on a 21 CFR Part 11 surface an unannounced derived
 * value sitting where a reading should be is a misrepresentation, not a
 * display preference. `ChartIntervalNote` discloses averaging, but it only
 * renders once a bucket is chosen, so the default was the one state where the
 * disagreement was silent.
 *
 * Averaging is now something the operator opts INTO, at which point the note
 * appears and says so. `chooseInterval` still widens the bucket when `raw`
 * would exceed `MAX_SERIES_POINTS`, and still reports `downgradedFrom`.
 */
export const DEFAULT_INTERVAL: IntervalKey = 'raw';

/**
 * The most points any single series may carry back to a browser.
 *
 * Not a display preference — a refusal to build a response no chart can draw. A
 * 30-day period at `raw` on a 5-second publish interval is ~518k points per series;
 * serialising that would stall the API before the browser ever got the chance to
 * fail. `chooseInterval` upgrades the bucket instead, and the response says it did.
 */
export const MAX_SERIES_POINTS = 5_000;

export function intervalSpec(key: IntervalKey): IntervalSpec {
  return INTERVALS.find((i) => i.value === key) ?? INTERVALS[2];
}

export function isIntervalKey(v: unknown): v is IntervalKey {
  return typeof v === 'string' && INTERVALS.some((i) => i.value === v);
}

export function isPeriodPreset(v: unknown): v is PeriodPreset {
  return v === 'custom' || (typeof v === 'string' && PERIOD_PRESETS.some((p) => p.value === v));
}

export interface ResolvedRange {
  from: Date;
  to: Date;
}

/**
 * A preset plus a reference instant becomes a concrete range.
 *
 * `now` is a parameter, never `new Date()` read inside: the caller passes ONE
 * instant for the whole screen, so two widgets on the same page cannot end up
 * covering slightly different windows and disagreeing about the same minute.
 */
export function resolvePeriod(preset: PeriodPreset, now: Date, custom?: ResolvedRange | null): ResolvedRange {
  if (preset === 'custom') {
    if (!custom) return { from: new Date(now.getTime() - 24 * 3_600_000), to: now };
    return custom;
  }
  const spec = PERIOD_PRESETS.find((p) => p.value === preset) ?? PERIOD_PRESETS.find((p) => p.value === DEFAULT_PERIOD)!;
  return { from: new Date(now.getTime() - spec.ms), to: now };
}

/**
 * The bucket actually used, which is not always the one asked for.
 *
 * Requesting `raw` over 30 days is a legitimate thing to click and an illegitimate
 * thing to serve, so the interval is WIDENED until the series fits
 * `MAX_SERIES_POINTS`. The caller is told (`downgradedFrom`) so the UI can say
 * "showing 1 hour averages" rather than silently quoting a different resolution
 * than the control claims — a chart labelled `raw` that is actually averaged is a
 * §11 record that misdescribes itself.
 *
 * `estimatedPublishSec` is how often the instrument is expected to publish; it only
 * matters for the `raw` estimate, since a bucketed count is fixed by arithmetic.
 */
export function chooseInterval(
  requested: IntervalKey,
  range: ResolvedRange,
  estimatedPublishSec = 5,
): { interval: IntervalKey; seconds: number | null; downgradedFrom: IntervalKey | null } {
  const spanSec = Math.max(1, (range.to.getTime() - range.from.getTime()) / 1000);
  const fits = (spec: IntervalSpec) =>
    spec.seconds === null
      ? spanSec / Math.max(1, estimatedPublishSec) <= MAX_SERIES_POINTS
      : spanSec / spec.seconds <= MAX_SERIES_POINTS;

  const asked = intervalSpec(requested);
  if (fits(asked)) return { interval: asked.value, seconds: asked.seconds, downgradedFrom: null };

  // INTERVALS is ordered narrowest to widest, so the first that fits is the
  // smallest honest bucket.
  const start = INTERVALS.findIndex((i) => i.value === asked.value);
  for (const spec of INTERVALS.slice(start + 1)) {
    if (fits(spec)) return { interval: spec.value, seconds: spec.seconds, downgradedFrom: asked.value };
  }
  const widest = INTERVALS[INTERVALS.length - 1];
  return { interval: widest.value, seconds: widest.seconds, downgradedFrom: asked.value };
}

/** "23 Aug 2026 09:00 → 24 Aug 2026 17:30", for audit reasons and report subtitles. */
export function describeRange(range: ResolvedRange): string {
  const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return `${fmt(range.from)} → ${fmt(range.to)}`;
}
