import {
  coerceReportTemplateDocument,
  type Placeholder, type ReportTemplateDocument, type TemplateKind,
} from '@digilog/shared';
import {
  buildTemplatedReport,
  type ReportRow, type TemplatedReportResult, type TemplatedSection,
} from '@/lib/templated-report';
import { chooseTemplate, planScopeKey, type PlanSection } from '@/lib/report-template-plan';
import {
  DATA_REPORT_EMPTY_TEXT, dataReportColumnStyles, dataReportLegend, dataReportParameterRows, limitText, printsMkt,
} from './data-report';
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

/** The instrument's section of the plan — with a profile — or `undefined`: the ONE test of "the server named a profile for it". */
function planSectionFor(plan: readonly PlanSection[], instrumentId: string): (PlanSection & { profileId: string }) | undefined {
  return plan.find((s): s is PlanSection & { profileId: string } => s.profileId !== null && s.instrumentIds.includes(instrumentId));
}

/**
 * The CODES of the instruments a LOADED plan leaves without a profile — `/resolve`
 * drops an instrument the caller cannot see. The download dialog names each one
 * before Confirm (`ReportTemplateLines`' `leftOut`: "No instrument profile
 * resolved for <code> — the report will be refused"), and the download refuses
 * (`templateForInstrument`). Empty while the plan loads or after it failed:
 * those are said on their own, in their own words.
 */
export function planLeavesOut(
  plan: { sections: readonly PlanSection[]; loading: boolean; error: unknown },
  instruments: readonly { id: string; code: string }[],
): string[] {
  if (plan.loading || (plan.error !== undefined && plan.error !== null)) return [];
  return instruments.filter((i) => planSectionFor(plan.sections, i.id) === undefined).map((i) => i.code);
}

/**
 * Whether a template prints an instrument ATTRIBUTE — an `attr:` column it
 * shows or an `attr:` info row. Only then is `GET /api/instruments/:id/attributes`
 * asked for that instrument: a built-in names none, so a built-in report reads
 * no attributes at all.
 */
export function templateNamesAttributes(document: ReportTemplateDocument): boolean {
  return document.columns.some((c) => c.show && c.id.startsWith('attr:'))
    || document.infoBlock.some((r) => r.source.startsWith('attr:'));
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
  const section = planSectionFor(plan, instrument.id);
  if (!section) {
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

/**
 * The values EVERY section holds, and holds alike: a key carries only when each
 * section defines it with the same text. An Area-wise Data Report's instruments
 * share their Block and Area (and the dialog's period and interval), so a saved
 * title "Data Report {area}" prints the Area; they do not share an instrument,
 * so `{instrument}` stays absent — and prints `—` — rather than naming the
 * first instrument as if it were the whole report's.
 */
/**
 * Whether a section's template PRINTS the column the empty-period sentence
 * rides in — `record.temperature`, the cell `emptyDataReportRow()` puts it in:
 * shown, and in the section's catalogue (a column it cannot fill prints empty).
 */
function printsStatementColumn(s: Pick<DataReportSection, 'document' | 'availableIds'>): boolean {
  return s.document.columns.some((c) => c.id === 'record.temperature' && c.show) && s.availableIds.includes('record.temperature');
}

function sharedValues(all: readonly Values[]): Values {
  if (all.length === 0) return {};
  const [first, ...rest] = all;
  return Object.fromEntries(
    Object.entries(first).filter(([k, v]) => v !== undefined && rest.every((r) => r[k as Placeholder] === v)),
  ) as Values;
}

/**
 * The DATA REPORT: one section per instrument, each on its own page with its
 * own template's header and columns (the built-in: today's parameter block
 * and four columns), the breach / fault bold grid carried, the 2,000-row cap
 * said above the records. The legend is the union of every page's — an
 * abbreviation is keyed if any page printed it — and prints unless the first
 * template carries its own (ruling P-1).
 *
 * Placeholders: each section's header names ITS instrument (`values` per
 * section). The report's title, subtitle and footer carry every value the
 * sections hold ALIKE (`sharedValues`): all of them on a report of one
 * instrument; on a report of several, the shared ones — the period, the
 * interval, a common Block or Area — while a value that differs between them
 * (the instrument, its location, its limits) prints `—`.
 *
 * An EMPTY period under a SAVED template that does not print the TEMPERATURE
 * column also says so in a muted note after the table: the empty row carries
 * the statement in that cell, and with the column hidden it would be lost.
 * With the column shown the row says it, so no note (no duplicate statement);
 * the built-in prints exactly what it always did.
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
    notes: [
      ...capNote(capNotice(printed, s.input.period)),
      ...(!s.builtin && printed.shownCount === 0 && !printsStatementColumn(s) ? [{ text: DATA_REPORT_EMPTY_TEXT, color: 'muted' as const }] : []),
    ],
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
  const reportValues: Values = { ...sharedValues(prepared.map((p) => p.values)), ...input.values };
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
