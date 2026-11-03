/**
 * The TEMPLATED REPORT builder (2026-11-03, page reports on templates) — what
 * every templated PDF prints: a dashboard widget's "Download report"
 * (`widget-report.ts` is its thin entry) and the five page reports (Data
 * Report, Instrument Trend, Instrument Alarms, Alarm Report, Audit Trail).
 * Spec docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md
 * §9, grown out of the widget builder of
 * docs/superpowers/specs/2026-11-02-widget-report-templates-design.md §6-§8.
 *
 * ONE report per download, ONE SECTION per instrument profile (a widget), per
 * instrument (a Data Report), or one for the whole report (an application-wide
 * kind). Each section prints with its OWN template's info block and columns;
 * the report's CHROME (header, logo, accent, footer, page, type scale) is the
 * FIRST section's template's, drawn through `createReport({ chrome })`, and
 * frozen in the snapshot (v3), so the approved copy replays with no fetch.
 * Which template a section uses is the SERVER's answer (`GET
 * /api/report-templates/resolve`); this file never decides it.
 *
 * The browser prints what the page or widget already received: the caller
 * hands rows of field id → value (`REPORT_TEMPLATE_FIELDS(kind)` ids,
 * `key:<name>`, `attr:<name>`; dates already formatted by the page's datetime
 * hook). Nothing here fetches data or re-derives a server decision.
 *
 * THE ROW GRAIN (`keyRowsCollapse`, shared): for the per-key widget types
 * (value cards, latest table, gauge, comparison bars, time series) a template
 * that shows NO per-key field prints one row per INSTRUMENT (per instant for
 * the time series) with the keys side by side as `key:<name>` columns. The
 * caller may hand the rows LONG — one per key — each naming its instrument
 * (+ instant) in `REPORT_ROW_GROUP`; this builder then merges them. Rows that
 * name no group are printed exactly as given: they are never merged on a
 * display string (two readings that FORMAT to the same minute are two
 * readings). Every page kind prints its rows as given.
 */
import {
  REPORT_TEMPLATE_FIELDS, REPORT_VALUE_MISSING, builtinReportTemplate, formatDecimals, isPageTemplateKind,
  keyRowsCollapse, substitutePlaceholders,
  type Placeholder, type ReportTemplateColumn, type ReportTemplateDocument, type TemplateKind,
} from '@digilog/shared';
import {
  createReport, loadReportChrome,
  type NoteColor, type ReportConfig, type ReportDoc, type TableCell,
} from './pdf-report';
import { DATA_REPORT_TYPOGRAPHY } from './report-typography';
import { scopeColumnStyles, scopeTableRows } from './report-header-block';

/** A cell as the caller hands it: text (the page's or widget's own formatting), the one raw number, or nothing. */
export type ReportRowValue = string | number | null;
/** Field id → value. Field ids are catalogue ids; `REPORT_ROW_GROUP` and `text` are the two non-column keys. */
export type ReportRow = Record<string, ReportRowValue>;

/**
 * The key on a row that names the INSTRUMENT (plus the instant, for the time
 * series) the row belongs to — any string unique to it, e.g. the instrument
 * id, or `<id>@<ISO instant>`. Rows sharing it are one instrument's keys:
 * merged into one row when the template collapses keys, and their `key:` /
 * `attr:` cells shared between them when it does not. `#` can never start a
 * column id (shared `reportTemplateDocumentSchema`), so it can never print.
 */
export const REPORT_ROW_GROUP = '#group';

/**
 * A line of text in a section. `before` = above the pictures and the table (a
 * cap notice, an "averaged" disclosure); otherwise under the table.
 * `style: 'note'` (the default) is a wrapped paragraph in `color` (default
 * `'text'`); `style: 'title'` is a section pill (`addSectionTitle`, `color`
 * ignored) — a `before` title with no picture after it rides on the records
 * table as that table's title, exactly as the page reports' 2,000-row cap
 * notice always printed (`addCapNotice`, ruling T3-B).
 */
export interface TemplatedNote { text: string; color?: NoteColor; before?: boolean; style?: 'note' | 'title' }

/**
 * A picture (a chart, the floor plan) across the text column at its own
 * proportions; `title` is printed above it. No `dataUrl` = the picture could
 * not be made: the title, then `missingText` as a muted note in its place (a
 * gap must say why — today's trend chart fallback, ruling T3-B).
 */
