/**
 * Replacement Schedule — entry-level 3-step workflow, reusing the PM workflow
 * config (pm-schedule-approval) for the enable toggle + role gates, and the
 * shared QNN generator. Mirrors pm-schedules/pm-approval.ts but operates on
 * replacementScheduleEntry. `approvalStatus` is independent of `status` (the
 * DUE/IN_PROGRESS/COMPLETED execution lifecycle); only APPROVED entries appear
 * as due replacement tasks.
 */
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { getReplacementWorkflowConfig, assertPmRole, generateQnn, type QnnAction } from '../pm-schedules/pm-workflow.js';

const MS_DAY = 86400000;
const windowsFor = (planned: Date, tol: number) => ({
  windowStart: new Date(planned.getTime() - tol * MS_DAY),
  windowEnd: new Date(planned.getTime() + tol * MS_DAY),
});

/**
 * Human-readable descriptor for a single replacement-schedule entry, e.g.
 * "AHU: AHU-12 · Size: 610x610 · Micron: 10µ · Qty: 4". Fed into each audit
 * row's `afterValue.name` so the audit-trail summary renders which AHU/filter
 * was reviewed/approved/rejected (the shared `{targetName}` placeholder resolves
 * from `after.name`) instead of an empty `""`. Each value is titled ("AHU:",
 * "Size:", …) so the one-line summary is self-explanatory — otherwise the four
 * values run together with no way to tell the dimension from the micron.
 */
export const entryLabel = (e: { ahuName: string; filterSize?: string | null; filterMicron?: string | null; qty: number }): string =>
  `AHU: ${e.ahuName}${e.filterSize ? ` · Size: ${e.filterSize}` : ''}${e.filterMicron ? ` · Micron: ${e.filterMicron}µ` : ''} · Qty: ${e.qty}`;

/** Structured entry detail merged into `afterValue` for the audit drill-down panel. */
const entryDetail = (e: any) => ({
  name: entryLabel(e),
  ahuName: e.ahuName,
  filterSize: e.filterSize ?? null,
  filterMicron: e.filterMicron ?? null,
  qty: e.qty,
});

async function mintQnn(action: QnnAction, entry: any, ctx: RequestContext, note: string) {
  return generateQnn(action, {
    pmScheduleEntryId: entry.id, // soft uuid column; holds the replacement entry id
    scheduleId: entry.scheduleId,
    ahuName: entry.ahuName,
    subject: 'Replacement Schedule',
    message: `${note} — ${entry.ahuName}${entry.filterSize ? ` · ${entry.filterSize}` : ''}${entry.filterMicron ? ` · ${entry.filterMicron}µ` : ''} · qty ${entry.qty}`,
  }, ctx);
}

/** Review step: approve → PENDING_APPROVAL, reject → REJECTED (stage REVIEW). */
export async function reviewEntries(ctx: RequestContext, entryIds: string[], action: 'approve' | 'reject', remarks?: string) {
  const cfg = await getReplacementWorkflowConfig();
  assertPmRole(ctx.userRole, cfg.reviewRole, 'review', 'replacement schedules');
  if (action === 'reject' && (!remarks || remarks.trim().length < 3)) {
    throw new AppError(400, 'REMARKS_REQUIRED', 'Remarks are required when rejecting (min 3 characters)');
  }
  const entries = await prisma.replacementScheduleEntry.findMany({ where: { id: { in: entryIds } } });
  if (entries.length === 0) throw new AppError(404, 'NOT_FOUND', 'No entries found');
  const qnns: string[] = [];
  for (const entry of entries) {
    if (entry.approvalStatus !== 'PENDING_REVIEW') continue;
    if (action === 'approve') {
      await prisma.replacementScheduleEntry.update({
        where: { id: entry.id },
        data: { approvalStatus: 'PENDING_APPROVAL', reviewedBy: ctx.userSub, reviewedByName: ctx.userId, reviewedAt: new Date(), reviewRemarks: remarks?.trim() || null },
      });
      qnns.push(await mintQnn('REVIEW', entry, ctx, 'Reviewed (sent for approval)'));
      await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'REPLACEMENT_SCHEDULE_REVIEWED', targetType: 'replacement_schedule_entry', targetId: entry.id, afterValue: { ...entryDetail(entry), remarks }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
    } else {
      await prisma.replacementScheduleEntry.update({
        where: { id: entry.id },
        data: { approvalStatus: 'REJECTED', rejectionStage: 'REVIEW', rejectedBy: ctx.userSub, rejectedByName: ctx.userId, rejectedAt: new Date(), approvalRemarks: remarks!.trim() },
      });
      qnns.push(await mintQnn('REJECT', entry, ctx, 'Rejected at review'));
      await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'REPLACEMENT_SCHEDULE_REJECTED', targetType: 'replacement_schedule_entry', targetId: entry.id, afterValue: { ...entryDetail(entry), stage: 'REVIEW', remarks: remarks!.trim() }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
    }
  }
  return { processed: qnns.length, qnns };
}

