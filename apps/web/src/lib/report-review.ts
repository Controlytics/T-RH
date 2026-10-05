import { apiClient } from './api-client';
import { renderSnapshotToPdf, normaliseSnapshot, type ReportSnapshot } from './pdf-report';
import type { ReportKind } from '@digilog/shared';

/**
 * The report review workflow's client (2026-09-07). Every PDF download in the
 * product is a REQUEST: the page renders the report as before, then posts the
 * snapshot here instead of saving it. An approver signs it on the Reports page;
 * the requester and the approver then download the approved copy, with both
 * signatures, through `downloadApproved` — which audits the download BEFORE
 * the file is saved, the same fail-closed order the old export log kept.
 *
 * Design: docs/superpowers/specs/2026-09-07-report-review-workflow-design.md
 */

export interface RequestMeta {
  period?: { from: string; to: string; label: string };
  intervalMs?: number | null;
  instrumentCodes?: string[];
  search?: string;
  /** Rows PRINTED in the document — never the number that matched. */
  recordCount?: number;
}

export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ReviewSummary {
  id: string;
  reportType: string;
  title: string;
  subtitle?: string | null;
  requestMeta: RequestMeta;
  status: ReviewStatus;
  requestedBy: string;
  /** The username — what the signature line prints. */
  requestedByName: string;
  /** The role held at the request, FROZEN there (2026-09-25); null on a row older than the column. */
  requestedByRole: string | null;
  requestedAt: string;
  requestRemarks: string;
  /** The requester's own choice, on rows raised before 2026-10-01 — kept, no longer written. */
  assigneeUserId: string | null;
  assigneeRole: string | null;
  /** The APPROVERS, frozen from Configuration → Report Approvers at the request
   *  (2026-10-01; older rows carry their single assignee here). */
  approverRoles: string[];
  approverUserIds: string[];
  /** The instruments the report is about — what scopes who may see it. */
  instrumentIds: string[];
  decidedBy: string | null;
  decidedByName: string | null;
  /** The role held at the decision, FROZEN there (2026-09-25). */
  decidedByRole: string | null;
  decidedAt: string | null;
  decisionRemarks: string | null;
  createdAt: string;
}

export interface ReviewFull extends ReviewSummary { dataSnapshot: unknown }

export type ReviewList = 'queue' | 'mine' | 'approved';

/**
 * Raise a request. Since 2026-10-01 it names NO approver — the server sends it
 * to every configured approver role and user — and it carries its REPORT KIND
 * (which decides whether it may be requested at all, and whether remarks and
 * the password are required) and the ids of the instruments it is about (which
 * decide who may see it).
 */
export async function submitReportForReview(input: {
  reportKind: ReportKind;
  snapshot: ReportSnapshot;
  reportType: string;
  title: string;
  subtitle?: string;
  requestMeta: RequestMeta;
  instrumentIds: string[];
  remarks: string;
  password?: string;
}): Promise<ReviewSummary> {
  const body = {
    reportKind: input.reportKind,
    reportType: input.reportType,
    title: input.title,
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    requestMeta: input.requestMeta,
    dataSnapshot: input.snapshot,
    instrumentIds: input.instrumentIds,
    remarks: input.remarks,
  };
  return input.password
    ? apiClient.postWithReauth<ReviewSummary>('/api/report-reviews', body, input.password)
    : apiClient.post<ReviewSummary>('/api/report-reviews', body);
}

// Module-private (audit 2026-10-03, WEB-9): `downloadApproved` below is its only
// caller; nothing outside this file imported it.
async function fetchReview(id: string): Promise<ReviewFull> {
  return apiClient.get<ReviewFull>(`/api/report-reviews/${id}`);
}

export async function decideReview(id: string, decision: 'approve' | 'reject', remarks: string, password: string): Promise<ReviewSummary> {
  return apiClient.postWithReauth<ReviewSummary>(`/api/report-reviews/${id}/${decision}`, { remarks }, password);
}

/**
 * What a row's "Send to" column prints: the frozen approvers — "any SUPERVISOR,
 * qa1". A user id the list cannot name (deleted, or not readable by this
 * caller) prints as the id rather than vanishing.
 */
export function approversText(
  r: Pick<ReviewSummary, 'approverRoles' | 'approverUserIds'>,
  users: { id: string; username: string }[] = [],
): string {
  const parts = [
    ...(r.approverRoles ?? []).map((role) => `any ${role}`),
    ...(r.approverUserIds ?? []).map((id) => users.find((u) => u.id === id)?.username ?? id),
  ];
  return parts.length ? parts.join(', ') : '-';
}

/**
 * The SIGNATURE TABLE the approved PDF prints (2026-09-25, operator: "reviewed
 * by and approved by … should come in table, Name, Role, Date & Time for both
 * should come side by side" / "name, role, date & Time should come one below
 * one, headings should be one row left side and reviewed by and approved by
 * on top side by side"). One column per signer — REVIEWED BY (the requester,
 * in the operator's words) and APPROVED BY — with Name, Role and Date & Time
 * as the rows. The name is the username (the identity this system signs
 * with); the role is the one FROZEN on the record at the password-verified
 * act, never looked up live; the date-time is that act's. Until then two
 * lines, "Requested By: name (id) — date-time".
 */
export interface SignatureColumn { label: string; name: string; role: string | null; dateTime: string }
export function reviewSignatures(
  r: Pick<ReviewSummary, 'requestedByName' | 'requestedByRole' | 'requestedAt' | 'decidedByName' | 'decidedByRole' | 'decidedAt' | 'status'>,
  formatDateTime: (d: string) => string,
): SignatureColumn[] {
  const columns: SignatureColumn[] = [
    { label: 'Reviewed By', name: r.requestedByName, role: r.requestedByRole ?? null, dateTime: formatDateTime(r.requestedAt) },
  ];
  if (r.status === 'APPROVED' && r.decidedByName && r.decidedAt) {
    columns.push({ label: 'Approved By', name: r.decidedByName, role: r.decidedByRole ?? null, dateTime: formatDateTime(r.decidedAt) });
  }
  return columns;
}

export function fileSlug(title: string): string {
  return (title || 'report').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'report';
}

// `openDraft` (the watermarked draft in a new tab) was REMOVED 2026-10-01 with
// the View draft button (operator: "remove view draft and how you are showing
// after approval that below the request show like that only"). A pending row
// now opens its frozen snapshot beneath it as tables, as an approved one does.

/**
 * The approved copy. Audited BEFORE the file is saved — fail-closed: a file on
 * disk with no record of who took it is an ungoverned export.
 */
export async function downloadApproved(id: string, formatDateTime: (d: string) => string): Promise<void> {
  const r = await fetchReview(id);
  if (r.status !== 'APPROVED') throw new Error('This report is not approved yet.');
  await apiClient.post(`/api/report-reviews/${id}/download-log`, {});
  const report = await renderSnapshotToPdf(normaliseSnapshot(r.dataSnapshot), { formatDateTime, signatureTable: reviewSignatures(r, formatDateTime) });
  report.save(`${fileSlug(r.title)}-approved.pdf`);
}
