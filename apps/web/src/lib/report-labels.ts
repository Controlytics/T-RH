/**
 * Report label registry — the single source of truth for every configurable
 * report title, subtitle, and table column header. Consumed by BOTH:
 *   - the /config/report-labels admin page (renders an editor per report), and
 *   - each report page (on-screen table + PDF) via useReportLabels().
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
  {
    key: 'cleaning-cycles',
    name: 'Cleaning Cycles',
    defaultTitle: 'Cleaning Cycles',
    columns: [
      { key: 'sNo', default: 'S.No' },
      { key: 'filter', default: 'Filter' },
      { key: 'size', default: 'Filter Dimensions' },
      { key: 'airPressure', default: 'Air Pressure' },
      { key: 'roWater', default: 'RO Water' },
      { key: 'washIn', default: 'Wash In' },
      { key: 'washOut', default: 'Wash Out' },
      { key: 'washBy', default: 'Wash By' },
      // 'duration' now = the dryer duration the operator selected at DRY_IN
      // (cycle.dryerDurationMinutes), NOT the full cycle duration. Header text
      // is unchanged ("Duration") so admin overrides on this key still apply.
      { key: 'duration', default: 'Duration' },
      // 'dryIn' time now = when the operator submitted the dryer-duration
      // record (cycle.dryerStartedAt), not the temperature-submission time.
      { key: 'dryIn', default: 'Dry In' },
      { key: 'dryerTemp', default: 'Dryer Temp' },
      { key: 'dryOut', default: 'Dry Out' },
      { key: 'status', default: 'Status' },
    ],
  },
  {
    key: 'manual-status-updates',
    name: 'Manual Status Updates',
    defaultTitle: 'Manual Status Updates',
    columns: [
      { key: 'sNo', default: 'S.No' },
      { key: 'filter', default: 'Filter' },
      { key: 'statusChange', default: 'Status Change' },
      { key: 'dateTime', default: 'Date & Time' },
      { key: 'updatedBy', default: 'Updated By' },
      { key: 'remarks', default: 'Remarks' },
    ],
  },
  {
    key: 'filter-traceability',
    name: 'Filter Traceability',
    defaultTitle: 'Filter Traceability',
    columns: [
      { key: 'code', default: 'Code' },
      { key: 'reason', default: 'Reason' },
      { key: 'status', default: 'Status' },
      { key: 'started', default: 'Started' },
      { key: 'completed', default: 'Completed' },
      { key: 'seq', default: '#' },
    ],
  },
  {
    key: 'rfid-track-record',
    name: 'RFID Track Record',
    defaultTitle: 'RFID Track Record',
    columns: [
      { key: 'sNo', default: 'S.No' },
      { key: 'dateTime', default: 'Date / Time' },
      { key: 'event', default: 'Event' },
      { key: 'rfid', default: 'RFID Number' },
      { key: 'filter', default: 'Filter' },
      { key: 'ahu', default: 'AHU' },
      { key: 'user', default: 'User' },
      { key: 'reason', default: 'Reason' },
    ],
  },
  {
    key: 'replacement-list',
    name: 'Replacement List',
    defaultTitle: 'Filter Replacement List',
    columns: [
      { key: 'sNo', default: 'S.No' },
      { key: 'oldFilter', default: 'Old Filter ID' },
      { key: 'newFilter', default: 'New Filter ID' },
      { key: 'replacedOn', default: 'Replaced On' },
      { key: 'performedBy', default: 'Performed By' },
      { key: 'remarks', default: 'Remarks' },
    ],
  },
  {
    key: 'retirement-list',
    name: 'Retirement List',
    defaultTitle: 'Filter Retirement List',
    columns: [
      { key: 'sNo', default: 'S.No' },
      { key: 'filter', default: 'Filter' },
      { key: 'set', default: 'Set' },
      { key: 'retiredOn', default: 'Retired On' },
      { key: 'retiredBy', default: 'Retired By' },
      { key: 'remarks', default: 'Remarks' },
    ],
  },
  {
    key: 'quality-notifications',
    name: 'Quality Notifications (QNN)',
    defaultTitle: 'Quality Notifications',
    columns: [
      { key: 'sNo', default: 'S.No' },
      { key: 'qnn', default: 'QNN' },
      { key: 'action', default: 'Action' },
      { key: 'ahu', default: 'AHU' },
      { key: 'message', default: 'Message' },
      { key: 'by', default: 'By' },
      { key: 'dateTime', default: 'Date / Time' },
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
