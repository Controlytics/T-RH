/**
 * Signal freshness — the first question anyone asks about an instrument.
 *
 * The registry used to answer "is this device actually talking?" with a bare
 * datetime, which makes the reader do arithmetic against the current time AND
 * against whatever reporting interval that particular instrument promised. This
 * turns both into one state, so a page can be scanned instead of read.
 *
 * THE CONTRACT IS PER-INSTRUMENT. `expectedIntervalSec` is the instrument's own
 * promise, so "late" is only meaningful when it made one. An instrument with no
 * interval is EXEMPT: it can be heard from, but it can never be late, and
 * colouring it red for a quiet week would be inventing a rule nobody set. That
 * distinction is the whole reason this is a module and not an inline ternary.
 */

export type SignalState =
  /** Reported within its promised interval (with slack). */
  | 'live'
  /** Overdue against its own interval, but not yet far overdue. */
  | 'due'
  /** Far past its interval — this is the one worth acting on. */
  | 'silent'
  /** Heard from, but it promised no interval, so it cannot be late. */
  | 'heard'
  /** Never reported at all: registered, never connected. */
  | 'never';

export interface Signal {
  state: SignalState;
  /** Bars lit on the mast, 0–3. Encodes the same fact for a fast scan. */
  bars: 0 | 1 | 2 | 3;
  /** "4m ago" / "3d ago" / "Never". Short enough for a table cell. */
  age: string;
  /** One line, for a tooltip or a detail page. */
  label: string;
}

/**
 * Slack multipliers on the instrument's own interval.
 *
 * 1.5× before "due" because a device reporting every 60s is not late at 61s —
 * jitter, retries and clock skew all live in that gap, and an indicator that
 * goes amber on jitter is one people learn to ignore. 4× before "silent"
 * because by then it has missed several windows in a row, which is a fact about
 * the device rather than about the network.
 */
const DUE_AT = 1.5;
const SILENT_AT = 4;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact, and never rounds UP into a lie ("59m ago", not "1h ago"). */
export function relativeAge(ms: number): string {
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}

/**
 * `now` is injected, never read from a global. A component that renders "3m
 * ago" from `Date.now()` inside a pure function cannot be tested at a fixed
 * point, and this one is the thing the whole page is colour-coded on.
 */
export function signalFor(
  lastSeenAt: string | null | undefined,
  expectedIntervalSec: number | null | undefined,
  now: Date = new Date(),
): Signal {
  if (!lastSeenAt) {
    return {
      state: 'never',
      bars: 0,
      age: 'Never',
      label: 'Registered, but has never reported',
    };
  }

  const ms = now.getTime() - new Date(lastSeenAt).getTime();
  // A device whose clock runs ahead reports a future timestamp. Treat it as
  // fresh rather than rendering "-3m ago", which reads as a bug in this page.
  const age = relativeAge(Math.max(0, ms));

  if (!expectedIntervalSec) {
    return {
      state: 'heard',
      bars: 3,
      age,
      label: `Last reported ${age}. No expected interval is set, so it is never counted late.`,
    };
  }

  const interval = expectedIntervalSec * 1000;
  if (ms <= interval * DUE_AT) {
    return { state: 'live', bars: 3, age, label: `Reporting on schedule — last heard ${age}` };
  }
  if (ms <= interval * SILENT_AT) {
    return { state: 'due', bars: 2, age, label: `Overdue — expected every ${expectedIntervalSec}s, last heard ${age}` };
  }
  return { state: 'silent', bars: 1, age, label: `Silent — expected every ${expectedIntervalSec}s, last heard ${age}` };
}

/**
 * The palette. Semantic colours are FIXED, not themed: the ten colour presets
 * move the brand accent around the app, and a theme that turned "silent" into
 * the same hue as "live" would make the one urgent state unreadable.
 */
export const SIGNAL_STYLES: Record<SignalState, {
  label: string;
  dot: string;
  bar: string;
  barDim: string;
  chip: string;
}> = {
  live:   { label: 'Live',   dot: 'bg-emerald-500', bar: 'bg-emerald-500', barDim: 'bg-emerald-100', chip: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' },
  due:    { label: 'Due',    dot: 'bg-amber-500',   bar: 'bg-amber-500',   barDim: 'bg-amber-100',   chip: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200' },
  silent: { label: 'Silent', dot: 'bg-rose-500',    bar: 'bg-rose-500',    barDim: 'bg-rose-100',    chip: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200' },
  heard:  { label: 'Heard',  dot: 'bg-sky-500',     bar: 'bg-sky-400',     barDim: 'bg-sky-100',     chip: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200' },
  never:  { label: 'Never',  dot: 'bg-slate-300',   bar: 'bg-slate-300',   barDim: 'bg-slate-100',   chip: 'bg-slate-50 text-slate-500 ring-1 ring-slate-200' },
};
