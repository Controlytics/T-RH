/**
 * The WIDGET REPORT builder (2026-11-02) — what a dashboard widget's
 * "Download report" prints. Spec:
 * docs/superpowers/specs/2026-11-02-widget-report-templates-design.md §6-§8.
 *
 * ONE report per download; ONE SECTION per instrument profile the widget's
 * instruments belong to (the server resolves which template each profile uses
 * — `GET /api/report-templates/resolve` — this file never decides that). Each
 * section prints with its OWN template's info block and columns; the report's
 * CHROME (header, logo, accent, footer, page, type scale) is the FIRST
 * section's template's, drawn through `createReport({ chrome })`, so the
 * snapshot is v3 and the approved copy replays with no fetch.
 *
 * The browser prints what the widget already received: the caller hands rows
 * of field id → value (`WIDGET_REPORT_FIELDS` ids, `key:<name>`, `attr:<name>`;
 * dates already formatted by the page's datetime hook). Nothing here fetches
 * data or re-derives a server decision.
 *
 * THE ROW GRAIN (`keyRowsCollapse`, shared): for the per-key types (value
 * cards, latest table, gauge, comparison bars, time series) a template that
 * shows NO per-key field prints one row per INSTRUMENT (per instant for the
 * time series) with the keys side by side as `key:<name>` columns. The caller
 * may hand the rows LONG — one per key — each naming its instrument (+ instant)
 * in `REPORT_ROW_GROUP`; this builder then merges them. Rows that name no group
 * are printed exactly as given: they are never merged on a display string (two
 * readings that FORMAT to the same minute are two readings).
 */
import {
  WIDGET_REPORT_FIELDS, keyRowsCollapse, substitutePlaceholders, builtinReportTemplate, widgetReportType,
  formatDecimals, REPORT_VALUE_MISSING,
  type Placeholder, type ReportTemplateColumn, type ReportTemplateDocument, type WidgetType,
} from '@digilog/shared';
import { createReport, loadReportChrome, type ReportDoc, type TableCell } from './pdf-report';
import { DATA_REPORT_TYPOGRAPHY } from '@/routes/instruments/data-report';

export { loadReportChrome, type ReportChrome } from './pdf-report';

export type WidgetReportValue = string | number | null;
/** Field id → value. Field ids are catalogue ids; `REPORT_ROW_GROUP` and `text` are the two non-column keys. */
export type WidgetReportRow = Record<string, WidgetReportValue>;

/**
 * The key on a row that names the INSTRUMENT (plus the instant, for the time
 * series) the row belongs to — any string unique to it, e.g. the instrument
 * id, or `<id>@<ISO instant>`. Rows sharing it are one instrument's keys:
 * merged into one row when the template collapses keys, and their `key:` /
 * `attr:` cells shared between them when it does not. `#` can never start a
 * column id (shared `reportTemplateDocumentSchema`), so it can never print.
 */
export const REPORT_ROW_GROUP = '#group';

export interface WidgetReportSection {
  profileId: string;
  profileName: string;
  /** The template this profile uses — the server's resolution, or the built-in. */
  document: ReportTemplateDocument;
  /**
   * The ids this PROFILE's field catalogue has (`GET /api/report-templates/
   * catalogue`): built-ins, `key:<name>`, `attr:<name>`. A shown column not
   * in it prints empty cells and is named under the table (spec §6, ruling PF-2).
   */
  availableIds: string[];
  /** Field id → value, already formatted by the caller's datetime hook. A fieldless type (text card) passes `{ text }`. */
  rows: WidgetReportRow[];
  /** A raster of what the widget draws (a chart, the floor plan), printed above the table. */
  imageDataUrl?: string;
  /** Its size on the page; scaled down to the text column and the page. Absent = full width at the image's own proportions. */
  imageSize?: { wMm: number; hMm: number };
  /** Values for THIS section's info block (e.g. its own `instrumentCount`), over the report's. `profile` defaults to `profileName`. */
  values?: Partial<Record<Placeholder, string>>;
}

export interface WidgetReportInput {
  widgetType: WidgetType;
  /** Placeholder values for the title, subtitle and info blocks (`{dashboard}`, `{period}` …). */
  values: Partial<Record<Placeholder, string>>;
  /** One per profile, in the order of the widget's instrument list. The first one's template draws the chrome. */
  sections: WidgetReportSection[];
  formatDateTime: (iso: string) => string;
}

