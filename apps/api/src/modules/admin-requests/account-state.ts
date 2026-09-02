/**
 * "Is this account already in the state the request asks for?" — decided ONCE,
 * as a pure function, for every state-changing admin request.
 *
 * ## The defect this exists to fix
 *
 * Operator, 2026-09-02: *"in contact admin user requested for account unlock but
 * that account was actually not locked, when admin approve that request account is
 * showing unlocked, we need to show account not locked"*.
 *
 * `executeApproval` called `userService.unlock()` unconditionally, and that method
 * clears the lock, sets status ENABLED, zeroes `failedLoginAttempts`, issues a
 * temporary password and writes an `ACCOUNT_UNLOCKED` audit row — none of which
 * checks whether a lock was ever there. **The audit row is the real damage**: a
 * §11 record asserting an administrative act that did not happen. A wrong screen
 * is a nuisance; a wrong regulated record is the thing the audit trail exists to
 * prevent.
 *
 * ## Why the guard is HERE and not on the contact-admin form
 *
 * The form already has one — `isAlreadyEnabled` in `contact-admin.tsx` — and it
 * **can never fire**. It reads `lookupUser.status`, but `GET /user-lookup` returns
 * only `{exists, username}`: `status`, `role`, `email` and `department` were
 * deliberately dropped by the 2026-05-20 delta audit (finding H1) because a
 * response that varies with the account is an unauthenticated enumeration oracle
 * for the whole staff directory. So the field is always `''` and the guard is
 * decoration.
 *
 * **Do not "fix" that by putting `status` back on the public endpoint.** The
 * check belongs where the caller is authenticated and already entitled to see the
 * account — at approval. That also closes the race the form could never close: an
 * account can be locked or unlocked in the hours between submission and approval,
 * so submission-time state is not the state being acted on.
 *
 * ## Why a no-op is APPROVED rather than REJECTED
 *
 * The admin did approve it; the system simply had nothing to do. Rejecting would
 * assert the request was refused on its merits, which is a different statement
 * about a person's access. The request is approved, no state-change audit row is
 * written, and the outcome message says plainly what was found.
 */

/** The four values `UserStatus` can hold. Mirrored rather than imported from
 *  `@prisma/client` so this module stays pure and testable without a database. */
export type AccountStatus = 'ENABLED' | 'DISABLED' | 'LOCKED' | 'EXPIRED';

/** The request types that change an account's state, and therefore need this. */
export type StateRequestType = 'UNLOCK' | 'ENABLE_ACCOUNT' | 'DISABLE_ACCOUNT';

export interface AccountStateDecision {
  /** Should the state-changing call actually run? */
  apply: boolean;
  /** What the admin is told, and what goes in the request's audit reason. */
  message: string;
}

/**
 * A LOCKED account is locked — nothing else is.
 *
 * `EXPIRED` and `DISABLED` are deliberately NOT treated as locked even though a
 * user cannot sign in under either. They are different administrative facts with
 * different remedies (a password reset; an enable), and answering an unlock
 * request by clearing one of them would be doing something the requester did not
 * ask for, to an account, on someone else's authority.
 */
export function isLocked(status: AccountStatus): boolean {
  return status === 'LOCKED';
}

/**
 * Decide whether an approval should act, and what to say either way.
 *
 * `username` is interpolated into the message rather than the caller doing it, so
 * every surface — the approval dialog, the audit reason, the API response — says
 * the same sentence about the same account.
 */
export function decideAccountState(
  requestType: StateRequestType,
  status: AccountStatus,
  username: string,
): AccountStateDecision {
  switch (requestType) {
    case 'UNLOCK':
      return isLocked(status)
        ? { apply: true, message: `Account "${username}" unlocked.` }
        // Names the state actually found. "Not locked" alone would leave an admin
        // wondering whether the account is usable at all — a DISABLED account is
        // also "not locked", and that one still needs action.
        : { apply: false, message: `Account "${username}" was not locked — no change made (status: ${statusWord(status)}).` };

    case 'ENABLE_ACCOUNT':
      return status === 'ENABLED'
        ? { apply: false, message: `Account "${username}" is already enabled — no change made.` }
        : { apply: true, message: `Account "${username}" enabled.` };

    case 'DISABLE_ACCOUNT':
      return status === 'DISABLED'
        ? { apply: false, message: `Account "${username}" is already disabled — no change made.` }
        : { apply: true, message: `Account "${username}" disabled.` };
  }
}

/**
 * The status in the operator's words.
 *
 * A raw `EXPIRED` in a sentence reads as a system token; these strings appear in
 * an approval dialog and in a §11 audit reason.
 */
export function statusWord(status: AccountStatus): string {
  switch (status) {
    case 'ENABLED': return 'enabled';
    case 'DISABLED': return 'disabled';
    case 'LOCKED': return 'locked';
    case 'EXPIRED': return 'password expired';
  }
}
