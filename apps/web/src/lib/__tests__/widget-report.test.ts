import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  builtinReportTemplate, REPORT_VALUE_MISSING, WIDGET_REPORT_FIELDS,
  type ReportTemplateDocument, type ReportTemplateColumn, type WidgetType,
} from '@digilog/shared';
import { buildWidgetReport, formatReportCell, reportColumnHeading, REPORT_ROW_GROUP, type WidgetReportRow, type WidgetReportSection } from '../widget-report';
import { loadReportChrome, renderSnapshotToPdf, normaliseSnapshot, DEFAULT_TYPOGRAPHY, type SnapshotSection } from '../pdf-report';
import { DATA_REPORT_TYPOGRAPHY } from '@/routes/instruments/data-report';

vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: vi.fn(async (url: string) => (url.includes('report-page-titles') ? { companyName: 'Titles Co', appName: '' } : {})),
    post: vi.fn(), postWithReauth: vi.fn(),
  },
}));

/**
 * The widget report builder (2026-11-02): one PDF per widget download, one
 * SECTION per instrument profile, each section's columns from its own
 * template; the chrome (header, logo, footer, page) from the FIRST section's.
 * Spec docs/superpowers/specs/2026-11-02-widget-report-templates-design.md
 * §6-§8. Every assertion reads `getSnapshot()` — the record that is submitted
 * for approval and replayed — so what is pinned is what is signed.
 */

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Uint8Array.from(atob(PNG_1x1.split(',')[1]), (c) => c.charCodeAt(0));
/** A valid 1 x 4 greyscale PNG: four times taller than wide. */
const PNG_1x4 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAECAAAAABqswrmAAAADElEQVR4nGNoYABDAAgIAgGxLR1jAAAAAElFTkSuQmCC';
const formatDateTime = (d: string) => d.slice(0, 16).replace('T', ' ');

/** Branding (public) and the branding logo; anything else is unexpected. */
function stubBranding() {
  const fetchSpy = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.endsWith('/api/config/branding')) return { ok: true, json: async () => ({ companyName: 'Branding Co', appName: 'Branding App', logoUrl: '/logo.png' }) };
    if (u === '/logo.png') return { ok: true, blob: async () => new Blob([PNG_BYTES], { type: 'image/png' }) };
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function col(id: string, heading: string, extra: Partial<ReportTemplateColumn> = {}): ReportTemplateColumn {
  return { id, heading, show: true, ...extra };
}

function docFor(type: WidgetType, patch: (d: ReportTemplateDocument) => void = () => {}): ReportTemplateDocument {
  const d = builtinReportTemplate(type);
  patch(d);
  return d;
}

const ALL_BUILTIN = (t: WidgetType) => WIDGET_REPORT_FIELDS[t].map((f) => f.id);

function section(over: Partial<WidgetReportSection> & Pick<WidgetReportSection, 'document' | 'rows'>): WidgetReportSection {
  return { profileId: 'p1', profileName: 'T&RH', availableIds: ALL_BUILTIN('latest_table'), ...over };
}

const tables = (s: SnapshotSection[]) => s.filter((x): x is Extract<SnapshotSection, { kind: 'table' }> => x.kind === 'table');
const notes = (s: SnapshotSection[]) => s.filter((x): x is Extract<SnapshotSection, { kind: 'note' }> => x.kind === 'note');
const pairsOf = (s: SnapshotSection[]) => s.filter((x): x is Extract<SnapshotSection, { kind: 'pairs' }> => x.kind === 'pairs');

