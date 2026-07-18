import { describe, it, expect } from 'vitest';
import { canDownloadReview, type ReviewSummary } from '../report-review';

// #reports-2: the "Download PDF" button must mirror the backend snapshot scope
// (canViewReportReview) so a non-party never sees a button that only 403s.
const base: ReviewSummary = {
  id: 'rr1', reportType: 'audit', title: 'T', status: 'APPROVED',
  generatedByName: 'gen', generatedAt: '', createdAt: '',
  reviewedByName: null, approvedByName: null, rejectedByName: null,
  assigneeUserId: null, assigneeRole: null,
};
const gen = { id: 'g-id', username: 'gen', role: 'OPERATOR' };
const stranger = { id: 's-id', username: 'stranger', role: 'OPERATOR' };

describe('canDownloadReview', () => {
  it('no user → false', () => {
    expect(canDownloadReview(undefined, base)).toBe(false);
  });
  it('SUPER_ADMIN → true for any report', () => {
    expect(canDownloadReview({ id: 'x', username: 'sa', role: 'SUPER_ADMIN' }, base)).toBe(true);
  });
  it('generator (by username) → true', () => {
    expect(canDownloadReview(gen, base)).toBe(true);
  });
  it('assignee by user id → true', () => {
    expect(canDownloadReview({ id: 'rev-id', username: 'rev', role: 'REVIEWER' }, { ...base, assigneeUserId: 'rev-id' })).toBe(true);
  });
  it('assignee by role → true', () => {
    expect(canDownloadReview({ id: 'x', username: 'anyone', role: 'QA' }, { ...base, assigneeRole: 'QA' })).toBe(true);
  });
  it('past reviewer/approver/rejecter (by username) → true', () => {
    expect(canDownloadReview({ id: 'x', username: 'rev', role: 'R' }, { ...base, reviewedByName: 'rev' })).toBe(true);
    expect(canDownloadReview({ id: 'x', username: 'app', role: 'A' }, { ...base, approvedByName: 'app' })).toBe(true);
    expect(canDownloadReview({ id: 'x', username: 'rej', role: 'R' }, { ...base, rejectedByName: 'rej' })).toBe(true);
  });
  it('uninvolved stranger → false (the core leak)', () => {
    expect(canDownloadReview(stranger, { ...base, assigneeUserId: 'rev-id', assigneeRole: 'REVIEWER' })).toBe(false);
  });
});
