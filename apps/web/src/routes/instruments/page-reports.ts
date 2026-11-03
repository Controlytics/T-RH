import {
  coerceReportTemplateDocument,
  type Placeholder, type ReportTemplateDocument, type TemplateKind,
} from '@digilog/shared';
import {
  buildTemplatedReport,
  type ReportRow, type TemplatedReportResult, type TemplatedSection,
} from '@/lib/templated-report';
import { chooseTemplate, planScopeKey, type PlanSection } from '@/lib/report-template-plan';
import { dataReportColumnStyles, dataReportLegend, dataReportParameterRows, limitText, printsMkt } from './data-report';
import {
  capNotice, dataReportPlaceholderValues, instrumentPlaceholderValues, rowsForDataReport, rowsForInstrumentAlarms,
  trendPlaceholderValues,
} from './page-report-rows';
import type { DataReportInput, InstrumentAlarmsReportInput, TrendReportInput } from './trend-report';

/**
 * The trend page's and the Data Report page's three reports — the Data Report,
 * the Instrument Trend, the Instrument Alarms — drawn from REPORT TEMPLATES
 * (2026-11-03, page reports on templates — spec
 * docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md):
 * the ONE templated builder (`lib/templated-report.ts`), fed the page's own
 * rows and wording (`page-report-rows.ts`).
 *
 * Which template each instrument prints with is the SERVER's answer (`GET
 * /api/report-templates/resolve`, `useReportTemplatePlan`) or the operator's
 * pick in the dialog; with none, the kind's BUILT-IN — which reproduces what
 * each page printed before templates exactly (pinned against frozen output in
 * `__tests__/page-reports-builtin.test.ts`). The report's chrome and title are
 * the FIRST instrument's template's.
 *
 * Nothing here fetches or decides: the pages fetch the readings, the alarms and
 * the attributes, resolve the templates, and hand everything over.
 */

/** The snapshot's `reportType` for all three, as before templates (the audit row's type is the page's, separately). */
const REPORT_KEY = 'instrument-trend';

type Values = Partial<Record<Placeholder, string>>;

/** The template one instrument prints with, and what its profile can fill. */
export interface PageReportTemplate {
  profileId: string | null;
  profileName: string | null;
  /** `coerceReportTemplateDocument(chooseTemplate(…)?.document, kind)` — the built-in when none is chosen. */
  document: ReportTemplateDocument;
  /** The profile's field catalogue (`PlanSection.availableIds`): the kind's built-in ids and its `attr:` ids. */
  availableIds: string[];
  /** The instrument's attributes, `attr:<key>` → the text the attributes panel shows (`fetchReportAttributes`). */
  attributes?: Record<string, string>;
}

/** One instrument of a Data Report. */
export interface DataReportSection extends PageReportTemplate {
  input: DataReportInput;
  /**
   * No saved template: `document` is the kind's built-in, and the section keeps
   * the two things a template cannot say — the spanning parameter block
   * (`dataReportParameterRows`: the extremes row's spans, Interval spanning or
   * beside MKT) and the pinned column widths. A SAVED template prints its own
   * info rows through the header grid and autotable's widths (ruling R-2).
   */
  builtin: boolean;
}

/** `POST /api/report-reviews` caps the title and the subtitle at these lengths. */
const REQUEST_TITLE_MAX = 500;
const REQUEST_SUBTITLE_MAX = 1000;

/**
 * The title and subtitle a download hands `deliverReport`: as printed, cut with
 * an ellipsis past the request's caps. A template's placeholders can run past
 * them — a Data Report's `{profile}` names every profile — and a Request must
 * never turn into a bare 400 for it (the widget dialog's rule, review m11). The
 * PDF itself prints them whole.
 */
export function deliveredTitles(result: Pick<TemplatedReportResult, 'title' | 'subtitle'>): { title: string; subtitle?: string } {
  const clamp = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
  return {
    title: clamp(result.title, REQUEST_TITLE_MAX),
    ...(result.subtitle === undefined ? {} : { subtitle: clamp(result.subtitle, REQUEST_SUBTITLE_MAX) }),
  };
}

