/**
 * Alarm decision logic: does this reading breach its rule, and should that raise,
 * hold or clear an alarm?
 *
 * PURE on purpose. The worker around it only does I/O. This is the part that decides
 * whether a regulated excursion is recorded, and the only part a machine can check —
 * a wrong comparison here is silent, because an alarm that never fires looks exactly
 * like a plant running normally.
 *
 * Design: docs/superpowers/specs/2026-08-13-alarm-subsystem-design.md
 */

export type AlarmMetric = 'TEMPERATURE' | 'HUMIDITY' | 'OFFLINE';
export type AlarmComparison = 'ABOVE' | 'BELOW' | 'OUTSIDE_RANGE';

export interface RuleShape {
  id: string;
  metric: AlarmMetric;
  comparison: AlarmComparison;
  thresholdLow: number | null;
  thresholdHigh: number | null;
  /** Seconds the condition must persist before raising. 0 = immediately. */
  delaySeconds: number;
}

export interface Sample {
  /** Latest value for the rule's metric. NULL when there is no reading. */
  value: number | null;
  /** True when the instrument is not reporting within its expected interval. */
  offline: boolean;
  /** When the condition was first seen breaching, if it already was. */
  breachingSince: Date | null;
}

export type Decision =
  | { action: 'raise'; reason: string }
  | { action: 'hold'; reason: string }
  | { action: 'clear'; reason: string }
  | { action: 'none'; reason: string };

/**
 * Is the rule's condition currently met?
 *
 * A MISSING value is NOT a breach for a value-based rule. "No reading" is
 * unknown, not out-of-spec — treating it as a breach would raise a limit alarm every
 * time a probe went quiet, which is what the OFFLINE metric is for and which would
 * make the two indistinguishable in the record.
 */
export function isBreaching(rule: RuleShape, sample: Sample): boolean {
  if (rule.metric === 'OFFLINE') return sample.offline;

  const v = sample.value;
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;

  switch (rule.comparison) {
    case 'ABOVE':
      // Threshold missing = misconfigured rule, which must not fire. A rule that
      // fires on every reading because someone left a field blank is worse than one
      // that never fires: the first trains people to ignore alarms.
      return typeof rule.thresholdHigh === 'number' && v > rule.thresholdHigh;
    case 'BELOW':
      return typeof rule.thresholdLow === 'number' && v < rule.thresholdLow;
    case 'OUTSIDE_RANGE':
      if (typeof rule.thresholdLow !== 'number' || typeof rule.thresholdHigh !== 'number') return false;
      // Boundaries are IN spec, matching outOfSpec() for room limits — a reading
      // exactly at the threshold is not a breach.
      return v < rule.thresholdLow || v > rule.thresholdHigh;
  }
}

/**
 * What to do, given the current sample and whether an ACTIVE alarm already exists.
 *
 * `now` is injected so the delay is testable at a fixed point.
 */
export function decide(
  rule: RuleShape,
  sample: Sample,
  hasActiveAlarm: boolean,
  now: Date,
): Decision {
  const breaching = isBreaching(rule, sample);

  if (!breaching) {
    return hasActiveAlarm
      ? { action: 'clear', reason: 'condition ended' }
      : { action: 'none', reason: 'not breaching' };
  }

  // Breaching. An existing ACTIVE alarm is held, never re-raised: one excursion must
  // produce ONE alarm, not one per evaluation cycle.
  if (hasActiveAlarm) return { action: 'hold', reason: 'already active' };

  if (rule.delaySeconds > 0) {
    if (!sample.breachingSince) {
      return { action: 'hold', reason: 'breach just started, waiting out the delay' };
    }
    const heldFor = (now.getTime() - sample.breachingSince.getTime()) / 1000;
    if (heldFor < rule.delaySeconds) {
      return {
        action: 'hold',
        reason: `breaching for ${Math.floor(heldFor)}s of ${rule.delaySeconds}s`,
      };
    }
  }

  return { action: 'raise', reason: 'condition met' };
}

/**
 * The rule as it will be frozen onto the alarm.
 *
 * Editing or deleting a rule must not change what a historical alarm says about
 * itself — an inspector asking "why did this fire at 24.0 when the spec is 25.0?" is
 * answered from here, not from the live rule.
 */
export function ruleSnapshot(rule: RuleShape & { name: string; severity: string }) {
  return {
    ruleId: rule.id,
    name: rule.name,
    metric: rule.metric,
    comparison: rule.comparison,
    thresholdLow: rule.thresholdLow,
    thresholdHigh: rule.thresholdHigh,
    delaySeconds: rule.delaySeconds,
    severity: rule.severity,
    snapshotAt: null as string | null,
  };
}

/** Human-readable rule condition, e.g. `temperature above 24.0`. */
export function describeRule(rule: RuleShape): string {
  const metric = rule.metric.toLowerCase();
  if (rule.metric === 'OFFLINE') return 'instrument not reporting';
  switch (rule.comparison) {
    case 'ABOVE': return `${metric} above ${rule.thresholdHigh}`;
    case 'BELOW': return `${metric} below ${rule.thresholdLow}`;
    case 'OUTSIDE_RANGE': return `${metric} outside ${rule.thresholdLow} – ${rule.thresholdHigh}`;
  }
}
