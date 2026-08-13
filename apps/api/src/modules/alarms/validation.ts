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
