import { describe, it, expect } from 'vitest';
import { isPasswordExpired, daysUntilPasswordExpiry } from '../password-expiry.js';

const day = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * day);
const daysFromNow = (n: number) => new Date(Date.now() + n * day);

describe('isPasswordExpired', () => {
  it('returns false when policy days is 0 (no expiry)', () => {
    expect(isPasswordExpired(daysAgo(365), daysAgo(365), 0, daysAgo(365))).toBe(false);
  });

  it('returns false when policy days is undefined', () => {
    expect(isPasswordExpired(daysAgo(365), daysAgo(365), undefined, null)).toBe(false);
  });

  it('falls back to createdAt when passwordChangedAt is null', () => {
    expect(isPasswordExpired(null, daysAgo(10), 5, daysAgo(365))).toBe(true);
    expect(isPasswordExpired(null, daysAgo(2), 5, daysAgo(365))).toBe(false);
  });

  it('expires when password is older than the policy window', () => {
    expect(isPasswordExpired(daysAgo(10), daysAgo(20), 5, daysAgo(365))).toBe(true);
  });

  it('does NOT expire when password is younger than the policy window', () => {
    expect(isPasswordExpired(daysAgo(2), daysAgo(20), 5, daysAgo(365))).toBe(false);
  });

  // The 2026-05-25 bug: admin lowers passwordExpiryDays from 120 to 1 and
  // every account with an older password gets force-flagged on the next
  // request. policyUpdatedAt acts as a floor so the new window is granted
  // as a grace period from the save time.
  describe('grace floor (policyUpdatedAt)', () => {
    it('does NOT expire an old password right after the policy was just lowered', () => {
      // password from 100 days ago, policy was just saved 5 minutes ago at 1 day.
      // Without the floor: 100d > 1d ⇒ expired. With the floor: anchor = NOW-5min,
      // expiry = NOW-5min+1d, still in the future ⇒ not expired.
      const policySavedJustNow = new Date(Date.now() - 5 * 60 * 1000);
      expect(isPasswordExpired(daysAgo(100), daysAgo(200), 1, policySavedJustNow)).toBe(false);
    });

    it('DOES expire an old password after the grace window has elapsed', () => {
      // Same scenario but the policy was saved 2 days ago and window is 1 day.
      const policySaved2DaysAgo = daysAgo(2);
      expect(isPasswordExpired(daysAgo(100), daysAgo(200), 1, policySaved2DaysAgo)).toBe(true);
    });

    it('uses passwordChangedAt when it is newer than policyUpdatedAt', () => {
      // User changed password yesterday, policy saved a year ago, window 5 days.
      // Should NOT be expired (anchor = yesterday, expiry = yesterday + 5d).
      expect(isPasswordExpired(daysAgo(1), daysAgo(200), 5, daysAgo(365))).toBe(false);
    });

    it('tolerates a null policyUpdatedAt (legacy / never-saved policy)', () => {
      // No floor available — behaves as if only passwordChangedAt counts.
      expect(isPasswordExpired(daysAgo(10), daysAgo(20), 5, null)).toBe(true);
      expect(isPasswordExpired(daysAgo(2), daysAgo(20), 5, null)).toBe(false);
    });
  });
});

describe('daysUntilPasswordExpiry', () => {
  it('returns null when expiry is disabled (0 or undefined)', () => {
    expect(daysUntilPasswordExpiry(daysAgo(10), daysAgo(10), 0, null)).toBeNull();
    expect(daysUntilPasswordExpiry(daysAgo(10), daysAgo(10), undefined, null)).toBeNull();
  });

  it('counts whole days remaining, rounding up', () => {
    // Changed 85 days ago, 90-day policy ⇒ expiry ~5 days out. ceil ⇒ 5.
    expect(daysUntilPasswordExpiry(daysAgo(85), daysAgo(85), 90, null)).toBe(5);
    // A password changed 4.5 days ago on a 10-day policy ⇒ 5.5 days left ⇒ 6.
    const halfDay = day / 2;
    const changed = new Date(Date.now() - (4 * day + halfDay));
    expect(daysUntilPasswordExpiry(changed, changed, 10, null)).toBe(6);
  });

  it('is <= 0 exactly when isPasswordExpired is true (already expired)', () => {
    // Changed 100 days ago, 90-day policy ⇒ expired.
    expect(daysUntilPasswordExpiry(daysAgo(100), daysAgo(100), 90, null)).toBeLessThanOrEqual(0);
    expect(isPasswordExpired(daysAgo(100), daysAgo(100), 90, null)).toBe(true);
  });

  it('falls back to createdAt when passwordChangedAt is null', () => {
    expect(daysUntilPasswordExpiry(null, daysAgo(88), 90, null)).toBe(2);
  });

  it('applies the policyUpdatedAt grace floor (fresh window after a lowered policy)', () => {
    // Old password (100d), policy just saved with a 5-day window ⇒ ~5 days left.
    const savedJustNow = new Date(Date.now() - 60 * 1000);
    expect(daysUntilPasswordExpiry(daysAgo(100), daysAgo(200), 5, savedJustNow)).toBe(5);
  });

  it('produces the expected warning window (days N..1)', () => {
    // 90-day policy, warn window 5: eligible on days 85..89 after change.
    const notifDays = 5;
    for (let ageDays = 85; ageDays <= 89; ageDays++) {
      const left = daysUntilPasswordExpiry(daysAgo(ageDays), daysAgo(ageDays), 90, null)!;
      expect(left >= 1 && left <= notifDays).toBe(true);
    }
    // Day 84 (6 days left) is just outside the window.
    expect(daysUntilPasswordExpiry(daysAgo(84), daysAgo(84), 90, null)).toBeGreaterThan(notifDays);
    // Future-dated createdAt sanity (defensive): still non-null.
    expect(daysUntilPasswordExpiry(daysFromNow(1), daysFromNow(1), 90, null)).not.toBeNull();
  });
});