/** Final approval: PENDING_APPROVAL (or legacy PENDING) → APPROVED. */
export async function approveEntries(ctx: RequestContext, entryIds: string[], comment?: string) {
  const cfg = await getReplacementWorkflowConfig();
  assertPmRole(ctx.userRole, cfg.approvalRole, 'approve', 'replacement schedules');
  const entries = await prisma.replacementScheduleEntry.findMany({ where: { id: { in: entryIds } } });
  if (entries.length === 0) throw new AppError(404, 'NOT_FOUND', 'No entries found');
  const qnns: string[] = [];
  for (const entry of entries) {
    if (entry.approvalStatus !== 'PENDING_APPROVAL' && entry.approvalStatus !== 'PENDING') continue;
    await prisma.replacementScheduleEntry.update({
      where: { id: entry.id },
      data: { approvalStatus: 'APPROVED', approvalRemarks: comment ?? null, approvedBy: ctx.userSub, approvedByName: ctx.userId, approvedAt: new Date(), rejectionStage: null, rejectedBy: null, rejectedByName: null, rejectedAt: null },
    });
    qnns.push(await mintQnn('APPROVE', entry, ctx, 'Approved'));
    await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'REPLACEMENT_SCHEDULE_APPROVED', targetType: 'replacement_schedule_entry', targetId: entry.id, afterValue: { ...entryDetail(entry), comment }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  }
  return { processed: qnns.length, qnns };
}

/** Reject at the approval stage. */
export async function rejectEntries(ctx: RequestContext, entryIds: string[], remarks: string) {
  const cfg = await getReplacementWorkflowConfig();
  assertPmRole(ctx.userRole, cfg.approvalRole, 'approve', 'replacement schedules');
  if (!remarks || remarks.trim().length < 3) throw new AppError(400, 'REMARKS_REQUIRED', 'Remarks are required when rejecting (min 3 characters)');
  const entries = await prisma.replacementScheduleEntry.findMany({ where: { id: { in: entryIds } } });
  if (entries.length === 0) throw new AppError(404, 'NOT_FOUND', 'No entries found');
  const qnns: string[] = [];
  for (const entry of entries) {
    if (entry.approvalStatus !== 'PENDING_APPROVAL' && entry.approvalStatus !== 'PENDING') continue;
    await prisma.replacementScheduleEntry.update({
      where: { id: entry.id },
      data: { approvalStatus: 'REJECTED', rejectionStage: 'APPROVAL', rejectedBy: ctx.userSub, rejectedByName: ctx.userId, rejectedAt: new Date(), approvalRemarks: remarks.trim() },
    });
    qnns.push(await mintQnn('REJECT', entry, ctx, 'Rejected at approval'));
    await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'REPLACEMENT_SCHEDULE_REJECTED', targetType: 'replacement_schedule_entry', targetId: entry.id, afterValue: { ...entryDetail(entry), stage: 'APPROVAL', remarks: remarks.trim() }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  }
  return { processed: qnns.length, qnns };
}

