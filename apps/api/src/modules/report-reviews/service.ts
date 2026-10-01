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
 * 2026-10-01: the requester no longer chooses an approver — every request goes
 * to the configured approver roles AND users, frozen on the row; the
 * requester's role-mates and the approvers all see it (and download it once
 * approved), within their INSTRUMENT SCOPE; and whether a report type is
 * requested at all, with remarks, with the password, is per-type
 * configuration (Configuration → Report Downloads).
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
import { REPORT_APPROVERS_NONE_MESSAGE, isReportKind, reportKindLabel, type ReportKind, type ReportKindPolicy } from '@digilog/shared';
import { loadReportApprovers } from './load-approvers.js';
import { loadReportDownloads } from './load-downloads.js';
import { resolveVisibility } from '../instruments/visibility.js';
import { roleHasPermission } from '../../plugins/rbac.js';

export type ReviewList = 'queue' | 'mine' | 'approved';
export type ReviewDecision = 'APPROVED' | 'REJECTED';

/**
 * Who a request belongs to (2026-10-01). The approver SET and the instruments
 * are FROZEN on the row at the request; `requestedByRole` was frozen there since
 * 2026-09-25. Rows older than 2026-10-01 had their single assignee copied into
 * the arrays by the migration, so there is ONE shape to read.
 */
export interface ReviewParties {
  requestedBy: string;
  requestedByRole: string | null;
  approverRoles: string[];
  approverUserIds: string[];
  decidedBy: string | null;
  instrumentIds: string[];
}

type Actor = Pick<RequestContext, 'userSub' | 'userRole'>;

/** The instruments the caller may see: `null` = unrestricted. */
export type VisibleInstruments = Set<string> | null;

/**
 * Operator (2026-10-01): "which are assigned to role or user for that users
 * only assigned instruments report requests should come". A request about no
 * instrument (the Audit Trail PDF) is not scope-restricted; otherwise the
 * caller must see ANY of its instruments (operator's choice: "any").
 */
export function inScope(row: Pick<ReviewParties, 'instrumentIds'>, visible: VisibleInstruments): boolean {
  if (visible === null || row.instrumentIds.length === 0) return true;
  return row.instrumentIds.some((id) => visible.has(id));
}

/** Is the caller one of the frozen approvers — by holding a role, or named? */
export function isApprover(ctx: Actor, row: Pick<ReviewParties, 'approverRoles' | 'approverUserIds'>): boolean {
  if (ctx.userRole === 'SUPER_ADMIN') return true;
  return row.approverUserIds.includes(ctx.userSub) || row.approverRoles.includes(ctx.userRole);
}

/**
 * May this caller SEE the request (its data, and an approved copy)? THE ONE
 * PREDICATE — the lists, the detail read, the decision and the download all
 * apply it, and the lists' SQL (`visibilityWhere`) is its translation.
 *
 *   - SUPER_ADMIN: always.
 *   - The requester and whoever decided it: always — they signed it; a later
 *     narrowing of their scope does not unsign a record.
 *   - Everyone in the requester's ROLE and every approver (operator: "if one
 *     operator user send request to supervisor then all operator user can view
 *     and download the report, and also all supervisor users can view and
 *     download") — but only when the request is IN THEIR INSTRUMENT SCOPE.
 *
 * Everyone else gets a 404 from the routes — never a 403, which would confirm
 * the id exists. Pure and exported, so it is unit-tested without a database.
 */
export function isParty(ctx: Actor, row: ReviewParties, visible: VisibleInstruments): boolean {
  if (ctx.userRole === 'SUPER_ADMIN') return true;
  if (row.requestedBy === ctx.userSub) return true;
  if (row.decidedBy && row.decidedBy === ctx.userSub) return true;
  const byRole = (row.requestedByRole !== null && row.requestedByRole === ctx.userRole) || isApprover(ctx, row);
  return byRole && inScope(row, visible);
}

/** May this caller DECIDE it? An approver whose scope covers it. Being the
 *  requester counts for nothing here — and `isSelfDecision` refuses the
 *  requester outright, unless they are SUPER_ADMIN. The requester's role-mates
 *  may view and download, never approve, unless they are approvers too. */
