import { verifyPassword } from './password.js';
import { ldapService, LDAP_SENTINEL_HASH } from '../modules/ldap/ldap.service.js';

/**
 * Directory-backed identity helpers.
 *
 * Before this module existed, "is this user LDAP-sourced?" was open-coded in
 * `auth.service.login()` as two different checks (`authSource === 'ldap'` in
 * one branch, `passwordHash === 'LDAP_EXTERNAL_AUTH'` in another) and NOWHERE
 * else — so every other credential surface silently treated a directory user
 * as a local one:
 *
 *   - `authService.verify()` (POST /api/auth/verify — both removed 2026-10-05,
 *     audit SEC-5; nothing consumed the token it minted) bcrypt-compared the
 *     supplied password against the literal string 'LDAP_EXTERNAL_AUTH'.
 *     bcrypt.compare against a non-hash returns false, so **re-authentication
 *     could never succeed for a directory user** — every reauth-gated action
 *     (approve, sign, bypass, terminate, config edit — 92 of them) was
 *     permanently unreachable for AD-authenticated staff. A client mapping AD
 *     groups to SUPERVISOR / QA would find those roles unable to sign anything,
 *     which is the entire point of 21 CFR §11.200 re-authentication.
 *   - `lib/reauth-check.ts` had the identical bug on the inline-password path.
 *   - `userService.resetPassword()` overwrote the sentinel with a real bcrypt
 *     hash, silently converting the account to local auth and bypassing the
 *     directory from then on.
 *   - Password EXPIRY applied to directory users, whose `passwordChangedAt` is
 *     null forever, so they were force-expired `passwordExpiryDays` after
 *     provisioning against a password the application does not own.
 *
 * Everything that needs to answer "can this person prove who they are?" now
 * goes through `verifyCredential()` so those surfaces cannot drift apart again.
 */

/**
 * The `users.password_hash` placeholder for directory accounts. Declared in
 * `ldap.service.ts` (the module that writes it) and re-exported here so callers
 * have one import for the whole identity surface.
 */
export { LDAP_SENTINEL_HASH };

export interface IdentityUser {
  username: string;
  role: string;
  authSource?: string | null;
  passwordHash: string;
}

/**
 * Is this account's credential owned by the directory rather than by us?
 *
 * SUPER_ADMIN is deliberately excluded. `ldapService.mapGroupsToRole()` refuses
 * to provision one, and `auth.service.login()` has always skipped the LDAP bind
 * branch for SUPER_ADMIN, so the break-glass account stays local-only and
 * remains usable when the directory is unreachable. Excluding it here keeps
 * that single rule in one place.
 *
 * Both signals are checked because they can disagree: `authSource` is the
 * intent, the sentinel hash is the physical state. A row with the sentinel but
 * `authSource='local'` (e.g. a partially-migrated record) has no usable local
 * password either way, so it must take the directory path.
 */
export function isLdapUser(user: Pick<IdentityUser, 'role' | 'authSource' | 'passwordHash'>): boolean {
  if (user.role === 'SUPER_ADMIN') return false;
  return user.authSource === 'ldap' || user.passwordHash === LDAP_SENTINEL_HASH;
}

export interface CredentialResult {
  /** Did the supplied password prove this identity? */
  ok: boolean;
  /** Which authority answered — 'ldap' means a successful/attempted directory bind. */
  via: 'ldap' | 'local';
  /**
   * True when a FAILURE must not increment the local lockout counter because the
   * directory owns lockout for this account (operator decision, 2026-08-08).
   * Counting locally as well produces double lockout: DigiLog locks at its own
   * `maxFailedAttempts` while AD still considers the account fine, leaving a
   * user with valid AD credentials needing a DigiLog admin to unlock them.
   * Failures are still audited — only the counter is delegated.
   */
  lockoutDelegated: boolean;
  /**
   * Set when the directory could not be consulted at all (LDAP disabled while
   * directory users exist, or the server was unreachable). Distinguishes
   * "wrong password" from "cannot check" for logging — never for the API
   * response, which stays a unified INVALID_CREDENTIALS.
   */
  unavailableReason?: string;
}

/**
 * Verify a password against whichever authority owns this account.
 *
 * Callers keep responsibility for lockout, auditing, and the (unified) error
 * response — this returns a verdict only. That split is what keeps this module
 * free of an import cycle back into `auth.service.ts`, which owns
 * `applyFailedPasswordAttempt`.
 *
 * Returns `attributes`/`groups` on a successful directory bind so the caller can
 * run attribute + role sync without a second round-trip to the directory.
 */
export async function verifyCredential(
  user: IdentityUser,
  password: string,
): Promise<CredentialResult & { ldapResult?: Awaited<ReturnType<typeof ldapService.authenticateUser>> }> {
  if (!isLdapUser(user)) {
    return { ok: await verifyPassword(password, user.passwordHash), via: 'local', lockoutDelegated: false };
  }

  const cfg = await ldapService.getConfig();
  if (!cfg.enabled) {
    // A directory user with LDAP switched off has no credential we can check.
    // Fail closed — do NOT fall through to bcrypt, which would compare against
    // the sentinel and (correctly but accidentally) deny. Being explicit means
    // the operator gets a diagnosable log line instead of "wrong password".
    return {
      ok: false, via: 'ldap', lockoutDelegated: true,
      unavailableReason: 'LDAP is disabled but this account is directory-sourced',
    };
  }

  try {
    const ldapResult = await ldapService.authenticateUser(user.username, password);
    return { ok: !!ldapResult, via: 'ldap', lockoutDelegated: true, ldapResult: ldapResult ?? undefined };
  } catch (err: any) {
    return {
      ok: false, via: 'ldap', lockoutDelegated: true,
      unavailableReason: `LDAP bind error: ${err?.message ?? err}`,
    };
  }
}

/**
 * Human-facing explanation used by every surface that refuses a local-password
 * operation on a directory account (admin reset, self-service change, forgot-
 * password). Kept in one place so the wording an operator sees is identical
 * wherever they hit it.
 */
export const LDAP_PASSWORD_MANAGED_MESSAGE =
  'This user signs in with their company directory (Active Directory) account. '
  + 'Their password is managed in the directory and cannot be changed here.';
