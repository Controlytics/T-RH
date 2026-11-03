/**
 * The AUDIT TRAIL export on report templates (2026-11-03, page reports on
 * templates — spec docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md
 * §6 / §8). The PDF prints through the ONE templated builder
 * (`lib/templated-report.ts`); this file turns the exported records into that
 * builder's input: rows keyed by the `page:audit-trail` field ids, the
 * placeholder values, and the report's ONE section (an application-wide kind
 * has no profile).
 *
 * The CELLS are the strings the export printed before templates — the action
 * with its underscores spaced, `-` for a missing user / role / IP, the target
 * type in words, and the description with a redacted record's note FIRST, so
 * the 80-character cut can never remove it: the export is what an inspector
 * actually receives. The Excel export (not templated — spec non-goal) is built
 * from the SAME rows, so the two cannot drift.
 *
 * THE BUILT-IN reads `lib/report-labels.ts` (its title, its headings and — when
 * one is set — its subtitle) and keeps today's column widths; a SAVED template
 * prints exactly its own document at jsPDF's widths.
 *
 * Types only from `lib/templated-report` (it carries jsPDF; the page calls it).
 */
import {
  REPORT_TEMPLATE_FIELDS, builtinReportTemplate, coerceReportTemplateDocument,
  type Placeholder, type ReportTemplateDocument, type ReportTemplateRow,
} from '@digilog/shared';
import type { ReportRow, TemplatedColumnStyles, TemplatedReportInput, TemplatedSection } from '@/lib/templated-report';
import type { ResolvedReportLabels } from '@/lib/report-labels';
import { friendlyTargetType, getAuditSummary, isRedacted, redactionNote } from './audit-helpers';

const KIND = 'page:audit-trail';

/** The seven columns: the kind's built-in field ids, in order, each with its `report-labels` key. */
export const AUDIT_REPORT_COLUMNS: readonly { id: string; labelKey: string }[] = [
  { id: 'audit.timestamp', labelKey: 'timestamp' },
  { id: 'audit.action', labelKey: 'action' },
  { id: 'audit.user', labelKey: 'user' },
  { id: 'audit.role', labelKey: 'role' },
  { id: 'audit.targetType', labelKey: 'targetType' },
  { id: 'audit.description', labelKey: 'description' },
  { id: 'audit.ip', labelKey: 'ipAddress' },
];

/** How much of a description the export prints. */
export const AUDIT_DESCRIPTION_MAX = 80;

/** The built-in's pinned widths: the timestamp and the description (landscape A4). */
export const AUDIT_BUILTIN_COLUMN_STYLES: TemplatedColumnStyles = { 0: { cellWidth: 35 }, 5: { cellWidth: 65 } };

/**
 * A record's description as exported: its summary from the administered audit
 * templates, a redacted record's note LEADING it so it survives the cut.
 */
export function auditExportDescription(record: any, templates: Record<string, string>): string {
  const summary = getAuditSummary(record, templates);
  const text = isRedacted(record) ? `${redactionNote(record)} ${summary}`.trim() : summary;
  return text.substring(0, AUDIT_DESCRIPTION_MAX);
}

/** One row per record, keyed by the seven `page:audit-trail` ids — today's strings. */
export function rowsForAuditTrail(
  records: readonly any[],
  fmt: { formatDateTime: (iso: string) => string },
  templates: Record<string, string>,
): ReportRow[] {
  return records.map((r) => ({
    'audit.timestamp': fmt.formatDateTime(r.timestamp),
    'audit.action': r.action?.replace(/_/g, ' ') ?? '-',
    'audit.user': r.userId ?? '-',
    'audit.role': r.userRole ?? '-',
    'audit.targetType': friendlyTargetType(r),
    'audit.description': auditExportDescription(r, templates),
    'audit.ip': r.ipAddress ?? '-',
  }));
}

/** The Excel export's cells: the same rows, in column order. */
export function auditExcelRows(rows: readonly ReportRow[]): string[][] {
  return rows.map((row) => AUDIT_REPORT_COLUMNS.map((c) => String(row[c.id] ?? '')));
}

/**
 * What the Audit Trail's placeholders print: the period as the page states it
 * ("All Time", or "<from> to <to>"), the search quoted as the subtitle always
 * quoted it (none = no value, so it prints `—`, ruling P-2), the records
 * printed, and each end of the period when one is set.
 */
export function auditPlaceholderValues(opts: {
  period: string;
  search: string;
  recordCount: number;
  from?: string;
  to?: string;
}): Partial<Record<Placeholder, string>> {
  return {
    period: opts.period,
    ...(opts.search ? { search: `"${opts.search}"` } : {}),
    recordCount: String(opts.recordCount),
    ...(opts.from ? { from: opts.from } : {}),
    ...(opts.to ? { to: opts.to } : {}),
  };
}

/**
 * The built-in document, as `report-labels` words it: its title, each column's
 * heading, and its subtitle when one is set (blank = the built-in's own line).
 * With the shipped labels it IS `builtinReportTemplate('page:audit-trail')`.
 */
export function auditBuiltinDocument(labels: ResolvedReportLabels): ReportTemplateDocument {
  const doc = builtinReportTemplate(KIND);
  const labelKey = new Map(AUDIT_REPORT_COLUMNS.map((c) => [c.id, c.labelKey]));
  return {
    ...doc,
    header: {
      ...doc.header,
      title: labels.title.trim() || doc.header.title,
      ...(labels.subtitle.trim() ? { subtitle: labels.subtitle } : {}),
    },
    columns: doc.columns.map((c) => ({ ...c, heading: labels.columns[labelKey.get(c.id) ?? '']?.trim() || c.heading })),
  };
}

/**
 * The builder's input for one Audit Trail PDF — what the page prints.
 *
 * `template`: the one the plan resolved or the operator picked
 * (`chooseTemplate`), or null = the built-in. A stored document that does not
 * parse prints the built-in document WHOLE (`coerceReportTemplateDocument`).
 * `printedAt` (an ISO instant) and `user` (the signed-in USERNAME, the
 * identity "Printed By" prints) fill `{date}` and `{user}`.
 */
export function auditReportInput(opts: {
  template: ReportTemplateRow | null;
  records: readonly any[];
  fmt: { formatDateTime: (iso: string) => string };
  templates: Record<string, string>;
  labels: ResolvedReportLabels;
  period: string;
  search: string;
  from?: string;
  to?: string;
  printedAt: string;
  user: string;
}): TemplatedReportInput {
  const { template, fmt } = opts;
  const common = {
    profileId: null,
    profileName: null,
    availableIds: REPORT_TEMPLATE_FIELDS(KIND).map((f) => f.id),
    rows: rowsForAuditTrail(opts.records, fmt, opts.templates),
  };
  const section: TemplatedSection = template
    ? { ...common, document: coerceReportTemplateDocument(template.document, KIND) }
    : { ...common, document: auditBuiltinDocument(opts.labels), columnStyles: { ...AUDIT_BUILTIN_COLUMN_STYLES } };
  return {
    kind: KIND,
    reportKey: 'audit-trail',
    values: {
      ...auditPlaceholderValues({ period: opts.period, search: opts.search, recordCount: opts.records.length, from: opts.from, to: opts.to }),
      date: fmt.formatDateTime(opts.printedAt),
      user: opts.user,
    },
    sections: [section],
    formatDateTime: fmt.formatDateTime,
  };
}
