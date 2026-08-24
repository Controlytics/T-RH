import { apiClient } from './api-client';

export interface ReportExportLogInput {
  /** Human report name shown in the audit trail, e.g. "Audit Trail", "Filters". */
  reportType: string;
  format: 'PDF' | 'Excel';
  recordCount: number;
  period?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  /** Why this report was generated. Required — a §11 record states its reason. */
  remarks: string;
  /** Carries the operator's re-authentication signature, when the role's policy requires one. */
  password?: string;
}

/**
 * Record a report download/generation in the audit trail (REPORT_GENERATED).
 * Also carries the operator's reason (`remarks`) and their signature
 * (`password`, when the DOWNLOAD_REPORT reauth policy requires it).
 *
 * Throws if the log write fails — callers await this BEFORE saving the file and
 * cancel the download on error (fail-closed, 21 CFR §11): every report download
 * must leave an audit record of who generated what.
 */
export async function logReportExport(input: ReportExportLogInput): Promise<void> {
  const body = {
    reportType: input.reportType,
    format: input.format,
    recordCount: input.recordCount,
    period: input.period || undefined,
    search: input.search || undefined,
    startDate: input.startDate || undefined,
    endDate: input.endDate || undefined,
    remarks: input.remarks,
  };
  // The password rides the reauth path the rest of the app uses — plain post
  // when the role's policy doesn't require one.
  if (input.password) {
    await apiClient.postWithReauth('/api/audit/report-export-log', body, input.password);
  } else {
    await apiClient.post('/api/audit/report-export-log', body);
  }
}

/**
 * Fail-OPEN variant for operational reports on the offline-first tablet: record
 * the export, but if logging can't reach the server (e.g. offline), warn and
 * STILL allow the download — these reports export from already-loaded data and
 * must not be blocked by connectivity. (The Audit Trail export uses the strict
 * `logReportExport` — fail-closed — because it already needs the server anyway.)
 */
export async function logReportExportOrWarn(
  input: ReportExportLogInput,
  warn: (title: string, message: string) => void,
): Promise<void> {
  try {
    await logReportExport(input);
  } catch (e: any) {
    warn(
      'Not recorded in audit trail',
      `This download couldn't be recorded in the audit trail (${e?.message ?? 'offline?'}), but the file was still generated.`,
    );
  }
}
