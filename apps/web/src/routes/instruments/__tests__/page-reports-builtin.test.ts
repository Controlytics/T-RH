import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_TEMPLATE_FIELDS, builtinReportTemplate, type ReportTemplateDocument, type TemplateKind,
} from '@digilog/shared';
import type { ReportDoc, SnapshotSection } from '@/lib/pdf-report';
import {
  buildDataReport, buildTrendReport, buildInstrumentAlarmsReport, planLeavesOut, templateNamesAttributes,
} from '../page-reports';
import { DATA_REPORT_EMPTY_TEXT, dataReportColumnStyles, limitText } from '../data-report';
import { brandingFetch } from '@/test-support/branding-stub';
import {
  dataA, dataB, dataCapped, formatDateTime, period, trendHeader, trendCharts, alarmRows, statusTexts, inactivityTexts,
} from './fixtures/page-report-inputs';

vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async () => ({})), post: vi.fn(), postWithReauth: vi.fn() },
}));

/**
 * The three instrument page reports on TEMPLATES (2026-11-03, page reports on
 * templates). The JSON fixtures beside this file are what the hand-built
 * renderers printed before templates — `renderDataReports`,
 * `renderTrendReport`, `renderAlarmsReport`, captured from
 * `fixtures/page-report-inputs.ts` in commit 7eff0bc6 and deleted after these
 * pins passed. Drawn from each kind's BUILT-IN template, the templated
 * builders must reproduce them exactly.
 *
 * What is frozen: the title, subtitle, orientation, the structured legend, the
 * whole type scale, the chrome (less the logo's bytes — none loads here) and
 * every drawing call. `config.showAppName` is left out on purpose: the chrome
 * carries the app-name line (`chrome.showAppName`, frozen), and the templated
 * builder hands `createReport` a chrome, not the flag. An image keeps its size
 * (to a millionth of a millimetre — the two builders compute the height in a
 * different order) and drops its bytes.
 */

const round = (n: number) => Math.round(n * 1e6) / 1e6;

function frozen(report: ReportDoc, compact = false): unknown {
  const s = report.getSnapshot();
  const { logoDataUrl: _logo, ...chrome } = s.chrome ?? ({} as Record<string, unknown>);
  const sections = s.sections.map((x) => {
    if (x.kind === 'image') return { kind: 'image', widthMm: round(x.widthMm), heightMm: round(x.heightMm) };
    // A capped table is 2,000 rows: its first and last row and its length are what it is pinned by.
    if (compact && x.kind === 'table' && x.head.length) {
      return { ...x, body: [x.body[0], x.body.at(-1)], bodyLength: x.body.length, ...(x.bold ? { bold: [x.bold[0], x.bold.at(-1)] } : {}) };
    }
    return x;
  });
  return JSON.parse(JSON.stringify({
    reportType: s.reportType, title: s.title, subtitle: s.subtitle, orientation: s.orientation,
    legend: s.config.legend, typography: s.config.typography, chrome, sections,
  }));
}

// NOT `new URL('./fixtures/…', import.meta.url)`: Vite rewrites that form as an asset import, and a templated name resolves to `undefined`.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixturePath = (name: string) => join(FIXTURES, `page-report-builtin-${name}.json`);

/** `actual` equals the frozen pre-template output. */
function pin(name: string, actual: unknown): void {
  expect(actual).toEqual(JSON.parse(readFileSync(fixturePath(name), 'utf8')));
}

// Branding names nothing here, so the chrome is the shipped defaults, deterministically — and its
// logo answers: a report made now REFUSES when Branding or its logo cannot be read (ruling F-1,
// extended 2026-11-03). Until then this stub made every fetch fail, which printed the same names.
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = brandingFetch() as any; });
afterAll(() => { globalThis.fetch = realFetch; });

// ── The templated builders ─────────────────────────────────────────────────

/** What every page hands over beside its data: the date printed and the signed-in USERNAME. */
const USER_VALUES = { date: '2026-11-03 10:00', user: 'alice' };

const builtinIds = (kind: TemplateKind) => REPORT_TEMPLATE_FIELDS(kind).map((f) => f.id);

/** A section printed with the kind's BUILT-IN template — what a profile with no saved template gets. */
function builtinSection(kind: TemplateKind, over: Partial<{ profileId: string; profileName: string; availableIds: string[] }> = {}) {
  return {
    profileId: 'p1', profileName: 'T&RH', document: builtinReportTemplate(kind), builtin: true,
    availableIds: builtinIds(kind), ...over,
  };
}

