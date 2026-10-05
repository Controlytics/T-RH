import { describe, it, expect } from 'vitest';
import { isNotificationVisible, visibilityWhere } from '../notification-visibility.js';

/**
 * Audit 2026-10-03, API-16. The list filter and the single-row / bulk checks
 * are derived from ONE rule; these pin that the two renderings agree on every
 * addressing shape, and that the two widenings the audit found are closed.
 */
type Row = { forUserId: string | null; forRole: string | null; targetUserId: string | null };

const rows: Record<string, Row> = {
  mine:           { forUserId: 'me',    forRole: null,          targetUserId: null },
  someoneElses:   { forUserId: 'other', forRole: null,          targetUserId: null },
  forAdmins:      { forUserId: null,    forRole: 'ADMIN',       targetUserId: null },
  forSuperAdmins: { forUserId: null,    forRole: 'SUPER_ADMIN', targetUserId: null },
  general:        { forUserId: null,    forRole: null,          targetUserId: null },
  aboutMeForAdmins: { forUserId: null,  forRole: 'ADMIN',       targetUserId: 'me' },
};

/** A tiny evaluator for the `where` fragment, so the SQL rendering is checked
 *  against the same rows as the predicate — not merely asserted to look right. */
function matchesWhere(where: Record<string, unknown>, row: Row): boolean {
  const matchLeaf = (cond: Record<string, unknown>): boolean =>
    Object.entries(cond).every(([k, v]) => {
      if (k === 'OR') return (v as Record<string, unknown>[]).some(matchLeaf);
      if (k === 'AND') return (v as Record<string, unknown>[]).every(matchLeaf);
      const actual = (row as Record<string, unknown>)[k] ?? null;
      if (v !== null && typeof v === 'object' && 'not' in (v as object)) return actual !== (v as { not: unknown }).not;
      return actual === v;
    });
  return matchLeaf(where);
}

describe('notification visibility — one rule, two renderings', () => {
  const cases: Array<[string, string, Record<string, boolean>]> = [
    ['SUPER_ADMIN', 'sa', { mine: true, someoneElses: true, forAdmins: true, forSuperAdmins: true, general: true, aboutMeForAdmins: true }],
    ['ADMIN', 'me', { mine: true, someoneElses: false, forAdmins: true, forSuperAdmins: false, general: true, aboutMeForAdmins: true }],
    ['OPERATOR', 'me', { mine: true, someoneElses: false, forAdmins: false, forSuperAdmins: false, general: false, aboutMeForAdmins: false }],
  ];

  for (const [role, user, expected] of cases) {
    for (const [name, row] of Object.entries(rows)) {
      it(`${role}/${user} on "${name}": predicate and where agree (${expected[name]})`, () => {
        expect(isNotificationVisible(row, role, user)).toBe(expected[name]);
        expect(matchesWhere(visibilityWhere(role, user), row)).toBe(expected[name]);
      });
    }
  }

  // The two widenings the audit found, named.
  it('an ADMIN cannot reach another user\'s personal notification by id', () => {
    expect(isNotificationVisible(rows.someoneElses, 'ADMIN', 'me')).toBe(false);
  });

  it('a user cannot reach the admin-addressed row ABOUT themself (targetUserId grants nothing)', () => {
    expect(isNotificationVisible(rows.aboutMeForAdmins, 'OPERATOR', 'me')).toBe(false);
  });

  // The 2026-07-13 null-safety rule survives: the exclusion must not swallow
  // forRole IS NULL rows.
  it('ADMIN where keeps the three branches and a null-safe SUPER_ADMIN exclusion', () => {
    expect(visibilityWhere('ADMIN', 'me')).toEqual({
      OR: [{ forUserId: 'me' }, { forRole: 'ADMIN' }, { forRole: null, forUserId: null }],
      AND: [{ OR: [{ forRole: null }, { forRole: { not: 'SUPER_ADMIN' } }] }],
    });
  });

  it('SUPER_ADMIN where is unrestricted', () => {
    expect(visibilityWhere('SUPER_ADMIN', 'sa')).toEqual({});
  });

  // `{ forUserId: undefined }` is dropped by Prisma, which would turn a missing
  // identity into "every row". Both renderings must say NOTHING instead.
  it('no username = no rows, for ADMIN and for everyone else', () => {
    for (const role of ['ADMIN', 'OPERATOR']) {
      expect(visibilityWhere(role, '')).toEqual({ id: { in: [] } });
      for (const row of Object.values(rows)) expect(isNotificationVisible(row, role, '')).toBe(false);
    }
  });
});
