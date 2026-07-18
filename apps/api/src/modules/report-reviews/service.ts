/**
 * Report Review service — 3-stage review/approval workflow for ad-hoc PDF
 * exports. "Send for Review" snapshots the rendered report data; a reviewer then
 * an approver act on it; once APPROVED the snapshot can be re-downloaded with
 * Printed By / Reviewed By / Approved By signatures.
 */
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { createNotification } from '../notifications/notification.service.js';

type NotifyType = 'REPORT_REVIEW_REQUESTED' | 'REPORT_REVIEW_APPROVED' | 'REPORT_REVIEW_REJECTED';

// Notify the current-stage assignee (a specific user OR a role). forUserId holds
// the username, so a UUID assignee is resolved to one. Best-effort — a failed
// notification never breaks the workflow.
async function notifyAssignee(row: { id: string; reportType: string; assigneeUserId: string | null; assigneeRole: string | null }, type: NotifyType, title: string, message: string, createdBy: string) {
  try {
    const base = { type, title, message, metadata: { reportReviewId: row.id, reportType: row.reportType }, createdBy };
    if (row.assigneeUserId) {
      const u = await prisma.user.findUnique({ where: { id: row.assigneeUserId }, select: { username: true } });
      if (u) await createNotification({ ...base, forUserId: u.username });
    } else if (row.assigneeRole) {
      await createNotification({ ...base, forRole: row.assigneeRole });
    }
  } catch (e) { console.error('[report-review] notify assignee failed:', (e as Error).message); }
}

async function notifySubmitter(row: { id: string; reportType: string; generatedByName: string }, type: NotifyType, title: string, message: string, createdBy: string) {
  try {
    await createNotification({ type, title, message, forUserId: row.generatedByName, metadata: { reportReviewId: row.id, reportType: row.reportType }, createdBy });
  } catch (e) { console.error('[report-review] notify submitter failed:', (e as Error).message); }
}

export interface SubmitInput {
  reportType: string;
  title: string;
  subtitle?: string;
  dataSnapshot: unknown;
  assigneeUserId?: string;
  assigneeRole?: string;
}

function requireOneAssignee(userId?: string, role?: string) {
  const u = (userId ?? '').trim();
  const r = (role ?? '').trim();
  if (!u && !r) throw new AppError(400, 'ASSIGNEE_REQUIRED', 'Choose a user or a role to send this to.');
  return { assigneeUserId: u || null, assigneeRole: u ? null : (r || null) };
}

// #reports-1 fix: the review/approve actions previously checked only `status`, so ANY
// REPORT_REVIEW / REPORT_APPROVE holder could act on a report assigned to someone else.
// Enforce that the caller is the assigned party (or SUPER_ADMIN, who may act as any
// assignee). The separation-of-duties checks in review()/approve() are separate and
// apply to everyone — they are the two-person 21 CFR §11 control and are NOT bypassed.
function assertIsAssignee(ctx: RequestContext, row: { assigneeUserId: string | null; assigneeRole: string | null }) {
  if (ctx.userRole === 'SUPER_ADMIN') return;
  const matchesUser = !!row.assigneeUserId && row.assigneeUserId === ctx.userSub;
  const matchesRole = !!row.assigneeRole && row.assigneeRole === ctx.userRole;
  if (!matchesUser && !matchesRole) {
    throw new AppError(403, 'NOT_ASSIGNEE', 'This report is not assigned to you or your role.');
  }
}

export interface ReportReviewParties {
  generatedBy: string | null;
  assigneeUserId: string | null;
  assigneeRole: string | null;
  reviewedBy: string | null;
  approvedBy: string | null;
  rejectedBy: string | null;
}

/**
 * #reports-2 fix: `getById` returns the full `dataSnapshot` (the entire rendered
 * report payload). It's reached by ANY `REPORT_REVIEW_SUBMIT`/`REPORT_REVIEW`/
 * `REPORT_APPROVE` holder, so without scoping a submit-only user could read the
 * snapshot of a report they have no part in. A caller may view a report only if
 * they are SUPER_ADMIN or a party to THIS report:
 *   - its generator, or
 *   - the current-stage assignee (matched by user id OR by role — a role
 *     assignee must preview before acting), or
 *   - a past actor (reviewer / approver / rejecter).
 * Pure + exported so it can be unit-tested without a DB.
 */
export function canViewReportReview(
  ctx: Pick<RequestContext, 'userSub' | 'userRole'>,
  row: ReportReviewParties,
): boolean {
  if (ctx.userRole === 'SUPER_ADMIN') return true;
  if (row.generatedBy && row.generatedBy === ctx.userSub) return true;
  if (row.reviewedBy && row.reviewedBy === ctx.userSub) return true;
  if (row.approvedBy && row.approvedBy === ctx.userSub) return true;
  if (row.rejectedBy && row.rejectedBy === ctx.userSub) return true;
  if (row.assigneeUserId && row.assigneeUserId === ctx.userSub) return true;
  if (row.assigneeRole && row.assigneeRole === ctx.userRole) return true;
  return false;
}