const trendInput = {
  slotLabel: 'Temperature & Humidity', charts: trendCharts, period, formatDateTime,
  header: trendHeader, averagedLabel: '5 minutes', coverage: { returned: 3, total: 3 },
};
const alarmsInput = { rows: alarmRows, period, formatDateTime, statusTexts, inactivityTexts, header: trendHeader };

const recordTables = (report: ReportDoc) =>
  report.getSnapshot().sections.filter((s): s is Extract<SnapshotSection, { kind: 'table' }> => s.kind === 'table' && s.head.length > 0);
const headerTables = (report: ReportDoc) =>
  report.getSnapshot().sections.filter((s): s is Extract<SnapshotSection, { kind: 'table' }> => s.kind === 'table' && s.head.length === 0);
const notes = (report: ReportDoc) =>
  report.getSnapshot().sections.filter((s): s is Extract<SnapshotSection, { kind: 'note' }> => s.kind === 'note').map((s) => s.text);

describe('the templated builders, drawn from each kind\'s BUILT-IN template, print what the page printed', () => {
  it('the Data Report of two instruments (two profiles)', async () => {
    const r = await buildDataReport({
      formatDateTime, values: USER_VALUES,
      sections: [
        { ...builtinSection('page:data-report'), input: dataA },
        { ...builtinSection('page:data-report', { profileId: 'p2', profileName: 'Pressure' }), input: dataB },
      ],
    });
    pin('data', frozen(r.report));
    expect(r.title).toBe('Temperature and RH Data Report');
  });

  it('the Data Report over the 2,000-row cap — the notice is the records table\'s title, as it always was', async () => {
    const r = await buildDataReport({
      formatDateTime, values: USER_VALUES, sections: [{ ...builtinSection('page:data-report'), input: dataCapped() }],
    });
    pin('data-capped', frozen(r.report, true));
    const sections = r.report.getSnapshot().sections;
    expect(sections.filter((s) => s.kind === 'title')).toHaveLength(0);
    expect(recordTables(r.report)[0].title).toMatch(/^Truncated: showing the first 2,000 of 2,001 rows/);
  });

  it('the Instrument Trend, two charts, averaged', async () => {
    const r = await buildTrendReport({ ...trendInput, ...builtinSection('page:trend'), values: USER_VALUES });
    pin('trend', frozen(r.report));
    expect(r.title).toBe('Instrument Trend — Temperature & Humidity');
  });

  it('the Instrument Alarms, three alarms', async () => {
    const r = await buildInstrumentAlarmsReport({ ...alarmsInput, ...builtinSection('page:instrument-alarms'), values: USER_VALUES });
    pin('instrument-alarms', frozen(r.report));
    expect(r.title).toBe('Instrument Alarms');
    expect(r.subtitle).toBe('CWH/RDU/046-00');
  });
});

