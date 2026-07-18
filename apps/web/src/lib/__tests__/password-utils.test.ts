import { describe, it, expect, vi } from 'vitest';
import { generatePassword, DEFAULT_PASSWORD_POLICY } from '../password-utils';

/**
 * `generatePassword` had no tests until 2026-07-15 — found while replacing its
 * Math.random with the platform CSPRNG. It produces the temporary passwords for
 * user-create, unlock and reset-approve, so "looks random" is not good enough.
 */
const policy = { ...DEFAULT_PASSWORD_POLICY };

describe('generatePassword — policy compliance', () => {
  it('satisfies every required class', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword(policy);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[!@#$%^&*()_+\-=[\]{}|;:,.<>?]/);
    }
  });

  it('respects minLength', () => {
    for (const minLength of [8, 16, 32]) {
      expect(generatePassword({ ...policy, minLength }).length).toBeGreaterThanOrEqual(minLength);
    }
  });

  it('honours per-class minimums', () => {
    const p = generatePassword({ ...policy, minLength: 20, minUppercase: 5, minNumbers: 4 });
    expect((p.match(/[A-Z]/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect((p.match(/[0-9]/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('omits a class the policy does not require', () => {
    const p = generatePassword({ ...policy, requireSpecialChars: false, minSpecialChars: 0, minLength: 40 });
    expect(p).not.toMatch(/[!@#$%^&*()_+\-=[\]{}|;:,.<>?]/);
  });
});

describe('generatePassword — randomness quality', () => {
  it('does not repeat across many calls', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassword(policy)));
    expect(seen.size).toBe(500);
  });

  /**
   * The old shuffle was `sort(() => Math.random() - 0.5)` — a non-transitive
   * comparator, so the permutation is biased and engine-dependent, not uniform.
   * The required-class characters are pushed onto the FRONT of the array before
   * shuffling, so the bias shows up as an uppercase landing in position 0 more
   * often than chance.
   *
   * The threshold is measured, not guessed. Under this policy (4 required + 4
   * filler): Fisher-Yates gives ~27.2%, the broken sort ~35.0%. At N=5000 the
   * standard error is ~0.6pt, so 31% sits ~4.5σ from each — it fails the broken
   * shuffle and passes the correct one without flaking.
   *
   * Verified by mutation: reverting to `sort(() => Math.random() - 0.5)` turns
   * this red. A passing statistical test proves nothing unless you check it can
   * fail.
   */
  it('shuffles uniformly — position 0 is not biased toward the first required class', () => {
    const N = 5000;
    let upperFirst = 0;
    for (let i = 0; i < N; i++) if (/[A-Z]/.test(generatePassword(policy)[0])) upperFirst++;
    expect(upperFirst / N).toBeLessThan(0.31);
  });

  it('every position varies across runs (nothing is pinned)', () => {
    const runs = Array.from({ length: 200 }, () => generatePassword({ ...policy, minLength: 12 }));
    for (let pos = 0; pos < 12; pos++) {
      const distinct = new Set(runs.map((r) => r[pos]));
      expect(distinct.size).toBeGreaterThan(1);
    }
  });

  it('uses the crypto RNG, not Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    generatePassword(policy);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