export const reportReviewService = {
  async submit(ctx: RequestContext, input: SubmitInput) {
    if (!input.reportType || !input.title || input.dataSnapshot == null) {
      throw new AppError(400, 'INVALID_INPUT', 'reportType, title and dataSnapshot are required.');
    }
    const assignee = requireOneAssignee(input.assigneeUserId, input.assigneeRole);
    const row = await prisma.reportReview.create({
      data: {
        reportType: input.reportType,
        title: input.title.slice(0, 500),
        subtitle: input.subtitle?.slice(0, 1000) ?? null,
        dataSnapshot: input.dataSnapshot as any,
        status: 'PENDING_REVIEW',
        generatedBy: ctx.userSub,
        generatedByName: ctx.userId,
        ...assignee,
      },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'REPORT_REVIEW_SUBMITTED',
      targetType: 'report_review', targetId: row.id,
      afterValue: { reportType: row.reportType, title: row.title, assignee },
      signatureMeaning: `Report "${row.title}" submitted for review`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    await notifyAssignee(row, 'REPORT_REVIEW_REQUESTED', 'Report awaiting your review', `"${row.title}" was sent to you for review by ${ctx.userId}.`, ctx.userId);
    return row;
  },

  /** Items the current user can act on right now (assigned to them or their role
   *  at the report's current pending stage). */
  async queue(ctx: RequestContext) {
    const rows = await prisma.reportReview.findMany({
      where: {
        status: { in: ['PENDING_REVIEW', 'PENDING_APPROVAL'] },
        OR: [{ assigneeUserId: ctx.userSub }, { assigneeRole: ctx.userRole }],
      },
      orderBy: { createdAt: 'desc' },
      select: SUMMARY_SELECT,
    });
    return rows.map((r) => ({ ...r, stage: r.status === 'PENDING_REVIEW' ? 'REVIEW' : 'APPROVE' }));
  },

  /** Broader list — for tracking what I submitted, and the approved archive. */
  async list(ctx: RequestContext, opts: { status?: string; mine?: boolean }) {
    const where: Record<string, unknown> = {};
    if (opts.status) where.status = opts.status;
    if (opts.mine) where.generatedBy = ctx.userSub;
    const rows = await prisma.reportReview.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, select: SUMMARY_SELECT });
    return rows;
  },

  async getById(ctx: RequestContext, id: string) {
    const row = await prisma.reportReview.findUnique({ where: { id } });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Report not found.');
    // #reports-2: scope the snapshot read to parties involved in THIS report.
    // 403 (not 404) is fine here — list()/the archive board already expose every
    // report's id + title to any perm-holder, so hiding existence adds nothing.
    if (!canViewReportReview(ctx, row)) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this report.');
    }
    return row;
  },

  /**
   * Apply a decision ONLY if the row is still in the status we checked.
   *
   * The status guards above are a check-then-act: they read the row, then issue
   * an UNCONDITIONAL update. Two assignees deciding within the same moment both
   * pass the guard and both writes land — so a report could end up carrying
   * rejectedBy/rejectedAt/rejectionStage AND approvedBy/approvedAt, status
   * APPROVED, and still be downloadable with full signature lines. In the
   * flagship §11 e-signature workflow, "rejected and approved at once" is not a
   * state that may exist.
   *
   * Moving the predicate into the WHERE makes the transition atomic: Postgres
   * serialises the two UPDATEs on the row, and the loser matches zero rows.
   * updateMany doesn't return the row, so re-read it for the audit/notify step —
   * safe, because the status is now terminal for this transition.
   */
  async decideIfStill(id: string, expected: 'PENDING_REVIEW' | 'PENDING_APPROVAL', data: Record<string, unknown>) {
    const { count } = await prisma.reportReview.updateMany({
      where: { id, status: expected as any },
      data: data as any,
    });
    if (count === 0) {
      throw new AppError(409, 'CONCURRENT_DECISION',
        'Someone else decided this report while you were deciding. Reload to see the current status.');
    }
    return prisma.reportReview.findUniqueOrThrow({ where: { id } });
  },

  /** Stage 2 — reviewer approves (→ PENDING_APPROVAL, assigns the approver) or rejects. */
  async review(ctx: RequestContext, id: string, action: 'approve' | 'reject', remarks: string | undefined, nextUserId?: string, nextRole?: string) {
    const row = await prisma.reportReview.findUnique({ where: { id } });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Report not found.');
    if (row.status !== 'PENDING_REVIEW') throw new AppError(400, 'INVALID_STATUS', 'This report is not awaiting review.');
    assertIsAssignee(ctx, row);
    // Separation of duties: the reviewer must not be the report's generator.
    if (ctx.userSub === row.generatedBy) {
      throw new AppError(403, 'SELF_REVIEW', 'You cannot review a report you generated (separation of duties).');
    }

    if (action === 'reject') {
      if (!remarks || remarks.trim().length < 3) throw new AppError(400, 'REMARKS_REQUIRED', 'Remarks are required when rejecting (min 3 chars).');
      const updated = await this.decideIfStill(id, 'PENDING_REVIEW', {
        status: 'REJECTED', rejectionStage: 'REVIEW', rejectedBy: ctx.userSub, rejectedByName: ctx.userId, rejectedAt: new Date(),
        reviewRemarks: remarks.trim(), assigneeUserId: null, assigneeRole: null,
      });
      await this.audit(ctx, updated, 'REPORT_REVIEW_REJECTED', `Report "${row.title}" rejected at review`);
      await notifySubmitter(updated, 'REPORT_REVIEW_REJECTED', 'Report rejected at review', `"${row.title}" was rejected at review by ${ctx.userId}.`, ctx.userId);
      return updated;
    }
    // approve → move to approval stage, assign approver
    const assignee = requireOneAssignee(nextUserId, nextRole);
    const updated = await this.decideIfStill(id, 'PENDING_REVIEW', {
      status: 'PENDING_APPROVAL', reviewedBy: ctx.userSub, reviewedByName: ctx.userId, reviewedAt: new Date(),
      reviewRemarks: remarks?.trim() || null, ...assignee,
    });
    await this.audit(ctx, updated, 'REPORT_REVIEW_REVIEWED', `Report "${row.title}" reviewed (sent for approval)`);
    await notifyAssignee(updated, 'REPORT_REVIEW_REQUESTED', 'Report awaiting your approval', `"${row.title}" was reviewed by ${ctx.userId} and needs your approval.`, ctx.userId);
    return updated;
  },

  /** Stage 3 — approver approves (→ APPROVED) or rejects. */
  async approve(ctx: RequestContext, id: string, action: 'approve' | 'reject', remarks: string | undefined) {
    const row = await prisma.reportReview.findUnique({ where: { id } });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Report not found.');
    if (row.status !== 'PENDING_APPROVAL') throw new AppError(400, 'INVALID_STATUS', 'This report is not awaiting approval.');
    assertIsAssignee(ctx, row);
    // Separation of duties: the approver must be neither the generator nor the reviewer.
    if (ctx.userSub === row.generatedBy || ctx.userSub === row.reviewedBy) {
      throw new AppError(403, 'SELF_APPROVE', 'You cannot approve a report you generated or reviewed (separation of duties).');
    }

    if (action === 'reject') {
      if (!remarks || remarks.trim().length < 3) throw new AppError(400, 'REMARKS_REQUIRED', 'Remarks are required when rejecting (min 3 chars).');
      const updated = await this.decideIfStill(id, 'PENDING_APPROVAL', {
        status: 'REJECTED', rejectionStage: 'APPROVAL', rejectedBy: ctx.userSub, rejectedByName: ctx.userId, rejectedAt: new Date(),
        approvalRemarks: remarks.trim(), assigneeUserId: null, assigneeRole: null,
      });
      await this.audit(ctx, updated, 'REPORT_REVIEW_REJECTED', `Report "${row.title}" rejected at approval`);
      await notifySubmitter(updated, 'REPORT_REVIEW_REJECTED', 'Report rejected at approval', `"${row.title}" was rejected at approval by ${ctx.userId}.`, ctx.userId);
      return updated;
    }
    const updated = await this.decideIfStill(id, 'PENDING_APPROVAL', {
      status: 'APPROVED', approvedBy: ctx.userSub, approvedByName: ctx.userId, approvedAt: new Date(),
      approvalRemarks: remarks?.trim() || null, assigneeUserId: null, assigneeRole: null,
    });
    await this.audit(ctx, updated, 'REPORT_REVIEW_APPROVED', `Report "${row.title}" approved`);
    await notifySubmitter(updated, 'REPORT_REVIEW_APPROVED', 'Report approved', `"${row.title}" was approved by ${ctx.userId}.`, ctx.userId);
    return updated;
  },

  async audit(ctx: RequestContext, row: { id: string; status: string }, action: string, meaning: string) {
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action,
      targetType: 'report_review', targetId: row.id, afterValue: { status: row.status },
      signatureMeaning: meaning, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
  },
};

const SUMMARY_SELECT = {
  id: true, reportType: true, title: true, subtitle: true, status: true,
  generatedByName: true, generatedAt: true, assigneeUserId: true, assigneeRole: true,
  reviewedByName: true, reviewedAt: true, approvedByName: true, approvedAt: true,
  rejectionStage: true, rejectedByName: true, rejectedAt: true, reviewRemarks: true, approvalRemarks: true,
  createdAt: true,
} as const;