describe('a Data Report whose instruments use DIFFERENT templates (Review Focus 2)', () => {
  /** A saved template: its own title, and only DATE and TEMPERATURE shown. */
  function customDocument(): ReportTemplateDocument {
    const doc = builtinReportTemplate('page:data-report');
    return {
      ...doc,
      header: { ...doc.header, title: 'Custom Data Report', subtitle: 'By {user} on {date} — {profile} — {instrument}' },
      columns: doc.columns.map((c) => ({ ...c, show: c.id === 'record.date' || c.id === 'record.temperature' })),
    };
  }

  it('takes the title and chrome from the FIRST instrument\'s template; each section prints its own columns; a page break between', async () => {
    const r = await buildDataReport({
      formatDateTime, values: USER_VALUES,
      sections: [
        { ...builtinSection('page:data-report'), document: customDocument(), builtin: false, input: dataA },
        { ...builtinSection('page:data-report', { profileId: 'p2', profileName: 'Pressure' }), input: dataB },
      ],
    });
    expect(r.title).toBe('Custom Data Report');
    // {user} and {date} are the page's; {profile} each profile once; {instrument} is NOT one instrument's on a report of two.
    expect(r.subtitle).toBe('By alice on 2026-11-03 10:00 — T&RH, Pressure — —');
    const [first, second] = recordTables(r.report);
    expect(first.head).toEqual(['DATE', 'TEMPERATURE (°C)']);
    expect(second.head).toEqual(['DATE', 'TIME', 'TEMPERATURE (°C)', 'RELATIVE HUMIDITY(%)']);
    // The breach stays bold under the saved template's columns (26.9 is now column 1).
    expect(first.bold?.[0]).toEqual([false, true]);
    // A saved template keeps none of the built-in's page-only layout: no fixed widths, its info rows through the grid.
    expect(first.columnStyles).toBeUndefined();
    expect(second.columnStyles).toEqual(dataReportColumnStyles());
    const [savedHeader] = headerTables(r.report);
    expect(savedHeader.body.find((row) => row[0] === 'Extremes :')).toEqual(
      ['Extremes :', 'Temp. Max : 26.9 , Temp. Min : 21.2 · RH Max : 63', 'Interval :', '15 minutes'],
    );
    const all = r.report.getSnapshot().sections;
    const breaks = all.map((s, i) => (s.kind === 'page-break' ? i : -1)).filter((i) => i >= 0);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toBeGreaterThan(all.indexOf(first));
    expect(breaks[0]).toBeLessThan(all.indexOf(second));
  });

  it('a one-instrument report names its instrument in the title placeholders', async () => {
    const r = await buildDataReport({
      formatDateTime, values: USER_VALUES,
      sections: [{ ...builtinSection('page:data-report'), document: customDocument(), builtin: false, input: dataA }],
    });
    expect(r.subtitle).toBe('By alice on 2026-11-03 10:00 — T&RH — CWH/RDU/001-00');
  });

  it('each section\'s header names ITS instrument, not the first one\'s', async () => {
    const doc = customDocument();
    const r = await buildDataReport({
      formatDateTime, values: USER_VALUES,
      sections: [
        { ...builtinSection('page:data-report'), document: doc, builtin: false, input: dataA },
        { ...builtinSection('page:data-report'), document: doc, builtin: false, input: dataB },
      ],
    });
    const instIds = headerTables(r.report).map((t) => t.body.find((row) => row[0] === 'Inst ID :')?.[1]);
    expect(instIds).toEqual(['CWH/RDU/001-00', 'CWH/RDU/002-00']);
  });
});

describe('instrument ATTRIBUTES on a page report (ruling T3-A)', () => {
  function withAttributes(kind: TemplateKind): ReportTemplateDocument {
    const doc = builtinReportTemplate(kind);
    return {
      ...doc,
      infoBlock: [{ label: 'Building', source: 'attr:Building' }, { label: 'Room', source: 'attr:Room' }],
      columns: kind === 'page:trend' ? doc.columns : [...doc.columns, { id: 'attr:Building', heading: 'Building', show: true }],
    };
  }

  it('the Data Report prints an attribute the profile has, and NAMES the one it lacks', async () => {
    const r = await buildDataReport({
      formatDateTime, values: USER_VALUES,
      sections: [{
        ...builtinSection('page:data-report', { availableIds: [...builtinIds('page:data-report'), 'attr:Building'] }),
        document: withAttributes('page:data-report'), builtin: false, input: dataA,
        attributes: { 'attr:Building': 'B-1', 'attr:Room': 'R-9' },
      }],
    });
    expect(headerTables(r.report)[0].body).toEqual([['Building :', 'B-1', 'Room :', '—']]);
    // The attribute COLUMN carries the instrument's value on every reading row.
    expect(recordTables(r.report)[0].body.map((row) => row[4])).toEqual(['B-1', 'B-1', 'B-1', 'B-1', 'B-1']);
    expect(notes(r.report)).toContain('Not available for this profile: Room');
  });

  it('the Instrument Alarms prints them too', async () => {
    const r = await buildInstrumentAlarmsReport({
      ...alarmsInput,
      ...builtinSection('page:instrument-alarms', { availableIds: [...builtinIds('page:instrument-alarms'), 'attr:Building', 'attr:Room'] }),
      document: withAttributes('page:instrument-alarms'), attributes: { 'attr:Building': 'B-1', 'attr:Room': 'R-9' },
      values: USER_VALUES,
    });
    expect(headerTables(r.report)[0].body).toEqual([['Building :', 'B-1', 'Room :', 'R-9']]);
    expect(recordTables(r.report)[0].body.map((row) => row[6])).toEqual(['B-1', 'B-1', 'B-1']);
  });

  it('the Instrument Trend has no rows — the attribute comes from the instrument, not from a row', async () => {
    const r = await buildTrendReport({
      ...trendInput, ...builtinSection('page:trend', { availableIds: ['attr:Building'] }),
      document: withAttributes('page:trend'), attributes: { 'attr:Building': 'B-1' }, values: USER_VALUES,
    });
    expect(headerTables(r.report)[0].body).toEqual([['Building :', 'B-1', 'Room :', '—']]);
    expect(notes(r.report)).toContain('Not available for this profile: Room');
  });
});

