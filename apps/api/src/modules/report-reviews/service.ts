/**
 * Report review workflow (2026-09-07).
 *
 * Every PDF download in the product is a REQUEST: the browser renders the
 * report exactly as before, captures the whole document as a snapshot, and
 * posts it here instead of saving it. An approver (a named user, or any holder
 * of a named role) opens the DRAFT, then approves or rejects with remarks and a
 * password. Once approved, the requester and the approver download the SAME
 * snapshot with both signatures printed. The snapshot is the record: what was
 * reviewed is what is downloaded.
 *
 * Operator: "when ever user click on download then directly pdf should not
 * download, as per requested time period data should go per review once
 * review completed and approved then user and approved user can get that
 * approved data in side bar new option there user can download reports, who
 * ever requested and approved users electronic signatures should come if
 * report was downloaded".
 *
 * Design: docs/superpowers/specs/2026-09-07-report-review-workflow-design.md
 *
 * The party-scoping and the single-decision guard are taken from the module
 * this replaces (removed 2026-07-18, on tag `pre-domain-strip`); its second
 * review stage is not.
 */
import { Prisma, type NotificationType } from '@prisma/client';
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { createNotification } from '../notifications/notification.service.js';
import { clampSignature } from '../alarms/validation.js';
import { REPORT_APPROVERS_NONE_MESSAGE } from '@digilog/shared';
import { loadApproverRoles } from './load-approvers.js';

export type ReviewList = 'queue' | 'mine' | 'approved';
export type ReviewDecision = 'APPROVED' | 'REJECTED';

export interface ReviewParties {
  requestedBy: string;
  assigneeUserId: string | null;
  assigneeRole: string | null;
  decidedBy: string | null;
}

type Actor = Pick<RequestContext, 'userSub' | 'userRole'>;

/**
 * May this caller SEE the request? The requester, the assignee (by user id, or
 * by holding the assignee ROLE), whoever decided it, and SUPER_ADMIN. Everyone
 * else gets a 404 from the routes — never a 403, which would confirm the id
 * exists. Pure and exported so it is unit-tested without a database.
 */
export function isParty(ctx: Actor, row: ReviewParties): boolean {
  if (ctx.userRole === 'SUPER_ADMIN') return true;
  if (row.requestedBy === ctx.userSub) return true;
  if (row.decidedBy && row.decidedBy === ctx.userSub) return true;
  if (row.assigneeUserId && row.assigneeUserId === ctx.userSub) return true;
  if (row.assigneeRole && row.assigneeRole === ctx.userRole) return true;
  return false;
}

/** May this caller DECIDE it? The named user, a holder of the named role, or
 *  SUPER_ADMIN. Being the requester counts for nothing here — and the
 *  separation-of-duties check (`isSelfDecision`) refuses the requester
 *  outright, unless they are SUPER_ADMIN. */
export function isAssignee(ctx: Actor, row: ReviewParties): boolean {
  if (ctx.userRole === 'SUPER_ADMIN') return true;
  if (row.assigneeUserId && row.assigneeUserId === ctx.userSub) return true;
  if (row.assigneeRole && row.assigneeRole === ctx.userRole) return true;
  return false;
}

/** Is this the requester deciding their OWN request? Separation of duties
 *  refuses it — the two signatures on an approved report are meant to be two
 *  people. SUPER_ADMIN is EXEMPT since 2026-09-08 (operator: "super admin
 *  should be able to approve own requests or other requests"); the
 *  consequence, stated when it was asked for, is that a super admin's own
 *  report carries the same name on both lines. The page mirrors this rule in
 *  `mayDecide`; it is presentation there and the 403 here is the control. */
export function isSelfDecision(ctx: Actor, row: Pick<ReviewParties, 'requestedBy'>): boolean {
  if (ctx.userRole === 'SUPER_ADMIN') return false;
  return row.requestedBy === ctx.userSub;
}

