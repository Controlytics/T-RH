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
import { createHash } from 'node:crypto';
import { Prisma, type NotificationType } from '@prisma/client';
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { canonicalize } from '../../lib/hash-chain.js';
import { AppError } from '../../lib/errors.js';
import { createNotification } from '../notifications/notification.service.js';
import { clampSignature } from '../alarms/validation.js';
import { REPORT_APPROVERS_NONE_MESSAGE, isReportKind, reportKindLabel, reportTypeMatchesKind, type ReportKind, type ReportKindPolicy } from '@digilog/shared';
import { loadReportApprovers } from './load-approvers.js';
import { loadReportDownloads } from './load-downloads.js';
import { resolveVisibility } from '../instruments/visibility.js';
import { roleHasPermission } from '../../plugins/rbac.js';

export type ReviewList = 'queue' | 'mine' | 'approved';
export type ReviewDecision = 'APPROVED' | 'REJECTED';

/**
 * The tamper-evidence digest of a frozen document (audit 2026-10-03, DATA-7):
 * sha256 over the SAME recursive canonical JSON the audit checksum uses, so
 * the bytes hashed at the request are the bytes hashed again when the row is
 * read back from JSONB (key order normalised, `undefined` never present —
 * the value is JSON round-tripped first, exactly as the audit writer does).
 * Stored on `report_reviews.snapshot_hash`, written into the REQUESTED and
 * APPROVED audit rows (hash-chained, so it cannot be edited to agree with an
 * edited snapshot), and recomputed before every download.
 */
export function snapshotDigest(snapshot: unknown): string {
  return createHash('sha256').update(canonicalize(JSON.parse(JSON.stringify(snapshot ?? null)))).digest('hex');
}

/** HTTP error code a download gets when the stored document no longer hashes
 *  to what was signed. */
export const SNAPSHOT_MISMATCH = 'SNAPSHOT_MISMATCH';

/**
 * Who a request belongs to (2026-10-01). The approver SET and the instruments
 * are FROZEN on the row at the request; `requestedByRole` was frozen there since
 * 2026-09-25. Rows older than 2026-10-01 had their single assignee copied into
 * the arrays by the migration, so there is ONE shape to read.
 */