export interface TemplatedImage { dataUrl?: string; title?: string; missingText?: string }

/** What a picture with no bytes says, when its caller gives no reason. */
const IMAGE_MISSING_TEXT = 'No chart image';

/** Column widths / alignment by SHOWN column index, as autotable takes them. */
export type TemplatedColumnStyles = Record<number, { cellWidth?: number | 'wrap'; halign?: 'center' }>;

export interface TemplatedSection {
  /** Printed first, as a section pill (a widget's "Profile: <name>" when there are several). */
  title?: string;
  /** The section's profile, or null for an application-wide kind's one section. */
  profileId: string | null;
  profileName: string | null;
  /** The template this section uses — the server's resolution, a pick, or the built-in. */
  document: ReportTemplateDocument;
  /**
   * The ids this section can fill: the profile's field catalogue (`GET
   * /api/report-templates/catalogue`) — built-ins, `key:<name>`, `attr:<name>`
   * — or an application kind's built-in ids. A shown column not in it prints
   * empty cells, and it and an info row it cannot fill are NAMED in one line
   * under the table (spec §6, ruling PF-2).
   */
  availableIds: string[];
  /** Field id → value, already formatted by the caller. A fieldless widget (text card) passes `{ text }`. */
  rows: ReportRow[];
  /**
   * `bold[row][i]` — the cell of input row `row` under the kind's i-th BUILT-IN
   * field (`REPORT_TEMPLATE_FIELDS(kind)[i]`, the order the page's own table
   * had: a breach, a fault word). Printed bold under WHICHEVER column shows
   * that field, in the template's order; a `key:` / `attr:` column is never
   * bold. Ignored when the template merges rows (`keyRowsCollapse`).
   */
  bold?: boolean[][];
  notes?: TemplatedNote[];
  /** Printed after the info block and the notes `before`, before the table, each under its title. */
  images?: TemplatedImage[];
  /** Values for THIS section's info block (its own instrument, `instrumentCount` …), over the report's. `profile` defaults to `profileName`. */
  values?: Partial<Record<Placeholder, string>>;
  /**
   * The section's ONE instrument's attribute values, keyed by catalogue id
   * (`attr:<key>` → its text) — what an `attr:` info row prints, consulted
   * BEFORE the rows (ruling T3-A). A page report fills it: a trend section has
   * no rows to read an attribute from. An id the catalogue lacks still prints
   * `—` and is named "Not available"; an id absent here falls back to the rows.
   */
  attributes?: Record<string, string>;
  /** A fresh page before this section (the Data Report's one instrument per page). Never before the first. */
  pageBreakBefore?: boolean;
  /** Passed to the records table AS GIVEN — the built-in page reports keep today's widths through it; a saved template passes none. */
  columnStyles?: TemplatedColumnStyles;
  /**
   * The ruled header block's ROWS, handed over whole in place of the
   * document's info rows — for a built-in whose block is not a plain
   * label / value grid (the Data Report's spanning extremes and interval
   * rows, `dataReportParameterRows`). A page kind only; a saved template
   * passes none and its info rows print.
   */
  infoBlockRows?: TableCell[][];
}

export interface TemplatedReportInput {
  kind: TemplateKind;
  /** `ReportConfig.reportKey` — the snapshot's `reportType`. */
  reportKey: string;
  /** Placeholder values for the title, subtitle, footer and info blocks (`{period}`, `{instrument}` …). */
  values: Partial<Record<Placeholder, string>>;
  /** In print order. The first one's template draws the chrome and the title. */
  sections: TemplatedSection[];
  formatDateTime: (iso: string) => string;
  /**
   * The page's STRUCTURED abbreviation key (the Data Report's, the Alarm
   * Report's) — printed only when the chrome document has no `notes.legend`
   * of its own; a template's own legend text replaces it (ruling P-1).
   */
  legend?: ReportConfig['legend'];
  /**
   * Pictures of the WHOLE report, printed once before the first section — a
   * widget's picture in a report of several profiles, which under
   * "Profile: <first>" would read as the first profile's alone (review m4).
   */
  leadImages?: TemplatedImage[];
}