/** "Send to" names exactly ONE of a user or a role. */
export function requireOneAssignee(userId?: string, role?: string): { assigneeUserId: string | null; assigneeRole: string | null } {
  const u = (userId ?? '').trim();
  const r = (role ?? '').trim();
  if (!u && !r) throw new AppError(400, 'ASSIGNEE_REQUIRED', 'Choose a user or a role to send this report to.');
  if (u && r) throw new AppError(400, 'ASSIGNEE_AMBIGUOUS', 'Choose a user or a role, not both.');
  return { assigneeUserId: u || null, assigneeRole: r || null };
}

export interface SubmitInput {
  reportType: string;
  title: string;
  subtitle?: string;
  requestMeta: unknown;
  dataSnapshot: unknown;
  remarks: string;
  assigneeUserId?: string;
  assigneeRole?: string;
}

/** The list rows: everything but the snapshot, which can be hundreds of KB. */
const SUMMARY_SELECT = {
  id: true, reportType: true, title: true, subtitle: true, requestMeta: true, status: true,
  requestedBy: true, requestedByName: true, requestedByRole: true, requestedAt: true, requestRemarks: true,
  assigneeUserId: true, assigneeRole: true,
  decidedBy: true, decidedByName: true, decidedByRole: true, decidedAt: true, decisionRemarks: true,
  createdAt: true,
} satisfies Prisma.ReportReviewSelect;

export type ReviewSummary = Prisma.ReportReviewGetPayload<{ select: typeof SUMMARY_SELECT }>;
export type ReviewFull = ReviewSummary & { dataSnapshot: Prisma.JsonValue };

/** The sentence an audit row signs, kept inside `signature_meaning`'s 255. */
function titleLabel(title: string): string {
  return title.length > 80 ? `${title.slice(0, 77)}…` : title;
}

/**
 * Best-effort notifications — a failed notification never breaks the
 * workflow; the audit row is the record, the notification a courtesy.
 * `forUserId` is a USERNAME (that is what the notification service keys on),
 * so a UUID assignee is resolved to one first.
 */
async function notifyAssignee(row: ReviewSummary, type: NotificationType, title: string, message: string, createdBy: string): Promise<void> {
  try {
    const base = { type, title, message, metadata: { reportReviewId: row.id, reportType: row.reportType }, createdBy };
    if (row.assigneeUserId) {
      const u = await prisma.user.findUnique({ where: { id: row.assigneeUserId }, select: { username: true } });
      if (u) await createNotification({ ...base, forUserId: u.username });
    } else if (row.assigneeRole) {
      await createNotification({ ...base, forRole: row.assigneeRole });
    }
  } catch (e) {
    console.error('[report-reviews] notify assignee failed:', (e as Error).message);
  }
}

async function notifyRequester(row: ReviewSummary, type: NotificationType, title: string, message: string, createdBy: string): Promise<void> {
  try {
    await createNotification({
      type, title, message, forUserId: row.requestedByName,
      metadata: { reportReviewId: row.id, reportType: row.reportType }, createdBy,
    });
  } catch (e) {
    console.error('[report-reviews] notify requester failed:', (e as Error).message);
  }
}

function auditBase(ctx: RequestContext) {
  return { userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId };
}