export interface WidgetReportResult {
  report: ReportDoc;
  /** As printed (placeholders substituted) — what `deliverReport` records. */
  title: string;
  subtitle?: string;
  /** Table rows PRINTED, all sections (after the row grain); a "No records." line is not a record. */
  recordCount: number;
}

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** A plain decimal number written as text ("21.5", "-3"); "21.5 °C", "1e3", "Error" are not. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * One cell as printed. Absent / blank / not a finite number → `—`. A column's
 * `decimals` apply to a number and to a PLAIN numeric string (the server's
 * display text of a reading); any other text — `Error`, `OL`, `NA`, a value
 * with its unit — prints exactly as given, never coerced.
 */
export function formatReportCell(value: WidgetReportValue | undefined, column: ReportTemplateColumn): string {
  if (isBlank(value)) return REPORT_VALUE_MISSING;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return REPORT_VALUE_MISSING;
    return column.decimals !== undefined ? formatDecimals(value, column.decimals) ?? REPORT_VALUE_MISSING : String(value);
  }
  const text = String(value);
  if (column.decimals !== undefined && PLAIN_NUMBER.test(text.trim())) {
    return formatDecimals(text.trim(), column.decimals) ?? text;
  }
  return text;
}

/** A column's heading as printed: the document's heading, its `unit` beside it when set. */
export function reportColumnHeading(column: ReportTemplateColumn): string {
  const unit = column.unit?.trim();
  return unit ? `${column.heading} (${unit})` : column.heading;
}

function groupOf(row: WidgetReportRow): string | null {
  const g = row[REPORT_ROW_GROUP];
  return typeof g === 'string' || typeof g === 'number' ? String(g) : null;
}

/** Copy each of `row`'s non-blank values into `target` where `target` has none. */
function fillBlanks(target: WidgetReportRow, row: WidgetReportRow, only?: (id: string) => boolean): void {
  for (const [id, v] of Object.entries(row)) {
    if ((only === undefined || only(id)) && isBlank(target[id]) && !isBlank(v)) target[id] = v;
  }
}

const isInstrumentCell = (id: string) => id.startsWith('key:') || id.startsWith('attr:');

/**
 * The rows a section prints, in the grain its template asks for (the shared
 * `keyRowsCollapse`). Only the per-key types have a grain to choose; every
 * other type prints its rows as given. Only rows that name their group
 * (`REPORT_ROW_GROUP`) are merged or shared; the rest pass through in place.
 */
export function printedRows(widgetType: WidgetType, document: ReportTemplateDocument, rows: WidgetReportRow[]): WidgetReportRow[] {
  if (!WIDGET_REPORT_FIELDS[widgetType].some((f) => f.perKey)) return rows;
  if (keyRowsCollapse(widgetType, document)) {
    // One row per group, at its first row's place; its fields are the first
    // non-blank value each field has across the group's rows.
    const out: WidgetReportRow[] = [];
    const byGroup = new Map<string, WidgetReportRow>();
    for (const row of rows) {
      const g = groupOf(row);
      if (g === null) { out.push(row); continue; }
      let merged = byGroup.get(g);
      if (!merged) { merged = {}; byGroup.set(g, merged); out.push(merged); }
      fillBlanks(merged, row);
    }
    return out;
  }
  // Long form: a row per key, and an instrument's `key:` / `attr:` cells are
  // that INSTRUMENT's — the same on each of its rows.
  const shared = new Map<string, WidgetReportRow>();
  for (const row of rows) {
    const g = groupOf(row);
    if (g === null) continue;
    const cells = shared.get(g) ?? {};
    fillBlanks(cells, row, isInstrumentCell);
    shared.set(g, cells);
  }
  return rows.map((row) => {
    const g = groupOf(row);
    if (g === null) return row;
    const filled = { ...row };
    fillBlanks(filled, shared.get(g)!);
    return filled;
  });
}

/**
 * An info row's value. A placeholder name → its value (blank / absent → `—`,
 * through the shared substitution, the ONE rule). `attr:<key>` → the
 * attribute of the section's ONE instrument; a section of several instruments
 * (or none) prints `—` — an attribute of one of them would read as all of
 * theirs.
 */
function infoValue(source: string, values: Partial<Record<Placeholder, string>>, rows: WidgetReportRow[]): string {
  if (source.startsWith('attr:')) {
    const instruments = new Set(rows.map((r) => r['instrument.code']).filter((v) => !isBlank(v)).map(String));
    if (instruments.size !== 1) return REPORT_VALUE_MISSING;
    const v = rows.map((r) => r[source]).find((x) => !isBlank(x));
    return v === undefined || v === null ? REPORT_VALUE_MISSING : String(v);
  }
  return substitutePlaceholders(`{${source}}`, values);
}

