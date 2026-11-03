/**
 * The WIDGET REPORT entry (2026-11-02) — what a dashboard widget's
 * "Download report" prints. Spec:
 * docs/superpowers/specs/2026-11-02-widget-report-templates-design.md §6-§8.
 *
 * Since 2026-11-03 the printing is `buildTemplatedReport`
 * (`lib/templated-report.ts`), the ONE builder every templated report — a
 * widget's and the five page reports' — goes through; this file is the
 * widget's thin entry over it, with the widget's own section shape and its
 * two rules: in a report of several profiles each section is titled
 * "Profile: <name>", and the widget's picture prints ONCE, before them.
 *
 * ONE report per download; ONE SECTION per instrument profile the widget's
 * instruments belong to (the server resolves which template each profile uses
 * — `GET /api/report-templates/resolve` — this file never decides that). The
 * report's CHROME is the FIRST section's template's, frozen in the snapshot
 * (v3), so the approved copy replays with no fetch.
 *
 * `REPORT_ROW_GROUP`, `formatReportCell`, `reportColumnHeading` and
 * `printedRows` live in `templated-report.ts` and are re-exported here for
 * the widget code that imports them from this module.
 */
import { widgetReportType, type Placeholder, type ReportTemplateDocument, type WidgetType } from '@digilog/shared';
import {
  buildTemplatedReport, type ReportRow, type ReportRowValue, type TemplatedReportResult, type TemplatedSection,
} from './templated-report';

export { REPORT_ROW_GROUP, formatReportCell, printedRows, reportColumnHeading } from './templated-report';

export type WidgetReportValue = ReportRowValue;
/** Field id → value. Field ids are catalogue ids; `REPORT_ROW_GROUP` and `text` are the two non-column keys. */
export type WidgetReportRow = ReportRow;

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

export type WidgetReportResult = TemplatedReportResult;

/**
 * Build the widget's report through the ONE templated builder. In a report of
 * several profiles each section is titled "Profile: <name>" and the first
 * section's picture prints ONCE, before them (review m4); with one profile the
 * picture prints in its section, above the table. No sections (no instruments
 * in the selection) = the widget type's built-in chrome and a line saying so.
 */
export async function buildWidgetReport(input: WidgetReportInput): Promise<WidgetReportResult> {
  const { widgetType, sections } = input;
  const several = sections.length > 1;
  const shared = several ? sections[0].imageDataUrl : undefined;
  return buildTemplatedReport({
    kind: widgetType,
    reportKey: widgetReportType(widgetType),
    values: input.values,
    formatDateTime: input.formatDateTime,
    ...(shared ? { leadImages: [{ dataUrl: shared }] } : {}),
    sections: sections.map((s, i): TemplatedSection => ({
      ...(several ? { title: `Profile: ${s.profileName}` } : {}),
      profileId: s.profileId,
      profileName: s.profileName,
      document: s.document,
      availableIds: s.availableIds,
      rows: s.rows,
      ...(s.values ? { values: s.values } : {}),
      ...(s.imageDataUrl && !(shared && i === 0) ? { images: [{ dataUrl: s.imageDataUrl }] } : {}),
    })),
  });
}