/**
 * The template ONE instrument prints with: its section of the plan — the
 * SERVER's grouping of the instruments by profile (`PlanSection.instrumentIds`),
 * never re-derived here — then the dialog's pick for that profile, else the
 * profile's default, else the kind's built-in (`builtin: true`).
 *
 * REFUSES when the plan names no profile for the instrument: `/resolve` drops an
 * instrument the caller cannot see, and a §11 record must neither leave an
 * instrument out without a word nor guess the template it prints with.
 */
export function templateForInstrument(
  kind: TemplateKind,
  plan: readonly PlanSection[],
  picks: Readonly<Record<string, string>>,
  instrument: { id: string; code: string },
): PageReportTemplate & { builtin: boolean } {
  const section = plan.find((s) => s.instrumentIds.includes(instrument.id));
  if (!section || section.profileId === null) {
    throw new Error(`The report templates name no instrument profile for ${instrument.code}, so the report cannot be printed. Close this and try again.`);
  }
  const chosen = chooseTemplate(section, picks[planScopeKey(section)]);
  return {
    profileId: section.profileId,
    profileName: section.profileName,
    document: coerceReportTemplateDocument(chosen?.document, kind),
    builtin: chosen === null,
    availableIds: section.availableIds,
  };
}

/**
 * Every READING row carries its instrument's code and attributes, so an
 * `attr:` COLUMN prints the instrument's value on each row and an `attr:` info
 * row can read it (ruling T3-A). The empty-period row is not a reading and
 * carries neither.
 */
function withInstrumentCells(rows: ReportRow[], code: string, attributes: Record<string, string> | undefined): ReportRow[] {
  return rows.map((row) => ({ ...row, 'instrument.code': code, ...attributes }));
}

/** A `before` title: rides on the records table as its title, exactly as the cap notice always printed (ruling T3-B). */
const capNote = (text: string | null) => (text ? [{ text, before: true, style: 'title' as const }] : []);

/** The period's values every section of a Data Report shares — the one dialog's period and interval. */
const SHARED_KEYS: readonly Placeholder[] = ['from', 'to', 'period', 'fromDate', 'fromTime', 'toDate', 'toTime', 'interval'];

/**
 * The DATA REPORT: one section per instrument, each on its own page with its
 * own template's header and columns (the built-in: today's parameter block
 * and four columns), the breach / fault bold grid carried, the 2,000-row cap
 * said above the records. The legend is the union of every page's — an
 * abbreviation is keyed if any page printed it — and prints unless the first
 * template carries its own (ruling P-1).
 *
 * Placeholders: each section's header names ITS instrument (`values` per
 * section). The report's title, subtitle and footer name the instrument only
 * when there is ONE; on a report of several they name the period alone — a
 * title naming the first instrument would read as the whole report's.
 */
export async function buildDataReport(input: {
  sections: DataReportSection[];
  formatDateTime: (iso: string) => string;
  /** The page's own values: `date` (printed at) and `user` (the signed-in username). */
  values: Values;
}): Promise<TemplatedReportResult> {
  const prepared = input.sections.map((s) => ({ s, printed: rowsForDataReport(s.input), values: dataReportPlaceholderValues(s.input) }));
  const legend = dataReportLegend(
    prepared.flatMap(({ s }) => [limitText(s.input.temp), limitText(s.input.rh)]),
    prepared.some(({ printed }) => printed.printedNoData),
    // MKT is keyed iff some page printed it — the server's number decides.
    prepared.some(({ s }) => printsMkt(s.input.temp)),
  );
  const sections: TemplatedSection[] = prepared.map(({ s, printed, values }, i) => ({
    profileId: s.profileId,
    profileName: s.profileName,
    document: s.document,
    availableIds: s.availableIds,
    rows: printed.shownCount ? withInstrumentCells(printed.rows, s.input.scope.instrumentLabel, s.attributes) : printed.rows,
    // An empty period's one row is a statement, not a reading: nothing in it is bold.
    ...(printed.shownCount ? { bold: printed.bold } : {}),
    notes: capNote(capNotice(printed, s.input.period)),
    values,
    ...(s.attributes ? { attributes: s.attributes } : {}),
    pageBreakBefore: i > 0,
    ...(s.builtin
      ? {
        columnStyles: dataReportColumnStyles(),
        infoBlockRows: dataReportParameterRows({
          scope: s.input.scope, period: s.input.period, temp: s.input.temp, rh: s.input.rh,
          intervalMs: s.input.intervalMs, fmt: s.input.fmt,
        }),
      }
      : {}),
  }));
  const first = prepared[0]?.values ?? {};
  const reportValues: Values = prepared.length === 1
    ? { ...first, ...input.values }
    : { ...Object.fromEntries(SHARED_KEYS.filter((k) => first[k] !== undefined).map((k) => [k, first[k]])), ...input.values };
  return buildTemplatedReport({
    kind: 'page:data-report',
    reportKey: REPORT_KEY,
    values: reportValues,
    sections,
    formatDateTime: input.formatDateTime,
    legend,
  });
}

