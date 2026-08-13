import { describe, it, expect } from 'vitest';
import { validateRuleDraft, validateAcknowledgement, clampSignature, SIGNATURE_MEANING_MAX, type RuleDraft } from '../validation.js';

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

describe('validateAcknowledgement', () => {
  const fresh = { acknowledgedAt: null, acknowledgedBy: null };

  it('accepts a real reason on an unacknowledged alarm', () => {
    expect(validateAcknowledgement(fresh, 'Door left open during transfer')).toBeNull();
  });

  it('rejects a blank, whitespace-only, or too-short reason', () => {
    // The reason is signed into the hash chain; "ok" is not an explanation.
    expect(validateAcknowledgement(fresh, '')?.code).toBe('VALIDATION_ERROR');
    expect(validateAcknowledgement(fresh, '     ')?.code).toBe('VALIDATION_ERROR');
    expect(validateAcknowledgement(fresh, 'ok')?.code).toBe('VALIDATION_ERROR');
  });

  it('names the field so the dialog can mark it', () => {
    const r = validateAcknowledgement(fresh, '');
    expect(r && 'field' in r && r.field).toBe('reason');
  });

  it('refuses a second acknowledgement even with a valid reason', () => {
    // 409, not an overwrite: replacing the first signature would erase who accepted it.
    const done = { acknowledgedAt: new Date('2026-08-13T04:00:00Z'), acknowledgedBy: 'qa.lead' };
    expect(validateAcknowledgement(done, 'Reviewed again by QA')?.code).toBe('ALREADY_ACKNOWLEDGED');
  });

  it('says who acknowledged it and when', () => {
    const done = { acknowledgedAt: new Date('2026-08-13T04:00:00Z'), acknowledgedBy: 'qa.lead' };
    const msg = validateAcknowledgement(done, 'Reviewed again by QA')!.message;
    expect(msg).toContain('qa.lead');
    expect(msg).toContain('2026-08-13T04:00:00');
  });

  it('checks acknowledgement BEFORE the reason', () => {
    // Otherwise an acknowledged alarm would report a reason problem, sending the
    // operator to fix the wrong thing.
    const done = { acknowledgedAt: new Date('2026-08-13T04:00:00Z'), acknowledgedBy: null };
    expect(validateAcknowledgement(done, '')?.code).toBe('ALREADY_ACKNOWLEDGED');
  });
});

describe('clampSignature', () => {
  it('leaves a normal signature line untouched', () => {
    const line = 'Acknowledged alarm on CWH-I/142 (TEMPERATURE) — door left open';
    expect(clampSignature(line)).toBe(line);
  });

  it('never exceeds the VARCHAR(255) column', () => {
    // Without this the INSERT throws AFTER the acknowledgement is written, leaving an
    // acknowledged alarm with no audit row.
    const long = clampSignature('Acknowledged alarm on X (TEMPERATURE) — ' + 'y'.repeat(400));
    expect(long.length).toBe(SIGNATURE_MEANING_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('keeps a line of exactly the limit', () => {
    const exact = 'z'.repeat(SIGNATURE_MEANING_MAX);
    expect(clampSignature(exact)).toBe(exact);
  });
});
