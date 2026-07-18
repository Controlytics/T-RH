/**
 * Registry of every report that renders a PDF via createReport() in pdf-report.ts.
 * The Report Signatories config page lists these; each report's createReport()
 * call passes its `key` so the right Printed/Reviewed/Approved By roles apply.
 * Keys are STABLE identifiers — do not rename without a config migration.
 */
export interface ReportType { key: string; label: string; }

export const REPORT_TYPES: ReportType[] = [
  { key: 'audit-trail', label: 'Audit Trail' },
  { key: 'cleaning-cycle-history', label: 'Cleaning Cycle History' },
  { key: 'cleaning-cycle-detail', label: 'Cleaning Cycle Detail' },
  { key: 'cleaning-lifecycle', label: 'Cleaning Lifecycle Report' },
  { key: 'deviations', label: 'Deviations Report' },
  { key: 'filters', label: 'Filters' },
  { key: 'pm-schedule', label: 'PM Schedule' },
  { key: 'quality-notifications', label: 'Quality Notifications (QNN)' },
  { key: 'replacement-schedule', label: 'Replacement Schedule' },
  { key: 'rfid-track-record', label: 'RFID Track Record' },
];
