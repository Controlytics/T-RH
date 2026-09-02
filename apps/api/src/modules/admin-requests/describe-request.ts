/**
 * What an admin-request audit record CALLS itself — one definition, used by the
 * submitted, approved and rejected rows alike.
 *
 * ## What was wrong
 *
 * Operator, 2026-09-02. The records read:
 *
 *     Admin request submitted — "Create User — Admin User (101010)"
 *     Admin request approved  — "Create User — Admin User (101010)" by 101010
 *
 * Both halves named the same person — the REQUESTER — and the record never said
 * which account the request was about. In their own example the requester was
 * `101020` and the approver `101010`; the two IDs are different people and a §11
 * record has to keep them apart.
 *
 * The record now answers three questions instead of one: **what operation**, **on
 * which account and in what role**, and **who asked**. `by {actor}` is untouched —
 * it was always `ctx.userId`, the admin who approved and e-signed.
 *
 * ## Why the requester stays
 *
 * Operator's choice when offered both (2026-09-02). "Who asked for this" is half
 * of what an approval record is for; dropping it to shorten a line would put that
 * fact only in `requestData`, where nobody reading the trail will look.
 */

/** The role, resolved where the system knows it. Absent is normal and not an
 *  error: a CREATE_USER names a role that does not exist yet, and a target user
 *  may have been deleted between submission and approval. */
export interface RequestTargetParts {
  /** The account the request is ABOUT — the requested login ID, not the requester. */
  username?: string | null;
  /** The role that account holds, or for CREATE_USER the one being asked for. */
  role?: string | null;
}

/**
 * The target account, as one phrase: `900123 (Operator)`, or `900123` when no
 * role is known.
 *
 * Returns an empty string when there is no username at all, so callers can fall
 * back rather than printing an empty bracket — a record reading `— ()` looks like
 * a rendering fault and invites someone to "fix" a record that is merely sparse.
 */
export function describeTarget(parts: RequestTargetParts): string {
  const username = (parts.username ?? '').trim();
  if (!username) return '';
  const role = (parts.role ?? '').trim();
  return role ? `${username} (${role})` : username;
}

/**
 * Pull the target account out of a request's own `requestData`.
 *
 * Every request type stores the account under `username` — CREATE_USER holds the
 * login ID being ASKED FOR, the rest hold an existing account — so one read
 * serves all of them. `requestedRole` is CREATE_USER's alone; for the others the
 * role is not in `requestData` at all and is passed in by the caller once it has
 * loaded the user.
 */
export function targetFromRequestData(
  requestData: unknown,
  resolvedRole?: string | null,
): RequestTargetParts {
  const data = (requestData ?? {}) as Record<string, unknown>;
  const username = typeof data.username === 'string' ? data.username : '';
  const requestedRole = typeof data.requestedRole === 'string' ? data.requestedRole : '';
  return { username, role: resolvedRole ?? requestedRole ?? '' };
}

/**
 * `Admin User (101010)` — the person who raised it.
 *
 * **The two halves are NOT equally trustworthy, and a reader of this record
 * should know it.** The employee ID is VERIFIED: the contact-admin form checks it
 * against `GET /user-lookup` and refuses to submit without a hit. The NAME is
 * typed by whoever is at the keyboard and is checked against nothing.
 *
 * It used to be taken from the lookup response, which made a mismatch impossible
 * by construction — but that stopped when the 2026-08-29 PII audit removed
 * `fullName` from the endpoint, and the form then sent an empty name and 400'd on
 * every submission until 2026-09-02. Restoring the typed value is what makes the
 * form work again; it does not restore the verification, and cannot without
 * putting a name back on an unauthenticated endpoint.
 *
 * The audit row stores `requesterName` and `requesterEmployeeId` as separate
 * fields as well as inside this label, so the verified half is always recoverable
 * on its own. The APPROVAL's `by {actor}` is a third thing again, and the
 * strongest: a re-authenticated session.
 */
export function requesterLabel(request: {
  requesterName: string;
  requesterEmployeeId?: string | null;
}): string {
  return request.requesterEmployeeId
    ? `${request.requesterName} (${request.requesterEmployeeId})`
    : request.requesterName;
}

/**
 * The full name a record carries, e.g.
 * `Create User — 900123 (Operator), requested by Admin User (101010)`.
 *
 * **Kept under `audit_trail.signature_meaning`'s VARCHAR(255).** That column is
 * shorter than `reason` (TEXT), and the throw on overflow happens INSIDE
 * `auditLog` — i.e. AFTER the action it describes has been performed — leaving a
 * regulated act with no audit row at all. This repo has that failure recorded
 * already for instrument codes. Every part here is operator-supplied free text, so
 * the result is clamped rather than trusted: 100 for the target (a username is 50
 * and a role name 50) and 100 for the requester.
 */
export function requestRecordName(opts: {
  operation: string;
  target: string;
  requester: string;
}): string {
  const target = clamp(opts.target, 100);
  const requester = clamp(opts.requester, 100);
  const head = target ? `${opts.operation} — ${target}` : opts.operation;
  return requester ? `${head}, requested by ${requester}` : head;
}

function clamp(v: string, max: number): string {
  return v.length <= max ? v : `${v.slice(0, max - 1)}…`;
}