export interface ReviewParties {
  /** The audit report type — decides whether an EMPTY instrument list is unscoped. */
  reportType: string;
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
export function inScope(row: Pick<ReviewParties, 'instrumentIds' | 'reportType'>, visible: VisibleInstruments): boolean {
  if (visible === null) return true;
  // Only the Audit Trail is genuinely about no instrument. Any other report
  // with an EMPTY list — an Alarm Report of no alarms, or a row older than the
  // column that the backfill could not resolve — is visible only to
  // UNRESTRICTED viewers: its subtitle can still name a location, and an empty
  // list must never mean "everyone" (code review, 2026-10-01).
  if (row.instrumentIds.length === 0) return row.reportType === UNSCOPED_REPORT_TYPE;
  return row.instrumentIds.some((id) => visible.has(id));
}

/** The one report type that is about no instrument. */
export const UNSCOPED_REPORT_TYPE = 'Audit Trail';

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
  return { OR: [{ instrumentIds: { isEmpty: true }, reportType: UNSCOPED_REPORT_TYPE }, { instrumentIds: { hasSome: [...visible] } }] };
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
export async function policyForKind(kind: unknown, reportType: unknown): Promise<{ kind: ReportKind; policy: ReportKindPolicy }> {
  if (!isReportKind(kind)) throw new AppError(400, 'VALIDATION_ERROR', 'reportKind is missing or unknown.');
  if (typeof reportType !== 'string' || !reportTypeMatchesKind(kind, reportType)) {
    throw new AppError(400, 'REPORT_TYPE_MISMATCH', 'The report type does not belong to that report kind.');
  }
  const policy = (await loadReportDownloads())[kind];
  return { kind, policy };
}

/**
 * The configured approvers that still EXIST and are active — inactive roles and
 * disabled users dropped. What a request freezes, and what the request dialog
 * is told through `/report-approvers/current`, so the dialog never promises an
 * approver the server will then refuse (code review, 2026-10-01).
 */
export async function activeApprovers(): Promise<{ approverRoles: string[]; approverUserIds: string[] }> {
  const configured = await loadReportApprovers();
  const [roles, users] = await Promise.all([
    prisma.role.findMany({ where: { name: { in: configured.approverRoles }, isActive: true }, select: { name: true } }),
    prisma.user.findMany({ where: { id: { in: configured.approverUserIds }, status: 'ENABLED', role: { not: 'SUPER_ADMIN' } }, select: { id: true } }),
  ]);
  return {
    approverRoles: configured.approverRoles.filter((r) => roles.some((x) => x.name === r)),
    approverUserIds: configured.approverUserIds.filter((u) => users.some((x) => x.id === u)),
  };
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
const INSTRUMENT_KINDS: ReportKind[] = ['data-report', 'time-series', 'trend-header', 'temperature-trend', 'humidity-trend', 'instrument-alarms'];

/** The list rows: everything but the snapshot, which can be hundreds of KB. */
const SUMMARY_SELECT = {
  id: true, reportType: true, title: true, subtitle: true, requestMeta: true, status: true,
  requestedBy: true, requestedByName: true, requestedByRole: true, requestedAt: true, requestRemarks: true,
  assigneeUserId: true, assigneeRole: true, approverRoles: true, approverUserIds: true, instrumentIds: true,
  decidedBy: true, decidedByName: true, decidedByRole: true, decidedAt: true, decisionRemarks: true,
  snapshotHash: true,
  createdAt: true,
} satisfies Prisma.ReportReviewSelect;

export type ReviewSummary = Prisma.ReportReviewGetPayload<{ select: typeof SUMMARY_SELECT }>;

/**
 * A list row as the Reports page receives it (audit 2026-10-12 #9): the
 * SERVER's answer to "may this caller decide it?" — status, the APPROVE
 * permission, separation of duties, approver AND instrument scope, the same
 * `mayDecide` / `isSelfDecision` the decision route applies — and the approver
 * users by NAME, so the page needs neither to re-derive the rule nor to read
 * `/api/users` (USER_READ) on a REPORT_REVIEW_READ page. Parallel to
 * `approverUserIds`; an id whose user no longer exists is given as the id.
 */
export type ReviewListRow = ReviewSummary & { canDecide: boolean; approverUserNames: string[] };

async function decorateRows(ctx: Actor, rows: ReviewSummary[], visible: VisibleInstruments): Promise<ReviewListRow[]> {
  const canApprove = await roleHasPermission(ctx.userRole, 'REPORT_REVIEW_APPROVE');
  const ids = [...new Set(rows.flatMap((r) => r.approverUserIds))];
  const users = ids.length === 0 ? [] : await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true } });
  const nameOf = new Map(users.map((u) => [u.id, u.username]));
  return rows.map((r) => ({
    ...r,
    canDecide: r.status === 'PENDING' && canApprove && !isSelfDecision(ctx, r) && mayDecide(ctx, r, visible),
    approverUserNames: r.approverUserIds.map((id) => nameOf.get(id) ?? id),
  }));
}
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
export async function eligibleApprovers(
  row: Pick<ReviewParties, 'requestedBy' | 'approverRoles' | 'approverUserIds' | 'instrumentIds' | 'reportType'>,
): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      status: 'ENABLED',
      id: { not: row.requestedBy },
      role: { not: 'SUPER_ADMIN' },
      OR: [{ role: { in: row.approverRoles } }, { id: { in: row.approverUserIds } }],
    },
    select: { id: true, username: true, role: true },
  });
  if (users.length === 0) return [];

  // Permissions resolve ONCE PER DISTINCT ROLE and the instrument scope ONCE
  // PER DISTINCT (role, user-config) PAIR (audit 2026-10-03, API-19). This ran
  // two permission reads and a full scope resolution — itself three or four
  // queries plus an instrument list — for EVERY candidate, on every PDF
  // request; a plant with thirty approvers in one role paid for the same
  // answer thirty times. Nothing is re-derived: `roleHasPermission` and
  // `visibleInstrumentsFor` (over `resolveVisibility`, the ONE resolver) are
  // still the deciders, each asked once per answer that can differ.
  //
  // READ as well as APPROVE: the queue, the detail and the decision routes are
  // all behind REPORT_REVIEW_READ, and APPROVE does not imply it.
  const roleOk = new Map<string, boolean>();
  for (const role of new Set(users.map((u) => u.role))) {
    roleOk.set(role, (await roleHasPermission(role, 'REPORT_REVIEW_APPROVE')) && (await roleHasPermission(role, 'REPORT_REVIEW_READ')));
  }
  const candidates = users.filter((u) => roleOk.get(u.role) === true);
  if (candidates.length === 0) return [];

  // The effective scope is user_configs over role_configs (visibility.ts), so
  // two users of one role share a scope iff their own user_config rows agree —
  // which for most users means "neither has one". The stored JSON is the key.
  const configs = await prisma.userConfig.findMany({
    where: { userId: { in: candidates.map((u) => u.id) } },
    select: { userId: true, instrumentScope: true },
  });
  const scopeRowByUser = new Map(configs.map((c) => [c.userId, c.instrumentScope]));
  const visibleByKey = new Map<string, VisibleInstruments>();
  const out: string[] = [];
  for (const u of candidates) {
    const key = `${u.role}\u0000${JSON.stringify(scopeRowByUser.get(u.id) ?? null)}`;
    if (!visibleByKey.has(key)) {
      visibleByKey.set(key, await visibleInstrumentsFor({ userId: u.username, userRole: u.role }));
    }
    if (inScope(row, visibleByKey.get(key) ?? null)) out.push(u.username);
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

/**
 * What the REQUESTED audit row says about this request's document:
 *   - `missing`  — no REQUESTED row names it (its audit write was lost, or it
 *                  was hard-deleted): nothing attests the document.
 *   - `redacted` — the row exists but its payload was redacted: the digest it
 *                  carried is gone.
 *   - `legacy`   — the row exists and has no `snapshotHash`: raised before the
 *                  digest existed (2026-10-05).
 *   - `attested` — the row carries the digest.
 */
type Attestation =
  | { kind: 'missing' } | { kind: 'redacted' } | { kind: 'legacy' }
  | { kind: 'attested'; hash: string };

async function requestAttestation(reviewId: string): Promise<Attestation> {
  const rows = await prisma.$queryRaw<Array<{ h: string | null; redacted: boolean }>>`
    SELECT after_value->>'snapshotHash' AS h, (redacted_at IS NOT NULL) AS redacted
    FROM audit_trail
    WHERE action = 'REPORT_REVIEW_REQUESTED' AND target_id = ${reviewId}
    ORDER BY chain_position ASC
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return { kind: 'missing' };
  if (r.redacted) return { kind: 'redacted' };
  return typeof r.h === 'string' && r.h.length > 0 ? { kind: 'attested', hash: r.h } : { kind: 'legacy' };
}

/** HTTP error code a download gets when nothing hash-chained vouches for the
 *  stored document (audit 2026-10-12 #8: fail CLOSED, never fall back to the
 *  row's own editable column). */
export const SNAPSHOT_UNATTESTED = 'SNAPSHOT_UNATTESTED';

function auditBase(ctx: RequestContext) {
  return { userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId };
}

/**
 * The configuration's refusals that need no database — mode and remarks. The
 * ROUTE calls this BEFORE the password check (code review, 2026-10-01: the
 * password was verified, and a mistype counted toward lockout, for a request
 * the configuration then refused); `submit` calls it again as the guard of
 * record.
 */
export function assertRequestable(kind: ReportKind, policy: ReportKindPolicy, remarks: string): void {
  // Direct kinds never come here; the dialog downloads them. Refused rather
  // than accepted, so the configuration is the ONE answer to "is this type
  // reviewed".
  if (policy.mode !== 'REQUEST') {
    throw new AppError(409, 'REPORT_IS_DIRECT', `The ${reportKindLabel(kind)} downloads directly — it is not sent for approval.`);
  }
  if (policy.remarksRequired && !remarks) {
    throw new AppError(400, 'VALIDATION_ERROR', 'remarks is required and cannot be blank.');
  }
}

export const reportReviewService = {
  async submit(ctx: RequestContext, input: SubmitInput): Promise<ReviewSummary> {
    assertRequestable(input.reportKind, input.policy, input.remarks);

    // The approvers are ADMINISTERED (Configuration → Report Approvers) and
    // FROZEN here — a later change never re-routes this request. Inactive roles
    // and disabled users are dropped first; nobody left = refused, naming the fix.
    const { approverRoles, approverUserIds } = await activeApprovers();
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
    const approvers = await eligibleApprovers({ requestedBy: ctx.userSub, approverRoles, approverUserIds, instrumentIds, reportType: input.reportType });
    if (approvers.length === 0 && ctx.userRole !== 'SUPER_ADMIN') {
      throw new AppError(400, 'NO_ELIGIBLE_APPROVER',
        'Nobody can approve this report: no configured approver other than you holds the approve permission and has these instruments assigned. Ask a super admin to check Configuration → Report Settings and Roles & Access.');
    }

    // The digest of the document being signed, frozen beside it and into the
    // chained audit row below — what every later download is checked against.
    const snapshotHash = snapshotDigest(input.dataSnapshot);
    const to = [...approverRoles.map((r) => `role ${r}`), ...approverUserIds.map((u) => `user ${u}`)].join(', ');
    // The request and its REQUESTED audit row are ONE transaction (audit
    // 2026-10-12 #8). Written separately, a failed audit insert left a request
    // with no audit row — and with no REQUESTED row the download check had
    // nothing hash-chained to compare the document against.
    const row = await prisma.$transaction(async (tx) => {
    const created = await tx.reportReview.create({
      data: {
        reportType: input.reportType.slice(0, 100),
        title: input.title.slice(0, 500),
        subtitle: input.subtitle?.slice(0, 1000) ?? null,
        requestMeta: input.requestMeta as Prisma.InputJsonValue,
        dataSnapshot: input.dataSnapshot as Prisma.InputJsonValue,
        snapshotHash,
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
    await auditLog({
      ...auditBase(ctx),
      action: 'REPORT_REVIEW_REQUESTED',
      // targetType carries the report name so the template reads
      // "<reportType> report requested for approval by <actor>".
      targetType: created.reportType, targetId: created.id,
      afterValue: {
        title: created.title, requestMeta: created.requestMeta, reportKind: input.reportKind,
        approvers: { roles: approverRoles, userIds: approverUserIds }, instrumentIds,
        remarks: input.remarks || null, passwordSigned: input.policy.passwordRequired, status: created.status,
        snapshotHash,
      },
      reason: input.remarks || undefined,
      signatureMeaning: clampSignature(`${ctx.userId} requested approval of the ${created.reportType} report "${titleLabel(created.title)}" from ${to}`),
    }, tx);
    return created;
    });
    await notifyApprovers(row, approvers, 'REPORT_REVIEW_REQUESTED', 'Report awaiting your approval',
      `"${row.title}" was sent for approval by ${ctx.userId}.`, ctx.userId);
    return row;
  },

  async list(ctx: RequestContext, list: ReviewList, page: number, pageSize: number): Promise<{ data: ReviewListRow[]; total: number }> {
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
    return { data: await decorateRows(ctx, data, visible), total };
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
    //
    // The decision and its audit row are ONE transaction (audit 2026-10-12 #8):
    // a failed audit insert rolls the decision back, so an approval can never
    // exist without the signed record of who approved it.
    const approved = decision === 'APPROVED';
    const after = await prisma.$transaction(async (tx) => {
    const { count } = await tx.reportReview.updateMany({
      where: { id, status: 'PENDING' },
      // `decidedByRole` FROZEN at the decision: the signature block prints it (2026-09-25).
      data: { status: decision, decidedBy: ctx.userSub, decidedByName: ctx.userId, decidedByRole: ctx.userRole, decidedAt: new Date(), decisionRemarks: remarks },
    });
    if (count === 0) throw new AppError(409, 'ALREADY_DECIDED', 'This request has already been decided.');
    const after = (await tx.reportReview.findUnique({ where: { id }, select: SUMMARY_SELECT }))!;
    await auditLog({
      ...auditBase(ctx),
      action: approved ? 'REPORT_REVIEW_APPROVED' : 'REPORT_REVIEW_REJECTED',
      targetType: after.reportType, targetId: after.id,
      beforeValue: { status: 'PENDING' },
      // `snapshotHash` names WHICH document was decided on — the one the
      // requester signed, by digest, so the two signatures are bound to the
      // same bytes (DATA-7).
      afterValue: { status: after.status, decidedBy: after.decidedByName, decidedAt: after.decidedAt, remarks, requestedBy: after.requestedByName, title: after.title, snapshotHash: after.snapshotHash },
      reason: remarks,
      signatureMeaning: clampSignature(`${ctx.userId} ${approved ? 'approved' : 'rejected'} the ${after.reportType} report "${titleLabel(after.title)}" requested by ${after.requestedByName}`),
    }, tx);
    return after;
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
    const row = await prisma.reportReview.findUnique({ where: { id }, select: { ...SUMMARY_SELECT, dataSnapshot: true } });
    if (!row || !isParty(ctx, row, await visibleInstrumentsFor(ctx))) throw new AppError(404, 'NOT_FOUND', 'Report request not found.');
    if (row.status !== 'APPROVED') throw new AppError(409, 'NOT_APPROVED', 'Only an approved report can be downloaded.');
    // The document must still hash to what was signed (DATA-7). The expected
    // digest is the one the REQUESTED audit row carries — hash-chained, so an
    // actor who edits the snapshot cannot also edit it to agree.
    //
    // FAIL CLOSED (audit 2026-10-12 #8). The row's own `snapshot_hash` column
    // is NEVER the anchor: it is editable together with the snapshot. Allowed
    // without a digest is ONE shape only — a request raised before the digest
    // existed: a REQUESTED audit row with no `snapshotHash` AND a NULL column
    // (recorded below as unattested). Refused: no REQUESTED row at all, a
    // redacted one (the digest it carried is gone), and a column set while the
    // audit row has none (the two have only ever been written together).
    const actual = snapshotDigest(row.dataSnapshot);
    const att = await requestAttestation(row.id);
    if (att.kind !== 'attested' && !(att.kind === 'legacy' && row.snapshotHash === null)) {
      const why = att.kind === 'missing'
        ? 'no audit record of the request exists'
        : att.kind === 'redacted'
          ? 'the audit record of the request was redacted'
          : 'the stored digest has no matching audit record';
      console.error(`[report-reviews] snapshot of ${row.id} is unattested (${att.kind}; stored column ${row.snapshotHash}) — download refused`);
      throw new AppError(409, SNAPSHOT_UNATTESTED,
        `This report cannot be verified against what was signed: ${why}. The download is refused; ask a super admin to investigate the audit trail.`);
    }
    const expected = att.kind === 'attested' ? att.hash : null;
    const mismatch = expected !== null && (expected !== actual || row.snapshotHash !== expected);
    if (mismatch) {
      console.error(`[report-reviews] snapshot of ${row.id} does not hash to what was signed (expected ${expected}, stored column ${row.snapshotHash}, actual ${actual}) — download refused`);
      throw new AppError(409, SNAPSHOT_MISMATCH,
        'This report\'s stored document no longer matches the one that was signed. The download is refused; ask a super admin to investigate the audit trail.');
    }
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
        snapshotHash: actual,
        snapshotAttested: expected !== null,
      },
      signatureMeaning: clampSignature(`${ctx.userId} downloaded the approved ${row.reportType} report "${titleLabel(row.title)}" (requested by ${row.requestedByName}, approved by ${row.decidedByName})`),
    });
  },
};
