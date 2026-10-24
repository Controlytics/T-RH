import type { ReportKind } from '@digilog/shared';
import type { ReportDoc } from './pdf-report';
import type { ReportDownloadRequest } from '@/components/report-download-dialog';
import { logReportExport } from './report-export-log';
import { submitReportForReview, fileSlug, type RequestMeta } from './report-review';

/**
 * The ONE place a built report leaves the page (2026-10-01), whichever way its
 * report type is configured:
 *
 *   DIRECT  — audit the download FIRST (`REPORT_GENERATED`, with the type, the
 *             remarks and the password when required), then save the file.
 *             Fail-closed: if the audit write throws, nothing is saved.
 *   REQUEST — post the frozen snapshot for approval, with the instruments it
 *             is about; nothing is saved here.
 *
 * Every report page calls this rather than branching itself, so five pages
 * cannot handle the two modes five ways.
 */
export async function deliverReport(input: {
  kind: ReportKind;
  req: ReportDownloadRequest;
  report: ReportDoc;
  reportType: string;
  title: string;
  subtitle?: string;
  requestMeta: RequestMeta;
  /** The instruments the report is about — empty only for the Audit Trail. */
  instrumentIds: string[];
}): Promise<DeliveryOutcome> {
  const { req, requestMeta } = input;
  if (req.mode === 'DIRECT') {
    await logReportExport({
      reportType: input.reportType,
      reportKind: input.kind,
      format: 'PDF',
      recordCount: requestMeta.recordCount ?? 0,
      period: requestMeta.period?.label,
      search: requestMeta.search,
      startDate: requestMeta.period?.from,
      endDate: requestMeta.period?.to,
      remarks: req.remarks,
      password: req.password,
    });
    input.report.save(`${fileSlug(input.title)}.pdf`);
    return 'DOWNLOADED';
  }
  const created = await submitReportForReview({
    reportKind: input.kind,
    snapshot: input.report.getSnapshot(),
    reportType: input.reportType,
    title: input.title,
    subtitle: input.subtitle,
    requestMeta,
    instrumentIds: input.instrumentIds,
    remarks: req.remarks,
    password: req.password,
  });
  // Nobody was notified: only a SUPER_ADMIN's request can get here with no
  // approver able to decide it (anyone else is refused by the server), and
  // "the approvers have been notified" would be false (2026-10-24).
  return created.eligibleApproverCount === 0 ? 'REQUESTED_NO_APPROVER' : 'REQUESTED';
}

export type DeliveryOutcome = 'DOWNLOADED' | 'REQUESTED' | 'REQUESTED_NO_APPROVER';

/** The toast after a delivery — one wording, and one tone, for every page. */
export function deliveryToast(outcome: DeliveryOutcome): { tone: 'success' | 'warning'; title: string; message: string } {
  if (outcome === 'DOWNLOADED') return { tone: 'success', title: 'Report downloaded', message: 'The download is recorded in the audit trail.' };
  if (outcome === 'REQUESTED') return { tone: 'success', title: 'Sent for approval', message: 'The approvers have been notified — see Reports.' };
  return {
    tone: 'warning',
    title: 'Sent, but nobody else can approve it',
    message: 'No configured approver can approve this report, so nobody was notified — only a super admin can decide it in Reports. Check Configuration → Report Settings.',
  };
}
