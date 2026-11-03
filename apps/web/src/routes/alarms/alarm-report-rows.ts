/**
 * The ALARM REPORT on report templates (2026-11-03, page reports on templates —
 * spec docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md
 * §6 / §8). The page prints through the ONE templated builder
 * (`lib/templated-report.ts`); this file turns its alarms into that builder's
 * input: rows keyed by the `page:alarms` field ids, the placeholder values, and
 * the report's ONE section (an application-wide kind has no profile).
 *
 * The CELLS are `reportRows`' (`alarms-report.ts`) — the strings the report
 * printed before templates, from the same helpers the Alarms page renders — so
 * a printed row cannot say something different from the row on screen.
 *
 * THE BUILT-IN keeps the page's two rules (spec §8): the INSTRUMENT ID / AREA /
 * LOCATION columns follow the selected level (`EXTRA_COLUMNS`), and a limit
 * column no row can fill is dropped (`hiddenLimitColumns`); it keeps today's
 * column widths (`columnWidths`) and today's empty-period row. A SAVED template
 * prints exactly the columns it shows, at jsPDF's widths — the two rules are
 * the built-in's, not the template's.
 *
 * Types only from `lib/templated-report` (it carries jsPDF, and the page is
 * what calls it); `alarms-report.ts` must not import it at all (ruling: the
 * lib once value-imported that file — no cycle may form).
 */
import {
  REPORT_TEMPLATE_FIELDS, builtinReportTemplate, coerceReportTemplateDocument,
  type Placeholder, type ReportTemplateColumn, type ReportTemplateRow,
} from '@digilog/shared';
import type { ReportRow, TemplatedReportInput, TemplatedSection } from '@/lib/templated-report';
import type { AlarmDisplayTexts, AlarmRow } from './alarm-display';
import {
  ALARM_REPORT_LEGEND, columnWidths, hiddenLimitColumns, reportHead, reportRows, truncationNote,
  type AlarmReportFormatters, type AlarmReportPeriod, type ReportLevel,
} from './alarms-report';

const KIND = 'page:alarms';

/**
 * The ten field ids, in the shared built-in's order — which IS the order the
 * report has always printed its columns, `reportHead('all')`: the placement
 * columns first, then the reference's seven (ruling T1-F; the i-th field is
 * headed with today's i-th word — pinned in `alarm-report-rows.test.ts`).
 */
const FIELD_IDS = REPORT_TEMPLATE_FIELDS(KIND).map((f) => f.id);

/** What the built-in's empty-period row says, under DESCRIPTION (`-` in every other cell). */
export const NO_ALARMS_IN_PERIOD = 'No alarms in the selected period';

/** What `{level}` prints: how far the operator narrowed the download. */
const LEVEL_TEXT: Record<ReportLevel, string> = {
  instrument: 'Instrument', area: 'Area', block: 'Block', all: 'All instruments',
};

/** Dates as the page prints them, and the date-time the builder and `{from}` / `{to}` use. */
export type AlarmReportDateFormatters = AlarmReportFormatters & { formatDateTime: (iso: string) => string };

/**
 * One row per alarm, keyed by the ten `page:alarms` ids — `reportRows` at its
 * widest level (every column), so each cell is exactly the string today's
 * report printed: a dash for a missing placement, `N/A` for a bound nobody
 * administered, EMPTY for a bound switched off, the page's own wording.
 */
export function rowsForAlarmReport(rows: readonly AlarmRow[], fmt: AlarmReportFormatters, texts?: AlarmDisplayTexts): ReportRow[] {
  return reportRows(rows, fmt, texts, 'all').map((cells) =>
    Object.fromEntries(FIELD_IDS.map((id, i) => [id, cells[i]])));
}

/**
 * The built-in's columns for this download: all ten, in order, as the shared
 * built-in heads them, `show` set by the page's two rules — the placement
 * columns at this level (`EXTRA_COLUMNS`) and each limit column unless no row
 * fills it (`hiddenLimitColumns`). Used ONLY when no saved template is in use.
 */
