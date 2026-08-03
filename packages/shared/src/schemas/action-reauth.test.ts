import { describe, it, expect } from 'vitest';
import { actionReauthConfigSchema } from './action-reauth.js';
import { ALWAYS_ON_REAUTH_ACTIONS } from '../types/reauth-actions.js';

/**
 * The schema is the last barrier for a class of write the UI already forbids.
 * Both reauth editors render always-on actions as locked, but they POST the
 * WHOLE config seeded from GET — so without a schema-level refusal a
 * pre-existing `ACKNOWLEDGE_ALARM: []` entry would be re-persisted on every
 * unrelated save, and the stored config would keep claiming a 21 CFR §11.50
 * signature is switched off when it is always enforced.
 */
describe('actionReauthConfigSchema', () => {
  it('accepts an ordinary per-role policy', () => {
    const result = actionReauthConfigSchema.safeParse({
      DELETE_USER: ['ADMIN', 'SUPERVISOR'],
      MANAGE_ALARM_THRESHOLD: ['OPERATOR'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty config', () => {
    expect(actionReauthConfigSchema.safeParse({}).success).toBe(true);
  });

  it.each(ALWAYS_ON_REAUTH_ACTIONS)('rejects %s as a key — it cannot be configured per role', (action) => {
    // Empty array is the shape the editors would send for an "unticked" row,
    // and is the one most likely to be read as "signature disabled".
    const emptied = actionReauthConfigSchema.safeParse({ [action]: [] });
    expect(emptied.success).toBe(false);

    const populated = actionReauthConfigSchema.safeParse({ [action]: ['ADMIN'] });
    expect(populated.success).toBe(false);
  });

  it('names the offending action in the error so the caller can fix the payload', () => {
    const result = actionReauthConfigSchema.safeParse({ ACKNOWLEDGE_ALARM: [] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0].message).toContain('ACKNOWLEDGE_ALARM');
    expect(result.error.issues[0].message).toMatch(/always requires an electronic signature/i);
  });

  it('rejects the whole payload when one always-on key rides along with valid ones', () => {
    // The editors post everything at once, so a single bad key must not be
    // silently dropped while the rest is saved.
    const result = actionReauthConfigSchema.safeParse({
      DELETE_USER: ['ADMIN'],
      ACKNOWLEDGE_ALARM: [],
    });
    expect(result.success).toBe(false);
  });
});
