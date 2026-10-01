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

/**
 * The report types, one per download POINT the operator can tell apart
 * (2026-10-01, second cut — operator: "give both trend options seperately and
 * … one seperate data report seperately"; the trend page header got its own
 * row by their answer). `inheritsFrom` names the setting a type was SPLIT OUT
 * of: while a type's own keys are absent from the stored row, it reads that
 * one's values, so splitting changed nothing on the day it shipped ("copy
 * values ok"). The first save of the Report Settings page writes every type's
 * own keys and the inheritance stops mattering.
 */
export const REPORT_KINDS = [
  { key: 'data-report', reportType: 'Instrument Time Series', settingPrefix: 'dataReport', inheritsFrom: null, label: 'Data Report', hint: 'The Data Report page in the sidebar.' },
  { key: 'time-series', reportType: 'Instrument Time Series', settingPrefix: 'timeSeries', inheritsFrom: 'dataReport', label: 'Time Series', hint: 'The Time Series card on an instrument\'s trend page.' },
  { key: 'trend-header', reportType: 'Instrument Time Series', settingPrefix: 'trendHeader', inheritsFrom: 'dataReport', label: 'Trend Page Report', hint: 'Export as PDF in the trend page header (that instrument\'s Data Report).' },
  { key: 'temperature-trend', reportType: 'Instrument Trend — Temperature', settingPrefix: 'temperatureTrend', inheritsFrom: 'trendChart', label: 'Temperature Trend', hint: 'The Temperature chart download on the trend page.' },
  { key: 'humidity-trend', reportType: 'Instrument Trend — Humidity', settingPrefix: 'humidityTrend', inheritsFrom: 'trendChart', label: 'Humidity Trend', hint: 'The Humidity chart download on the trend page.' },
  { key: 'instrument-alarms', reportType: 'Instrument Alarms', settingPrefix: 'instrumentAlarms', inheritsFrom: null, label: 'Instrument Alarms', hint: 'The alarms widget download on the trend page.' },
  { key: 'alarms', reportType: 'Alarms', settingPrefix: 'alarms', inheritsFrom: null, label: 'Alarm Report', hint: 'The Alarms page download.' },
  { key: 'audit-trail', reportType: 'Audit Trail', settingPrefix: 'auditTrail', inheritsFrom: null, label: 'Audit Trail (PDF)', hint: 'The Audit Trail PDF export. The Excel export is not a PDF and always downloads directly.' },
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
  for (const { key, inheritsFrom } of REPORT_KINDS) {
    const k = reportKindSettingKeys(key);
    // A type's OWN key wins; absent, the setting it was split out of.
    const read = (own: string, suffix: string) =>
      o[own] !== undefined ? o[own] : inheritsFrom ? o[`${inheritsFrom}${suffix}`] : undefined;
    out[key] = {
      mode: read(k.mode, 'Mode') === 'DIRECT' ? 'DIRECT' : 'REQUEST',
      remarksRequired: read(k.remarks, 'Remarks') !== false,
      passwordRequired: read(k.password, 'Password') !== false,
    };
  }
  return out;
}

/** The stored row for a policy — every type's OWN keys (what the Report
 *  Settings page saves; the legacy `trendChart*` keys are not written). */
export function reportDownloadsRow(policy: ReportDownloadsPolicy): Record<string, string | boolean> {
  const row: Record<string, string | boolean> = {};
  for (const { key } of REPORT_KINDS) {
    const k = reportKindSettingKeys(key);
    row[k.mode] = policy[key].mode;
    row[k.remarks] = policy[key].remarksRequired;
    row[k.password] = policy[key].passwordRequired;
  }
  return row;
}

/**
 * Does a request's audit `reportType` belong to the kind it claims? (2026-10-01,
 * code review.) The kind decides the policy and the type names the record; a
 * client naming a Direct kind for a reviewed report would otherwise write a
 * download record for a report the configuration says must be reviewed.
 */
export function reportTypeMatchesKind(kind: ReportKind, reportType: string): boolean {
  return REPORT_KINDS.find((k) => k.key === kind)!.reportType === reportType;
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
