/**
 * Instrument-limit alarm decisions: does this reading breach the instrument's own
 * limit attributes?
 *
 * PURE on purpose, exactly like decide.ts beside it. The worker does only I/O.
 * This is the part that decides whether a regulated excursion is recorded, and the
 * only part a machine can check — a wrong comparison here is silent, because an
 * alarm that never fires looks exactly like a plant running normally.
 *
 * Design: docs/superpowers/specs/2026-08-17-instrument-limit-alarms-design.md
 */

export type LimitMetric = 'TEMPERATURE' | 'HUMIDITY';
export type LimitKind = 'HIGH' | 'LOW';

export interface InstrumentLimits {
  temperatureHigh: number | null;
  temperatureLow: number | null;
  humidityHigh: number | null;
  humidityLow: number | null;
}

export interface LimitCheck {
  metric: LimitMetric;
  limitKind: LimitKind;
  limit: number;
  breaching: boolean;
}

/**
 * A low limit ABOVE its high limit is a misconfiguration, not a permanent breach.
 * Every reading would breach one bound or the other forever, which trains
 * operators to ignore alarms — the same alarm-fatigue reasoning decide.ts applies
 * to a missing threshold.
 */
export function limitsInverted(high: number | null, low: number | null): boolean {
  return high !== null && low !== null && low > high;
}

function checkPair(
  metric: LimitMetric,
  high: number | null,
  low: number | null,
  value: number | null,
): LimitCheck[] {
  if (limitsInverted(high, low)) return [];
  const out: LimitCheck[] = [];
  // Boundaries are IN spec: strictly greater / strictly less, matching
  // isBreaching() for OUTSIDE_RANGE and breaches() for room limits.
  // A null reading is NOT a breach — "the probe went quiet" is the OFFLINE
  // metric's concern, and conflating them would make an excursion and a dead
  // probe indistinguishable in a regulated record.
  if (high !== null) {
    out.push({ metric, limitKind: 'HIGH', limit: high, breaching: value !== null && value > high });
  }
  if (low !== null) {
    out.push({ metric, limitKind: 'LOW', limit: low, breaching: value !== null && value < low });
  }
  return out;
}

/** Every bound this instrument actually declares, and whether each is breaching now. */
export function checkLimits(
  limits: InstrumentLimits,
  reading: { temperature: number | null; humidity: number | null },
): LimitCheck[] {
  return [
    ...checkPair('TEMPERATURE', limits.temperatureHigh, limits.temperatureLow, reading.temperature),
    ...checkPair('HUMIDITY', limits.humidityHigh, limits.humidityLow, reading.humidity),
  ];
}

/** Human-readable condition, e.g. `temperature above 25`. Mirrors describeRule(). */
export function describeLimit(c: Pick<LimitCheck, 'metric' | 'limitKind' | 'limit'>): string {
  return `${c.metric.toLowerCase()} ${c.limitKind === 'HIGH' ? 'above' : 'below'} ${c.limit}`;
}

/**
 * The limit as it will be FROZEN onto the alarm.
 *
 * Changing an instrument's limit attribute later must not change what a historical
 * alarm says about itself — an inspector asking "why did this fire at 24.0 when the
 * attribute says 26?" is answered from here, never from the live attribute.
 */
export function limitSnapshot(input: {
  metric: string;
  limitKind: string;
  limit: number;
  attributeKey: string | null;
  snapshotAt: string;
}): Record<string, unknown> {
  return {
    source: 'INSTRUMENT_LIMIT',
    ruleId: null,
    name: `${input.metric} ${input.limitKind} limit`,
    metric: input.metric,
    limitKind: input.limitKind,
    limit: input.limit,
    attributeKey: input.attributeKey,
    description: describeLimit({
      metric: input.metric as LimitMetric,
      limitKind: input.limitKind as LimitKind,
      limit: input.limit,
    }),
    snapshotAt: input.snapshotAt,
  };
}
