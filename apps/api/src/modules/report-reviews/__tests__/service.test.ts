import { describe, it, expect } from 'vitest';
import { isParty, isApprover, mayDecide, inScope, isSelfDecision, type ReviewParties } from '../service.js';

/**
 * The pure rules of the report review workflow, with no database: who may SEE
 * a request, who may DECIDE it. Since 2026-10-01 the approvers are a frozen SET
 * (roles and users from Configuration → Report Approvers), the requester's
 * ROLE-MATES may see it too, and everyone but the two signers and SUPER_ADMIN
 * is bounded by their INSTRUMENT SCOPE ("any" of the request's instruments).
 */
const row: ReviewParties = {
  requestedBy: 'u-req', requestedByRole: 'OPERATOR',
  approverRoles: ['SUPERVISOR'], approverUserIds: ['u-named'],
  decidedBy: null, instrumentIds: ['i1', 'i2'],
};
const ALL = null;                       // unrestricted scope
const SEES_I2 = new Set(['i2', 'i9']);  // overlaps the request
const SEES_I9 = new Set(['i9']);        // does not

describe('inScope', () => {
  it('is true for an unrestricted scope, for a request about no instrument, and for ANY overlap', () => {
    expect(inScope(row, ALL)).toBe(true);
    expect(inScope({ instrumentIds: [] }, SEES_I9)).toBe(true);
    expect(inScope(row, SEES_I2)).toBe(true);
  });
  it('is false with no overlap — including a scope of no instruments at all', () => {
    expect(inScope(row, SEES_I9)).toBe(false);
    expect(inScope(row, new Set())).toBe(false);
  });
});

describe('isParty', () => {
  it('admits the requester\'s role-mates and every approver (role or named) within their scope', () => {
    expect(isParty({ userSub: 'mate', userRole: 'OPERATOR' }, row, SEES_I2)).toBe(true);
    expect(isParty({ userSub: 'sup', userRole: 'SUPERVISOR' }, row, ALL)).toBe(true);
    expect(isParty({ userSub: 'u-named', userRole: 'QA' }, row, SEES_I2)).toBe(true);
  });

  it('refuses the same people outside their scope', () => {
    expect(isParty({ userSub: 'mate', userRole: 'OPERATOR' }, row, SEES_I9)).toBe(false);
    expect(isParty({ userSub: 'sup', userRole: 'SUPERVISOR' }, row, SEES_I9)).toBe(false);
    expect(isParty({ userSub: 'u-named', userRole: 'QA' }, row, SEES_I9)).toBe(false);
  });

  it('always admits the two signers and SUPER_ADMIN, whatever the scope', () => {
    expect(isParty({ userSub: 'u-req', userRole: 'OPERATOR' }, row, SEES_I9)).toBe(true);
    expect(isParty({ userSub: 'u-dec', userRole: 'SUPERVISOR' }, { ...row, decidedBy: 'u-dec' }, SEES_I9)).toBe(true);
    expect(isParty({ userSub: 'x', userRole: 'SUPER_ADMIN' }, row, new Set())).toBe(true);
  });

  it('refuses a user in neither the requester\'s role nor the approvers', () => {
    expect(isParty({ userSub: 'x', userRole: 'QA' }, row, ALL)).toBe(false);
    // A legacy row without a frozen requester role does not admit "null-role" peers.
    expect(isParty({ userSub: 'x', userRole: 'OPERATOR' }, { ...row, requestedByRole: null }, ALL)).toBe(false);
  });
});

describe('isApprover / mayDecide', () => {
  it('an approver role holder or a named user, in scope', () => {
    expect(isApprover({ userSub: 'sup', userRole: 'SUPERVISOR' }, row)).toBe(true);
    expect(isApprover({ userSub: 'u-named', userRole: 'QA' }, row)).toBe(true);
    expect(mayDecide({ userSub: 'sup', userRole: 'SUPERVISOR' }, row, SEES_I2)).toBe(true);
    expect(mayDecide({ userSub: 'sup', userRole: 'SUPERVISOR' }, row, SEES_I9)).toBe(false);
  });

  it('never the requester\'s role-mates by virtue of the role — they view and download only', () => {
    expect(mayDecide({ userSub: 'mate', userRole: 'OPERATOR' }, row, ALL)).toBe(false);
  });

  it('SUPER_ADMIN always', () => {
    expect(mayDecide({ userSub: 'x', userRole: 'SUPER_ADMIN' }, row, new Set())).toBe(true);
  });
});

describe('isSelfDecision', () => {
  it('refuses the requester deciding their own request', () => {
    expect(isSelfDecision({ userSub: 'u-req', userRole: 'SUPERVISOR' }, row)).toBe(true);
    expect(isSelfDecision({ userSub: 'sup', userRole: 'SUPERVISOR' }, row)).toBe(false);
  });

  it('exempts SUPER_ADMIN — they may decide their own request (operator, 2026-09-08)', () => {
    expect(isSelfDecision({ userSub: 'u-req', userRole: 'SUPER_ADMIN' }, row)).toBe(false);
  });
});
