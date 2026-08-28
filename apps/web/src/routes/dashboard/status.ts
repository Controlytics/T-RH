import type { InstrumentStatus } from '@digilog/shared';

/**
 * Status → Tailwind classes.
 *
 * These colours are SEMANTIC, so they are fixed rather than theme variables: a
 * site that themes the app purple must not end up with a purple "out of limit".
 *
 * The vocabulary is LIMIT, not spec (operator wording, 2026-08-24): a reading is
 * judged against configured bounds, so it is in or out of LIMIT. "Out of limit"
 * shipped first and left its opposite reading "In spec", which put both words on
 * the same screen — one page saying a reading was in spec and out of limit is
 * how a reader stops trusting either.
 *
 * STALE and PARTIAL share amber deliberately. Both mean "cannot confirm this is
 * in limit" — one because the reading is old, one because a promised reading is
 * missing — and inventing a fifth colour for that distinction would cost more
 * legibility than it buys. The labels still tell them apart.
 */
export interface StatusClasses {
  dot: string;
  text: string;
  bg: string;
  border: string;
  label: string;
}

const MAP: Record<InstrumentStatus, StatusClasses> = {
  OUT_OF_SPEC: {
    dot: 'bg-red-500', text: 'text-red-700', bg: 'bg-red-50', border: 'border-red-300',
    label: 'Out of limit',
  },
  STALE: {
    dot: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-300',
    label: 'Not reporting',
  },
  NO_DATA: {
    dot: 'bg-slate-400', text: 'text-slate-600', bg: 'bg-slate-50', border: 'border-slate-300',
    label: 'No data',
  },
  PARTIAL: {
    dot: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-300',
    label: 'Partial data',
  },
  OK: {
    dot: 'bg-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-300',
    label: 'In limit',
  },
};

export function statusClasses(status: InstrumentStatus): StatusClasses {
  return MAP[status] ?? MAP.NO_DATA;
}

/**
 * The OLDER of an instrument's two slot timestamps, or null when it has neither.
 *
 * The older, deliberately, and NOT the same question the Status column asks. That
 * one uses the LATEST timestamp, because it is answering "are we hearing from this
 * instrument at all". This answers "how stale might the numbers on this row be",
 * and the freshest of two values cannot answer that: a row whose humidity arrived
 * a second ago and whose temperature stopped an hour ago is an hour stale in the
 * only sense the reading columns care about.
 */
export function oldestReadingTs(
  temperature: { ts: string } | null | undefined,
  humidity: { ts: string } | null | undefined,
): string | null {
  const stamps = [temperature?.ts, humidity?.ts].filter((t): t is string => typeof t === 'string');
  if (stamps.length === 0) return null;
  return stamps.reduce((oldest, t) => (new Date(t) < new Date(oldest) ? t : oldest));
}

/**
 * "12s ago" / "4h ago" / "Never".
/**
 * "12s ago" / "4h ago" / "Never".
 *
 * Short by design — it sits inside a table cell. `now` is injected so the
 * function is testable at a fixed point.
 */
export function readingAge(ts: string | null | undefined, now = Date.now()): string {
  if (!ts) return 'Never';
  const secs = Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
