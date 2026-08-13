import type { AlarmComparison, AlarmMetric } from './decide.js';

/**
 * Alarm-rule invariants, as pure logic so they are testable without Prisma and
 * enforced identically on create and update.
 */

export interface RuleDraft {
  name: string;
  instrumentId: string | null;
  functionalLocationId: string | null;
  metric: AlarmMetric;
  comparison: AlarmComparison;
  thresholdLow: number | null;
  thresholdHigh: number | null;
  delaySeconds: number;
}

export interface RuleFieldError {
  field: string;
  message: string;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Acknowledgement is a 21 CFR §11 e-signature, so both of its refusals are decided here
 * rather than inline in the route: the reason must be real, and the FIRST acceptance is
 * the record — a second one would overwrite a signature.
 */
export type AckRefusal =
  | { code: 'VALIDATION_ERROR'; message: string; field: string }
  | { code: 'ALREADY_ACKNOWLEDGED'; message: string };

/** Same floor the audit redact/delete reasons use, so "ok" can't stand in for a reason. */
const MIN_REASON = 5;

export function validateAcknowledgement(
  alarm: { acknowledgedAt: Date | null; acknowledgedBy: string | null },
  reason: string,
): AckRefusal | null {
  if (alarm.acknowledgedAt) {
    return {
      code: 'ALREADY_ACKNOWLEDGED',
      message: `This alarm was already acknowledged${alarm.acknowledgedBy ? ` by ${alarm.acknowledgedBy}` : ''} on ${alarm.acknowledgedAt.toISOString()}. The first acceptance is the record and cannot be replaced.`,
    };
  }
  if (reason.trim().length < MIN_REASON) {
    return {
      code: 'VALIDATION_ERROR',
      field: 'reason',
      message: `A reason of at least ${MIN_REASON} characters is required — it is signed into the audit trail.`,
    };
  }
  return null;
}

/**
 * `audit_trail.signature_meaning` is VARCHAR(255) while `reason` is TEXT, so a signature
 * line built from free text can exceed the column and make the INSERT throw — after the
 * record it describes has already been written. Clamping loses nothing: the reason is
 * stored verbatim in `audit_trail.reason` and `alarms.acknowledge_reason`.
 */
export const SIGNATURE_MEANING_MAX = 255;

export function clampSignature(line: string): string {
  return line.length <= SIGNATURE_MEANING_MAX ? line : `${line.slice(0, SIGNATURE_MEANING_MAX - 1)}…`;
}

export function validateRuleDraft(d: RuleDraft): RuleFieldError | null {
  if (!d.name?.trim()) return { field: 'name', message: 'Name is required.' };

  // Exactly one target. Both would make the rule's scope ambiguous; neither would make
  // it apply to nothing while still looking active on the rules page.
  const targets = [d.instrumentId, d.functionalLocationId].filter(Boolean).length;
  if (targets === 0) {
    return { field: 'instrumentId', message: 'Choose an instrument or a functional location.' };
  }
  if (targets > 1) {
    return { field: 'instrumentId', message: 'Choose either an instrument or a functional location, not both.' };
  }

  if (!Number.isInteger(d.delaySeconds) || d.delaySeconds < 0) {
    return { field: 'delaySeconds', message: 'Delay must be zero or a positive number of seconds.' };
  }

  // OFFLINE has no value to compare, so thresholds are meaningless for it. Accepting
  // them would leave a rule whose stored numbers are silently ignored.
  if (d.metric === 'OFFLINE') {
    if (finite(d.thresholdLow) || finite(d.thresholdHigh)) {
      return { field: 'thresholdHigh', message: 'An offline rule has no threshold — it fires when the instrument stops reporting.' };
    }
    return null;
  }

  // A rule with no usable threshold NEVER fires (see decide.ts). Rejecting it here is
  // the difference between "you cannot save that" and a rule that sits on the page
  // looking active while doing nothing.
  switch (d.comparison) {
    case 'ABOVE':
      if (!finite(d.thresholdHigh)) {
        return { field: 'thresholdHigh', message: 'An "above" rule needs an upper threshold.' };
      }
      return null;
    case 'BELOW':
      if (!finite(d.thresholdLow)) {
        return { field: 'thresholdLow', message: 'A "below" rule needs a lower threshold.' };
      }
      return null;
    case 'OUTSIDE_RANGE':
      if (!finite(d.thresholdLow) || !finite(d.thresholdHigh)) {
        return { field: 'thresholdLow', message: 'An "outside range" rule needs both thresholds.' };
      }
      if (d.thresholdLow >= d.thresholdHigh) {
        return { field: 'thresholdLow', message: 'The lower threshold must be below the upper one.' };
      }
      return null;
  }
}
