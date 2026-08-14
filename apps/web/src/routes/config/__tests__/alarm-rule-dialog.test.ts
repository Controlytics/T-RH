import { describe, it, expect } from 'vitest';
import { draftError, parseThreshold, emptyDraft, type RuleDraft } from '../alarm-rule-dialog';

const draft = (over: Partial<RuleDraft> = {}): RuleDraft => ({
  ...emptyDraft,
  name: 'Cold room high',
  targetKind: 'instrument',
  targetId: 'i1',
  thresholdHigh: 25,
  ...over,
});

describe('draftError mirrors the server rules', () => {
  it('accepts a complete draft', () => {
    expect(draftError(draft())).toBeNull();
  });

  it('requires a name and a target', () => {
    expect(draftError(draft({ name: '   ' }))?.field).toBe('name');
    expect(draftError(draft({ targetId: '' }))?.field).toBe('targetId');
  });

  it('requires the threshold the comparison actually uses', () => {
    // A rule with no usable threshold NEVER fires, so it must not be savable — this is
    // the difference between "you cannot save that" and a rule that silently does nothing.
    expect(draftError(draft({ thresholdHigh: null }))?.field).toBe('thresholdHigh');
    expect(draftError(draft({ comparison: 'BELOW', thresholdHigh: null }))?.field).toBe('thresholdLow');
    expect(draftError(draft({ comparison: 'BELOW', thresholdLow: 2, thresholdHigh: null }))).toBeNull();
  });

  it('requires both thresholds for a range, in the right order', () => {
    expect(draftError(draft({ comparison: 'OUTSIDE_RANGE', thresholdLow: 18 }))).toBeNull();
    expect(draftError(draft({ comparison: 'OUTSIDE_RANGE', thresholdLow: null }))?.field).toBe('thresholdLow');
    expect(draftError(draft({ comparison: 'OUTSIDE_RANGE', thresholdLow: 30, thresholdHigh: 20 }))?.field)
      .toBe('thresholdLow');
  });

  it('accepts a zero threshold', () => {
    // 0 °C is a real cold-room limit; a falsy check would reject it.
    expect(draftError(draft({ comparison: 'BELOW', thresholdLow: 0, thresholdHigh: null }))).toBeNull();
  });

  it('rejects a threshold on a stopped-reporting rule', () => {
    expect(draftError(draft({ metric: 'OFFLINE' }))?.field).toBe('thresholdHigh');
    expect(draftError(draft({ metric: 'OFFLINE', thresholdHigh: null }))).toBeNull();
  });

  it('rejects a negative or fractional delay', () => {
    expect(draftError(draft({ delaySeconds: -1 }))?.field).toBe('delaySeconds');
    expect(draftError(draft({ delaySeconds: 1.5 }))?.field).toBe('delaySeconds');
  });

  it('checks name before target, matching the server order', () => {
    expect(draftError(draft({ name: '', targetId: '' }))?.field).toBe('name');
  });
});

describe('parseThreshold', () => {
  it('treats an empty box as unset but keeps zero', () => {
    expect(parseThreshold('')).toBeNull();
    expect(parseThreshold('   ')).toBeNull();
    expect(parseThreshold('0')).toBe(0);
  });

  it('parses negatives and decimals', () => {
    expect(parseThreshold('-20.5')).toBe(-20.5);
  });

  it('yields NaN for junk, so draftError refuses it rather than sending it', () => {
    expect(Number.isNaN(parseThreshold('abc') as number)).toBe(true);
  });
});
