import { apiClient } from './api-client';
import { renderSnapshotToPdf, normaliseSnapshot, type ReportSnapshot } from './pdf-report';

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

export type Assignee = { userId: string } | { role: string };

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
  assigneeUserId: string | null;
  assigneeRole: string | null;
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

export async function submitReportForReview(input: {
  snapshot: ReportSnapshot;
  reportType: string;
  title: string;
  subtitle?: string;
  requestMeta: RequestMeta;
  remarks: string;
  assignee: Assignee;
  password?: string;
}): Promise<ReviewSummary> {
  return apiClient.postWithReauth<ReviewSummary>('/api/report-reviews', {
    reportType: input.reportType,
    title: input.title,
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    requestMeta: input.requestMeta,
    dataSnapshot: input.snapshot,
    remarks: input.remarks,
    ...('userId' in input.assignee ? { assigneeUserId: input.assignee.userId } : { assigneeRole: input.assignee.role }),
  }, input.password ?? '');
}

export async function fetchReview(id: string): Promise<ReviewFull> {
  return apiClient.get<ReviewFull>(`/api/report-reviews/${id}`);
}

export async function decideReview(id: string, decision: 'approve' | 'reject', remarks: string, password: string): Promise<ReviewSummary> {
  return apiClient.postWithReauth<ReviewSummary>(`/api/report-reviews/${id}/${decision}`, { remarks }, password);
}

/** "user qa1" / "any QA" — who will approve, for a toast or a list cell. */
export function assigneeLabel(assignee: Assignee, users: { id: string; username: string }[] = []): string {
  if ('userId' in assignee) return users.find((u) => u.id === assignee.userId)?.username ?? assignee.userId;
  return `any ${assignee.role}`;
}

/** What a row's Send-to column prints. */
export function assigneeText(r: Pick<ReviewSummary, 'assigneeUserId' | 'assigneeRole'>, users: { id: string; username: string }[] = []): string {
  if (r.assigneeUserId) return assigneeLabel({ userId: r.assigneeUserId }, users);
  if (r.assigneeRole) return assigneeLabel({ role: r.assigneeRole });
  return '-';
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

function fileSlug(title: string): string {
  return (title || 'report').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'report';
}

/**
 * The approver's view: the exact document, watermarked, unsigned, in a new tab.
 * Nothing is saved or audited. `toBlobUrl` FINALISES the document first — the
 * watermark and page numbers are painted at finalisation, and the raw
 * `doc.output('bloburl')` this used to call skipped it, so the approver's tab
 * opened a clean, unpaginated, unwatermarked PDF (review, 2026-09-07).
 */
export async function openDraft(id: string, formatDateTime: (d: string) => string): Promise<void> {
  const r = await fetchReview(id);
  const report = await renderSnapshotToPdf(normaliseSnapshot(r.dataSnapshot), { formatDateTime, draft: true });
  window.open(report.toBlobUrl(), '_blank');
}

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