/** A saved Data Report template: its title naming the placement, and only DATE and TIME shown (TEMPERATURE hidden). */
function placementDocument(title: string, subtitle?: string): ReportTemplateDocument {
  const doc = builtinReportTemplate('page:data-report');
  return {
    ...doc,
    header: { ...doc.header, title, ...(subtitle !== undefined ? { subtitle } : {}) },
    columns: doc.columns.map((c) => ({ ...c, show: c.id === 'record.date' || c.id === 'record.time' })),
  };
}

describe('a Data Report\'s title carries every value its instruments SHARE (whole-branch review, Important 1)', () => {
  it('two instruments in one Area: {area} and {block} print; {instrument} and {location}, which differ, print —', async () => {
    const doc = placementDocument('Data Report {area} / {block} / {instrument} / {location} / {period}');
    const r = await buildDataReport({
      formatDateTime, values: USER_VALUES,
      sections: [
        // Instrument A placed in B's Area: the same Block and Area, its own code and Location.
        { ...builtinSection('page:data-report'), document: doc, builtin: false, input: { ...dataA, scope: { ...dataA.scope, areaName: 'QC 3' } } },
        { ...builtinSection('page:data-report'), document: doc, builtin: false, input: dataB },
      ],
    });
    expect(r.title).toBe('Data Report QC 3 / CWH Block / — / — / Last hour');
  });

  it('a value one instrument has and another lacks is not shared: an MKT on A only prints —', async () => {
    const doc = placementDocument('MKT {mkt} · {interval}');
    const r = await buildDataReport({
      formatDateTime, values: USER_VALUES,
      sections: [
        { ...builtinSection('page:data-report'), document: doc, builtin: false, input: dataA },
        { ...builtinSection('page:data-report'), document: doc, builtin: false, input: dataB },
      ],
    });
    // A has an MKT, B none; both have the dialog's 15-minute interval.
    expect(r.title).toBe('MKT — · 15 minutes');
  });

  it('one instrument: everything carries — its code, its Area, its Location, its limit', async () => {
    const r = await buildDataReport({
      formatDateTime, values: USER_VALUES,
      sections: [{
        ...builtinSection('page:data-report'),
        document: placementDocument('Data Report {area} / {instrument} / {location}', '{tempLimit} by {user}'),
        builtin: false, input: dataB,
      }],
    });
    expect(r.title).toBe('Data Report QC 3 / CWH/RDU/002-00 / LCMS Room-II');
    expect(limitText(dataB.temp)).not.toBe('');
    expect(r.subtitle).toBe(`${limitText(dataB.temp)} by alice`);
  });
});

