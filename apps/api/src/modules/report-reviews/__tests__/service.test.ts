import { describe, it, expect } from 'vitest';
import { canViewReportReview, type ReportReviewParties } from '../service.js';

// #reports-2: getById returns the full dataSnapshot, so viewing must be scoped
// to parties involved in THIS report. These are the authorization rules.
const base: ReportReviewParties = {
  generatedBy: null,
  assigneeUserId: null,
  assigneeRole: null,
  reviewedBy: null,
  approvedBy: null,
  rejectedBy: null,
};

describe('canViewReportReview', () => {
  it('SUPER_ADMIN may view any report', () => {
    expect(canViewReportReview({ userSub: 'sa', userRole: 'SUPER_ADMIN' }, base)).toBe(true);
  });

  it('the generator may view their own report', () => {
    const row = { ...base, generatedBy: 'gen-1' };
    expect(canViewReportReview({ userSub: 'gen-1', userRole: 'OPERATOR' }, row)).toBe(true);
  });

  it('the current assignee (by user id) may view', () => {
    const row = { ...base, generatedBy: 'gen-1', assigneeUserId: 'rev-1' };
    expect(canViewReportReview({ userSub: 'rev-1', userRole: 'REVIEWER' }, row)).toBe(true);
  });

  it('the current assignee (by role) may view — needed to preview before acting', () => {
    const row = { ...base, generatedBy: 'gen-1', assigneeRole: 'QA_MANAGER' };
    expect(canViewReportReview({ userSub: 'anyone', userRole: 'QA_MANAGER' }, row)).toBe(true);
  });

  it('a past reviewer/approver/rejecter retains view access after the stage moves on', () => {
    const reviewed = { ...base, generatedBy: 'gen-1', reviewedBy: 'rev-1', assigneeRole: 'APPROVER' };
    expect(canViewReportReview({ userSub: 'rev-1', userRole: 'REVIEWER' }, reviewed)).toBe(true);
    const approved = { ...base, generatedBy: 'gen-1', approvedBy: 'app-1' };
    expect(canViewReportReview({ userSub: 'app-1', userRole: 'APPROVER' }, approved)).toBe(true);
    const rejected = { ...base, generatedBy: 'gen-1', rejectedBy: 'rej-1' };
    expect(canViewReportReview({ userSub: 'rej-1', userRole: 'REVIEWER' }, rejected)).toBe(true);
  });

  it('a submit-only holder who has no part in the report CANNOT view its snapshot', () => {
    // The core leak: an uninvolved REPORT_REVIEW_SUBMIT holder.
    const row = { ...base, generatedBy: 'gen-1', assigneeUserId: 'rev-1' };
    expect(canViewReportReview({ userSub: 'stranger', userRole: 'OPERATOR' }, row)).toBe(false);
  });

  it('a user whose role differs from the role-assignee CANNOT view', () => {
    const row = { ...base, generatedBy: 'gen-1', assigneeRole: 'QA_MANAGER' };
    expect(canViewReportReview({ userSub: 'stranger', userRole: 'REVIEWER' }, row)).toBe(false);
  });

  it('does not match on null identity fields (null userSub-vs-null generatedBy)', () => {
    // Defensive: a caller with an empty/undefined identity must not match a row
    // whose party fields are also null.
    expect(canViewReportReview({ userSub: '', userRole: '' }, base)).toBe(false);
  });
});
