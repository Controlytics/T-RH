/**
 * Report label registry — the single source of truth for every configurable
 * report title, subtitle, and table column header. Consumed by each report
 * page (on-screen table + PDF) via useReportLabels().
 *
 * The admin config (systemConfig key 'report-labels') stores only OVERRIDES;
 * resolveReportLabels() merges them over these defaults, so a blank config means
 * "use the built-in labels". Logo + company name are NOT here — they remain in
 * the Branding config and already render on every PDF + report header.
 */

export interface ReportColumnDef {
  /** Stable key the report code references (never changes). */
  key: string;
  /** Built-in label, used when the admin hasn't overridden it. */
  default: string;
}

export interface ReportDef {
  /** Stable report key (config + useReportLabels lookups). */
  key: string;
  /** Human name shown in the config editor. */
  name: string;
  /** Built-in report title / heading. */
  defaultTitle: string;
  /** Ordered configurable columns. */
  columns: ReportColumnDef[];
}

/** Per-report override the admin can set; all fields optional. */
export interface ReportLabelOverride {
  title?: string;
  /** Optional static subtitle. Blank ⇒ the report keeps its auto subtitle
   *  (period / totals). */
  subtitle?: string;
  columns?: Record<string, string>;
}
export type ReportLabelsConfig = Record<string, ReportLabelOverride>;

/** Resolved labels handed to a report. */
export interface ResolvedReportLabels {
  title: string;
  /** '' ⇒ caller should fall back to its auto-generated subtitle. */
  subtitle: string;
  /** colKey → label (override ?? default). */
  columns: Record<string, string>;
  /** Ordered label list for a quick PDF `head` array. */
  orderedLabels: (keys?: string[]) => string[];
}

export const REPORT_DEFS: ReportDef[] = [
  {
    key: 'audit-trail',
    name: 'Audit Trail',
    defaultTitle: 'Audit Trail',
    columns: [
      { key: 'timestamp', default: 'Timestamp' },
      { key: 'action', default: 'Action' },
      { key: 'user', default: 'User' },
      { key: 'role', default: 'Role' },
      { key: 'targetType', default: 'Target Type' },
      { key: 'description', default: 'Description' },
      { key: 'ipAddress', default: 'IP Address' },
    ],
  },
];

const DEF_BY_KEY = new Map(REPORT_DEFS.map((d) => [d.key, d]));

/** Merge an admin override over the built-in defaults for one report. */
export function resolveReportLabels(
  reportKey: string,
  config: ReportLabelsConfig | undefined,
): ResolvedReportLabels {
  const def = DEF_BY_KEY.get(reportKey);
  const override = config?.[reportKey] ?? {};
  const columns: Record<string, string> = {};
  for (const c of def?.columns ?? []) {
    columns[c.key] = override.columns?.[c.key]?.trim() || c.default;
  }
  return {
    title: override.title?.trim() || def?.defaultTitle || reportKey,
    subtitle: override.subtitle?.trim() || '',
    columns,
    orderedLabels: (keys?: string[]) => {
      const order = keys ?? (def?.columns ?? []).map((c) => c.key);
      return order.map((k) => columns[k] ?? k);
    },
  };
}