describe('an EMPTY period under a SAVED template still says so — once (whole-branch review, Important 2)', () => {
  const sectionNotes = (report: ReportDoc) => report.getSnapshot().sections;

  it('a saved template that hides TEMPERATURE: a muted note after the table says the period is empty', async () => {
    const r = await buildDataReport({
      formatDateTime, values: USER_VALUES,
      sections: [{ ...builtinSection('page:data-report'), document: placementDocument('Saved'), builtin: false, input: dataB }],
    });
    const all = sectionNotes(r.report);
    const [table] = recordTables(r.report);
    // The row the template prints holds no statement: only DATE and TIME are shown.
    expect(table.head).toEqual(['DATE', 'TIME']);
    expect(table.body).toEqual([['-', '-']]);
    const note = all.find((s) => s.kind === 'note' && s.text === DATA_REPORT_EMPTY_TEXT);
    expect(note).toEqual({ kind: 'note', text: 'No readings in the selected period', color: 'muted' });
    expect(all.indexOf(note!)).toBeGreaterThan(all.indexOf(table));
  });

  it('a saved template that SHOWS TEMPERATURE: the row says it, and no note repeats it', async () => {
    const shown = placementDocument('Saved');
    shown.columns = shown.columns.map((c) => ({ ...c, show: c.id !== 'record.humidity' }));
    const r = await buildDataReport({
      formatDateTime, values: USER_VALUES,
      sections: [{ ...builtinSection('page:data-report'), document: shown, builtin: false, input: dataB }],
    });
    expect(recordTables(r.report)[0].body).toEqual([['-', '-', DATA_REPORT_EMPTY_TEXT]]);
    expect(notes(r.report)).not.toContain(DATA_REPORT_EMPTY_TEXT);
  });

  it('a saved template showing TEMPERATURE that the profile cannot fill: the note, since the cell prints empty', async () => {
    const shown = placementDocument('Saved');
    shown.columns = shown.columns.map((c) => ({ ...c, show: true }));
    const r = await buildDataReport({
      formatDateTime, values: USER_VALUES,
      sections: [{
        ...builtinSection('page:data-report', { availableIds: builtinIds('page:data-report').filter((id) => id !== 'record.temperature') }),
        document: shown, builtin: false, input: dataB,
      }],
    });
    expect(recordTables(r.report)[0].body[0][2]).toBe('');
    expect(notes(r.report)).toContain(DATA_REPORT_EMPTY_TEXT);
  });

  it('the BUILT-IN prints exactly what it did: the statement in its row, and no note', async () => {
    const r = await buildDataReport({
      formatDateTime, values: USER_VALUES, sections: [{ ...builtinSection('page:data-report'), input: dataB }],
    });
    expect(recordTables(r.report)[0].body).toEqual([['-', '-', DATA_REPORT_EMPTY_TEXT, '-']]);
    expect(notes(r.report)).not.toContain(DATA_REPORT_EMPTY_TEXT);
  });

  it('a period WITH readings under a saved template adds no such note', async () => {
    const r = await buildDataReport({
      formatDateTime, values: USER_VALUES,
      sections: [{ ...builtinSection('page:data-report'), document: placementDocument('Saved'), builtin: false, input: dataA }],
    });
    expect(notes(r.report)).not.toContain(DATA_REPORT_EMPTY_TEXT);
  });
});

describe('the plan helpers the download dialogs use', () => {
  const section = (instrumentIds: string[]) => ({
    profileId: 'p1', profileName: 'T&RH', instrumentIds, resolved: null, templates: [], availableIds: [],
  });
  const A = { id: 'a', code: 'CWH/RDU/001-00' };
  const B = { id: 'b', code: 'CWH/RDU/002-00' };

  it('planLeavesOut names the CODE of each instrument a LOADED plan left out, in the selection\'s order', () => {
    expect(planLeavesOut({ sections: [section(['a'])], loading: false, error: undefined }, [A, B])).toEqual(['CWH/RDU/002-00']);
    expect(planLeavesOut({ sections: [], loading: false, error: undefined }, [A, B])).toEqual(['CWH/RDU/001-00', 'CWH/RDU/002-00']);
    expect(planLeavesOut({ sections: [section(['a', 'b'])], loading: false, error: undefined }, [A, B])).toEqual([]);
  });

  it('planLeavesOut says nothing while the plan loads or after it failed — those say their own', () => {
    expect(planLeavesOut({ sections: [], loading: true, error: undefined }, [A])).toEqual([]);
    expect(planLeavesOut({ sections: [], loading: false, error: new Error('503') }, [A])).toEqual([]);
  });

  it('templateNamesAttributes: a SHOWN attr: column or an attr: info row — never a built-in', () => {
    const builtin = builtinReportTemplate('page:data-report');
    expect(templateNamesAttributes(builtin)).toBe(false);
    for (const kind of ['page:trend', 'page:instrument-alarms'] as const) expect(templateNamesAttributes(builtinReportTemplate(kind))).toBe(false);
    expect(templateNamesAttributes({ ...builtin, infoBlock: [{ label: 'Building', source: 'attr:Building' }] })).toBe(true);
    const column = { id: 'attr:Building', heading: 'Building', show: true };
    expect(templateNamesAttributes({ ...builtin, columns: [...builtin.columns, column] })).toBe(true);
    // A HIDDEN attr: column prints nothing, so it asks for nothing.
    expect(templateNamesAttributes({ ...builtin, columns: [...builtin.columns, { ...column, show: false }] })).toBe(false);
  });
});
