/**
 * How each REPORT TYPE downloads — administered by SUPER_ADMIN under
 * Configuration → Report Downloads (2026-10-01).
 *
 * Operator: "provide one configuration for which one we need report request and
 * normal time period selection download option … if normal option was selected
 * then … directly pdf should download, if user select request in configuration
 * then user can able to request and after approval report should be download,
 * and request or direct download configuration should be come for all report
 * types", then "for which report type remarks should be there or not", then
 * "password reauthentication should be required or not also should be
 * selectable".
 *
 * Three switches per type:
 *   mode              DIRECT  — the dialog saves the PDF at once (audited first)
 *                     REQUEST — the report goes for approval (the review workflow)
 *   remarksRequired   whether the dialog asks for, and the server demands, a reason
 *   passwordRequired  whether the act is signed with the password (re-auth)
 *
 * **Keyed on a stable REPORT KIND, never on the audit `reportType` string.** The
 * same string is emitted by two surfaces ('Instrument Time Series' — the Data
 * Report page and the trend page's Time Series), and the trend chart's type
 * carries its slot ('Instrument Trend — Temperature'). A setting keyed on those
 * would be ambiguous or fragile; the kind is what the browser names explicitly
 * and the server validates.
 *
 * **Absent, malformed or unknown reads as TODAY's behaviour — REQUEST, remarks
 * and password required.** Fail closed: a corrupted row must not quietly turn
 * every report into an unreviewed, unsigned download.
 *
 * `coerceReportDownloads` is the ONE reader: the server's two download routes,
 * the narrow-slice route and the browser's dialog all go through it.
 */
export const REPORT_DOWNLOADS_CONFIG_KEY = 'report-downloads';

export const REPORT_KINDS = [
  { key: 'data-report', settingPrefix: 'dataReport', label: 'Data Report', hint: 'The Data Report page and the trend page\'s Time Series / header download.' },
  { key: 'trend-chart', settingPrefix: 'trendChart', label: 'Trend Chart', hint: 'The trend page\'s Temperature and Humidity chart downloads.' },
  { key: 'instrument-alarms', settingPrefix: 'instrumentAlarms', label: 'Instrument Alarms', hint: 'The trend page\'s alarms widget download.' },
  { key: 'alarms', settingPrefix: 'alarms', label: 'Alarm Report', hint: 'The Alarms page download.' },
  { key: 'audit-trail', settingPrefix: 'auditTrail', label: 'Audit Trail (PDF)', hint: 'The Audit Trail PDF export. The Excel export is not a PDF and always downloads directly.' },
] as const;

export type ReportKind = (typeof REPORT_KINDS)[number]['key'];
export type ReportDownloadMode = 'DIRECT' | 'REQUEST';

export interface ReportKindPolicy {
  mode: ReportDownloadMode;
  remarksRequired: boolean;
  passwordRequired: boolean;
}

export type ReportDownloadsPolicy = Record<ReportKind, ReportKindPolicy>;

/** Today's behaviour, and what anything unreadable falls back to. */
export const REPORT_KIND_POLICY_DEFAULT: ReportKindPolicy = Object.freeze({
  mode: 'REQUEST',
  remarksRequired: true,
  passwordRequired: true,
}) as ReportKindPolicy;

export function isReportKind(v: unknown): v is ReportKind {
  return typeof v === 'string' && REPORT_KINDS.some((k) => k.key === v);
}

/** The three setting keys a kind is stored under on the flat config row. */
export function reportKindSettingKeys(kind: ReportKind): { mode: string; remarks: string; password: string } {
  const prefix = REPORT_KINDS.find((k) => k.key === kind)!.settingPrefix;
  return { mode: `${prefix}Mode`, remarks: `${prefix}Remarks`, password: `${prefix}Password` };
}

/**
 * The stored row → a policy for every kind. Each switch fails closed on its
 * own: only the exact string `'DIRECT'` turns review off, and only the boolean
 * `false` turns remarks or the password off.
 */
export function coerceReportDownloads(value: unknown): ReportDownloadsPolicy {
  const o = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const out = {} as ReportDownloadsPolicy;
  for (const { key } of REPORT_KINDS) {
    const k = reportKindSettingKeys(key);
    out[key] = {
      mode: o[k.mode] === 'DIRECT' ? 'DIRECT' : 'REQUEST',
      remarksRequired: o[k.remarks] !== false,
      passwordRequired: o[k.password] !== false,
    };
  }
  return out;
}

export function reportKindLabel(kind: ReportKind): string {
  return REPORT_KINDS.find((k) => k.key === kind)!.label;
}

/**
 * The NARROW ROUTE's response (`GET /api/config/report-downloads/current`) →
 * a policy. That route returns the ALREADY-coerced, per-kind shape
 * `{ [kind]: { mode, remarksRequired, passwordRequired } }` — NOT the stored
 * flat row `coerceReportDownloads` reads. Reading one shape with the other's
 * reader fails closed to Request for every kind, silently: the Direct option
 * could never reach a dialog. Same fail-closed rules, per field.
 */
export function coerceReportDownloadsResponse(value: unknown): ReportDownloadsPolicy {
  const o = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const out = {} as ReportDownloadsPolicy;
  for (const { key } of REPORT_KINDS) {
    const p = o[key] && typeof o[key] === 'object' ? (o[key] as Record<string, unknown>) : {};
    out[key] = {
      mode: p.mode === 'DIRECT' ? 'DIRECT' : 'REQUEST',
      remarksRequired: p.remarksRequired !== false,
      passwordRequired: p.passwordRequired !== false,
    };
  }
  return out;
}
