import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    reportReview: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));
vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../notifications/notification.service.js', () => ({ createNotification: vi.fn().mockResolvedValue(undefined) }));

import { reportReviewService } from '../service.js';

beforeEach(() => vi.clearAllMocks());

/**
 * The status guards in review()/approve() are a check-then-act: they read the
 * row, then used to issue an UNCONDITIONAL update. Two assignees deciding at the
 * same moment both passed the guard and both writes landed — leaving a row that
 * carried rejectedBy/rejectedAt/rejectionStage AND approvedBy/approvedAt with
 * status APPROVED, still downloadable with full signature lines. In a §11
 * e-signature workflow, "rejected and approved at once" must not be reachable.
 *
 * The predicate now lives in the WHERE, so Postgres serialises the two UPDATEs
 * and the loser matches zero rows.
 */
describe('report-review — concurrent decisions', () => {
  const row = {
    id: 'r1', title: 'Cleaning Record', status: 'PENDING_APPROVAL',
    generatedBy: 'gen-user', reviewedBy: 'rev-user',
    assigneeUserId: 'appr-user', assigneeRole: null,
  };
  const ctx: any = { userSub: 'appr-user', userId: 'EMP-9', userRole: 'QA' };

  it('approve writes with the status predicate, not a bare id', async () => {
    mockPrisma.reportReview.findUnique.mockResolvedValue(row);
    mockPrisma.reportReview.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.reportReview.findUniqueOrThrow.mockResolvedValue({ ...row, status: 'APPROVED' });

    await reportReviewService.approve(ctx, 'r1', 'approve', 'ok');

    expect(mockPrisma.reportReview.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1', status: 'PENDING_APPROVAL' } }),
    );
    // The unconditional update must not be used at all.
    expect(mockPrisma.reportReview.update).not.toHaveBeenCalled();
  });

  it('the loser of a race is rejected with 409, not silently applied', async () => {
    mockPrisma.reportReview.findUnique.mockResolvedValue(row);
    // Someone else decided between our read and our write → zero rows match.
    mockPrisma.reportReview.updateMany.mockResolvedValue({ count: 0 });

    await expect(reportReviewService.approve(ctx, 'r1', 'approve', 'ok'))
      .rejects.toMatchObject({ statusCode: 409, code: 'CONCURRENT_DECISION' });
  });

  it('a lost race writes no audit row and sends no notification', async () => {
    const { auditLog } = await import('../../../lib/audit.js');
    const { createNotification } = await import('../../notifications/notification.service.js');
    mockPrisma.reportReview.findUnique.mockResolvedValue(row);
    mockPrisma.reportReview.updateMany.mockResolvedValue({ count: 0 });

    await expect(reportReviewService.approve(ctx, 'r1', 'approve', 'ok')).rejects.toThrow();

    // The whole point: the loser must produce NO side effects. An audit
    // e-signature for a decision that never applied is worse than the race.
    expect(auditLog).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('reject at the approval stage is equally guarded', async () => {
    mockPrisma.reportReview.findUnique.mockResolvedValue(row);
    mockPrisma.reportReview.updateMany.mockResolvedValue({ count: 0 });

    await expect(reportReviewService.approve(ctx, 'r1', 'reject', 'not good enough'))
      .rejects.toMatchObject({ code: 'CONCURRENT_DECISION' });
  });

  it('review() guards on PENDING_REVIEW', async () => {
    // At the review stage the row is assigned to the REVIEWER, not the approver.
    mockPrisma.reportReview.findUnique.mockResolvedValue({
      ...row, status: 'PENDING_REVIEW', reviewedBy: null, assigneeUserId: 'rev-user',
    });
    mockPrisma.reportReview.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.reportReview.findUniqueOrThrow.mockResolvedValue({ ...row, status: 'PENDING_APPROVAL' });

    await reportReviewService.review({ ...ctx, userSub: 'rev-user' }, 'r1', 'approve', 'fine', 'next-user');

    expect(mockPrisma.reportReview.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1', status: 'PENDING_REVIEW' } }),
    );
  });
});
