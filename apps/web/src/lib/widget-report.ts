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
  /**
   * A raster of what the widget draws (a chart, the floor plan): the text
   * column wide at its own proportions, scaled down to fit a page. Printed
   * above the table — or, in a report of several profiles, the FIRST
   * section's once, before the first "Profile:" title (it is the widget's,
   * not one profile's).
   */
  imageDataUrl?: string;
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

/**
 * One cell as printed. Absent / blank / not a finite number → `—`.
 *
 * A column's `decimals` apply to a NUMBER only — a raw, unjudged key, the one
 * value the widget hands over unformatted. TEXT is the server's or the
 * widget's own formatting (a measured reading at the instrument's
 * administered precision, a range figure, `Error` / `OL` / `NA`) and prints
 * VERBATIM whatever `decimals` says (review C1, 2026-11-02): re-rounding it
 * could hide an excursion (25.4 → "25") or state a precision never recorded
 * (21.5 → "21.500"). A number with no `decimals` prints as the widget prints a
 * raw key with none (`formatKeyValue` → `String(n)`).
 */
export function formatReportCell(value: WidgetReportValue | undefined, column: ReportTemplateColumn): string {
  if (isBlank(value)) return REPORT_VALUE_MISSING;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return REPORT_VALUE_MISSING;
    return column.decimals !== undefined ? formatDecimals(value, column.decimals) ?? REPORT_VALUE_MISSING : String(value);
  }
  return String(value);
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
 * theirs — and so does an attribute this profile's catalogue does not have
 * (`available`), which the caller names as not available (review m3).
 */
function infoValue(source: string, values: Partial<Record<Placeholder, string>>, rows: WidgetReportRow[], available?: ReadonlySet<string>): string {
  if (source.startsWith('attr:')) {
    if (available && !available.has(source)) return REPORT_VALUE_MISSING;
    const instruments = new Set(rows.map((r) => r['instrument.code']).filter((v) => !isBlank(v)).map(String));
    if (instruments.size !== 1) return REPORT_VALUE_MISSING;
    const v = rows.map((r) => r[source]).find((x) => !isBlank(x));
    return v === undefined || v === null ? REPORT_VALUE_MISSING : String(v);
  }
  return substitutePlaceholders(`{${source}}`, values);
}

/**
 * The info block; returns the LABELS of its rows this profile's catalogue
 * cannot fill (an `attr:` source not in `available`). Placeholders are the
 * report's own values, never the catalogue's. No `available` = nothing is
 * checked (no section: there is no profile to ask).
 */
function printInfoBlock(
  report: ReportDoc, document: ReportTemplateDocument, values: Partial<Record<Placeholder, string>>,
  rows: WidgetReportRow[], available?: ReadonlySet<string>,
): string[] {
  if (!document.infoBlock.length) return [];
  // The value is always given: `addKeyValue` would print a bare "-" for a blank one.
  report.addKeyValue(document.infoBlock.map((r) => [r.label, infoValue(r.source, values, rows, available)] as [string, string]));
  return available
    ? document.infoBlock.filter((r) => r.source.startsWith('attr:') && !available.has(r.source)).map((r) => r.label)
    : [];
}

/**
 * A picture across the text column (14mm gutters) at its own proportions —
 * read from its own bytes — scaled down to fit a page less its top margin and
 * footer zone. An unreadable image throws here exactly as `addImage` would: a
 * caller's bug, not swallowed.
 */
function printImage(report: ReportDoc, dataUrl: string): void {
  const maxW = report.pw - 28;
  const maxH = report.ph - 14 - 24;
  const p = report.doc.getImageProperties(dataUrl);
  const h = (maxW * p.height) / p.width;
  const k = Math.min(1, maxH / h);
  report.addImage(dataUrl, maxW * k, h * k);
}

/** The section's table; returns the records printed and the headings of the shown columns this profile does not have. */
function printTable(
  report: ReportDoc, section: WidgetReportSection, rows: WidgetReportRow[], available: ReadonlySet<string>,
): { records: number; missing: string[] } {
  const shown = section.document.columns.filter((c) => c.show);
  if (!shown.length) return { records: 0, missing: [] };
  const body: TableCell[][] = rows.map((row) => shown.map((c) => (available.has(c.id) ? formatReportCell(row[c.id], c) : '')));
  report.addTable({
    head: shown.map(reportColumnHeading),
    // A heading row over nothing reads as a broken table; say so instead.
    body: body.length ? body : [[{ content: 'No records.', colSpan: shown.length }]],
  });
  return { records: body.length, missing: shown.filter((c) => !available.has(c.id)).map(reportColumnHeading) };
}

/**
 * Build the widget's report: the first section's template titles it and
 * draws the chrome (its footer text's placeholders filled with the title's
 * values, so the FROZEN chrome carries the filled text — review I1). In a
 * report of several profiles the first section's picture prints ONCE, before
 * the sections (review m4). Each section then prints, in order, its
 * "Profile: <name>" title (only when there are several), its info block, a
 * fieldless widget's text, its picture, its table, and ONE "Not available for
 * this profile" line naming every info row and shown column its profile's
 * catalogue does not have (spec §6, review m3). No sections (no instruments in
 * the selection) = the widget type's built-in chrome and a line saying so.
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
  const loaded = await loadReportChrome(first);
  const chrome = loaded.footer.text
    ? { ...loaded, footer: { ...loaded.footer, text: substitutePlaceholders(loaded.footer.text, titleValues) } }
    : loaded;

  const report = await createReport({
    title,
    subtitle,
    formatDateTime: input.formatDateTime,
    reportKey: widgetReportType(widgetType),
    chrome,
    ...(first.page.typography === 'data-report' ? { typography: DATA_REPORT_TYPOGRAPHY } : {}),
  });

  if (!sections.length) {
    printInfoBlock(report, first, input.values, []);
    report.addNote('No instruments in this selection.', 'muted');
    return { report, title, subtitle, recordCount: 0 };
  }

  const fieldless = WIDGET_REPORT_FIELDS[widgetType].length === 0;
  // The widget's picture covers every profile; under "Profile: <first>" it
  // would read as the first profile's alone.
  const sharedImage = sections.length > 1 ? sections[0].imageDataUrl : undefined;
  if (sharedImage) printImage(report, sharedImage);
  let recordCount = 0;
  sections.forEach((s, i) => {
    if (sections.length > 1) report.addSectionTitle(`Profile: ${s.profileName}`);
    const available = new Set(s.availableIds);
    const rows = printedRows(widgetType, s.document, s.rows);
    const missing = printInfoBlock(report, s.document, { ...input.values, profile: s.profileName, ...s.values }, rows, available);
    // Ruling T1-C1: a type with no fields (text card, floor plan) prints what
    // it shows — its text as a paragraph, then its image — and no table.
    if (fieldless && !isBlank(s.rows[0]?.text)) report.addNote(String(s.rows[0].text), 'text');
    if (s.imageDataUrl && !(sharedImage && i === 0)) printImage(report, s.imageDataUrl);
    if (!fieldless) {
      const table = printTable(report, s, rows, available);
      recordCount += table.records;
      missing.push(...table.missing);
    }
    // Spec §6: what this profile cannot fill is NAMED, under the table — never
    // dropped, never invented. One line, each name once.
    const names = [...new Set(missing)];
    if (names.length) report.addNote(`Not available for this profile: ${names.join(', ')}`, 'muted');
  });
  return { report, title, subtitle, recordCount };
}
