import { apiClient } from './api-client';
import type { ReportKind } from '@digilog/shared';

export interface ReportExportLogInput {
  /** Human report name shown in the audit trail, e.g. "Audit Trail", "Filters". */
  reportType: string;
  /** The configured report type (Configuration → Report Downloads, 2026-10-01).
   *  REQUIRED for a PDF — the server applies that type's mode, remarks and
   *  password rules. Not sent for Excel, which keeps the per-role policy. */
  reportKind?: ReportKind;
  format: 'PDF' | 'Excel';
  recordCount: number;
  period?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  /** Why this report was generated. '' when the report type's remarks are off. */
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
    ...(input.reportKind ? { reportKind: input.reportKind } : {}),
    format: input.format,
    recordCount: input.recordCount,
    period: input.period || undefined,
    search: input.search || undefined,
    startDate: input.startDate || undefined,
    endDate: input.endDate || undefined,
    ...(input.remarks ? { remarks: input.remarks } : {}),
  };
  // The password rides the reauth path the rest of the app uses — plain post
  // when the role's policy doesn't require one.
  if (input.password) {
    await apiClient.postWithReauth('/api/audit/report-export-log', body, input.password);
  } else {
    await apiClient.post('/api/audit/report-export-log', body);
  }
}

// `logReportExportOrWarn` — the fail-OPEN variant for the offline-first tablet —
// was REMOVED (audit 2026-10-03, WEB-9): it had no caller, and every download in
// the product now goes through `lib/report-delivery.ts`, which logs BEFORE it
// saves (fail-closed). A governed download that proceeds when the record could
// not be written is not something this product offers any more.