function printInfoBlock(report: ReportDoc, document: ReportTemplateDocument, values: Partial<Record<Placeholder, string>>, rows: WidgetReportRow[]): void {
  if (!document.infoBlock.length) return;
  // The value is always given: `addKeyValue` would print a bare "-" for a blank one.
  report.addKeyValue(document.infoBlock.map((r) => [r.label, infoValue(r.source, values, rows)] as [string, string]));
}

/** The text column (14mm gutters) and a page less its top margin and footer zone. */
function printImage(report: ReportDoc, dataUrl: string, size: WidgetReportSection['imageSize']): void {
  const maxW = report.pw - 28;
  const maxH = report.ph - 14 - 24;
  let w: number;
  let h: number;
  if (size && size.wMm > 0 && size.hMm > 0) {
    ({ wMm: w, hMm: h } = size);
  } else {
    // Its own proportions, from its own bytes. An unreadable image throws
    // here exactly as `addImage` would below — a caller's bug, not swallowed.
    const p = report.doc.getImageProperties(dataUrl);
    w = maxW;
    h = (maxW * p.height) / p.width;
  }
  const k = Math.min(1, maxW / w, maxH / h);
  report.addImage(dataUrl, w * k, h * k);
}

/** The section's table; returns the records printed. */
function printTable(report: ReportDoc, section: WidgetReportSection, rows: WidgetReportRow[]): number {
  const shown = section.document.columns.filter((c) => c.show);
  if (!shown.length) return 0;
  const available = new Set(section.availableIds);
  const body: TableCell[][] = rows.map((row) => shown.map((c) => (available.has(c.id) ? formatReportCell(row[c.id], c) : '')));
  report.addTable({
    head: shown.map(reportColumnHeading),
    // A heading row over nothing reads as a broken table; say so instead.
    body: body.length ? body : [[{ content: 'No records.', colSpan: shown.length }]],
  });
  // Spec §6: a column this profile's catalogue does not have is NAMED, under
  // the table, never dropped and never invented.
  const missing = shown.filter((c) => !available.has(c.id));
  if (missing.length) report.addNote(`Not available for this profile: ${missing.map(reportColumnHeading).join(', ')}`, 'muted');
  return body.length;
}

/**
 * Build the widget's report: the first section's template titles it and
 * draws the chrome; each section prints, in order, its "Profile: <name>"
 * title (only when there are several), its info block, a fieldless widget's
 * text, its image, its table and the "not available" line. No sections (no
 * instruments in the selection) = the widget type's built-in chrome and a
 * line saying so.
 */
export async function buildWidgetReport(input: WidgetReportInput): Promise<WidgetReportResult> {
  const { widgetType, sections } = input;
  const first = sections[0]?.document ?? builtinReportTemplate(widgetType);
  const profiles = sections.map((s) => s.profileName).filter((n) => n.trim() !== '');
  const titleValues: Partial<Record<Placeholder, string>> = {
    ...(profiles.length ? { profile: profiles.join(', ') } : {}),
    ...input.values,
  };
  const title = substitutePlaceholders(first.header.title, titleValues);
  const subtitle = first.header.subtitle?.trim() ? substitutePlaceholders(first.header.subtitle, titleValues) : undefined;

  const report = await createReport({
    title,
    subtitle,
    formatDateTime: input.formatDateTime,
    reportKey: widgetReportType(widgetType),
    chrome: await loadReportChrome(first),
    ...(first.page.typography === 'data-report' ? { typography: DATA_REPORT_TYPOGRAPHY } : {}),
  });

  if (!sections.length) {
    printInfoBlock(report, first, input.values, []);
    report.addNote('No instruments in this selection.', 'muted');
    return { report, title, subtitle, recordCount: 0 };
  }

  const fieldless = WIDGET_REPORT_FIELDS[widgetType].length === 0;
  let recordCount = 0;
  for (const s of sections) {
    if (sections.length > 1) report.addSectionTitle(`Profile: ${s.profileName}`);
    const rows = printedRows(widgetType, s.document, s.rows);
    printInfoBlock(report, s.document, { ...input.values, profile: s.profileName, ...s.values }, rows);
    // Ruling T1-C1: a type with no fields (text card, floor plan) prints what
    // it shows — its text as a paragraph, then its image — and no table.
    if (fieldless && !isBlank(s.rows[0]?.text)) report.addNote(String(s.rows[0].text), 'text');
    if (s.imageDataUrl) printImage(report, s.imageDataUrl, s.imageSize);
    if (!fieldless) recordCount += printTable(report, s, rows);
  }
  return { report, title, subtitle, recordCount };
}
