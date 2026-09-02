import { describe, it, expect } from 'vitest';
import { decideAccountState, isLocked, statusWord, type AccountStatus } from '../account-state.js';

/**
 * The guard that stops an approval reporting an act it did not perform.
 *
 * Operator, 2026-09-02: an unlock was requested for an account that was never
 * locked, and approving it reported the account unlocked — and wrote an
 * `ACCOUNT_UNLOCKED` §11 audit row for an unlock that never happened.
 */
describe('decideAccountState — UNLOCK', () => {
  it('unlocks an account that is actually LOCKED', () => {
    const d = decideAccountState('UNLOCK', 'LOCKED', 'jsmith');
    expect(d.apply).toBe(true);
    expect(d.message).toBe('Account "jsmith" unlocked.');
  });

  it('does NOT act on an account that was never locked, and says the state found', () => {
    const d = decideAccountState('UNLOCK', 'ENABLED', 'jsmith');
    expect(d.apply).toBe(false);
    expect(d.message).toBe('Account "jsmith" was not locked — no change made (status: enabled).');
  });

  it('refuses for DISABLED and EXPIRED too, naming each state', () => {
    /**
     * Both are "cannot sign in" and NEITHER is locked. Silently clearing one to
     * satisfy an unlock request would grant access on an authority nobody gave —
     * a disabled account is disabled deliberately, and an expired one needs a
     * password reset, which is a different request type the form already offers.
     */
    const disabled = decideAccountState('UNLOCK', 'DISABLED', 'jsmith');
    expect(disabled.apply).toBe(false);
    expect(disabled.message).toContain('status: disabled');

    const expired = decideAccountState('UNLOCK', 'EXPIRED', 'jsmith');
    expect(expired.apply).toBe(false);
    expect(expired.message).toContain('status: password expired');
  });

  it('treats ONLY LOCKED as locked', () => {
    expect(isLocked('LOCKED')).toBe(true);
    for (const s of ['ENABLED', 'DISABLED', 'EXPIRED'] as AccountStatus[]) {
      expect(isLocked(s)).toBe(false);
    }
  });
});

describe('decideAccountState — ENABLE_ACCOUNT', () => {
  it('enables an account that is not already enabled', () => {
    for (const s of ['DISABLED', 'LOCKED', 'EXPIRED'] as AccountStatus[]) {
      const d = decideAccountState('ENABLE_ACCOUNT', s, 'jsmith');
      expect(d.apply).toBe(true);
      expect(d.message).toBe('Account "jsmith" enabled.');
    }
  });

  it('says "already enabled" and changes nothing', () => {
    const d = decideAccountState('ENABLE_ACCOUNT', 'ENABLED', 'jsmith');
    expect(d.apply).toBe(false);
    expect(d.message).toBe('Account "jsmith" is already enabled — no change made.');
  });
});

describe('decideAccountState — DISABLE_ACCOUNT', () => {
  it('disables an account that is not already disabled', () => {
    for (const s of ['ENABLED', 'LOCKED', 'EXPIRED'] as AccountStatus[]) {
      const d = decideAccountState('DISABLE_ACCOUNT', s, 'jsmith');
      expect(d.apply).toBe(true);
      expect(d.message).toBe('Account "jsmith" disabled.');
    }
  });

  it('says "already disabled" and changes nothing', () => {
    const d = decideAccountState('DISABLE_ACCOUNT', 'DISABLED', 'jsmith');
    expect(d.apply).toBe(false);
    expect(d.message).toBe('Account "jsmith" is already disabled — no change made.');
  });
});

describe('the three requests do not answer each other', () => {
  /**
   * The property that matters across the whole helper: each request type reads
   * only the state IT is about. A shared "is the account usable?" test would make
   * an enable request clear a lock, or an unlock enable a disabled account —
   * granting access nobody approved.
   */
  it('an unlock request never enables, and an enable request never unlocks', () => {
    // DISABLED: unlock declines, enable acts.
    expect(decideAccountState('UNLOCK', 'DISABLED', 'u').apply).toBe(false);
    expect(decideAccountState('ENABLE_ACCOUNT', 'DISABLED', 'u').apply).toBe(true);
    // LOCKED: unlock acts, disable also acts (a locked account can be disabled).
    expect(decideAccountState('UNLOCK', 'LOCKED', 'u').apply).toBe(true);
    expect(decideAccountState('DISABLE_ACCOUNT', 'LOCKED', 'u').apply).toBe(true);
  });

  it('names the account in every message, so one sentence serves every surface', () => {
    const types = ['UNLOCK', 'ENABLE_ACCOUNT', 'DISABLE_ACCOUNT'] as const;
    const states = ['ENABLED', 'DISABLED', 'LOCKED', 'EXPIRED'] as AccountStatus[];
    for (const t of types) {
      for (const s of states) {
        expect(decideAccountState(t, s, 'CWH-USER-1').message).toContain('"CWH-USER-1"');
      }
    }
  });
});

describe('statusWord', () => {
  it('renders EXPIRED in words rather than as a token', () => {
    // These strings reach an approval dialog and a §11 audit reason.
    expect(statusWord('EXPIRED')).toBe('password expired');
    expect(statusWord('ENABLED')).toBe('enabled');
    expect(statusWord('DISABLED')).toBe('disabled');
    expect(statusWord('LOCKED')).toBe('locked');
  });
});