export function builtinAlarmColumns(level: ReportLevel, rows: readonly AlarmRow[]): ReportTemplateColumn[] {
  const printed = new Set(reportHead(level, hiddenLimitColumns(rows)));
  const word = reportHead('all');
  return builtinReportTemplate(KIND).columns.map((c, i) => ({ ...c, show: printed.has(word[i]) }));
}

/**
 * What the Alarm Report's placeholders print: the period (its two ends by date
 * and time, each end whole, the range), the alarms printed, the search (quoted;
 * none = no value, so it prints `—`) and the level.
 */
export function alarmReportPlaceholderValues(opts: {
  period: AlarmReportPeriod;
  fmt: AlarmReportDateFormatters;
  recordCount: number;
  search: string;
  level: ReportLevel;
}): Partial<Record<Placeholder, string>> {
  const { period, fmt } = opts;
  const from = fmt.formatDateTime(period.from);
  const to = fmt.formatDateTime(period.to);
  const search = opts.search.trim();
  return {
    fromDate: fmt.formatDate(period.from), fromTime: fmt.formatTime(period.from),
    toDate: fmt.formatDate(period.to), toTime: fmt.formatTime(period.to),
    from, to, period: `${from} – ${to}`,
    recordCount: String(opts.recordCount),
    ...(search ? { search: `"${search}"` } : {}),
    level: LEVEL_TEXT[opts.level],
  };
}

/**
 * The builder's input for one Alarm Report download — what the page prints.
 *
 * `template`: the one the plan resolved or the operator picked
 * (`chooseTemplate`), or null = the built-in. A stored document that does not
 * parse prints the built-in document WHOLE (`coerceReportTemplateDocument`),
 * still as a saved template — the built-in's two rules belong to "no template".
 *
 * `rows` are the alarms PRINTED (at most the page's cap), `total` how many
 * matched: a shortfall is disclosed ON the record, as today — the truncation
 * line rides on the records table as its title (`before`, `style: 'title'`).
 * `printedAt` (an ISO instant) and `user` (the signed-in USERNAME, the identity
 * "Printed By" prints) fill `{date}` and `{user}`.
 */
export function alarmReportInput(opts: {
  template: ReportTemplateRow | null;
  rows: readonly AlarmRow[];
  total: number;
  level: ReportLevel;
  period: AlarmReportPeriod;
  search: string;
  fmt: AlarmReportDateFormatters;
  texts?: AlarmDisplayTexts;
  printedAt: string;
  user: string;
}): TemplatedReportInput {
  const { template, rows, level, fmt } = opts;
  const note = truncationNote(rows.length, opts.total);
  const printed = rowsForAlarmReport(rows, fmt, opts.texts);
  const common = {
    profileId: null,
    profileName: null,
    availableIds: [...FIELD_IDS],
    ...(note ? { notes: [{ text: note, before: true, style: 'title' as const }] } : {}),
  };

  let section: TemplatedSection;
  if (template) {
    section = { ...common, document: coerceReportTemplateDocument(template.document, KIND), rows: printed };
  } else {
    const columns = builtinAlarmColumns(level, rows);
    section = {
      ...common,
      document: { ...builtinReportTemplate(KIND), columns },
      // A report of an empty period must SAY it is empty: today's row, width-
      // matched to the head, the description saying so (a heading over nothing
      // reads as a rendering failure on paper).
      rows: rows.length ? printed : [Object.fromEntries(columns.filter((c) => c.show)
        .map((c) => [c.id, c.id === 'alarm.description' ? NO_ALARMS_IN_PERIOD : '-']))],
      columnStyles: columnWidths(level, hiddenLimitColumns(rows)),
    };
  }

  return {
    kind: KIND,
    reportKey: 'alarms',
    values: {
      ...alarmReportPlaceholderValues({ period: opts.period, fmt, recordCount: rows.length, search: opts.search, level }),
      date: fmt.formatDateTime(opts.printedAt),
      user: opts.user,
    },
    sections: [section],
    formatDateTime: fmt.formatDateTime,
    // Printed unless the template has a legend of its own (ruling P-1; the builder decides).
    legend: ALARM_REPORT_LEGEND,
  };
}
