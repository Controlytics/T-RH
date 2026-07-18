/**
 * Compute whether a user's password is expired under the live policy.
 *
 * Replaces direct reads of `users.password_expires_at`. That column is a
 * frozen snapshot baked in at password-change / create / unlock / reset
 * time — when an admin lowers `passwordExpiryDays` later, no existing
 * user's stored value moves, so the policy change has no effect.
 * Deriving from `passwordChangedAt` + the live policy makes policy edits
 * apply to everyone, but on a fresh clock (see policyUpdatedAt below).
 *
 * `passwordExpiryDays === 0` (or absent) means "no expiry" — matches the
 * `changePassword` semantics: `expiryDays > 0 ? ... : null`.
 *
 * Falls back to `createdAt` when `passwordChangedAt` is null (legacy
 * users created before the column was populated).
 *
 * **Policy-change grace period (`policyUpdatedAt`).** The anchor is floored
 * at the policy's own `updatedAt` timestamp. Lowering the policy (e.g.
 * 120 → 1 day) therefore grants every user a fresh `days`-long window
 * from the moment the admin clicked Save, rather than instantly expiring
 * everyone whose last password change is older than the new window.
 * Without this floor, dropping the policy from 120 to 1 mass-locks
 * everyone including superadmin the moment the policy is saved — the
 * exact bug reported on 2026-05-25.
 */
const DAY_MS = 86_400_000;

/**
 * The effective expiry anchor: the later of the user's password-change time
 * (falling back to createdAt for legacy users) and the policy's own
 * `updatedAt`. The policy floor is the grace-period guard documented above —
 * lowering the policy grants everyone a fresh window rather than mass-expiring.
 * Returns null only when there is no usable timestamp at all.
 */
function expiryAnchor(
  passwordChangedAt: Date | null,
  createdAt: Date,
  policyUpdatedAt: Date | null,
): Date | null {
  const passwordAnchor = passwordChangedAt ?? createdAt;
  if (!passwordAnchor) return null;
  return policyUpdatedAt && policyUpdatedAt.getTime() > passwordAnchor.getTime()
    ? policyUpdatedAt
    : passwordAnchor;
}

export function isPasswordExpired(
  passwordChangedAt: Date | null,
  createdAt: Date,
  passwordExpiryDays: number | undefined | null,
  policyUpdatedAt: Date | null,
): boolean {
  if (!passwordExpiryDays || passwordExpiryDays <= 0) return false;
  const anchor = expiryAnchor(passwordChangedAt, createdAt, policyUpdatedAt);
  if (!anchor) return false;
  const expiresAt = anchor.getTime() + passwordExpiryDays * DAY_MS;
  return expiresAt < Date.now();
}

/**
 * Whole days from now until the password expires, using the SAME anchor as
 * `isPasswordExpired` so warnings and the login block agree exactly.
 *
 * Rounds UP (`Math.ceil`) so a password 4 days 14 hours out reads as "5 days".
 * Returns:
 *   - `null` when expiry is disabled (`passwordExpiryDays <= 0`) or no anchor.
 *   - `>= 1` when the password is not yet expired.
 *   - `<= 0` when already expired (use `isPasswordExpired` for the authoritative
 *     expired check — this mirrors it: expiresAt < now ⇒ ceil((<0)/DAY) <= 0).
 */
export function daysUntilPasswordExpiry(
  passwordChangedAt: Date | null,
  createdAt: Date,
  passwordExpiryDays: number | undefined | null,
  policyUpdatedAt: Date | null,
): number | null {
  if (!passwordExpiryDays || passwordExpiryDays <= 0) return null;
  const anchor = expiryAnchor(passwordChangedAt, createdAt, policyUpdatedAt);
  if (!anchor) return null;
  const expiresAt = anchor.getTime() + passwordExpiryDays * DAY_MS;
  return Math.ceil((expiresAt - Date.now()) / DAY_MS);
}
