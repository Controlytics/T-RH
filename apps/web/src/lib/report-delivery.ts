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
}): Promise<'DOWNLOADED' | 'REQUESTED'> {
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
  await submitReportForReview({
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
  return 'REQUESTED';
}

/** The toast after a delivery — one wording for every page. */
export function deliveryToast(outcome: 'DOWNLOADED' | 'REQUESTED'): [string, string] {
  return outcome === 'DOWNLOADED'
    ? ['Report downloaded', 'The download is recorded in the audit trail.']
    : ['Sent for approval', 'The approvers have been notified — see Reports.'];
}
