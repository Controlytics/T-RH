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
  requestedAt: string;
  requestRemarks: string;
  assigneeUserId: string | null;
  assigneeRole: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
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

export async function listReviews(list: ReviewList, page: number, pageSize: number): Promise<{ data: ReviewSummary[]; total: number }> {
  const qs = new URLSearchParams({ list, page: String(page), pageSize: String(pageSize) });
  return apiClient.get<{ data: ReviewSummary[]; total: number }>(`/api/report-reviews?${qs}`);
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
 * The signature lines the approved PDF prints: each signer's name, user ID and
 * the date-time of their password-verified action. The name IS the user ID
 * here (usernames are the identity this system signs with), so it prints
 * twice on purpose — the label the reader knows and the ID the record keys on.
 */
export function reviewSignatures(
  r: Pick<ReviewSummary, 'requestedByName' | 'requestedAt' | 'decidedByName' | 'decidedAt' | 'status'>,
  formatDateTime: (d: string) => string,
): { label: string; value: string }[] {
  const lines = [{ label: 'Requested By', value: `${r.requestedByName} (${r.requestedByName}) — ${formatDateTime(r.requestedAt)}` }];
  if (r.status === 'APPROVED' && r.decidedByName && r.decidedAt) {
    lines.push({ label: 'Approved By', value: `${r.decidedByName} (${r.decidedByName}) — ${formatDateTime(r.decidedAt)}` });
  }
  return lines;
}

function fileSlug(title: string): string {
  return (title || 'report').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'report';
}

/** The approver's view: the exact document, watermarked, unsigned, in a new tab. Nothing is saved or audited. */
export async function openDraft(id: string, formatDateTime: (d: string) => string): Promise<void> {
  const r = await fetchReview(id);
  const report = await renderSnapshotToPdf(normaliseSnapshot(r.dataSnapshot), { formatDateTime, draft: true });
  window.open(report.doc.output('bloburl') as unknown as string, '_blank');
}

/**
 * The approved copy. Audited BEFORE the file is saved — fail-closed: a file on
 * disk with no record of who took it is an ungoverned export.
 */
export async function downloadApproved(id: string, formatDateTime: (d: string) => string): Promise<void> {
  const r = await fetchReview(id);
  if (r.status !== 'APPROVED') throw new Error('This report is not approved yet.');
  await apiClient.post(`/api/report-reviews/${id}/download-log`, {});
  const report = await renderSnapshotToPdf(normaliseSnapshot(r.dataSnapshot), { formatDateTime, signatures: reviewSignatures(r, formatDateTime) });
  report.save(`${fileSlug(r.title)}-approved.pdf`);
}
