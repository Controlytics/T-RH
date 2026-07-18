import { apiClient } from './api-client';
import { renderSnapshotToPdf, type ReportSnapshot } from './pdf-report';

export interface ReviewSummary {
  id: string; reportType: string; title: string; subtitle?: string; status: string;
  generatedByName: string; generatedAt: string;
  reviewedByName?: string | null; reviewedAt?: string | null;
  approvedByName?: string | null; approvedAt?: string | null;
  rejectionStage?: string | null; rejectedByName?: string | null; rejectedAt?: string | null;
  reviewRemarks?: string | null; approvalRemarks?: string | null;
  assigneeUserId?: string | null; assigneeRole?: string | null;
  createdAt: string; stage?: 'REVIEW' | 'APPROVE';
}
export interface ReviewFull extends ReviewSummary { dataSnapshot: ReportSnapshot; }

/**
 * #reports-2: mirror the backend `canViewReportReview` scope so the "Download PDF"
 * button only shows for reports the current user is a party to (the download
 * fetches the full dataSnapshot via GET /api/report-reviews/:id, which the server
 * now 403s for non-parties). Actor fields in the summary are usernames — unique,
 * so equivalent to the server's sub comparison; assigneeUserId is a sub (user.id).
 */
export function canDownloadReview(
  user: { id: string; username: string; role: string } | undefined,
  r: ReviewSummary,
): boolean {
  if (!user) return false;
  if (user.role === 'SUPER_ADMIN') return true;
  if (r.generatedByName && r.generatedByName === user.username) return true;
  if (r.reviewedByName && r.reviewedByName === user.username) return true;
  if (r.approvedByName && r.approvedByName === user.username) return true;
  if (r.rejectedByName && r.rejectedByName === user.username) return true;
  if (r.assigneeUserId && r.assigneeUserId === user.id) return true;
  if (r.assigneeRole && r.assigneeRole === user.role) return true;
  return false;
}

/** Send a generated report (its snapshot) for review, to a user OR a role. */
export async function submitForReview(snapshot: ReportSnapshot, assignee: { userId?: string; role?: string }) {
  return apiClient.post<{ id: string; status: string }>('/api/report-reviews', {
    reportType: snapshot.reportType ?? '',
    title: snapshot.title,
    subtitle: snapshot.subtitle,
    dataSnapshot: snapshot,
    ...(assignee.userId ? { assigneeUserId: assignee.userId } : {}),
    ...(assignee.role && !assignee.userId ? { assigneeRole: assignee.role } : {}),
  });
}

export async function fetchReview(id: string): Promise<ReviewFull> {
  return apiClient.get<ReviewFull>(`/api/report-reviews/${id}`);
}

/** Build the Printed/Reviewed/Approved By lines from a review record. */
export function reviewSignatures(r: { generatedByName: string; reviewedByName?: string | null; approvedByName?: string | null }): { label: string; value: string }[] {
  const lines = [{ label: 'Printed By', value: r.generatedByName }];
  if (r.reviewedByName) lines.push({ label: 'Reviewed By', value: r.reviewedByName });
  if (r.approvedByName) lines.push({ label: 'Approved By', value: r.approvedByName });
  return lines;
}

/** Re-download an approved (or any) report from its snapshot with the signatures. */
export async function downloadReview(id: string, formatDateTime: (d: string) => string) {
  const r = await fetchReview(id);
  const fname = `${(r.title || 'report').replace(/[^\w-]+/g, '_')}.pdf`;
  await renderSnapshotToPdf(r.dataSnapshot, reviewSignatures(r), formatDateTime, fname);
}