export const reportReviewService = {
  async submit(ctx: RequestContext, input: SubmitInput): Promise<ReviewSummary> {
    const assignee = requireOneAssignee(input.assigneeUserId, input.assigneeRole);
    // Which roles may approve is administered (Configuration → Report Approvers,
    // 2026-09-07). Checked HERE, at the request: the picker offers only these,
    // but the picker is presentation. An empty list refuses every request —
    // fail closed — with the fix named, since nothing else on screen can say it.
    const approverRoles = await loadApproverRoles();
    if (approverRoles.length === 0) throw new AppError(400, 'NO_APPROVER_ROLE', REPORT_APPROVERS_NONE_MESSAGE);
    if (assignee.assigneeUserId) {
      const u = await prisma.user.findFirst({ where: { id: assignee.assigneeUserId, status: 'ENABLED' }, select: { id: true, role: true } });
      if (!u) throw new AppError(400, 'ASSIGNEE_NOT_FOUND', 'That user does not exist or is not active.');
      // Separation of duties starts at the request: a report sent to oneself
      // would be signed by one person twice.
      if (u.id === ctx.userSub) throw new AppError(400, 'SELF_ASSIGNMENT', 'A report cannot be sent to yourself for approval.');
      if (!approverRoles.includes(u.role)) throw new AppError(400, 'USER_NOT_APPROVER', 'That user does not hold an approver role.');
    } else {
      const r = await prisma.role.findFirst({ where: { name: assignee.assigneeRole!, isActive: true }, select: { name: true } });
      if (!r) throw new AppError(400, 'ASSIGNEE_NOT_FOUND', 'That role does not exist or is not active.');
      if (!approverRoles.includes(r.name)) throw new AppError(400, 'ROLE_NOT_APPROVER', 'That role is not a configured approver role.');
    }
    const row = await prisma.reportReview.create({
      data: {
        reportType: input.reportType.slice(0, 100),
        title: input.title.slice(0, 500),
        subtitle: input.subtitle?.slice(0, 1000) ?? null,
        requestMeta: input.requestMeta as Prisma.InputJsonValue,
        dataSnapshot: input.dataSnapshot as Prisma.InputJsonValue,
        requestedBy: ctx.userSub,
        requestedByName: ctx.userId,
        // FROZEN at the request: the signature block prints it (2026-09-25).
        requestedByRole: ctx.userRole,
        requestRemarks: input.remarks,
        ...assignee,
      },
      select: SUMMARY_SELECT,
    });
    const to = assignee.assigneeUserId ? `user ${assignee.assigneeUserId}` : `role ${assignee.assigneeRole}`;
    await auditLog({
      ...auditBase(ctx),
      action: 'REPORT_REVIEW_REQUESTED',
      // targetType carries the report name so the template reads
      // "<reportType> report requested for approval by <actor>".
      targetType: row.reportType, targetId: row.id,
      afterValue: { title: row.title, requestMeta: row.requestMeta, assignee, remarks: input.remarks, status: row.status },
      reason: input.remarks,
      signatureMeaning: clampSignature(`${ctx.userId} requested approval of the ${row.reportType} report "${titleLabel(row.title)}" from ${to}`),
    });
    await notifyAssignee(row, 'REPORT_REVIEW_REQUESTED', 'Report awaiting your approval',
      `"${row.title}" was sent to you for approval by ${ctx.userId}.`, ctx.userId);
    return row;
  },

  async list(ctx: RequestContext, list: ReviewList, page: number, pageSize: number): Promise<{ data: ReviewSummary[]; total: number }> {
    const superAdmin = ctx.userRole === 'SUPER_ADMIN';
    const partyOr = [
      { requestedBy: ctx.userSub },
      { decidedBy: ctx.userSub },
      { assigneeUserId: ctx.userSub },
      { assigneeRole: ctx.userRole },
    ];
    const where: Prisma.ReportReviewWhereInput =
      list === 'queue'
        ? (superAdmin ? { status: 'PENDING' } : { status: 'PENDING', OR: [{ assigneeUserId: ctx.userSub }, { assigneeRole: ctx.userRole }] })
        : list === 'mine'
          ? { requestedBy: ctx.userSub }
          : (superAdmin ? { status: 'APPROVED' } : { status: 'APPROVED', OR: partyOr });
    const [data, total] = await prisma.$transaction([
      prisma.reportReview.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, select: SUMMARY_SELECT }),
      prisma.reportReview.count({ where }),
    ]);
    return { data, total };
  },

  /** The full row with its snapshot — or `null` when it does not exist OR the
   *  caller is not a party. The route turns both into the same 404. */
  async getForParty(ctx: RequestContext, id: string): Promise<ReviewFull | null> {
    const row = await prisma.reportReview.findUnique({ where: { id }, select: { ...SUMMARY_SELECT, dataSnapshot: true } });
    if (!row || !isParty(ctx, row)) return null;
    return row;
  },

  async decide(ctx: RequestContext, id: string, decision: ReviewDecision, remarks: string): Promise<ReviewSummary> {
    const row = await prisma.reportReview.findUnique({ where: { id }, select: SUMMARY_SELECT });
    if (!row || !isParty(ctx, row)) throw new AppError(404, 'NOT_FOUND', 'Report request not found.');
    // Separation of duties — the two-person control — for everyone but
    // SUPER_ADMIN (see isSelfDecision); checked before the assignee bypass.
    if (isSelfDecision(ctx, row)) throw new AppError(403, 'SELF_APPROVAL', 'You cannot decide on your own request.');
    if (!isAssignee(ctx, row)) throw new AppError(403, 'NOT_ASSIGNEE', 'This request is not assigned to you or your role.');
    if (row.status !== 'PENDING') throw new AppError(409, 'ALREADY_DECIDED', 'This request has already been decided.');
    // The guard that makes two approvers acting at once safe: the UPDATE is
    // conditional on the status still being PENDING, so the second one changes
    // nothing and is told so.
    const { count } = await prisma.reportReview.updateMany({
      where: { id, status: 'PENDING' },
      // `decidedByRole` FROZEN at the decision: the signature block prints it (2026-09-25).
      data: { status: decision, decidedBy: ctx.userSub, decidedByName: ctx.userId, decidedByRole: ctx.userRole, decidedAt: new Date(), decisionRemarks: remarks },
    });
    if (count === 0) throw new AppError(409, 'ALREADY_DECIDED', 'This request has already been decided.');
    const after = (await prisma.reportReview.findUnique({ where: { id }, select: SUMMARY_SELECT }))!;
    const approved = decision === 'APPROVED';
    await auditLog({
      ...auditBase(ctx),
      action: approved ? 'REPORT_REVIEW_APPROVED' : 'REPORT_REVIEW_REJECTED',
      targetType: after.reportType, targetId: after.id,
      beforeValue: { status: 'PENDING' },
      afterValue: { status: after.status, decidedBy: after.decidedByName, decidedAt: after.decidedAt, remarks, requestedBy: after.requestedByName, title: after.title },
      reason: remarks,
      signatureMeaning: clampSignature(`${ctx.userId} ${approved ? 'approved' : 'rejected'} the ${after.reportType} report "${titleLabel(after.title)}" requested by ${after.requestedByName}`),
    });
    await notifyRequester(after, approved ? 'REPORT_REVIEW_APPROVED' : 'REPORT_REVIEW_REJECTED',
      approved ? 'Report approved' : 'Report rejected',
      `"${after.title}" was ${approved ? 'approved' : 'rejected'} by ${ctx.userId}: ${remarks}`, ctx.userId);
    return after;
  },

  /** A download of the approved document, written BEFORE the browser saves
   *  the file. Not a signature event — no re-auth — but a §11 record of who
   *  took a signed copy and when. */
  async logDownload(ctx: RequestContext, id: string): Promise<void> {
    const row = await prisma.reportReview.findUnique({ where: { id }, select: SUMMARY_SELECT });
    if (!row || !isParty(ctx, row)) throw new AppError(404, 'NOT_FOUND', 'Report request not found.');
    if (row.status !== 'APPROVED') throw new AppError(409, 'NOT_APPROVED', 'Only an approved report can be downloaded.');
    await auditLog({
      ...auditBase(ctx),
      action: 'REPORT_DOWNLOADED',
      targetType: row.reportType, targetId: row.id,
      afterValue: {
        title: row.title,
        signatures: [
          { label: 'Requested By', name: row.requestedByName, at: row.requestedAt },
          { label: 'Approved By', name: row.decidedByName, at: row.decidedAt },
        ],
      },
      signatureMeaning: clampSignature(`${ctx.userId} downloaded the approved ${row.reportType} report "${titleLabel(row.title)}" (requested by ${row.requestedByName}, approved by ${row.decidedByName})`),
    });
  },
};