export interface TemplatedReportResult {
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
 * value a widget hands over unformatted. TEXT is the server's, the page's or
 * the widget's own formatting (a measured reading at the instrument's
 * administered precision, a range figure, `Error` / `OL` / `NA`) and prints
 * VERBATIM whatever `decimals` says (review C1, 2026-11-02): re-rounding it
 * could hide an excursion (25.4 → "25") or state a precision never recorded
 * (21.5 → "21.500"). A number with no `decimals` prints as a widget prints a
 * raw key with none (`formatKeyValue` → `String(n)`).
 */
export function formatReportCell(value: ReportRowValue | undefined, column: ReportTemplateColumn): string {
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

function groupOf(row: ReportRow): string | null {
  const g = row[REPORT_ROW_GROUP];
  return typeof g === 'string' || typeof g === 'number' ? String(g) : null;
}

/** Copy each of `row`'s non-blank values into `target` where `target` has none. */
function fillBlanks(target: ReportRow, row: ReportRow, only?: (id: string) => boolean): void {
  for (const [id, v] of Object.entries(row)) {
    if ((only === undefined || only(id)) && isBlank(target[id]) && !isBlank(v)) target[id] = v;
  }
}

const isInstrumentCell = (id: string) => id.startsWith('key:') || id.startsWith('attr:');

/**
 * The rows a section prints, in the grain its template asks for (the shared
 * `keyRowsCollapse`). Only the per-key widget types have a grain to choose;
 * every other kind prints its rows as given. Only rows that name their group
 * (`REPORT_ROW_GROUP`) are merged or shared; the rest pass through in place.
 */
export function printedRows(kind: TemplateKind, document: ReportTemplateDocument, rows: ReportRow[]): ReportRow[] {
  if (!REPORT_TEMPLATE_FIELDS(kind).some((f) => f.perKey)) return rows;
  if (keyRowsCollapse(kind, document)) {
    // One row per group, at its first row's place; its fields are the first
    // non-blank value each field has across the group's rows.
    const out: ReportRow[] = [];
    const byGroup = new Map<string, ReportRow>();
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
  const shared = new Map<string, ReportRow>();
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
 * through the shared substitution, the ONE rule). `attr:<key>` → an attribute
 * this section's catalogue does not have (`available`) prints `—` and the
 * caller names it as not available (review m3); otherwise the section's own
 * `attributes` (its ONE instrument's, handed over by a page — ruling T3-A);
 * otherwise the attribute of the section's ONE instrument read from its rows
 * (their `instrument.code`) — a section of several instruments (or none)
 * prints `—`, because an attribute of one of them would read as all of theirs.
 */
function infoValue(
  source: string, values: Partial<Record<Placeholder, string>>, rows: ReportRow[],
  available?: ReadonlySet<string>, attributes?: Readonly<Record<string, string>>,
): string {
  if (source.startsWith('attr:')) {
    if (available && !available.has(source)) return REPORT_VALUE_MISSING;
    const given = attributes?.[source];
    if (given !== undefined) return isBlank(given) ? REPORT_VALUE_MISSING : given;
    const instruments = new Set(rows.map((r) => r['instrument.code']).filter((v) => !isBlank(v)).map(String));
    if (instruments.size !== 1) return REPORT_VALUE_MISSING;
    const v = rows.map((r) => r[source]).find((x) => !isBlank(x));
    return v === undefined || v === null ? REPORT_VALUE_MISSING : String(v);
  }
  return substitutePlaceholders(`{${source}}`, values);
}

/**
 * The info block, in the look its kind has always had — and the LABELS of
 * its rows this section's catalogue cannot fill (an `attr:` source not in
 * `available`). No `available` = nothing is checked (no section: there is no
 * profile to ask).
 *
 * - A WIDGET kind: caption-over-value pairs (`addKeyValue`), three across.
 * - A PAGE kind: the ruled HEADER BLOCK every page report has printed since
 *   2026-10-05 — a headless table, `Label :` and value two to a row, the
 *   label columns bold, all four columns pinned (`scopeTableRows`,
 *   `scopeColumnStyles`, the same helpers today's page builders call) — or
 *   the block's rows as the built-in hands them over (`infoBlockRows`).
 */
function printInfoBlock(
  report: ReportDoc, kind: TemplateKind, document: ReportTemplateDocument, values: Partial<Record<Placeholder, string>>,
  rows: ReportRow[], available?: ReadonlySet<string>, section?: Pick<TemplatedSection, 'infoBlockRows' | 'attributes'>,
): string[] {
  const pageKind = isPageTemplateKind(kind);
  const infoBlockRows = section?.infoBlockRows;
  if (pageKind && infoBlockRows) {
    if (infoBlockRows.length) report.addTable({ body: infoBlockRows, columnStyles: headerColumnStyles(report) });
    return [];
  }
  if (!document.infoBlock.length) return [];
  // The value is always given: `addKeyValue` would print a bare "-" for a blank one.
  const pairs = document.infoBlock.map((r) => [r.label, infoValue(r.source, values, rows, available, section?.attributes)] as [string, string]);
  if (pageKind) report.addTable({ body: scopeTableRows(pairs), columnStyles: headerColumnStyles(report) });
  else report.addKeyValue(pairs);
  return available
    ? document.infoBlock.filter((r) => r.source.startsWith('attr:') && !available.has(r.source)).map((r) => r.label)
    : [];
}

/**
 * The header block's four columns across the TEXT COLUMN: A4 portrait 182mm,
 * as every page report has pinned it, or 269mm on a landscape page. Rounded
 * from the page so jsPDF's 210.0016mm reads as 210 — the widths are the
 * header helper's own, never a near miss of them.
 */
const headerColumnStyles = (report: ReportDoc) => scopeColumnStyles(Math.round(report.pw) - 28);

/**
 * A picture across the text column (14mm gutters) at its own proportions —
 * read from its own bytes — scaled down to fit a page less its top margin and
 * footer zone, under its title. An unreadable image throws here exactly as
 * `addImage` would: a caller's bug, not swallowed. A picture with no bytes
 * prints its title and, in its place, WHY there is none (muted) — a gap must
 * not read as "no data".
 */
function printImage(report: ReportDoc, image: TemplatedImage): void {
  if (image.title) report.addSectionTitle(image.title);
  if (!image.dataUrl) {
    report.addNote(image.missingText?.trim() || IMAGE_MISSING_TEXT, 'muted');
    return;
  }
  const maxW = report.pw - 28;
  const maxH = report.ph - 14 - 24;
  const p = report.doc.getImageProperties(image.dataUrl);
  const h = (maxW * p.height) / p.width;
  const k = Math.min(1, maxH / h);
  report.addImage(image.dataUrl, maxW * k, h * k);
}

/** A section's line of text: a section pill for `style: 'title'`, else a wrapped paragraph. */
function printNote(report: ReportDoc, note: TemplatedNote): void {
  if (note.style === 'title') report.addSectionTitle(note.text);
  else report.addNote(note.text, note.color ?? 'text');
}

/** The section's table; returns the records printed and the headings of the shown columns this section cannot fill. */
function printTable(
  report: ReportDoc, kind: TemplateKind, section: TemplatedSection, rows: ReportRow[], available: ReadonlySet<string>,
): { records: number; missing: string[] } {
  const shown = section.document.columns.filter((c) => c.show);
  if (!shown.length) return { records: 0, missing: [] };
  // A PAGE kind's row may hold an intentionally EMPTY cell — exactly `''` —
  // which prints empty (ruling T3-E: the Alarm Report prints a switched-off
  // limit as an empty box, operator 2026-09-07). Nothing else changes: null,
  // undefined and whitespace still print `—`, and a widget's `''` still `—`.
  const pageKind = isPageTemplateKind(kind);
  const cell = (row: ReportRow, c: ReportTemplateColumn): string => {
    if (!available.has(c.id)) return '';
    return pageKind && row[c.id] === '' ? '' : formatReportCell(row[c.id], c);
  };
  const body: TableCell[][] = rows.map((row) => shown.map((c) => cell(row, c)));
  // The grid is by built-in FIELD (the page's own column order); re-indexed to
  // the template's shown columns. A merged grain has no input row to follow.
  const fieldIndex = new Map(REPORT_TEMPLATE_FIELDS(kind).map((f, i) => [f.id, i]));
  const bold = section.bold && body.length && !keyRowsCollapse(kind, section.document)
    ? rows.map((_, r) => shown.map((c) => {
      const i = fieldIndex.get(c.id);
      return i !== undefined && section.bold?.[r]?.[i] === true;
    }))
    : undefined;
  report.addTable({
    head: shown.map(reportColumnHeading),
    // A heading row over nothing reads as a broken table; say so instead.
    body: body.length ? body : [[{ content: 'No records.', colSpan: shown.length }]],
    columnStyles: section.columnStyles,
    ...(bold ? { bold } : {}),
  });
  return { records: body.length, missing: shown.filter((c) => !available.has(c.id)).map(reportColumnHeading) };
}

/**
 * Build the report: the first section's template titles it and draws the
 * chrome (its footer text's placeholders filled with the title's values, so
 * the FROZEN chrome carries the filled text — review I1). The report-wide
 * pictures print first (`leadImages`). Each section then prints, in order:
 * a page break (`pageBreakBefore`, never before the first), its `title`, its
 * info block, on a kind with NO fields one line naming the columns its
 * template shows but cannot print (ruling T3-C), its notes marked `before`,
 * a fieldless widget's text, its pictures (each under its title), its table
 * (the bold grid carried), its other notes, and ONE "Not available" line
 * naming every info row and shown column its catalogue does not have (spec
 * §6, review m3). No sections = the kind's built-in chrome and a line saying
 * so.
 */
export async function buildTemplatedReport(input: TemplatedReportInput): Promise<TemplatedReportResult> {
  const { kind, sections } = input;
  const first = sections[0]?.document ?? builtinReportTemplate(kind);
  // Each profile ONCE: a Data Report has a section per INSTRUMENT, several of one profile.
  const profiles = [...new Set(sections.map((s) => s.profileName).filter((n): n is string => !!n && n.trim() !== ''))];
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
    reportKey: input.reportKey,
    chrome,
    ...(first.page.typography === 'data-report' ? { typography: DATA_REPORT_TYPOGRAPHY } : {}),
    // The page's structured key prints unless the template has its own (which the chrome carries).
    ...(input.legend && !first.notes.legend?.trim() ? { legend: input.legend } : {}),
  });

  for (const image of input.leadImages ?? []) printImage(report, image);

  if (!sections.length) {
    printInfoBlock(report, kind, first, input.values, []);
    report.addNote('No instruments in this selection.', 'muted');
    return { report, title, subtitle, recordCount: 0 };
  }

  const fieldless = REPORT_TEMPLATE_FIELDS(kind).length === 0;
  let recordCount = 0;
  sections.forEach((s, i) => {
    if (i > 0 && s.pageBreakBefore) report.newPage();
    if (s.title) report.addSectionTitle(s.title);
    const available = new Set(s.availableIds);
    const rows = printedRows(kind, s.document, s.rows);
    const values = { ...input.values, ...(s.profileName ? { profile: s.profileName } : {}), ...s.values };
    const missing = printInfoBlock(report, kind, s.document, values, rows, available, s);
    // A kind with no fields has no table (ruling T3-C): a column its template
    // nevertheless shows is SAID, never silently dropped (spec §3 anti-goal).
    const unprinted = fieldless ? s.document.columns.filter((c) => c.show).map(reportColumnHeading) : [];
    if (unprinted.length) report.addNote(`This report has no table; columns not printed: ${unprinted.join(', ')}`, 'muted');
    for (const note of s.notes ?? []) if (note.before) printNote(report, note);
    // Ruling T1-C1: a widget with no fields (text card, floor plan) prints what
    // it shows — its text as a paragraph, then its image — and no table.
    if (fieldless && !isBlank(s.rows[0]?.text)) report.addNote(String(s.rows[0].text), 'text');
    for (const image of s.images ?? []) printImage(report, image);
    if (!fieldless) {
      const table = printTable(report, kind, s, rows, available);
      recordCount += table.records;
      missing.push(...table.missing);
    }
    for (const note of s.notes ?? []) if (!note.before) printNote(report, note);
    // Spec §6: what this section cannot fill is NAMED, under the table — never
    // dropped, never invented. One line, each name once.
    const names = [...new Set(missing)];
    if (names.length) report.addNote(`Not available for this ${s.profileId === null ? 'report' : 'profile'}: ${names.join(', ')}`, 'muted');
  });
  return { report, title, subtitle, recordCount };
}
