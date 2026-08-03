/**
 * Threshold evaluation — PURE. No database, no clock, no I/O.
 *
 * `isOpen` is injected rather than looked up so this file can be exhaustively
 * unit-tested, exactly like fan-out.ts.
 *
 * Hysteresis is a dead-band applied ONLY on the recovery side. Without it a
 * value oscillating around the limit alternates BREACH/RECOVERED on every
 * message, and with latching that means an operator can never finish reviewing
 * an excursion before it changes state underneath them.
 */
import type { AlarmSeverity, ThresholdOperator } from '@prisma/client';

export interface ThresholdSpec {
  id: string;
  key: string;
  operator: ThresholdOperator;
  limit: number | null;
  limitLow: number | null;
  limitHigh: number | null;
  hysteresis: number;
  severity: AlarmSeverity;
}

export type Verdict = 'BREACH' | 'RECOVERED' | 'NEUTRAL';

/**
 * Coerce a reading to a number, or null when it is not numerically meaningful.
 *
 * Deliberately NOT `Number(value)`: Number(false) === 0 and Number('') === 0,
 * either of which would silently breach any LT threshold above zero. Booleans,
 * null, objects and non-numeric strings are not comparable to a limit and must
 * be skipped, not coerced.
 */
export function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function breaches(spec: ThresholdSpec, v: number): boolean {
  switch (spec.operator) {
    case 'GT':  return spec.limit !== null && v > spec.limit;
    case 'GTE': return spec.limit !== null && v >= spec.limit;
    case 'LT':  return spec.limit !== null && v < spec.limit;
    case 'LTE': return spec.limit !== null && v <= spec.limit;
    case 'EQ':  return spec.limit !== null && v === spec.limit;
    case 'NEQ': return spec.limit !== null && v !== spec.limit;
    case 'OUT_OF_RANGE':
      return spec.limitLow !== null && spec.limitHigh !== null
        && (v < spec.limitLow || v > spec.limitHigh);
    default: return false;
  }
}

/** Has the value returned past the limit by the full dead-band? */
function recovers(spec: ThresholdSpec, v: number): boolean {
  const h = Math.max(0, spec.hysteresis);
  switch (spec.operator) {
    case 'GT':
    case 'GTE': return spec.limit !== null && v <= spec.limit - h;
    case 'LT':
    case 'LTE': return spec.limit !== null && v >= spec.limit + h;
    // A dead-band around an equality test is meaningless — recovery is exact.
    case 'EQ':  return spec.limit !== null && v !== spec.limit;
    case 'NEQ': return spec.limit !== null && v === spec.limit;
    case 'OUT_OF_RANGE':
      return spec.limitLow !== null && spec.limitHigh !== null
        && v >= spec.limitLow + h && v <= spec.limitHigh - h;
    default: return false;
  }
}

export function evaluate(spec: ThresholdSpec, value: number, isOpen: boolean): Verdict {
  if (breaches(spec, value)) return 'BREACH';
  // NEUTRAL rather than RECOVERED when no alarm is open: recovery is a
  // transition, and there is nothing to transition.
  if (isOpen && recovers(spec, value)) return 'RECOVERED';
  return 'NEUTRAL';
}