/** Re-submit a rejected entry (corrected date/tolerance/qty) → back to PENDING_REVIEW. */
export async function resubmitEntry(ctx: RequestContext, entryId: string, data: { scheduleDate: string; toleranceDays?: number; qty?: number }) {
  const cfg = await getReplacementWorkflowConfig();
  const entry = await prisma.replacementScheduleEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new AppError(404, 'NOT_FOUND', 'Entry not found');
  if (entry.approvalStatus !== 'REJECTED') throw new AppError(400, 'INVALID_STATUS', 'Only rejected entries can be re-submitted');
  const planned = new Date(`${data.scheduleDate}T00:00:00Z`);
  if (isNaN(planned.getTime())) throw new AppError(400, 'INVALID_DATE', 'Invalid date');
  const tol = data.toleranceDays ?? entry.toleranceDays;
  const { windowStart, windowEnd } = windowsFor(planned, tol);
  const updated = await prisma.replacementScheduleEntry.update({
    where: { id: entryId },
    data: {
      scheduleDate: planned, toleranceDays: tol, windowStart, windowEnd, ...(data.qty != null ? { qty: data.qty } : {}),
      approvalStatus: cfg.workflowEnabled ? 'PENDING_REVIEW' : 'APPROVED',
      approvalRemarks: null, reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewRemarks: null,
      approvedBy: null, approvedByName: null, approvedAt: null, rejectedBy: null, rejectedByName: null, rejectedAt: null, rejectionStage: null,
      submittedBy: ctx.userSub, submittedByName: ctx.userId,
    },
  });
  const qnn = await mintQnn('RESUBMIT', entry, ctx, 'Resubmitted');
  await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'REPLACEMENT_SCHEDULE_RESUBMITTED', targetType: 'replacement_schedule_entry', targetId: entryId, afterValue: { ...entryDetail(entry), scheduleDate: data.scheduleDate, toleranceDays: tol }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  return { ...updated, qnn };
}

/** Reviewer modifies a PENDING_REVIEW entry in place (stays in review). */
export async function modifyReviewEntry(ctx: RequestContext, entryId: string, data: { scheduleDate: string; toleranceDays?: number; qty?: number }) {
  const cfg = await getReplacementWorkflowConfig();
  assertPmRole(ctx.userRole, cfg.reviewRole, 'review', 'replacement schedules');
  const entry = await prisma.replacementScheduleEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new AppError(404, 'NOT_FOUND', 'Entry not found');
  if (entry.approvalStatus !== 'PENDING_REVIEW') throw new AppError(400, 'INVALID_STATUS', 'Only entries awaiting review can be modified by the reviewer');
  const planned = new Date(`${data.scheduleDate}T00:00:00Z`);
  if (isNaN(planned.getTime())) throw new AppError(400, 'INVALID_DATE', 'Invalid date');
  const tol = data.toleranceDays ?? entry.toleranceDays;
  const { windowStart, windowEnd } = windowsFor(planned, tol);
  const updated = await prisma.replacementScheduleEntry.update({
    where: { id: entryId },
    data: { scheduleDate: planned, toleranceDays: tol, windowStart, windowEnd, ...(data.qty != null ? { qty: data.qty } : {}), reviewedBy: ctx.userSub, reviewedByName: ctx.userId, reviewedAt: new Date() },
  });
  const qnn = await mintQnn('EDIT', entry, ctx, 'Modified at review');
  await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'REPLACEMENT_SCHEDULE_REVIEW_MODIFIED', targetType: 'replacement_schedule_entry', targetId: entryId, afterValue: { ...entryDetail(entry), scheduleDate: data.scheduleDate, toleranceDays: tol }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  return { ...updated, qnn };
}