/**
 * The INSTRUMENT TREND: the header block and the CHART(S) the operator saw.
 * A chart averaged over an interval says so first, in red, above everything it
 * qualifies — a plotted point in an averaged chart is a derived number, and a
 * printed record that drops the disclosure shows it as a reading. A chart that
 * could not be drawn prints its title and WHY, never a gap that reads as "no
 * data". No readings table: the stored readings are the Time Series report's.
 */
export async function buildTrendReport(
  input: TrendReportInput & PageReportTemplate & { values: Values },
): Promise<TemplatedReportResult> {
  const { scope, fmt } = input.header;
  return buildTemplatedReport({
    kind: 'page:trend',
    reportKey: REPORT_KEY,
    values: { ...trendPlaceholderValues(scope, input.period, fmt, input.formatDateTime, input.slotLabel), ...input.values },
    formatDateTime: input.formatDateTime,
    sections: [{
      profileId: input.profileId,
      profileName: input.profileName,
      document: input.document,
      availableIds: input.availableIds,
      rows: [],
      // The same disclosure `ChartIntervalNote` makes on screen, in the same words.
      notes: input.averagedLabel
        ? [{
          text: `Note: the chart is AVERAGED over ${input.averagedLabel}. Each point is `
            + 'the mean of the readings in its bucket, not a stored reading. '
            + 'For the same period UNAVERAGED, use the Instrument Time Series report — it prints stored readings rather '
            + 'than bucket means. It is built from the same sample as this report, and states its own coverage.',
          color: 'red',
          before: true,
        }]
        : [],
      images: input.charts.map((c) => (c.image
        ? { title: c.title, dataUrl: c.image.dataUrl }
        : { title: c.title, missingText: c.unavailableReason })),
      ...(input.attributes ? { attributes: input.attributes } : {}),
    }],
  });
}

/**
 * The trend page's INSTRUMENT ALARMS: the header block and the instrument's
 * alarms in the period, worded as the screen words them, the 2,000-row cap
 * said above the table.
 */
export async function buildInstrumentAlarmsReport(
  input: InstrumentAlarmsReportInput & PageReportTemplate & { values: Values },
): Promise<TemplatedReportResult> {
  const { scope, fmt } = input.header;
  const printed = rowsForInstrumentAlarms(input.rows, input.formatDateTime, input.statusTexts, input.inactivityTexts);
  return buildTemplatedReport({
    kind: 'page:instrument-alarms',
    reportKey: REPORT_KEY,
    values: { ...instrumentPlaceholderValues(scope, input.period, fmt, input.formatDateTime), ...input.values },
    formatDateTime: input.formatDateTime,
    sections: [{
      profileId: input.profileId,
      profileName: input.profileName,
      document: input.document,
      availableIds: input.availableIds,
      rows: withInstrumentCells(printed.rows, scope.instrumentLabel, input.attributes),
      notes: capNote(capNotice(printed, input.period)),
      ...(input.attributes ? { attributes: input.attributes } : {}),
    }],
  });
}
