import { describe, it, expect } from 'vitest';
import { validateRuleDraft, type RuleDraft } from '../validation.js';

const draft = (over: Partial<RuleDraft> = {}): RuleDraft => ({
  name: 'Cold room high',
  instrumentId: 'i1',
  functionalLocationId: null,
  metric: 'TEMPERATURE',
  comparison: 'ABOVE',
  thresholdLow: null,
  thresholdHigh: 25,
  delaySeconds: 0,
  ...over,
});

describe('validateRuleDraft — target', () => {
  it('accepts an instrument target', () => {
    expect(validateRuleDraft(draft())).toBeNull();
  });

  it('accepts a functional-location target', () => {
    expect(validateRuleDraft(draft({ instrumentId: null, functionalLocationId: 'fl1' }))).toBeNull();
  });

  it('rejects no target', () => {
    // Otherwise the rule sits on the page looking active while applying to nothing.
    expect(validateRuleDraft(draft({ instrumentId: null }))?.field).toBe('instrumentId');
  });

  it('rejects both targets', () => {
    expect(validateRuleDraft(draft({ functionalLocationId: 'fl1' }))?.field).toBe('instrumentId');
  });
});

describe('validateRuleDraft — thresholds', () => {
  it('rejects ABOVE with no upper threshold', () => {
    // decide() makes a thresholdless rule never fire; refusing to save it is the
    // difference between "you cannot save that" and a rule that silently does nothing.
    expect(validateRuleDraft(draft({ thresholdHigh: null }))?.field).toBe('thresholdHigh');
  });

  it('rejects BELOW with no lower threshold', () => {
    expect(validateRuleDraft(draft({ comparison: 'BELOW', thresholdHigh: null }))?.field).toBe('thresholdLow');
  });

  it('requires both thresholds for OUTSIDE_RANGE', () => {
    expect(validateRuleDraft(draft({ comparison: 'OUTSIDE_RANGE', thresholdLow: 18 }))).toBeNull();
    expect(validateRuleDraft(draft({ comparison: 'OUTSIDE_RANGE', thresholdLow: null }))?.field).toBe('thresholdLow');
  });

  it('rejects an inverted range', () => {
    expect(validateRuleDraft(draft({ comparison: 'OUTSIDE_RANGE', thresholdLow: 30, thresholdHigh: 20 }))?.field)
      .toBe('thresholdLow');
  });

  it('accepts a zero threshold', () => {
    // A 0 degree limit is a real cold-room spec, so no falsy checks.
    expect(validateRuleDraft(draft({ comparison: 'BELOW', thresholdLow: 0, thresholdHigh: null }))).toBeNull();
  });

  it('rejects a non-finite threshold', () => {
    expect(validateRuleDraft(draft({ thresholdHigh: Number.NaN }))?.field).toBe('thresholdHigh');
  });
});

describe('validateRuleDraft — OFFLINE', () => {
  it('accepts an offline rule with no thresholds', () => {
    expect(validateRuleDraft(draft({ metric: 'OFFLINE', thresholdHigh: null }))).toBeNull();
  });

  it('rejects thresholds on an offline rule', () => {
    // Accepting them would store numbers the evaluator silently ignores.
    expect(validateRuleDraft(draft({ metric: 'OFFLINE', thresholdHigh: 25 }))?.field).toBe('thresholdHigh');
  });
});

describe('validateRuleDraft — name and delay', () => {
  it('rejects a blank or whitespace-only name', () => {
    expect(validateRuleDraft(draft({ name: '' }))?.field).toBe('name');
    expect(validateRuleDraft(draft({ name: '   ' }))?.field).toBe('name');
  });

  it('rejects a negative or fractional delay', () => {
    expect(validateRuleDraft(draft({ delaySeconds: -1 }))?.field).toBe('delaySeconds');
    expect(validateRuleDraft(draft({ delaySeconds: 1.5 }))?.field).toBe('delaySeconds');
  });

  it('accepts a zero delay', () => {
    expect(validateRuleDraft(draft({ delaySeconds: 0 }))).toBeNull();
  });
});
