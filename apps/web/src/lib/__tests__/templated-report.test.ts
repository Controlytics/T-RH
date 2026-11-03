import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  builtinReportTemplate, REPORT_TEMPLATE_FIELDS, REPORT_VALUE_MISSING,
  type ReportTemplateColumn, type ReportTemplateDocument, type TemplateKind,
} from '@digilog/shared';
import { buildTemplatedReport, type TemplatedSection } from '../templated-report';
import { DEFAULT_TYPOGRAPHY, type SnapshotSection } from '../pdf-report';
import { scopeColumnStyles } from '../report-header-block';
import { DATA_REPORT_TYPOGRAPHY } from '../report-typography';

vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async () => ({})), post: vi.fn(), postWithReauth: vi.fn() },
}));

/**
 * `buildTemplatedReport` (2026-11-03, page reports on templates — spec
 * docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md §9):
 * the ONE builder a widget's report and every page report print through. What
 * it adds over the widget builder it grew out of — per-section notes before the
 * table, pictures with their titles, a bold grid, a page break, column widths,
 * the page kinds' ruled header block — is pinned here on the snapshot, the
 * record that is submitted for approval and replayed.
 */

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const formatDateTime = (d: string) => d.slice(0, 16).replace('T', ' ');

beforeEach(() => {
  // Branding and nothing else; the logo request fails (no logo drawn).
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (String(url).endsWith('/api/config/branding')) return { ok: true, json: async () => ({ companyName: 'Branding Co', appName: 'Branding App', logoUrl: '/logo.png' }) };
    return { ok: false };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const col = (id: string, heading: string, extra: Partial<ReportTemplateColumn> = {}): ReportTemplateColumn => ({ id, heading, show: true, ...extra });
const docFor = (kind: TemplateKind, patch: (d: ReportTemplateDocument) => void = () => {}) => { const d = builtinReportTemplate(kind); patch(d); return d; };
const builtinIds = (kind: TemplateKind) => REPORT_TEMPLATE_FIELDS(kind).map((f) => f.id);
const section = (over: Partial<TemplatedSection> & Pick<TemplatedSection, 'document' | 'rows'>): TemplatedSection => ({
  profileId: 'p1', profileName: 'T&RH', availableIds: builtinIds('latest_table'), ...over,
});

type Of<K extends SnapshotSection['kind']> = Extract<SnapshotSection, { kind: K }>;
const only = <K extends SnapshotSection['kind']>(s: SnapshotSection[], kind: K) => s.filter((x): x is Of<K> => x.kind === kind);

describe('buildTemplatedReport — what a section prints, and in what order', () => {
  /** The status grid's first two built-in fields, in order, and an info row: the bold grid is by built-in FIELD. */
  const twoCols = docFor('status_grid', (d) => {
    d.infoBlock = [{ label: 'Selection', source: 'selection' }];
    d.columns = [col('instrument.code', 'Instrument ID'), col('instrument.area', 'Area')];
  });

  it('title → info → notes before → pictures (each under its title) → table (bold carried) → page break → the next section', async () => {
    const r = await buildTemplatedReport({
      kind: 'status_grid', reportKey: 'Widget: Status grid', values: { selection: 'QC' }, formatDateTime,
      sections: [
        section({
          document: twoCols, rows: [{ 'instrument.code': 'A', 'instrument.area': 'QC' }], bold: [[true, false]],
          notes: [{ text: 'cap', color: 'muted', before: true }, { text: 'after the table', color: 'red' }],
          images: [{ dataUrl: PNG_1x1, title: 'Chart' }],
        }),
        section({ document: twoCols, rows: [{ 'instrument.code': 'B', 'instrument.area': 'QC 3' }], pageBreakBefore: true }),
      ],
    });
    const s = r.report.getSnapshot().sections;
    expect(s.map((x) => x.kind)).toEqual(['pairs', 'note', 'title', 'image', 'table', 'note', 'page-break', 'pairs', 'table']);
    expect(s[1]).toEqual({ kind: 'note', text: 'cap', color: 'muted' });
    expect(s[2]).toEqual({ kind: 'title', text: 'Chart' });
    expect(s[5]).toEqual({ kind: 'note', text: 'after the table', color: 'red' });
    const [first, second] = only(s, 'table');
    expect(first.body).toEqual([['A', 'QC']]);
    expect(first.bold).toEqual([[true, false]]);
    // A section that sends no grid prints none.
    expect(second).not.toHaveProperty('bold');
    expect(r.recordCount).toBe(2);
  });

  it('the bold grid follows its FIELD to whichever column shows it, in the template\'s order', async () => {
    const reordered = docFor('status_grid', (d) => {
      d.columns = [col('instrument.area', 'Area'), col('attr:Building', 'Building'), col('instrument.code', 'Instrument ID')];
    });
    const r = await buildTemplatedReport({
      kind: 'status_grid', reportKey: 'k', values: {}, formatDateTime,
      sections: [section({ document: reordered, availableIds: [...builtinIds('status_grid'), 'attr:Building'], rows: [{ 'instrument.code': 'A', 'instrument.area': 'QC', 'attr:Building': 'CWH' }], bold: [[true, false]] })],
    });
    expect(only(r.report.getSnapshot().sections, 'table')[0].bold).toEqual([[false, false, true]]);
  });

  it('a template that MERGES rows (a per-key type showing no per-key field) prints no bold: no input row to follow', async () => {
    const merged = docFor('latest_table', (d) => { d.columns = [col('instrument.code', 'Instrument ID'), col('key:temp', 'Temp')]; });
    const r = await buildTemplatedReport({
      kind: 'latest_table', reportKey: 'k', values: {}, formatDateTime,
      sections: [section({ document: merged, availableIds: [...builtinIds('latest_table'), 'key:temp'], rows: [
        { '#group': 'i1', 'instrument.code': 'A', 'key:temp': '21.5' }, { '#group': 'i1', 'instrument.code': 'A' },
      ], bold: [[true], [false]] })],
    });
    const [t] = only(r.report.getSnapshot().sections, 'table');
    expect(t.body).toEqual([['A', '21.5']]);
    expect(t).not.toHaveProperty('bold');
  });

  it('a page break is never put before the FIRST section', async () => {
    const r = await buildTemplatedReport({
      kind: 'status_grid', reportKey: 'k', values: {}, formatDateTime,
      sections: [section({ document: twoCols, rows: [], pageBreakBefore: true })],
    });
    expect(r.report.getSnapshot().sections.map((x) => x.kind)).not.toContain('page-break');
    expect(r.report.doc.getNumberOfPages()).toBe(1);
  });

  it('a section title rides on the info block that follows it', async () => {
    const r = await buildTemplatedReport({
      kind: 'status_grid', reportKey: 'k', values: {}, formatDateTime,
      sections: [section({ title: 'Profile: Alpha', document: twoCols, rows: [] })],
    });
    expect(only(r.report.getSnapshot().sections, 'pairs')[0].title).toBe('Profile: Alpha');
  });

  it('report-wide pictures print ONCE, before the first section', async () => {
    const r = await buildTemplatedReport({
      kind: 'status_grid', reportKey: 'k', values: {}, formatDateTime,
      leadImages: [{ dataUrl: PNG_1x1 }],
      sections: [section({ title: 'Profile: Alpha', document: twoCols, rows: [] }), section({ title: 'Profile: Beta', document: twoCols, rows: [] })],
    });
    const s = r.report.getSnapshot().sections;
    expect(s[0].kind).toBe('image');
    expect(only(s, 'image')).toHaveLength(1);
  });

  it('column widths are passed to the table as given', async () => {
    const r = await buildTemplatedReport({
      kind: 'page:audit-trail', reportKey: 'audit-trail', values: {}, formatDateTime,
      sections: [section({
        profileId: null, profileName: null, document: builtinReportTemplate('page:audit-trail'), availableIds: builtinIds('page:audit-trail'),
        rows: [{ 'audit.timestamp': '2026-11-03 10:00', 'audit.action': 'LOGIN' }],
        columnStyles: { 0: { cellWidth: 35 }, 5: { cellWidth: 65 } },
      })],
    });
    expect(only(r.report.getSnapshot().sections, 'table')[0].columnStyles).toEqual({ 0: { cellWidth: 35 }, 5: { cellWidth: 65 } });
  });
});

describe('buildTemplatedReport — the cells', () => {
  it('a STRING prints verbatim whatever the column\'s decimals (review C1); only a number is rounded', async () => {
    const document = docFor('trend_chart', (d) => { d.columns = [col('summary.max', 'Maximum', { decimals: 0 }), col('summary.min', 'Minimum', { decimals: 0 })]; });
    const r = await buildTemplatedReport({
      kind: 'trend_chart', reportKey: 'k', values: {}, formatDateTime,
      sections: [section({ document, availableIds: builtinIds('trend_chart'), rows: [{ 'summary.max': '25.4', 'summary.min': 20.6 }] })],
    });
    expect(only(r.report.getSnapshot().sections, 'table')[0].body).toEqual([['25.4', '21']]);
  });

  it('a shown column this profile cannot fill prints EMPTY cells and is named once, under the table', async () => {
    const document = docFor('page:instrument-alarms', (d) => { d.columns = [...d.columns, col('attr:Building', 'Building')]; });
    const r = await buildTemplatedReport({
      kind: 'page:instrument-alarms', reportKey: 'instrument-trend', values: {}, formatDateTime,
      sections: [section({ document, availableIds: builtinIds('page:instrument-alarms'), rows: [{ 'alarm.type': 'High Temperature', 'attr:Building': 'CWH' }] })],
    });
    const s = r.report.getSnapshot().sections;
    const records = only(s, 'table').find((t) => t.head.length > 0)!;
    expect(records.head.at(-1)).toBe('Building');
    expect(records.body[0].at(-1)).toBe('');
    expect(records.body[0][0]).toBe('High Temperature');
    expect(records.body[0][1]).toBe(REPORT_VALUE_MISSING);
    expect(only(s, 'note')).toEqual([{ kind: 'note', text: 'Not available for this profile: Building', color: 'muted' }]);
    expect(s.findIndex((x) => x.kind === 'note')).toBeGreaterThan(s.indexOf(records));
  });
});

describe('buildTemplatedReport — an intentionally empty cell (ruling T3-E)', () => {
  it('a PAGE kind prints exactly \'\' as empty; null, undefined and whitespace still print —; a WIDGET kind prints \'\' as — as before', async () => {
    const page = await buildTemplatedReport({
      kind: 'page:alarms', reportKey: 'alarms', values: {}, formatDateTime,
      sections: [section({
        profileId: null, profileName: null, document: builtinReportTemplate('page:alarms'), availableIds: builtinIds('page:alarms'),
        rows: [{ 'alarm.date': '03/11/2026', 'alarm.pv': null, 'alarm.high': '', 'alarm.low': '   ' }],
      })],
    });
    const [, records] = only(page.report.getSnapshot().sections, 'table');
    const at = (id: string) => records.body[0][builtinIds('page:alarms').indexOf(id)];
    expect(at('alarm.date')).toBe('03/11/2026');
    expect(at('alarm.high')).toBe('');
    expect(at('alarm.low')).toBe(REPORT_VALUE_MISSING);
    expect(at('alarm.pv')).toBe(REPORT_VALUE_MISSING);
    expect(at('alarm.uom')).toBe(REPORT_VALUE_MISSING);

    const widget = await buildTemplatedReport({
      kind: 'status_grid', reportKey: 'Widget: Status grid', values: {}, formatDateTime,
      sections: [section({ document: builtinReportTemplate('status_grid'), availableIds: builtinIds('status_grid'), rows: [{ 'instrument.code': 'A', 'instrument.area': '' }] })],
    });
    expect(only(widget.report.getSnapshot().sections, 'table')[0].body).toEqual([['A', REPORT_VALUE_MISSING, REPORT_VALUE_MISSING, REPORT_VALUE_MISSING]]);
  });
});

describe('buildTemplatedReport — page kinds', () => {
  const trendValues = {
    block: 'CWH', area: 'QC', location: 'Lab 1', instrument: 'CWH/RDU/001-00',
    fromDate: '01/11/2026', fromTime: '00:00', toDate: '02/11/2026', toTime: '00:00', series: 'Temperature',
  };

  it('page:trend has no fields: no table, no "No records." — its pictures print under their titles', async () => {
    const r = await buildTemplatedReport({
      kind: 'page:trend', reportKey: 'instrument-trend', values: trendValues, formatDateTime,
      sections: [section({
        document: builtinReportTemplate('page:trend'), availableIds: [], rows: [],
        images: [{ dataUrl: PNG_1x1, title: 'Temperature' }],
        notes: [{ text: 'Note: the chart is AVERAGED over 1 hour.', color: 'red', before: true }],
      })],
    });
    const s = r.report.getSnapshot().sections;
    expect(JSON.stringify(s)).not.toContain('No records.');
    expect(only(s, 'table').filter((t) => t.head.length > 0)).toEqual([]);
    expect(s.map((x) => x.kind)).toEqual(['table', 'note', 'title', 'image']);
    expect(r.title).toBe('Instrument Trend — Temperature');
    expect(r.recordCount).toBe(0);
  });

  it('a page kind\'s info rows print as the RULED HEADER BLOCK every page report has — label : value, two to a row', async () => {
    const r = await buildTemplatedReport({
      kind: 'page:trend', reportKey: 'instrument-trend', values: trendValues, formatDateTime,
      sections: [section({ document: builtinReportTemplate('page:trend'), availableIds: [], rows: [] })],
    });
    const [header] = only(r.report.getSnapshot().sections, 'table');
    expect(header.head).toEqual([]);
    expect(header.body).toEqual([
      ['Block :', 'CWH', 'Start Date :', '01/11/2026'],
      ['Area :', 'QC', 'Start Time :', '00:00'],
      ['Location :', 'Lab 1', 'End Date :', '02/11/2026'],
      ['Inst ID :', 'CWH/RDU/001-00', 'End Time :', '00:00'],
    ]);
    expect(header.columnStyles).toEqual(scopeColumnStyles());
    // A widget kind keeps its caption-over-value pairs.
    const w = await buildTemplatedReport({
      kind: 'latest_table', reportKey: 'k', values: { selection: 'QC' }, formatDateTime,
      sections: [section({ document: docFor('latest_table', (d) => { d.infoBlock = [{ label: 'Selection', source: 'selection' }]; }), rows: [] })],
    });
    expect(only(w.report.getSnapshot().sections, 'pairs')[0].pairs).toEqual([['Selection', 'QC']]);
  });

  it('a built-in header block may be handed over WHOLE (the Data Report\'s spans), in place of the document\'s info rows', async () => {
    const rows = [['Block :', 'CWH', 'Start Date :', '01/11/2026'], ['Interval :', { content: 'Raw (every reading)', colSpan: 3 }]];
    const r = await buildTemplatedReport({
      kind: 'page:data-report', reportKey: 'instrument-trend', values: {}, formatDateTime,
      sections: [section({ document: builtinReportTemplate('page:data-report'), availableIds: builtinIds('page:data-report'), rows: [], infoBlockRows: rows })],
    });
    const [header] = only(r.report.getSnapshot().sections, 'table');
    expect(header.body).toEqual(rows);
  });

  it('the Data Report\'s typography and app-name line come from its document; reportKey is the snapshot\'s reportType', async () => {
    const r = await buildTemplatedReport({
      kind: 'page:data-report', reportKey: 'instrument-trend', values: {}, formatDateTime,
      sections: [section({ document: builtinReportTemplate('page:data-report'), availableIds: builtinIds('page:data-report'), rows: [] })],
    });
    const snap = r.report.getSnapshot();
    expect(snap.reportType).toBe('instrument-trend');
    expect(snap.version).toBe(3);
    expect(snap.config.typography?.tablePt).toBe(DATA_REPORT_TYPOGRAPHY.tablePt);
    expect(snap.chrome?.showAppName).toBe(false);
    expect(snap.chrome?.companyName).toBe('Branding Co');
    const a = await buildTemplatedReport({
      kind: 'page:alarms', reportKey: 'alarms', values: {}, formatDateTime,
      sections: [section({ profileId: null, profileName: null, document: builtinReportTemplate('page:alarms'), availableIds: builtinIds('page:alarms'), rows: [] })],
    });
    expect(a.report.getSnapshot().config.typography?.tablePt).toBe(DEFAULT_TYPOGRAPHY.tablePt);
  });

  it('legend: the page\'s structured legend prints when the chrome document has none; a template\'s own legend replaces it', async () => {
    const legend = [{ abbr: 'NMT', meaning: 'Not More Than' }];
    const builtin = await buildTemplatedReport({
      kind: 'page:alarms', reportKey: 'alarms', values: {}, formatDateTime, legend,
      sections: [section({ profileId: null, profileName: null, document: builtinReportTemplate('page:alarms'), availableIds: builtinIds('page:alarms'), rows: [] })],
    });
    expect(builtin.report.getSnapshot().config.legend).toEqual(legend);
    const own = await buildTemplatedReport({
      kind: 'page:alarms', reportKey: 'alarms', values: {}, formatDateTime, legend,
      sections: [section({ profileId: null, profileName: null, document: docFor('page:alarms', (d) => { d.notes = { legend: 'H = High' }; }), availableIds: builtinIds('page:alarms'), rows: [] })],
    });
    expect(own.report.getSnapshot().config.legend).toBeUndefined();
    expect(own.report.getSnapshot().chrome?.legend).toBe('H = High');
  });

  it('{profile} names each profile ONCE across a report of one instrument per section', async () => {
    const document = docFor('page:data-report', (d) => { d.header.subtitle = '{profile}'; });
    const r = await buildTemplatedReport({
      kind: 'page:data-report', reportKey: 'instrument-trend', values: {}, formatDateTime,
      sections: [
        section({ document, availableIds: builtinIds('page:data-report'), rows: [] }),
        section({ document, availableIds: builtinIds('page:data-report'), rows: [], pageBreakBefore: true }),
        section({ profileId: 'p2', profileName: 'Pressure', document, availableIds: builtinIds('page:data-report'), rows: [], pageBreakBefore: true }),
      ],
    });
    expect(r.subtitle).toBe('T&RH, Pressure');
  });
});

/** Fix round 1 (2026-11-03): rulings T3-A, T3-B and T3-C. */
describe('buildTemplatedReport — what a page hands over beyond its rows', () => {
  const locationRow = docFor('page:trend', (d) => { d.infoBlock = [{ label: 'Location', source: 'attr:Location' }]; });
  const trendSection = (over: Partial<TemplatedSection>) => section({ document: locationRow, rows: [], availableIds: ['attr:Location'], ...over });
  const headerOf = async (s: TemplatedSection) => {
    const r = await buildTemplatedReport({ kind: 'page:trend', reportKey: 'instrument-trend', values: {}, formatDateTime, sections: [s] });
    const snap = r.report.getSnapshot().sections;
    return { body: only(snap, 'table')[0].body, notes: only(snap, 'note').map((n) => n.text) };
  };

  it('T3-A — an attr: info row prints the section\'s own `attributes` (a trend section has no rows to read it from)', async () => {
    const got = await headerOf(trendSection({ attributes: { 'attr:Location': 'Lab 1' } }));
    expect(got.body).toEqual([['Location :', 'Lab 1', '', '']]);
    expect(got.notes).toEqual([]);
  });

  it('T3-A — the key absent prints —; the catalogue lacking it also NAMES it "Not available"', async () => {
    const absent = await headerOf(trendSection({ attributes: { 'attr:Building': 'CWH' } }));
    expect(absent.body).toEqual([['Location :', REPORT_VALUE_MISSING, '', '']]);
    expect(absent.notes).toEqual([]);
    const notInCatalogue = await headerOf(trendSection({ availableIds: [], attributes: { 'attr:Location': 'Lab 1' } }));
    expect(notInCatalogue.body).toEqual([['Location :', REPORT_VALUE_MISSING, '', '']]);
    expect(notInCatalogue.notes).toEqual(['Not available for this profile: Location']);
  });

  it('T3-A — attributes win over the rows; the rows are still the fallback', async () => {
    const document = docFor('page:instrument-alarms', (d) => { d.infoBlock = [{ label: 'Building', source: 'attr:Building' }, { label: 'Room', source: 'attr:Room' }]; });
    const r = await buildTemplatedReport({
      kind: 'page:instrument-alarms', reportKey: 'instrument-trend', values: {}, formatDateTime,
      sections: [section({
        document, availableIds: [...builtinIds('page:instrument-alarms'), 'attr:Building', 'attr:Room'], attributes: { 'attr:Building': 'CWH' },
        rows: [{ 'instrument.code': 'A', 'attr:Building': 'from a row', 'attr:Room': 'R-12' }],
      })],
    });
    expect(only(r.report.getSnapshot().sections, 'table')[0].body).toEqual([['Building :', 'CWH', 'Room :', 'R-12']]);
  });

  it('T3-B — a `before` note styled as a TITLE rides on the records table, as the 2,000-row cap notice always has', async () => {
    const cap = 'Truncated: showing the first 2,000 of 2,500 rows for Last 30 days. Narrow the period for a complete report.';
    const r = await buildTemplatedReport({
      kind: 'page:instrument-alarms', reportKey: 'instrument-trend', values: {}, formatDateTime,
      sections: [section({
        document: builtinReportTemplate('page:instrument-alarms'), availableIds: builtinIds('page:instrument-alarms'),
        rows: [{ 'alarm.type': 'High Temperature' }], notes: [{ text: cap, before: true, style: 'title' }],
      })],
    });
    const s = r.report.getSnapshot().sections;
    expect(s.map((x) => x.kind)).toEqual(['table', 'table']);
    const records = only(s, 'table')[1];
    expect(records.title).toBe(cap);
    expect(records.head[0]).toBe('Type');
  });

  it('T3-B — a picture that could not be made prints its title and WHY, in its place; with no reason, "No chart image"', async () => {
    const r = await buildTemplatedReport({
      kind: 'page:trend', reportKey: 'instrument-trend', values: {}, formatDateTime,
      sections: [section({
        document: builtinReportTemplate('page:trend'), availableIds: [], rows: [],
        images: [
          { title: 'Temperature', missingText: 'No temperature readings in this period.' },
          { dataUrl: PNG_1x1, title: 'Humidity' },
          { title: 'Pressure' },
        ],
      })],
    });
    const s = r.report.getSnapshot().sections;
    expect(s.map((x) => x.kind)).toEqual(['table', 'title', 'note', 'title', 'image', 'title', 'note']);
    expect(s[1]).toEqual({ kind: 'title', text: 'Temperature' });
    expect(s[2]).toEqual({ kind: 'note', text: 'No temperature readings in this period.', color: 'muted' });
    expect(s[6]).toEqual({ kind: 'note', text: 'No chart image', color: 'muted' });
  });

  it('T3-C — a kind with NO table names the columns its template shows, once, after the info block, and prints no table', async () => {
    const document = docFor('page:trend', (d) => { d.columns = [col('attr:Building', 'Building', { unit: 'site' }), col('attr:Room', 'Room'), col('attr:Floor', 'Floor', { show: false })]; });
    const r = await buildTemplatedReport({
      kind: 'page:trend', reportKey: 'instrument-trend', values: {}, formatDateTime,
      sections: [section({ document, availableIds: ['attr:Building', 'attr:Room'], rows: [], images: [{ dataUrl: PNG_1x1, title: 'Temperature' }] })],
    });
    const s = r.report.getSnapshot().sections;
    expect(s.map((x) => x.kind)).toEqual(['table', 'note', 'title', 'image']);
    expect(s[1]).toEqual({ kind: 'note', text: 'This report has no table; columns not printed: Building (site), Room', color: 'muted' });
    expect(only(s, 'table').filter((t) => t.head.length > 0)).toEqual([]);
    // A fieldless kind whose template shows no column says nothing.
    const plain = await buildTemplatedReport({
      kind: 'page:trend', reportKey: 'instrument-trend', values: {}, formatDateTime,
      sections: [section({ document: builtinReportTemplate('page:trend'), availableIds: [], rows: [] })],
    });
    expect(only(plain.report.getSnapshot().sections, 'note')).toEqual([]);
  });
});