export function mayDecide(ctx: Actor, row: ReviewParties, visible: VisibleInstruments): boolean {
  if (ctx.userRole === 'SUPER_ADMIN') return true;
  return isApprover(ctx, row) && inScope(row, visible);
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

/** The caller's visible instruments, from the ONE resolver (`resolveVisibility`). */
export async function visibleInstrumentsFor(ctx: { userId: string; userRole: string }): Promise<VisibleInstruments> {
  const { where } = await resolveVisibility(ctx);
  if (!where) return null;
  const rows = await prisma.instrument.findMany({ where, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/** `inScope` as a Prisma fragment. `hasSome: []` matches nothing — a scope of
 *  no instruments sees only the unscoped (no-instrument) requests. */
function scopeWhere(visible: VisibleInstruments): Prisma.ReportReviewWhereInput {
  if (visible === null) return {};
  return { OR: [{ instrumentIds: { isEmpty: true } }, { instrumentIds: { hasSome: [...visible] } }] };
}

/** `isParty` as a Prisma fragment — keep the two in step. */
function visibilityWhere(ctx: Actor, visible: VisibleInstruments): Prisma.ReportReviewWhereInput {
  if (ctx.userRole === 'SUPER_ADMIN') return {};
  return {
    OR: [
      { requestedBy: ctx.userSub },
      { decidedBy: ctx.userSub },
      {
        AND: [
          { OR: [{ requestedByRole: ctx.userRole }, { approverRoles: { has: ctx.userRole } }, { approverUserIds: { has: ctx.userSub } }] },
          scopeWhere(visible),
        ],
      },
    ],
  };
}

/**
 * The download policy of a report KIND (Configuration → Report Downloads,
 * 2026-10-01). Thrown as a 400 for an unknown kind. Both download routes call
 * this BEFORE the password check, so nobody is asked to sign a refused act.
 */
export async function policyForKind(kind: unknown): Promise<{ kind: ReportKind; policy: ReportKindPolicy }> {
  if (!isReportKind(kind)) throw new AppError(400, 'VALIDATION_ERROR', 'reportKind is missing or unknown.');
  const policy = (await loadReportDownloads())[kind];
  return { kind, policy };
}

export interface SubmitInput {
  reportKind: ReportKind;
  policy: ReportKindPolicy;
  reportType: string;
  title: string;
  subtitle?: string;
  requestMeta: unknown;
  dataSnapshot: unknown;
  /** '' when the kind's remarks are switched off. */
  remarks: string;
  /** The instruments the report is about. */
  instrumentIds: string[];
}

/** Kinds that are always about at least one instrument. The Alarm Report may
 *  legitimately cover none (no alarm in the period); the Audit Trail never does. */
const INSTRUMENT_KINDS: ReportKind[] = ['data-report', 'trend-chart', 'instrument-alarms'];

/** The list rows: everything but the snapshot, which can be hundreds of KB. */
const SUMMARY_SELECT = {
  id: true, reportType: true, title: true, subtitle: true, requestMeta: true, status: true,
  requestedBy: true, requestedByName: true, requestedByRole: true, requestedAt: true, requestRemarks: true,
  assigneeUserId: true, assigneeRole: true, approverRoles: true, approverUserIds: true, instrumentIds: true,
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
 * The users who could actually DECIDE a request (2026-10-01): enabled, not the
 * requester, holding an approver role or named outright, whose role holds
 * `REPORT_REVIEW_APPROVE` (the route gate on approve/reject — read through the
 * same resolver, `roleHasPermission`), and whose instrument scope covers the
 * request. Ticking a role or a user in configuration is not enough: a named
 * user without the permission gets a 403 at the button, and an approver scoped
 * away from the instruments never sees the request. `submit` refuses a request
 * with nobody here, rather than accepting one only a super admin could ever
 * decide while telling the requester "the approvers have been notified".
 */
async function eligibleApprovers(
  row: Pick<ReviewParties, 'requestedBy' | 'approverRoles' | 'approverUserIds' | 'instrumentIds'>,
): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      status: 'ENABLED',
      id: { not: row.requestedBy },
      role: { not: 'SUPER_ADMIN' },
      OR: [{ role: { in: row.approverRoles } }, { id: { in: row.approverUserIds } }],
    },
    select: { username: true, role: true },
  });
  const out: string[] = [];
  for (const u of users) {
    if (!(await roleHasPermission(u.role, 'REPORT_REVIEW_APPROVE'))) continue;
    if (!inScope(row, await visibleInstrumentsFor({ userId: u.username, userRole: u.role }))) continue;
    out.push(u.username);
  }
  return out;
}

/**
 * Best-effort notifications — a failed notification never breaks the
 * workflow; the audit row is the record, the notification a courtesy.
 *
 * PER USER, never `forRole` (2026-10-01): a role broadcast would tell an
 * approver outside the request's instrument scope about a request they then
 * get a 404 on — and the title names the instruments. The recipients are the
 * eligible approvers `submit` already resolved.
 */
async function notifyApprovers(row: ReviewSummary, usernames: string[], type: NotificationType, title: string, message: string, createdBy: string): Promise<void> {
  try {
    for (const username of usernames) {
      await createNotification({ type, title, message, forUserId: username, metadata: { reportReviewId: row.id, reportType: row.reportType }, createdBy });
    }
  } catch (e) {
    console.error('[report-reviews] notify approvers failed:', (e as Error).message);
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
    // Direct kinds never come here; the dialog downloads them. Refused rather
    // than accepted, so the configuration is the ONE answer to "is this type
    // reviewed".
    if (input.policy.mode !== 'REQUEST') {
      throw new AppError(409, 'REPORT_IS_DIRECT', `The ${reportKindLabel(input.reportKind)} downloads directly — it is not sent for approval.`);
    }
    if (input.policy.remarksRequired && !input.remarks) {
      throw new AppError(400, 'VALIDATION_ERROR', 'remarks is required and cannot be blank.');
    }

    // The approvers are ADMINISTERED (Configuration → Report Approvers) and
    // FROZEN here — a later change never re-routes this request. Inactive roles
    // and disabled users are dropped first; nobody left = refused, naming the fix.
    const configured = await loadReportApprovers();
    const [roles, users] = await Promise.all([
      prisma.role.findMany({ where: { name: { in: configured.approverRoles }, isActive: true }, select: { name: true } }),
      prisma.user.findMany({ where: { id: { in: configured.approverUserIds }, status: 'ENABLED', role: { not: 'SUPER_ADMIN' } }, select: { id: true } }),
    ]);
    const approverRoles = configured.approverRoles.filter((r) => roles.some((x) => x.name === r));
    const approverUserIds = configured.approverUserIds.filter((u) => users.some((x) => x.id === u));
    if (approverRoles.length === 0 && approverUserIds.length === 0) {
      throw new AppError(400, 'NO_APPROVER', REPORT_APPROVERS_NONE_MESSAGE);
    }

    // The instruments: real, and every one inside the REQUESTER's scope — the
    // browser's list is a claim; this is the check. Out of scope reads as not
    // found, the same answer every other scoped route gives.
    const instrumentIds = [...new Set(input.instrumentIds)];
    if (INSTRUMENT_KINDS.includes(input.reportKind) && instrumentIds.length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'instrumentIds is required for this report.');
    }
    if (input.reportKind === 'audit-trail' && instrumentIds.length > 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'The Audit Trail is not about an instrument.');
    }
    if (instrumentIds.length > 0) {
      const found = await prisma.instrument.findMany({ where: { id: { in: instrumentIds } }, select: { id: true } });
      const visible = await visibleInstrumentsFor(ctx);
      const ok = found.length === instrumentIds.length && (visible === null || instrumentIds.every((id) => visible.has(id)));
      if (!ok) throw new AppError(404, 'INSTRUMENT_NOT_FOUND', 'One of the report\'s instruments was not found.');
    }

    // Somebody must be able to DECIDE it. A super admin may decide anything,
    // their own request included, so their requests are always decidable.
    const approvers = await eligibleApprovers({ requestedBy: ctx.userSub, approverRoles, approverUserIds, instrumentIds });
    if (approvers.length === 0 && ctx.userRole !== 'SUPER_ADMIN') {
      throw new AppError(400, 'NO_ELIGIBLE_APPROVER',
        'Nobody can approve this report: no configured approver other than you holds the approve permission and has these instruments assigned. Ask a super admin to check Configuration → Report Approvers and Roles & Access.');
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
        // FROZEN at the request: the signature block prints it (2026-09-25),
        // and the requester's role-mates see the request by it (2026-10-01).
        requestedByRole: ctx.userRole,
        requestRemarks: input.remarks,
        approverRoles,
        approverUserIds,
        instrumentIds,
      },
      select: SUMMARY_SELECT,
    });
    const to = [...approverRoles.map((r) => `role ${r}`), ...approverUserIds.map((u) => `user ${u}`)].join(', ');
    await auditLog({
      ...auditBase(ctx),
      action: 'REPORT_REVIEW_REQUESTED',
      // targetType carries the report name so the template reads
      // "<reportType> report requested for approval by <actor>".
      targetType: row.reportType, targetId: row.id,
      afterValue: {
        title: row.title, requestMeta: row.requestMeta, reportKind: input.reportKind,
        approvers: { roles: approverRoles, userIds: approverUserIds }, instrumentIds,
        remarks: input.remarks || null, passwordSigned: input.policy.passwordRequired, status: row.status,
      },
      reason: input.remarks || undefined,
      signatureMeaning: clampSignature(`${ctx.userId} requested approval of the ${row.reportType} report "${titleLabel(row.title)}" from ${to}`),
    });
    await notifyApprovers(row, approvers, 'REPORT_REVIEW_REQUESTED', 'Report awaiting your approval',
      `"${row.title}" was sent for approval by ${ctx.userId}.`, ctx.userId);
    return row;
  },

  async list(ctx: RequestContext, list: ReviewList, page: number, pageSize: number): Promise<{ data: ReviewSummary[]; total: number }> {
    const superAdmin = ctx.userRole === 'SUPER_ADMIN';
    const visible = await visibleInstrumentsFor(ctx);
    // queue    — PENDING, I am an approver, in my scope, not my own (SUPER_ADMIN: every PENDING one)
    // mine     — raised by me or by anyone in my role, in my scope ("Requests" tab)
    // approved — APPROVED and visible to me by `isParty`
    const where: Prisma.ReportReviewWhereInput =
      list === 'queue'
        ? (superAdmin
          ? { status: 'PENDING' }
          : {
            status: 'PENDING',
            requestedBy: { not: ctx.userSub },
            AND: [
              { OR: [{ approverRoles: { has: ctx.userRole } }, { approverUserIds: { has: ctx.userSub } }] },
              scopeWhere(visible),
            ],
          })
        : list === 'mine'
          ? { OR: [{ requestedBy: ctx.userSub }, { AND: [{ requestedByRole: ctx.userRole }, scopeWhere(visible)] }] }
          : { status: 'APPROVED', ...visibilityWhere(ctx, visible) };
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
    if (!row || !isParty(ctx, row, await visibleInstrumentsFor(ctx))) return null;
    return row;
  },

  async decide(ctx: RequestContext, id: string, decision: ReviewDecision, remarks: string): Promise<ReviewSummary> {
    const row = await prisma.reportReview.findUnique({ where: { id }, select: SUMMARY_SELECT });
    const visible = await visibleInstrumentsFor(ctx);
    if (!row || !isParty(ctx, row, visible)) throw new AppError(404, 'NOT_FOUND', 'Report request not found.');
    // Separation of duties — the two-person control — for everyone but
    // SUPER_ADMIN (see isSelfDecision); checked before the approver check.
    if (isSelfDecision(ctx, row)) throw new AppError(403, 'SELF_APPROVAL', 'You cannot decide on your own request.');
    if (!mayDecide(ctx, row, visible)) throw new AppError(403, 'NOT_APPROVER', 'You are not an approver of this request.');
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
    if (!row || !isParty(ctx, row, await visibleInstrumentsFor(ctx))) throw new AppError(404, 'NOT_FOUND', 'Report request not found.');
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
