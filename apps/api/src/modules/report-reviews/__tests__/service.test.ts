import { describe, it, expect } from 'vitest';
import { isParty, isAssignee, isSelfDecision, requireOneAssignee } from '../service.js';

/**
 * The pure rules of the report review workflow (2026-09-07), with no database:
 * who may SEE a request, who may DECIDE it, and what "send to" must name.
 * Design: docs/superpowers/specs/2026-09-07-report-review-workflow-design.md
 */
const row = { requestedBy: 'u-req', assigneeUserId: 'u-appr', assigneeRole: null, decidedBy: null };

describe('isParty', () => {
  it('admits the requester, the assignee user, a holder of the assignee role, the decider, and SUPER_ADMIN', () => {
    expect(isParty({ userSub: 'u-req', userRole: 'OPERATOR' }, row)).toBe(true);
    expect(isParty({ userSub: 'u-appr', userRole: 'OPERATOR' }, row)).toBe(true);
    expect(isParty({ userSub: 'x', userRole: 'QA' }, { ...row, assigneeUserId: null, assigneeRole: 'QA' })).toBe(true);
    expect(isParty({ userSub: 'u-dec', userRole: 'OPERATOR' }, { ...row, decidedBy: 'u-dec' })).toBe(true);
    expect(isParty({ userSub: 'x', userRole: 'SUPER_ADMIN' }, row)).toBe(true);
  });

  it('refuses everyone else — a non-party cannot even learn the request exists', () => {
    expect(isParty({ userSub: 'x', userRole: 'OPERATOR' }, row)).toBe(false);
    // Holding the ASSIGNEE's role is not enough when a specific USER was named.
    expect(isParty({ userSub: 'x', userRole: 'QA' }, { ...row, assigneeRole: null })).toBe(false);
  });
});

describe('isAssignee', () => {
  it('is the named user, or a holder of the named role, or SUPER_ADMIN', () => {
    expect(isAssignee({ userSub: 'u-appr', userRole: 'OPERATOR' }, row)).toBe(true);
    expect(isAssignee({ userSub: 'x', userRole: 'QA' }, { ...row, assigneeUserId: null, assigneeRole: 'QA' })).toBe(true);
    expect(isAssignee({ userSub: 'x', userRole: 'SUPER_ADMIN' }, row)).toBe(true);
  });

  it('is never the requester by virtue of requesting', () => {
    expect(isAssignee({ userSub: 'u-req', userRole: 'OPERATOR' }, row)).toBe(false);
  });
});

describe('isSelfDecision', () => {
  it('refuses the requester deciding their own request', () => {
    expect(isSelfDecision({ userSub: 'u-req', userRole: 'OPERATOR' }, row)).toBe(true);
    expect(isSelfDecision({ userSub: 'u-appr', userRole: 'OPERATOR' }, row)).toBe(false);
  });

  it('exempts SUPER_ADMIN — they may decide their own request (operator, 2026-09-08)', () => {
    expect(isSelfDecision({ userSub: 'u-req', userRole: 'SUPER_ADMIN' }, row)).toBe(false);
  });
});

describe('requireOneAssignee', () => {
  it('needs exactly one of user or role', () => {
    expect(requireOneAssignee('u1', undefined)).toEqual({ assigneeUserId: 'u1', assigneeRole: null });
    expect(requireOneAssignee(undefined, 'QA')).toEqual({ assigneeUserId: null, assigneeRole: 'QA' });
    expect(() => requireOneAssignee(undefined, undefined)).toThrow(/user or a role/);
    expect(() => requireOneAssignee('  ', '')).toThrow(/user or a role/);
    expect(() => requireOneAssignee('u1', 'QA')).toThrow(/not both/);
  });
});