beforeEach(async () => {
  const { apiClient } = await import('@/lib/api-client');
  (apiClient.get as any).mockClear();
  stubBranding();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('buildWidgetReport — columns', () => {
  it('prints the SHOWN columns in the DOCUMENT\'s order, under the document\'s headings; a hidden column is absent', async () => {
    const document = docFor('latest_table', (d) => {
      d.columns = [
        col('reading.value', 'Reading', { decimals: 1, unit: '°C' }),
        col('instrument.code', 'Tag'),
        col('instrument.area', 'Area', { show: false }),
        col('key.label', 'Parameter'),
      ];
    });
    const rows = [
      { 'instrument.code': 'CWH/RDU/001-00', 'instrument.area': 'QC', 'key.label': 'Temperature', 'reading.value': 21.456 },
      { 'instrument.code': 'CWH/RDU/002-00', 'instrument.area': 'QC', 'key.label': 'Temperature', 'reading.value': 22 },
    ];
    const { report, recordCount } = await buildWidgetReport({ widgetType: 'latest_table', values: {}, sections: [section({ document, rows })], formatDateTime });
    const [t] = tables(report.getSnapshot().sections);
    expect(t.head).toEqual(['Reading (°C)', 'Tag', 'Parameter']);
    expect(t.body).toEqual([['21.5', 'CWH/RDU/001-00', 'Temperature'], ['22.0', 'CWH/RDU/002-00', 'Temperature']]);
    expect(JSON.stringify(t)).not.toContain('QC');
    expect(recordCount).toBe(2);
  });

  it('a column the profile does not have prints EMPTY cells and is named ONCE under the table; a missing value prints —', async () => {
    const document = docFor('latest_table', (d) => {
      d.columns = [col('instrument.code', 'Instrument ID'), col('key:Pressure', 'Pressure'), col('reading.ts', 'Reading time'), col('attr:Building', 'Building')];
    });
    const rows = [{ 'instrument.code': 'A', 'reading.ts': null, 'key:Pressure': 5 }];
    const { report } = await buildWidgetReport({
      widgetType: 'latest_table', values: {}, formatDateTime,
      sections: [section({ document, rows, availableIds: ['instrument.code', 'reading.ts'] })],
    });
    const s = report.getSnapshot().sections;
    const [t] = tables(s);
    expect(t.body).toEqual([['A', '', REPORT_VALUE_MISSING, '']]);
    expect(notes(s)).toEqual([{ kind: 'note', text: 'Not available for this profile: Pressure, Building', color: 'muted' }]);
    // Under the table, never above it.
    expect(s.findIndex((x) => x.kind === 'note')).toBeGreaterThan(s.findIndex((x) => x.kind === 'table'));
  });

  it('no table rows → the heading row and one "No records." line, counted as nothing', async () => {
    const { report, recordCount } = await buildWidgetReport({
      widgetType: 'status_grid', values: {}, formatDateTime,
      sections: [section({ document: builtinReportTemplate('status_grid'), rows: [], availableIds: ALL_BUILTIN('status_grid') })],
    });
    const [t] = tables(report.getSnapshot().sections);
    expect(t.head).toEqual(['Instrument ID', 'Area', 'Location', 'Status']);
    expect(t.body).toEqual([[{ content: 'No records.', colSpan: 4 }]]);
    expect(recordCount).toBe(0);
  });
});

describe('formatReportCell / reportColumnHeading', () => {
  it('decimals apply to a NUMBER only (a raw, unjudged key); TEXT — the server\'s or the widget\'s formatting — prints verbatim (review C1)', () => {
    const c = col('reading.value', 'Value', { decimals: 2 });
    expect(formatReportCell(21.456, c)).toBe('21.46');
    expect(formatReportCell(21.46, col('reading.value', 'Value', { decimals: 1 }))).toBe('21.5');
    // A measured reading already at the instrument's administered precision is
    // never re-rounded: fewer decimals could hide an excursion (25.4 → "25"),
    // more would state a precision never recorded (21.5 → "21.500").
    expect(formatReportCell('21.4', c)).toBe('21.4');
    expect(formatReportCell('25.4', col('summary.max', 'Maximum', { decimals: 0 }))).toBe('25.4');
    expect(formatReportCell('-3', c)).toBe('-3');
    for (const w of ['Error', 'OL', 'NA', '21.5 °C', '1e3']) expect(formatReportCell(w, c)).toBe(w);
    expect(formatReportCell(null, c)).toBe(REPORT_VALUE_MISSING);
    expect(formatReportCell(undefined, c)).toBe(REPORT_VALUE_MISSING);
    expect(formatReportCell('  ', c)).toBe(REPORT_VALUE_MISSING);
    expect(formatReportCell(Number.NaN, c)).toBe(REPORT_VALUE_MISSING);
    // No decimals set: as given.
    expect(formatReportCell(21.456, col('reading.value', 'Value'))).toBe('21.456');
    expect(formatReportCell('21.456', col('reading.value', 'Value'))).toBe('21.456');
  });

  it('a unit goes beside the heading', () => {
    expect(reportColumnHeading(col('reading.value', 'Value', { unit: '°C' }))).toBe('Value (°C)');
    expect(reportColumnHeading(col('reading.value', 'Value', { unit: '  ' }))).toBe('Value');
    expect(reportColumnHeading(col('reading.value', 'Value'))).toBe('Value');
  });
});

describe('buildWidgetReport — the title, the chrome, the sections', () => {
  it('title and subtitle are the FIRST document\'s, placeholders substituted; an absent {to} prints —', async () => {
    const document = docFor('value_cards', (d) => { d.header.title = 'Readings {from} to {to}'; d.header.subtitle = '{dashboard} · {profile}'; });
    const r = await buildWidgetReport({
      widgetType: 'value_cards', values: { from: '01/11/2026', dashboard: 'QC Floor' }, formatDateTime,
      sections: [section({ document, rows: [] })],
    });
    expect(r.title).toBe('Readings 01/11/2026 to —');
    expect(r.subtitle).toBe('QC Floor · T&RH');
    const snap = r.report.getSnapshot();
    expect(snap.title).toBe(r.title);
    expect(snap.subtitle).toBe(r.subtitle);
    expect(snap.reportType).toBe('Widget: Value cards');
  });

  it('the footer text\'s placeholders are filled with the title\'s values, and the FROZEN chrome carries the filled text (review I1)', async () => {
    const document = docFor('gauge', (d) => { d.footer = { ...d.footer, text: 'Printed {date} by {user} for {profile} {nope}' }; });
    const r = await buildWidgetReport({
      widgetType: 'gauge', values: { date: '02/11/2026', user: 'superadmin' }, formatDateTime,
      sections: [section({ document, rows: [], availableIds: ALL_BUILTIN('gauge') })],
    });
    const filled = 'Printed 02/11/2026 by superadmin for T&RH —';
    expect(r.report.getSnapshot().chrome?.footer.text).toBe(filled);
    r.report.save('footer-filled.pdf');
    const stream = (r.report.doc.internal as any).pages.filter(Boolean).flat().join('\n');
    expect(stream).toContain('(Printed 02/11/2026 by superadmin for T&RH');
    expect(stream).not.toContain('{date}');
  });

  it('two profiles → two sections titled "Profile: <name>", each with its own columns; the chrome is the FIRST\'s', async () => {
    const alpha = docFor('latest_table', (d) => {
      d.header.companyName = 'Alpha Co'; d.page.orientation = 'landscape';
      d.columns = [col('instrument.code', 'Alpha ID'), col('reading.value', 'Alpha value')];
    });
    const beta = docFor('latest_table', (d) => {
      d.header.companyName = 'Beta Co'; d.page.orientation = 'portrait';
      d.columns = [col('instrument.location', 'Beta place'), col('instrument.code', 'Beta ID')];
    });
    const r = await buildWidgetReport({
      widgetType: 'latest_table', values: { selection: 'QC', instrumentCount: '3' }, formatDateTime,
      sections: [
        section({ profileId: 'pa', profileName: 'Alpha', document: alpha, rows: [{ 'instrument.code': 'A1', 'reading.value': 1 }, { 'instrument.code': 'A2', 'reading.value': 2 }] }),
        section({ profileId: 'pb', profileName: 'Beta', document: beta, rows: [{ 'instrument.code': 'B1', 'instrument.location': 'Lab' }] }),
      ],
    });
    const snap = r.report.getSnapshot();
    expect(snap.chrome?.companyName).toBe('Alpha Co');
    expect(snap.chrome?.orientation).toBe('landscape');
    expect(r.report.pw).toBeGreaterThan(r.report.ph);
    // The section title rides on the info block that follows it.
    expect(pairsOf(snap.sections).map((p) => p.title)).toEqual(['Profile: Alpha', 'Profile: Beta']);
    const [ta, tb] = tables(snap.sections);
    expect(ta.head).toEqual(['Alpha ID', 'Alpha value']);
    expect(tb.head).toEqual(['Beta place', 'Beta ID']);
    expect(tb.body).toEqual([['Lab', 'B1']]);
    expect(r.recordCount).toBe(3);
  });

  it('one profile → no "Profile:" title', async () => {
    const r = await buildWidgetReport({ widgetType: 'latest_table', values: {}, formatDateTime, sections: [section({ document: builtinReportTemplate('latest_table'), rows: [] })] });
    expect(JSON.stringify(r.report.getSnapshot().sections)).not.toContain('Profile:');
  });

  it('typography "data-report" prints at the Data Report\'s scale; "default" at the shared one', async () => {
    const dr = docFor('timeseries_table', (d) => { d.page.typography = 'data-report'; });
    const a = await buildWidgetReport({ widgetType: 'timeseries_table', values: {}, formatDateTime, sections: [section({ document: dr, rows: [] })] });
    expect(a.report.getSnapshot().config.typography?.tablePt).toBe(DATA_REPORT_TYPOGRAPHY.tablePt);
    expect(a.report.getSnapshot().config.typography?.tableHeadAlign).toBe('center');
    const b = await buildWidgetReport({ widgetType: 'timeseries_table', values: {}, formatDateTime, sections: [section({ document: builtinReportTemplate('timeseries_table'), rows: [] })] });
    expect(b.report.getSnapshot().config.typography?.tablePt).toBe(DEFAULT_TYPOGRAPHY.tablePt);
  });

  it('no sections at all → the widget type\'s built-in chrome and one line saying so', async () => {
    const r = await buildWidgetReport({ widgetType: 'gauge', values: { widget: 'Freezer gauge', selection: 'QC' }, formatDateTime, sections: [] });
    expect(r.title).toBe('Freezer gauge');
    expect(r.recordCount).toBe(0);
    const s = r.report.getSnapshot().sections;
    expect(notes(s).map((n) => n.text)).toEqual(['No instruments in this selection.']);
    expect(tables(s)).toEqual([]);
  });

  it('a v3 widget report replays with NO fetch at all', async () => {
    const document = docFor('gauge', (d) => { d.header.logo = { mode: 'custom', dataUrl: PNG_1x1 }; });
    const r = await buildWidgetReport({ widgetType: 'gauge', values: {}, formatDateTime, sections: [section({ document, rows: [{ 'instrument.code': 'A' }], availableIds: ALL_BUILTIN('gauge') })] });
    const stored = normaliseSnapshot(JSON.parse(JSON.stringify(r.report.getSnapshot())));
    expect(stored.version).toBe(3);
    const fetchSpy = vi.fn(async () => { throw new Error('no fetch on replay'); });
    vi.stubGlobal('fetch', fetchSpy);
    const replay = await renderSnapshotToPdf(stored, { formatDateTime });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replay.getSnapshot().sections).toEqual(stored.sections);
  });
});

describe('buildWidgetReport — the info block', () => {
  it('placeholders and the section\'s own values; an absent value prints — (not the generic "-")', async () => {
    const document = docFor('latest_table', (d) => {
      d.infoBlock = [{ label: 'Selection', source: 'selection' }, { label: 'Instruments', source: 'instrumentCount' }, { label: 'Profile', source: 'profile' }, { label: 'To', source: 'to' }];
    });
    const r = await buildWidgetReport({
      widgetType: 'latest_table', values: { selection: 'QC Block', instrumentCount: '9' }, formatDateTime,
      sections: [section({ document, rows: [], values: { instrumentCount: '2' } })],
    });
    expect(pairsOf(r.report.getSnapshot().sections)[0].pairs).toEqual([
      ['Selection', 'QC Block'], ['Instruments', '2'], ['Profile', 'T&RH'], ['To', REPORT_VALUE_MISSING],
    ]);
  });

  it('an info row whose source the profile does not have prints — and is named in the ONE "Not available" line with the columns (review m3)', async () => {
    const document = docFor('latest_table', (d) => {
      d.infoBlock = [{ label: 'Building', source: 'attr:Building' }, { label: 'Selection', source: 'selection' }];
      d.columns = [col('instrument.code', 'Instrument ID'), col('key:Pressure', 'Pressure')];
    });
    const r = await buildWidgetReport({
      widgetType: 'latest_table', values: { selection: 'QC' }, formatDateTime,
      // The row CARRIES a Building value; the catalogue says this profile has no such attribute.
      sections: [section({ document, availableIds: ['instrument.code'], rows: [{ 'instrument.code': 'A', 'attr:Building': 'CWH', 'key:Pressure': 5 }] })],
    });
    const s = r.report.getSnapshot().sections;
    expect(pairsOf(s)[0].pairs).toEqual([['Building', REPORT_VALUE_MISSING], ['Selection', 'QC']]);
    expect(notes(s)).toEqual([{ kind: 'note', text: 'Not available for this profile: Building, Pressure', color: 'muted' }]);
  });

  it('a fieldless widget still names an info row its profile does not have', async () => {
    const document = docFor('floorplan', (d) => { d.infoBlock = [{ label: 'Building', source: 'attr:Building' }]; });
    const r = await buildWidgetReport({
      widgetType: 'floorplan', values: {}, formatDateTime,
      sections: [section({ document, availableIds: [], rows: [], imageDataUrl: PNG_1x1 })],
    });
    expect(notes(r.report.getSnapshot().sections).map((n) => n.text)).toEqual(['Not available for this profile: Building']);
  });

  it('an attr: row prints the attribute of a ONE-instrument section; several instruments → —', async () => {
    const document = docFor('latest_table', (d) => { d.infoBlock = [{ label: 'Building', source: 'attr:Building' }]; });
    const one = await buildWidgetReport({
      widgetType: 'latest_table', values: {}, formatDateTime,
      sections: [section({ document, availableIds: [...ALL_BUILTIN('latest_table'), 'attr:Building'], rows: [
        { 'instrument.code': 'A', 'key.label': 'Temperature', 'attr:Building': null },
        { 'instrument.code': 'A', 'key.label': 'Humidity', 'attr:Building': 'CWH' },
      ] })],
    });
    expect(pairsOf(one.report.getSnapshot().sections)[0].pairs).toEqual([['Building', 'CWH']]);
    const two = await buildWidgetReport({
      widgetType: 'latest_table', values: {}, formatDateTime,
      sections: [section({ document, availableIds: [...ALL_BUILTIN('latest_table'), 'attr:Building'], rows: [
        { 'instrument.code': 'A', 'attr:Building': 'CWH' }, { 'instrument.code': 'B', 'attr:Building': 'CWH' },
      ] })],
    });
    expect(pairsOf(two.report.getSnapshot().sections)[0].pairs).toEqual([['Building', REPORT_VALUE_MISSING]]);
  });
});

describe('buildWidgetReport — the row grain (keyRowsCollapse)', () => {
  const twoInstrumentsLong: WidgetReportRow[] = [
    { [REPORT_ROW_GROUP]: 'i1', 'instrument.code': 'A', 'key.label': 'Temperature', 'reading.value': 21, 'key:Temperature': 21, 'attr:Building': 'CWH' },
    { [REPORT_ROW_GROUP]: 'i1', 'instrument.code': 'A', 'key.label': 'Humidity', 'reading.value': 45, 'key:Humidity': 45 },
    { [REPORT_ROW_GROUP]: 'i2', 'instrument.code': 'B', 'key.label': 'Temperature', 'reading.value': 22, 'key:Temperature': 22, 'attr:Building': 'QC' },
    { [REPORT_ROW_GROUP]: 'i2', 'instrument.code': 'B', 'key.label': 'Humidity', 'reading.value': 50, 'key:Humidity': 50 },
  ];
  const ids = [...ALL_BUILTIN('value_cards'), 'key:Temperature', 'key:Humidity', 'attr:Building'];

  it('a template showing NO per-key field prints ONE row per instrument, its keys side by side', async () => {
    const document = docFor('value_cards', (d) => {
      d.columns = [
        col('instrument.code', 'Instrument ID'), col('key:Temperature', 'Temp', { decimals: 1 }), col('key:Humidity', 'RH'),
        col('key.label', 'Key', { show: false }), col('reading.value', 'Value', { show: false }),
      ];
    });
    const r = await buildWidgetReport({ widgetType: 'value_cards', values: {}, formatDateTime, sections: [section({ document, rows: twoInstrumentsLong, availableIds: ids })] });
    expect(tables(r.report.getSnapshot().sections)[0].body).toEqual([['A', '21.0', '45'], ['B', '22.0', '50']]);
    expect(r.recordCount).toBe(2);
  });

  it('a template showing a per-key field keeps one row per KEY; an instrument\'s key:/attr: cells fill every one of its rows', async () => {
    const document = docFor('value_cards', (d) => {
      d.columns = [col('instrument.code', 'Instrument ID'), col('key.label', 'Key'), col('reading.value', 'Value'), col('attr:Building', 'Building')];
    });
    const r = await buildWidgetReport({ widgetType: 'value_cards', values: {}, formatDateTime, sections: [section({ document, rows: twoInstrumentsLong, availableIds: ids })] });
    expect(tables(r.report.getSnapshot().sections)[0].body).toEqual([
      ['A', 'Temperature', '21', 'CWH'], ['A', 'Humidity', '45', 'CWH'],
      ['B', 'Temperature', '22', 'QC'], ['B', 'Humidity', '50', 'QC'],
    ]);
    expect(r.recordCount).toBe(4);
  });

  it('rows that name no group are printed exactly as given — never merged on a display string', async () => {
    const document = docFor('timeseries_table', (d) => { d.columns = [col('reading.ts', 'Time'), col('instrument.code', 'ID'), col('key:Temperature', 'Temp')]; });
    // Two instants that FORMAT to the same minute are two readings, not one.
    const rows = [
      { 'reading.ts': '02/11/2026 10:00', 'instrument.code': 'A', 'key:Temperature': 21 },
      { 'reading.ts': '02/11/2026 10:00', 'instrument.code': 'A', 'key:Temperature': 22 },
    ];
    const r = await buildWidgetReport({
      widgetType: 'timeseries_table', values: {}, formatDateTime,
      sections: [section({ document, rows, availableIds: [...ALL_BUILTIN('timeseries_table'), 'key:Temperature'] })],
    });
    expect(tables(r.report.getSnapshot().sections)[0].body).toHaveLength(2);
    expect(r.recordCount).toBe(2);
  });
});

describe('buildWidgetReport — what a widget SHOWS', () => {
  it('a text card prints its text as a paragraph, no table', async () => {
    const r = await buildWidgetReport({
      widgetType: 'text_card', values: {}, formatDateTime,
      sections: [section({ document: builtinReportTemplate('text_card'), rows: [{ text: 'Shift notes: door 3 sticks' }], availableIds: [] })],
    });
    const s = r.report.getSnapshot().sections;
    expect(notes(s)).toEqual([{ kind: 'note', text: 'Shift notes: door 3 sticks', color: 'text' }]);
    expect(tables(s)).toEqual([]);
    expect(r.recordCount).toBe(0);
  });

  it('a chart prints its image before its table, the text column wide at its own proportions', async () => {
    const r = await buildWidgetReport({
      widgetType: 'trend_chart', values: {}, formatDateTime,
      sections: [section({
        document: builtinReportTemplate('trend_chart'), availableIds: ALL_BUILTIN('trend_chart'),
        rows: [{ 'instrument.code': 'A', 'summary.min': 20 }], imageDataUrl: PNG_1x1,
      })],
    });
    const s = r.report.getSnapshot().sections;
    const kinds = s.map((x) => x.kind);
    expect(kinds.indexOf('image')).toBeGreaterThan(kinds.indexOf('pairs'));
    expect(kinds.indexOf('image')).toBeLessThan(kinds.indexOf('table'));
    const img = s.find((x) => x.kind === 'image') as Extract<SnapshotSection, { kind: 'image' }>;
    const textW = r.report.pw - 28;
    expect(img.widthMm).toBeCloseTo(textW, 5);
    expect(img.heightMm).toBeCloseTo(textW, 5); // a 1 x 1 picture stays square
  });

  it('a picture taller than the page is scaled DOWN to fit it, keeping its proportions', async () => {
    const r = await buildWidgetReport({
      widgetType: 'trend_chart', values: {}, formatDateTime,
      sections: [section({ document: builtinReportTemplate('trend_chart'), availableIds: ALL_BUILTIN('trend_chart'), rows: [], imageDataUrl: PNG_1x4 })],
    });
    const img = r.report.getSnapshot().sections.find((x) => x.kind === 'image') as Extract<SnapshotSection, { kind: 'image' }>;
    expect(img.heightMm).toBeCloseTo(r.report.ph - 38, 5);
    expect(img.widthMm).toBeCloseTo(img.heightMm / 4, 5);
  });

  it('several profiles: the widget\'s ONE picture prints once, BEFORE the first "Profile:" title (review m4)', async () => {
    const r = await buildWidgetReport({
      widgetType: 'trend_chart', values: {}, formatDateTime,
      sections: [
        section({ profileName: 'Alpha', document: builtinReportTemplate('trend_chart'), availableIds: ALL_BUILTIN('trend_chart'), rows: [], imageDataUrl: PNG_1x1 }),
        section({ profileName: 'Beta', document: builtinReportTemplate('trend_chart'), availableIds: ALL_BUILTIN('trend_chart'), rows: [] }),
      ],
    });
    const s = r.report.getSnapshot().sections;
    expect(s.filter((x) => x.kind === 'image')).toHaveLength(1);
    expect(s[0].kind).toBe('image');
    expect(pairsOf(s).map((p) => p.title)).toEqual(['Profile: Alpha', 'Profile: Beta']);
  });

  it('a floor plan prints its image and no table', async () => {
    const r = await buildWidgetReport({
      widgetType: 'floorplan', values: {}, formatDateTime,
      sections: [section({ document: builtinReportTemplate('floorplan'), rows: [], availableIds: [], imageDataUrl: PNG_1x1 })],
    });
    const s = r.report.getSnapshot().sections;
    expect(s.filter((x) => x.kind === 'image')).toHaveLength(1);
    expect(tables(s)).toEqual([]);
  });
});

describe('loadReportChrome', () => {
  it('the template\'s names win; a blank one falls to Report Page Titles, then Branding', async () => {
    const c = await loadReportChrome(docFor('gauge', (d) => { d.header.companyName = 'Doc Co'; }));
    expect(c.companyName).toBe('Doc Co');
    // Report Page Titles names no app name here, so Branding's stands.
    expect(c.appName).toBe('Branding App');
    const c2 = await loadReportChrome(builtinReportTemplate('gauge'));
    expect(c2.companyName).toBe('Titles Co');
  });

  it('logo: branding → the branding logo as a data URL; custom → the template\'s; none → none', async () => {
    const branding = await loadReportChrome(builtinReportTemplate('gauge'));
    expect(branding.logoDataUrl).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    const custom = await loadReportChrome(docFor('gauge', (d) => { d.header.logo = { mode: 'custom', dataUrl: PNG_1x1 }; }));
    expect(custom.logoDataUrl).toBe(PNG_1x1);
    const none = await loadReportChrome(docFor('gauge', (d) => { d.header.logo = { mode: 'none', dataUrl: PNG_1x1 }; }));
    expect(none.logoDataUrl).toBeNull();
  });

  it('carries the footer, the page, the accent and the notes; with both names and no branding logo it fetches nothing', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('nothing to fetch'); });
    vi.stubGlobal('fetch', fetchSpy);
    const document = docFor('gauge', (d) => {
      d.header.companyName = 'Doc Co'; d.header.appName = 'Doc App'; d.header.showAppName = false;
      d.header.logo = { mode: 'none' }; d.header.accentColor = '#c0392b';
      d.footer = { text: 'Controlled copy', showPageNumbers: false, showPrintedBy: true, showPrintedAt: false, signatureLine: true };
      d.page.orientation = 'landscape';
      d.notes = { remarksLabel: 'Comments', legend: 'NA = Not Applicable' };
    });
    expect(await loadReportChrome(document)).toEqual({
      companyName: 'Doc Co', appName: 'Doc App', showAppName: false, logoDataUrl: null, accentColor: '#c0392b',
      footer: document.footer, orientation: 'landscape', remarksLabel: 'Comments', legend: 'NA = Not Applicable',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const { apiClient } = await import('@/lib/api-client');
    expect((apiClient.get as any).mock.calls.filter((c: unknown[]) => String(c[0]).includes('report-page-titles'))).toEqual([]);
  });
});
