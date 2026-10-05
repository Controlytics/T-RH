/**
 * WHO MAY SEE A NOTIFICATION — one rule, two renderings (audit 2026-10-03,
 * API-16).
 *
 * Until then the rule lived three times: `buildVisibilityFilter` (the list),
 * `assertNotificationVisible` (mark-read / mark-unread / delete by id) and
 * `buildBulkVisibilityFilter` (bulk read / unread / delete) — and the copies
 * disagreed. The list showed an ADMIN their own rows, the ADMIN-addressed rows
 * and the general ones; the single-row check let an ADMIN act on ANY row not
 * addressed to SUPER_ADMIN, another user's personal notification included. A
 * regular user's list was `forUserId = me`; the single-row and bulk copies also
 * accepted `targetUserId = me`, which is the admin-addressed row ABOUT the
 * user — so a user holding NOTIFICATION_DELETE could delete the USER_LOCKED
 * notice raised about themself.
 *
 * The rule is written ONCE here as data (`visibilityRule`), and BOTH the Prisma
 * `where` fragment (`visibilityWhere`) and the in-memory predicate
 * (`isNotificationVisible`) are derived from that data, so they cannot say
 * different things. Nothing else in the module may spell the rule out again.
 *
 * The rule itself (unchanged for the list, which was the correct copy):
 *   SUPER_ADMIN — everything.
 *   ADMIN       — addressed to them, addressed to the ADMIN role, or general
 *                 (no forUserId AND no forRole); never a row addressed to
 *                 SUPER_ADMIN.
 *   anyone else — addressed to them (`forUserId`). `targetUserId` — the user a
 *                 row is ABOUT — grants nothing: that row is addressed to the
 *                 administrators.
 */

/** A notification's addressing fields, the only ones the rule reads. */
export interface Addressed {
  forUserId: string | null;
  forRole: string | null;
}

/** One branch of the rule: every named field must equal the value given. */
type Branch = Partial<Addressed>;

export interface VisibilityRule {
  /** `null` = no restriction (SUPER_ADMIN). */
  anyOf: Branch[] | null;
  /** A `forRole` value that is refused even when a branch matches. */
  notForRole?: string;
}

export function visibilityRule(userRole: string, username: string): VisibilityRule {
  if (userRole === 'SUPER_ADMIN') return { anyOf: null };
  // No identity, no rows. `{ forUserId: undefined }` would be DROPPED by Prisma
  // (undefined = "no condition"), turning a missing username into "everything".
  if (!username) return { anyOf: [] };
  if (userRole === 'ADMIN') {
    return {
      anyOf: [
        { forUserId: username },
        { forRole: 'ADMIN' },
        { forRole: null, forUserId: null },
      ],
      notForRole: 'SUPER_ADMIN',
    };
  }
  return { anyOf: [{ forUserId: username }] };
}

/**
 * The rule as a Prisma `where` fragment for `notification`.
 *
 * The role exclusion is null-safe ON PURPOSE: a bare `NOT: { forRole: 'X' }`
 * compiles to `NOT (for_role = 'X')`, which is NULL — not TRUE — for a row
 * whose for_role IS NULL, so it silently dropped the personally-addressed and
 * general branches (found 2026-07-13). Hence `OR [forRole null, forRole not X]`.
 */
export function visibilityWhere(userRole: string, username: string): Record<string, unknown> {
  const rule = visibilityRule(userRole, username);
  if (rule.anyOf === null) return {};
  // `in: []` matches nothing in Prisma (`{}` would match everything).
  if (rule.anyOf.length === 0) return { id: { in: [] } };
  const where: Record<string, unknown> = {};
  if (rule.anyOf.length === 1) {
    Object.assign(where, rule.anyOf[0]);
  } else {
    where.OR = rule.anyOf.map((b) => ({ ...b }));
  }
  if (rule.notForRole !== undefined) {
    where.AND = [{ OR: [{ forRole: null }, { forRole: { not: rule.notForRole } }] }];
  }
  return where;
}

/** The SAME rule evaluated against one row already in hand. */
export function isNotificationVisible(notif: Addressed, userRole: string, username: string): boolean {
  const rule = visibilityRule(userRole, username);
  if (rule.anyOf === null) return true;
  if (rule.notForRole !== undefined && notif.forRole === rule.notForRole) return false;
  return rule.anyOf.some((branch) =>
    (Object.keys(branch) as Array<keyof Addressed>).every((k) => (notif[k] ?? null) === (branch[k] ?? null)),
  );
}
