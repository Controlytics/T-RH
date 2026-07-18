/**
 * PM Schedules — entry-level workflow (3-step when enabled, single-step when off).
 *
 * Workflow ON (config pm-schedule-approval.workflowEnabled):
 *   upload → PENDING_REVIEW → (review) PENDING_APPROVAL → (approve) APPROVED
 *   reject at review or approval → REJECTED → (resubmit) → PENDING_REVIEW
 * Workflow OFF (legacy): upload → PENDING → (approve) APPROVED / REJECTED.
 *
 * Every action also mints a QNN (Quality Notification Number) into
 * quality_notifications via pm-workflow.generateQnn().
 */
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { checkPmEnabled } from './pm-shared.js';
import { getPmWorkflowConfig, assertPmRole, generateQnn, type QnnAction } from './pm-workflow.js';

const MS_DAY = 86400000;
function windowsFor(planned: Date, tol: number) {
  return { windowStart: new Date(planned.getTime() - tol * MS_DAY), windowEnd: new Date(planned.getTime() + tol * MS_DAY) };
}

/** Resolve AHU names for a set of entries (each entry carries schedule.entityId). */
async function ahuNameByEntry(entries: { id: string; schedule?: { entityId?: string | null } | null }[]): Promise<Map<string, string>> {
  const entityIds = [...new Set(entries.map((e) => e.schedule?.entityId).filter(Boolean) as string[])];
  const ahus = entityIds.length > 0
    ? await prisma.assetInstance.findMany({ where: { id: { in: entityIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(ahus.map((a) => [a.id, a.name]));
  const out = new Map<string, string>();
  for (const e of entries) out.set(e.id, (e.schedule?.entityId && nameById.get(e.schedule.entityId)) || '?');
  return out;
}

async function mintQnn(action: QnnAction, entry: any, ahuName: string, ctx: RequestContext, note: string) {
  return generateQnn(action, {
    pmScheduleEntryId: entry.id,
    scheduleId: entry.scheduleId,
    ahuName,
    message: `${note} — ${ahuName} (month ${entry.month})`,
  }, ctx);
}

/** List schedule entries with workflow status for the PM Schedules table. */
export async function listEntries(
  _ctx: RequestContext,
  query: { approvalStatus?: string; year?: number; page?: number; limit?: number },
) {
  await checkPmEnabled();
  const page = query.page ?? 1;
  // The PM Schedules page renders a whole year's entries (12 months × AHUs) in one
  // table with no pagination UI, so the default cap must comfortably cover a full
  // year. Raised from 200 → 2000 (2026-06-12): the old cap silently hid entries
  // beyond the first 50/200 in the ALL view.
  const limit = Math.min(query.limit ?? 50, 2000);
  const year = query.year ?? new Date().getFullYear();

  const where: any = { schedule: { status: 'ACTIVE', year } };
  if (query.approvalStatus && query.approvalStatus !== 'ALL') {
    where.approvalStatus = query.approvalStatus;
  }

  const [entries, total] = await Promise.all([
    prisma.pmScheduleEntry.findMany({
      where,
      include: { schedule: true },
      orderBy: { plannedDate: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.pmScheduleEntry.count({ where }),
  ]);

  const entityIds = [...new Set(entries.map((e: any) => e.schedule?.entityId).filter(Boolean))];
  const ahus = entityIds.length > 0
    ? await prisma.assetInstance.findMany({ where: { id: { in: entityIds } }, select: { id: true, name: true } })
    : [];
  const ahuMap = new Map(ahus.map(a => [a.id, a.name]));

  const data = entries.map((e: any) => ({
    id: e.id,
    scheduleId: e.scheduleId,
    ahuId: e.schedule?.entityId,
    ahuName: ahuMap.get(e.schedule?.entityId) ?? '?',
    month: e.month,
    plannedDate: e.plannedDate,
    toleranceDays: e.toleranceDays,
    windowStart: e.windowStart,
    windowEnd: e.windowEnd,
    approvalStatus: e.approvalStatus,
    approvalRemarks: e.approvalRemarks,
    submittedByName: e.submittedByName,
    reviewedByName: e.reviewedByName,
    reviewedAt: e.reviewedAt,
    reviewRemarks: e.reviewRemarks,
    approvedByName: e.approvedByName,
    approvedAt: e.approvedAt,
    rejectedByName: e.rejectedByName,
    rejectedAt: e.rejectedAt,
    rejectionStage: e.rejectionStage,
    pendingPlannedDate: e.pendingPlannedDate,
    pendingToleranceDays: e.pendingToleranceDays,
  }));

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

/**
 * Review step (workflow ON). action='approve' moves PENDING_REVIEW →
 * PENDING_APPROVAL; action='reject' moves PENDING_REVIEW → REJECTED (stage REVIEW).
 * Gated by the configured reviewRole.
 */
export async function reviewEntries(
  ctx: RequestContext,
  entryIds: string[],
  action: 'approve' | 'reject',
  remarks?: string,
) {
  await checkPmEnabled();
  const cfg = await getPmWorkflowConfig();
  assertPmRole(ctx.userRole, cfg.reviewRole, 'review');
  if (action === 'reject' && (!remarks || remarks.trim().length < 3)) {
    throw new AppError(400, 'REMARKS_REQUIRED', 'Remarks are required when rejecting (min 3 characters)');
  }

  const entries = await prisma.pmScheduleEntry.findMany({ where: { id: { in: entryIds } }, include: { schedule: true } });
  if (entries.length === 0) throw new AppError(404, 'NOT_FOUND', 'No entries found');
  const ahuNames = await ahuNameByEntry(entries as any);
  const qnns: string[] = [];

  for (const entry of entries) {
    // Reviewable from PENDING_REVIEW, plus legacy PENDING entries that predate the
    // workflow being enabled (so they enter review instead of being stuck as
    // directly-approvable). Workflow must be ON for PENDING to count as reviewable.
    if (entry.approvalStatus !== 'PENDING_REVIEW' && !(cfg.workflowEnabled && entry.approvalStatus === 'PENDING')) continue;
    const ahuName = ahuNames.get(entry.id) ?? '?';
    if (action === 'approve') {
      await prisma.pmScheduleEntry.update({
        where: { id: entry.id },
        data: {
          approvalStatus: 'PENDING_APPROVAL',
          reviewedBy: ctx.userSub, reviewedByName: ctx.userId, reviewedAt: new Date(),
          reviewRemarks: remarks?.trim() || null,
        },
      });
      qnns.push(await mintQnn('REVIEW', entry, ahuName, ctx, 'Reviewed (sent for approval)'));
      await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'PM_SCHEDULE_REVIEWED', targetType: 'pm_schedule_entry', targetId: entry.id, afterValue: { remarks, ahuName }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
    } else {
      await prisma.pmScheduleEntry.update({
        where: { id: entry.id },
        data: {
          approvalStatus: 'REJECTED', rejectionStage: 'REVIEW',
          rejectedBy: ctx.userSub, rejectedByName: ctx.userId, rejectedAt: new Date(),
          approvalRemarks: remarks!.trim(),
        },
      });
      qnns.push(await mintQnn('REJECT', entry, ahuName, ctx, 'Rejected at review'));
      await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'PM_SCHEDULE_REJECTED', targetType: 'pm_schedule_entry', targetId: entry.id, afterValue: { stage: 'REVIEW', remarks: remarks!.trim() }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
    }
  }
  return { processed: qnns.length, qnns };
}

/** Approve selected entries (final approval). Applies any pending edit. */
export async function approveEntries(ctx: RequestContext, entryIds: string[], comment?: string) {
  await checkPmEnabled();
  const cfg = await getPmWorkflowConfig();
  assertPmRole(ctx.userRole, cfg.approvalRole, 'approve');

  const entries = await prisma.pmScheduleEntry.findMany({ where: { id: { in: entryIds } }, include: { schedule: true } });
  if (entries.length === 0) throw new AppError(404, 'NOT_FOUND', 'No entries found');
  const ahuNames = await ahuNameByEntry(entries as any);

  // Approvable from PENDING_APPROVAL (workflow ON) or legacy PENDING (workflow OFF).
  const results: string[] = [];
  const qnns: string[] = [];
  for (const entry of entries) {
    // Workflow ON: approve ONLY from PENDING_APPROVAL — review must happen first.
    // Workflow OFF (legacy): PENDING is directly approvable.
    const approvable = cfg.workflowEnabled
      ? entry.approvalStatus === 'PENDING_APPROVAL'
      : (entry.approvalStatus === 'PENDING_APPROVAL' || entry.approvalStatus === 'PENDING');
    if (!approvable) {
      results.push(`${entry.id}: not awaiting approval (${entry.approvalStatus})`);
      continue;
    }
    const hasPendingEdit = entry.pendingPlannedDate != null;
    const newPlannedDate = hasPendingEdit ? entry.pendingPlannedDate! : entry.plannedDate;
    const newTolerance = hasPendingEdit && entry.pendingToleranceDays != null ? entry.pendingToleranceDays : entry.toleranceDays;
    const { windowStart, windowEnd } = windowsFor(newPlannedDate, newTolerance);

    await prisma.pmScheduleEntry.update({
      where: { id: entry.id },
      data: {
        approvalStatus: 'APPROVED',
        approvalRemarks: comment ?? null,
        approvedBy: ctx.userSub, approvedByName: ctx.userId, approvedAt: new Date(),
        rejectionStage: null, rejectedBy: null, rejectedByName: null, rejectedAt: null,
        ...(hasPendingEdit ? {
          plannedDate: newPlannedDate, toleranceDays: newTolerance, windowStart, windowEnd,
          pendingPlannedDate: null, pendingToleranceDays: null, pendingEditBy: null, pendingEditAt: null,
        } : {}),
      },
    });
    qnns.push(await mintQnn('APPROVE', entry, ahuNames.get(entry.id) ?? '?', ctx, 'Approved'));
    await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'PM_SCHEDULE_APPROVED', targetType: 'pm_schedule_entry', targetId: entry.id, afterValue: { comment, hasPendingEdit, ahuName: ahuNames.get(entry.id) ?? '?' }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
    results.push(`${entry.id}: approved`);
  }
  return { processed: results.length, results, qnns };
}

/** Reject at the approval stage with mandatory remarks. */
export async function rejectEntries(ctx: RequestContext, entryIds: string[], remarks: string) {
  await checkPmEnabled();
  const cfg = await getPmWorkflowConfig();
  assertPmRole(ctx.userRole, cfg.approvalRole, 'approve');
  if (!remarks || remarks.trim().length < 3) {
    throw new AppError(400, 'REMARKS_REQUIRED', 'Remarks are required when rejecting (min 3 characters)');
  }

  const entries = await prisma.pmScheduleEntry.findMany({ where: { id: { in: entryIds } }, include: { schedule: true } });
  if (entries.length === 0) throw new AppError(404, 'NOT_FOUND', 'No entries found');
  const ahuNames = await ahuNameByEntry(entries as any);
  const qnns: string[] = [];

  for (const entry of entries) {
    // Approval-stage reject: workflow ON → only PENDING_APPROVAL (a PENDING entry
    // hasn't been reviewed yet — it's rejected at the review stage instead).
    // Workflow OFF → legacy PENDING is rejectable here.
    const rejectable = cfg.workflowEnabled
      ? entry.approvalStatus === 'PENDING_APPROVAL'
      : (entry.approvalStatus === 'PENDING_APPROVAL' || entry.approvalStatus === 'PENDING');
    if (!rejectable) continue;
    await prisma.pmScheduleEntry.update({
      where: { id: entry.id },
      data: {
        approvalStatus: 'REJECTED', rejectionStage: 'APPROVAL',
        rejectedBy: ctx.userSub, rejectedByName: ctx.userId, rejectedAt: new Date(),
        approvalRemarks: remarks.trim(),
        pendingPlannedDate: null, pendingToleranceDays: null, pendingEditBy: null, pendingEditAt: null,
      },
    });
    qnns.push(await mintQnn('REJECT', entry, ahuNames.get(entry.id) ?? '?', ctx, 'Rejected at approval'));
    await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'PM_SCHEDULE_REJECTED', targetType: 'pm_schedule_entry', targetId: entry.id, afterValue: { stage: 'APPROVAL', remarks: remarks.trim() }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  }
  return { processed: entries.length, qnns };
}

/** Re-submit a rejected entry with corrected data. Goes back to the start of the flow. */
export async function resubmitEntry(
  ctx: RequestContext,
  entryId: string,
  data: { plannedDate: string; toleranceDays?: number },
) {
  await checkPmEnabled();
  const cfg = await getPmWorkflowConfig();
  const entry = await prisma.pmScheduleEntry.findUnique({ where: { id: entryId }, include: { schedule: true } });
  if (!entry) throw new AppError(404, 'NOT_FOUND', 'Entry not found');
  if (entry.approvalStatus !== 'REJECTED') {
    throw new AppError(400, 'INVALID_STATUS', 'Only rejected entries can be re-submitted');
  }

  const planned = new Date(data.plannedDate);
  if (isNaN(planned.getTime())) throw new AppError(400, 'INVALID_DATE', 'Invalid date');
  const tol = data.toleranceDays ?? entry.toleranceDays;
  const { windowStart, windowEnd } = windowsFor(planned, tol);
  const nextStatus = cfg.workflowEnabled ? 'PENDING_REVIEW' : 'PENDING';

  const updated = await prisma.pmScheduleEntry.update({
    where: { id: entryId },
    data: {
      plannedDate: planned, toleranceDays: tol, windowStart, windowEnd,
      approvalStatus: nextStatus,
      approvalRemarks: null,
      reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewRemarks: null,
      approvedBy: null, approvedByName: null, approvedAt: null,
      rejectedBy: null, rejectedByName: null, rejectedAt: null, rejectionStage: null,
      submittedBy: ctx.userSub, submittedByName: ctx.userId,
    },
  });
  const ahuName = (await ahuNameByEntry([entry as any])).get(entry.id) ?? '?';
  const qnn = await mintQnn('RESUBMIT', entry, ahuName, ctx, 'Resubmitted');

  await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'PM_SCHEDULE_RESUBMITTED', targetType: 'pm_schedule_entry', targetId: entryId, afterValue: { plannedDate: data.plannedDate, toleranceDays: tol }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  return { ...updated, qnn };
}

/** Edit an approved entry — stages proposed values and sends it back through the flow. */
export async function editApprovedEntry(
  ctx: RequestContext,
  entryId: string,
  data: { plannedDate: string; toleranceDays?: number },
) {
  await checkPmEnabled();
  const cfg = await getPmWorkflowConfig();
  const entry = await prisma.pmScheduleEntry.findUnique({ where: { id: entryId }, include: { schedule: true } });
  if (!entry) throw new AppError(404, 'NOT_FOUND', 'Entry not found');
  if (entry.approvalStatus !== 'APPROVED') {
    throw new AppError(400, 'INVALID_STATUS', 'Only approved entries can be edited (pending changes require approval)');
  }

  const planned = new Date(data.plannedDate);
  if (isNaN(planned.getTime())) throw new AppError(400, 'INVALID_DATE', 'Invalid date');
  const nextStatus = cfg.workflowEnabled ? 'PENDING_REVIEW' : 'PENDING';

  const updated = await prisma.pmScheduleEntry.update({
    where: { id: entryId },
    data: {
      pendingPlannedDate: planned,
      pendingToleranceDays: data.toleranceDays ?? entry.toleranceDays,
      pendingEditBy: ctx.userSub, pendingEditAt: new Date(),
      approvalStatus: nextStatus,
      approvalRemarks: null,
      reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewRemarks: null,
      approvedBy: null, approvedByName: null, approvedAt: null,
      submittedBy: ctx.userSub, submittedByName: ctx.userId,
    },
  });
  const ahuName = (await ahuNameByEntry([entry as any])).get(entry.id) ?? '?';
  const qnn = await mintQnn('EDIT', entry, ahuName, ctx, 'Edit requested');

  await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'PM_SCHEDULE_EDIT_REQUESTED', targetType: 'pm_schedule_entry', targetId: entryId, beforeValue: { plannedDate: entry.plannedDate, toleranceDays: entry.toleranceDays }, afterValue: { pendingPlannedDate: data.plannedDate, pendingToleranceDays: data.toleranceDays ?? entry.toleranceDays }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  return { ...updated, qnn };
}

/**
 * Reviewer modifies a PENDING_REVIEW entry in place (date/tolerance) before
 * sending it on for approval. Status stays PENDING_REVIEW. Gated by reviewRole.
 */
export async function modifyReviewEntry(
  ctx: RequestContext,
  entryId: string,
  data: { plannedDate: string; toleranceDays?: number },
) {
  await checkPmEnabled();
  const cfg = await getPmWorkflowConfig();
  assertPmRole(ctx.userRole, cfg.reviewRole, 'review');
  const entry = await prisma.pmScheduleEntry.findUnique({ where: { id: entryId }, include: { schedule: true } });
  if (!entry) throw new AppError(404, 'NOT_FOUND', 'Entry not found');
  if (entry.approvalStatus !== 'PENDING_REVIEW') {
    throw new AppError(400, 'INVALID_STATUS', 'Only entries awaiting review can be modified by the reviewer');
  }
  const planned = new Date(data.plannedDate);
  if (isNaN(planned.getTime())) throw new AppError(400, 'INVALID_DATE', 'Invalid date');
  const tol = data.toleranceDays ?? entry.toleranceDays;
  const { windowStart, windowEnd } = windowsFor(planned, tol);

  const updated = await prisma.pmScheduleEntry.update({
    where: { id: entryId },
    data: {
      plannedDate: planned, toleranceDays: tol, windowStart, windowEnd,
      // Record the reviewer touched it, but keep it in the review stage.
      reviewedBy: ctx.userSub, reviewedByName: ctx.userId, reviewedAt: new Date(),
    },
  });
  const ahuName = (await ahuNameByEntry([entry as any])).get(entry.id) ?? '?';
  const qnn = await mintQnn('EDIT', entry, ahuName, ctx, 'Modified at review');
  await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'PM_SCHEDULE_REVIEW_MODIFIED', targetType: 'pm_schedule_entry', targetId: entryId, beforeValue: { plannedDate: entry.plannedDate, toleranceDays: entry.toleranceDays }, afterValue: { plannedDate: data.plannedDate, toleranceDays: tol }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  return { ...updated, qnn };
}

/** Counts per workflow stage for status badges. */
export async function pendingCounts(_ctx: RequestContext) {
  await checkPmEnabled();
  const baseWhere = { schedule: { status: 'ACTIVE' as const } };
  const [pending, pendingReview, pendingApproval, rejected] = await Promise.all([
    prisma.pmScheduleEntry.count({ where: { ...baseWhere, approvalStatus: 'PENDING' } }),
    prisma.pmScheduleEntry.count({ where: { ...baseWhere, approvalStatus: 'PENDING_REVIEW' } }),
    prisma.pmScheduleEntry.count({ where: { ...baseWhere, approvalStatus: 'PENDING_APPROVAL' } }),
    prisma.pmScheduleEntry.count({ where: { ...baseWhere, approvalStatus: 'REJECTED' } }),
  ]);
  // `pending` (legacy + review + approval) kept for the existing badge consumer.
  return { pending: pending + pendingReview + pendingApproval, pendingReview, pendingApproval, rejected };
}
