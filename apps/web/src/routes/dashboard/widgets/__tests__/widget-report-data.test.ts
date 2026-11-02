import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WIDGET_REPORT_FIELDS, builtinReportTemplate,
  type CustomWidget, type LatestKeyValue, type LatestValuesRow, type ReportTemplateDocument, type WidgetKey,
} from '@digilog/shared';
import { REPORT_ROW_GROUP, printedRows, type WidgetReportRow } from '@/lib/widget-report';
import type { AlarmRow } from '@/routes/alarms/alarm-display';
import type { OverviewRow } from '../../use-telemetry';
import { keyCell } from '../key-value';
import type { BarModel } from '../bar-chart-model';
import type { TrendPlotted } from '../trend-chart-widget';
import type { InstrumentHistory, TimeseriesRow } from '../use-widget-data';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiClient: api }));
// The pictures: what the collector asks for, not the raster (svg-raster.test / chart-image.test).
const pics = vi.hoisted(() => ({
  chart: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AAAA', width: 1800, height: 840 })),
  keyed: vi.fn(async (img: { dataUrl: string; width: number; height: number }, _items: { label: string; color: string }[]) => ({ ...img, height: img.height + 40 })),
}));
vi.mock('@/routes/instruments/chart-image', () => ({ renderChartToPng: pics.chart }));
vi.mock('@/lib/svg-raster', () => ({ pictureWithLegend: pics.keyed, svgMarkupToPng: vi.fn(async () => null), svgElementToPng: vi.fn(async () => null) }));

import {
  ROW_GROUP, REPORT_ROW_INSTRUMENT, collectWidgetReport, type CollectInput,
  instrumentCells, reportRefs, sectionRows, fetchLatestValuesAllKeys, fetchAllAlarms, ALARM_REPORT_MAX,
  rowsForLatestTable, rowsForValueCards, rowsForGauge, rowsForAlarmTable, rowsForTimeseriesTable,
  rowsForTrendChart, rowsForBarChart, rowsForPieChart, rowsForAlarmCounts, rowsForStatusGrid, rowsForInstrumentList,
} from '../widget-report-data';

const WORDS = { failure: 'Error', outOfRange: 'OL' };
const fmt = (iso: string) => `F(${iso})`;
const TS = '2026-11-02T10:00:00.000Z';

const T: WidgetKey = { source: 'telemetry', key: 'temp', label: 'Temperature' };
const P: WidgetKey = { source: 'telemetry', key: 'p' };
const LIMIT: WidgetKey = { source: 'attribute', key: 'Temp NMT' };

const measured = (key: string, value: unknown, over: Partial<LatestKeyValue> = {}): LatestKeyValue => ({
  source: 'telemetry', key, value, ts: TS, unit: '°C', decimals: 1, display: null,
  judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false },
  ...over,
});
const raw = (key: string, value: unknown, over: Partial<LatestKeyValue> = {}): LatestKeyValue => ({
  source: 'telemetry', key, value, ts: TS, unit: null, decimals: null, display: null, judged: null, ...over,
});
const attr = (key: string, value: unknown, display: string | null): LatestKeyValue => ({
  source: 'attribute', key, value, ts: TS, unit: null, decimals: null, display, judged: null,
});
const latestRow = (id: string, values: LatestKeyValue[], over: Partial<LatestValuesRow> = {}): LatestValuesRow => ({
  instrumentId: id, code: `CODE-${id}`, name: id, functionalLocationName: 'QC 3', locationAttribute: 'Dissolution Room',
  reporting: true, lastSeenAt: TS, values, ...over,
});

beforeEach(() => { api.get.mockReset(); api.post.mockReset(); });

describe('the row-grain contract shared with the PDF builder', () => {
  it("the group key is the builder's REPORT_ROW_GROUP (one constant, not a second spelling)", () => {
    expect(ROW_GROUP).toBe(REPORT_ROW_GROUP);
  });
});

describe('rowsForLatestTable — one row per KEY of each instrument, every value the widget prints', () => {
  const rows = [latestRow('a', [measured('temp', 21.456), raw('p', '1013.2500000000001'), attr('Temp NMT', 25, '25.00')])];
  const out = rowsForLatestTable(rows, [T, P, LIMIT], WORDS, fmt);

  it("prints a measured reading at the SERVER's decimals, raw text as received, an attribute as the server's display", () => {
    expect(out.map((r) => r['reading.value'])).toEqual(['21.5', '1013.2500000000001', '25.00']);
    // The same text the widget's cell prints (keyCell), never a second formatting.
    expect(out[0]['reading.value']).toBe(keyCell(measured('temp', 21.456), true, T, WORDS).text);
    // The attribute's display wins over its number: 25 would print "25".
    expect(out[2]['reading.value']).not.toBe('25');
  });

  it('carries the unit beside a number only, the status word, the instant through the page formatter', () => {
    expect(out[0]['reading.unit']).toBe('°C');
    expect(out[0]['reading.status']).toBe(keyCell(measured('temp', 21.456), true, T, WORDS).label);
    expect(out[0]['reading.ts']).toBe(`F(${TS})`);
    expect(out[1]['key.label']).toBe('p');
    expect(out[0]['key.label']).toBe('Temperature');
  });

  it('names its instrument, Area and Location, and the key as its own `key:` / `attr:` cell', () => {
    expect(out[0]).toMatchObject({
      [REPORT_ROW_GROUP]: 'a', [REPORT_ROW_INSTRUMENT]: 'a',
      'instrument.code': 'CODE-a', 'instrument.area': 'QC 3', 'instrument.location': 'Dissolution Room',
      'key:temp': '21.5',
    });
    expect(out[2]['attr:Temp NMT']).toBe('25.00');
  });

  it('collapses to ONE row per instrument through the builder when the template shows no per-key field', () => {
    const doc: ReportTemplateDocument = {
      ...builtinReportTemplate('latest_table'),
      columns: [
        { id: 'instrument.code', heading: 'ID', show: true },
        { id: 'key:temp', heading: 'T', show: true },
        { id: 'key:p', heading: 'P', show: true },
        { id: 'reading.value', heading: 'Value', show: false },
      ],
    };
    const merged = printedRows('latest_table', doc, out);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ 'key:temp': '21.5', 'key:p': '1013.2500000000001', 'attr:Temp NMT': '25.00' });
  });

  it('a template key the widget does not show fills from the instrument cells; the widget key keeps its own text', () => {
    const cells = instrumentCells([latestRow('a', [measured('temp', 99), raw('rh', 40)])], WORDS);
    const withCells = rowsForLatestTable(rows, [T], WORDS, fmt, cells);
    expect(withCells[0]['key:rh']).toBe('40');
    expect(withCells[0]['key:temp']).toBe('21.5');
  });
});

describe('the other present-state key widgets', () => {
  const rows = [latestRow('a', [measured('temp', 21.456), raw('p', null, { ts: null })])];
  it('value cards print every key, NA included (the widget draws a card for it)', () => {
    expect(rowsForValueCards(rows, [T, P], WORDS, fmt).map((r) => r['reading.value'])).toEqual(['21.5', 'NA']);
  });
  it('gauges leave out a key the instrument never sent, as the widget draws no ring for it', () => {
    expect(rowsForGauge(rows, [T, P], WORDS, fmt).map((r) => r['key.label'])).toEqual(['Temperature']);
  });
});

describe('instrumentCells', () => {
  it('maps each value to its `key:` / `attr:` id, the measured fault word as the widget shows it, nothing for an absent value', () => {
    const faulted = measured('temp', 60, { judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: true } });
    const cells = instrumentCells([latestRow('a', [faulted, attr('Location', 'Room 4', null), raw('p', null, { ts: null })])], WORDS);
    expect(cells.get('a')).toEqual({ 'key:temp': 'OL', 'attr:Location': 'Room 4' });
  });
});

describe('rowsForAlarmTable', () => {
  const alarm: AlarmRow = {
    id: 'al1', instrumentId: 'a', instrumentCode: 'CODE-a', locationName: 'QC 3', locationAttribute: 'Room 4',
    metric: 'TEMPERATURE', triggeredValue: 28.24, state: 'CLEARED', raisedAt: TS, clearedAt: '2026-11-02T11:00:00.000Z',
    acknowledgedAt: '2026-11-02T12:00:00.000Z', acknowledgedBy: 'qa1', acknowledgeReason: 'checked',
    source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH', clearedValue: 26.1,
    ruleSnapshot: { limit: 27, limitKind: 'HIGH', decimals: 1 },
  };

  it("prints exactly the alarm table's built-in fields (plus nothing but its own bookkeeping)", () => {
    const [row] = rowsForAlarmTable([alarm], {}, undefined, fmt);
    const fields = Object.keys(row).filter((k) => !k.startsWith('#') && !k.startsWith('key:') && !k.startsWith('attr:'));
    expect(fields.sort()).toEqual(WIDGET_REPORT_FIELDS.alarm_table.map((f) => f.id).sort());
  });

  it('words each cell as the alarm table does, every instant through the page formatter', () => {
    const [row] = rowsForAlarmTable([alarm], {}, undefined, fmt);
    expect(row).toMatchObject({
      [REPORT_ROW_INSTRUMENT]: 'a',
      'instrument.code': 'CODE-a', 'instrument.location': 'Room 4',
      'alarm.raisedAt': `F(${TS})`, 'alarm.value': '28.2', 'alarm.limit': '> 27.0',
      'alarm.clearedAt': 'F(2026-11-02T11:00:00.000Z)', 'alarm.clearedValue': '26.1',
      'alarm.acknowledgedBy': 'qa1', 'alarm.acknowledgedAt': 'F(2026-11-02T12:00:00.000Z)',
    });
    expect(typeof row['alarm.type']).toBe('string');
    expect(typeof row['alarm.status']).toBe('string');
  });

  it('an alarm still open prints no cleared time; one not acknowledged, no signer', () => {
    const [row] = rowsForAlarmTable([{ ...alarm, state: 'ACTIVE', clearedAt: null, clearedValue: null, acknowledgedAt: null, acknowledgedBy: null }], {}, undefined, fmt);
    expect(row['alarm.clearedAt']).toBeNull();
    expect(row['alarm.acknowledgedBy']).toBeNull();
    expect(row['alarm.acknowledgedAt']).toBeNull();
  });
});

describe('rowsForTimeseriesTable — one row per stored instant per key', () => {
  const byId = new Map([['a', latestRow('a', [measured('temp', 20)])]]);
  const history: TimeseriesRow[] = [{ instrumentId: 'a', ts: TS, values: { temp: 21.456, rh: 40 } }];
  const out = rowsForTimeseriesTable(history, byId, [T], ['rh'], fmt);

  it("prints the reading by the widget's own cell rule and groups it by instrument and instant", () => {
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      [REPORT_ROW_GROUP]: `a@${TS}`, [REPORT_ROW_INSTRUMENT]: 'a',
      'reading.ts': `F(${TS})`, 'instrument.code': 'CODE-a', 'key.label': 'Temperature',
      'reading.value': '21.5', 'reading.unit': '°C', 'key:temp': '21.5', 'key:rh': '40',
    });
  });
});

describe('rowsForTrendChart — one row per drawn series, the range figures at its decimals', () => {
  it("prints the server's minimum, maximum, average and count", () => {
    const row = latestRow('a', [measured('temp', 21)]);
    const plotted = [{
      series: { id: 'a:temp', label: 'CODE-a · Temperature', decimals: 1, color: '#000', points: [] },
      instrumentId: 'a', key: 'temp', row, widgetKey: T, latest: row.values[0], current: '21.0', currentUnit: '°C', unit: '°C',
    }] as TrendPlotted[];
    const byInstrument = new Map<string, InstrumentHistory>([['a', {
      history: [], historySampled: false, historyTotal: 3,
      summaries: { temp: { count: 3, numericCount: 3, min: 20.04, max: 22.96, avg: 21.5 } },
    }]]);
    expect(rowsForTrendChart(plotted, byInstrument)[0]).toMatchObject({
      [REPORT_ROW_INSTRUMENT]: 'a', 'instrument.code': 'CODE-a', 'instrument.location': 'Dissolution Room',
      'key.label': 'Temperature', 'reading.unit': '°C',
      'summary.min': '20.0', 'summary.max': '23.0', 'summary.avg': '21.5', 'summary.count': 3,
    });
  });
});

describe('rowsForBarChart — one row per bar', () => {
  const model = {
    bucket: 'day', agg: 'avg', groupBy: 'all', categories: ['c0', 'c1'], labels: ['D0', 'D1'], times: [], dates: [],
    partial: [true, false], unit: '°C', unsent: [],
    series: [{ name: 'Temperature', legendName: 'Temperature', instrumentId: null, color: '#000', unit: '°C', decimals: 2, points: [{ value: 21.5, readings: 10, instruments: 2 }, null] }],
  } as BarModel;

  it('a bar of every instrument combined names no instrument and reads "All instruments"; a partial bucket says so', () => {
    const out = rowsForBarChart(model, () => undefined);
    expect(out).toHaveLength(1);
    expect(out[0][REPORT_ROW_INSTRUMENT]).toBeUndefined();
    expect(out[0]).toMatchObject({
      'instrument.code': 'All instruments', 'bucket.ts': 'D0 (partial)', 'series.label': 'Temperature',
      'bucket.value': '21.50', 'reading.unit': '°C', 'bucket.readings': 10,
    });
  });

  it("a series of one instrument names it, for its profile's section", () => {
    const mine = { ...model, groupBy: 'instrument', series: [{ ...model.series[0], instrumentId: 'a', name: 'CODE-a · Temperature' }] } as BarModel;
    expect(rowsForBarChart(mine, (id) => `CODE-${id}`)[0]).toMatchObject({ [REPORT_ROW_INSTRUMENT]: 'a', 'instrument.code': 'CODE-a' });
  });
});

describe('the present-state count widgets', () => {
  it("pie slices: the label, the count and the share of the whole; Other names what it holds", () => {
    const out = rowsForPieChart([
      { key: 'OK', label: 'In limit', count: 3, hex: '#0' },
      { key: 'OTHER', label: 'Other', count: 1, hex: '#1', merged: [{ label: 'Offline', count: 1 }] },
    ]);
    expect(out).toEqual([
      { 'slice.label': 'In limit', 'slice.count': 3, 'slice.share': '75.0' },
      { 'slice.label': 'Other (Offline 1)', 'slice.count': 1, 'slice.share': '25.0' },
    ]);
  });

  it('alarm counts: Active, Unacknowledged, then each type the server lists, zeros kept', () => {
    const out = rowsForAlarmCounts({
      quadrants: { activeUnack: 2, activeAck: 1, clearedUnack: 4, clearedAck: 9 },
      byType: [{ type: 'OFFLINE', active: 0, unacknowledged: 0 }],
    }, undefined);
    expect(out.map((r) => [r['count.label'], r['count.value']])).toEqual([
      ['Active', 3], ['Unacknowledged', 6], [expect.stringContaining('Active —'), 0],
    ]);
  });

  const overview = {
    instrumentId: 'a', code: 'CODE-a', name: 'a', isActive: true, room: null, functionalLocationName: 'QC 3',
    locationAttribute: 'Room 4', limits: null, status: 'OK', reporting: true, judged: true, lastSeenAt: TS,
  } as unknown as OverviewRow;

  it("status grid and instrument list: the server's status in the widget's word, Last seen through the formatter", () => {
    expect(rowsForStatusGrid([overview])[0]).toMatchObject({
      [REPORT_ROW_INSTRUMENT]: 'a', 'instrument.code': 'CODE-a', 'instrument.area': 'QC 3', 'instrument.location': 'Room 4',
    });
    expect(rowsForInstrumentList([overview], fmt)[0]['instrument.lastSeen']).toBe(`F(${TS})`);
    expect(rowsForInstrumentList([{ ...overview, judged: false } as OverviewRow], fmt)[0]['instrument.status']).toBe('Not judged');
  });
});

describe('reportRefs — the extra keys and attributes the chosen templates print', () => {
  it('reads SHOWN `key:` / `attr:` columns and `attr:` info rows, once each, never a hidden column', () => {
    const doc = builtinReportTemplate('latest_table');
    const a: ReportTemplateDocument = {
      ...doc,
      columns: [...doc.columns, { id: 'key:rh', heading: 'RH', show: true }, { id: 'key:hidden', heading: 'H', show: false }, { id: 'attr:Block', heading: 'B', show: true }],
      infoBlock: [{ label: 'Room', source: 'attr:Location' }, { label: 'n', source: 'instrumentCount' }],
    };
    const b: ReportTemplateDocument = { ...doc, columns: [{ id: 'key:rh', heading: 'RH', show: true }] };
    expect(reportRefs([a, b])).toEqual([
      { source: 'telemetry', key: 'rh' }, { source: 'attribute', key: 'Block' }, { source: 'attribute', key: 'Location' },
    ]);
  });
});

describe('sectionRows', () => {
  it("puts each row in its instrument's profile section, and a row of no instrument in the FIRST (ruling T1-C3)", () => {
    const rows: WidgetReportRow[] = [{ [REPORT_ROW_INSTRUMENT]: 'b', n: 1 }, { n: 2 }, { [REPORT_ROW_INSTRUMENT]: 'a', n: 3 }];
    const out = sectionRows(rows, [{ instrumentIds: ['a'] }, { instrumentIds: ['b'] }]);
    expect(out.map((s) => s.map((r) => r.n))).toEqual([[2, 3], [1]]);
  });
});

describe('fetchLatestValuesAllKeys', () => {
  it('asks at most 20 keys per request and merges each instrument back into one row', async () => {
    const refs = Array.from({ length: 25 }, (_, n) => ({ source: 'telemetry' as const, key: `k${n}` }));
    api.post.mockImplementation(async (_url: string, body: { instrumentIds: string[]; keys: { key: string }[] }) => ({
      data: body.instrumentIds.map((id) => latestRow(id, body.keys.map((k) => raw(k.key, 1)))),
    }));
    const out = await fetchLatestValuesAllKeys(['a'], refs);
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(api.post.mock.calls.map((c) => c[1].keys.length)).toEqual([20, 5]);
    expect(out).toHaveLength(1);
    expect(out[0].values.map((v) => v.key)).toEqual(refs.map((r) => r.key));
  });
});

describe('fetchAllAlarms', () => {
  it('walks every page to the total and says when it stopped at the cap', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `x${i}` }));
    api.get.mockResolvedValueOnce({ data: page(500), total: 700 }).mockResolvedValueOnce({ data: page(200), total: 700 });
    const all = await fetchAllAlarms({ instrumentIds: ['a'] }, { search: '', type: '', status: '' });
    expect(all.rows).toHaveLength(700);
    expect(all.total).toBe(700);
    expect(api.get.mock.calls[0][0]).toContain('page=1');
    expect(api.get.mock.calls[1][0]).toContain('page=2');
    expect(ALARM_REPORT_MAX).toBe(5000);
  });

  it('asks nothing for an EMPTY fixed list', async () => {
    const all = await fetchAllAlarms({ instrumentIds: [] }, { search: '', type: '', status: '' });
    expect(all).toEqual({ rows: [], total: 0 });
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('collectWidgetReport — the widget asked again, at confirm, for the DIALOG\'s period', () => {
  const PERIOD = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' };
  const base = (widget: CustomWidget, over: Partial<CollectInput> = {}): CollectInput => ({
    widget, selection: { directOnly: false }, ids: ['a', 'b'], period: PERIOD,
    alarmFilters: { search: '', type: '', status: '' }, refs: [], words: WORDS,
    alarm: { texts: {}, statusTexts: undefined, typeNames: undefined },
    dates: { formatDate: fmt, formatTime: fmt, formatDateTime: fmt },
    ...over,
  });
  const latestFor = (ids: string[]) => ({ data: ids.map((id) => latestRow(id, [measured('temp', 21)])) });

  beforeEach(() => { pics.chart.mockClear(); pics.keyed.mockClear(); });

  it("trend chart: each instrument's history is asked for the dialog's period; two lines get a key under the picture", async () => {
    api.post.mockImplementation(async (_u: string, body: { instrumentIds: string[] }) => latestFor(body.instrumentIds));
    api.get.mockImplementation(async (url: string) => ({
      history: [{ key: 'temp', ts: '2026-10-02T00:00:00.000Z', value: 21 }], historySampled: false, historyTotal: 1,
      summaries: { temp: { count: 4, numericCount: 4, min: 20, max: 22, avg: 21 } }, url,
    }));
    const widget = { id: 'w', type: 'trend_chart', title: 'T', source: { mode: 'selection' }, keys: [T], options: {} } as CustomWidget;
    const out = await collectWidgetReport(base(widget));
    const urls = api.get.mock.calls.map((c) => decodeURIComponent(String(c[0])));
    expect(urls).toHaveLength(2);
    for (const u of urls) {
      expect(u).toContain(`from=${PERIOD.from}`);
      expect(u).toContain(`to=${PERIOD.to}`);
    }
    expect(out.rows.map((r) => r['instrument.code'])).toEqual(['CODE-a', 'CODE-b']);
    expect(pics.chart).toHaveBeenCalledTimes(1);
    expect(pics.keyed).toHaveBeenCalledTimes(1);
    expect(pics.keyed.mock.calls[0][1]).toEqual([
      expect.objectContaining({ label: 'CODE-a · Temperature' }), expect.objectContaining({ label: 'CODE-b · Temperature' }),
    ]);
    expect(out.image?.height).toBe(880);
  });

  it('time series: every page of the period is walked, and a cut is SAID', async () => {
    api.post.mockImplementation(async (_u: string, body: { instrumentIds: string[] }) => latestFor(body.instrumentIds));
    const page = (n: number) => Array.from({ length: n }, (_, k) => ({ instrumentId: 'a', ts: new Date(Date.parse(PERIOD.to) - k * 60_000).toISOString(), values: { temp: 21 } }));
    api.get.mockResolvedValueOnce({ data: page(500), total: 5600 }).mockResolvedValue({ data: page(500), total: 5600 });
    const widget = { id: 'w', type: 'timeseries_table', title: 'TS', source: { mode: 'selection' }, keys: [T], options: {} } as CustomWidget;
    const out = await collectWidgetReport(base(widget));
    const urls = api.get.mock.calls.map((c) => decodeURIComponent(String(c[0])));
    expect(urls[0]).toContain(`from=${PERIOD.from}`);
    expect(urls[0]).toContain('offset=0');
    expect(urls[1]).toContain('offset=500');
    expect(urls).toHaveLength(10);
    expect(out.notes).toContain('The first 5,000 of 5,600 stored instants, newest first.');
  });

  it("alarm table: the filters the viewer has on the panel are the report's", async () => {
    api.get.mockResolvedValue({ data: [], total: 0 });
    const widget = { id: 'w', type: 'alarm_table', title: 'Alarms', source: { mode: 'selection' }, keys: [], options: {} } as CustomWidget;
    await collectWidgetReport(base(widget, { alarmFilters: { search: 'QC', type: '', status: 'active-unack' } }));
    const url = decodeURIComponent(String(api.get.mock.calls[0][0]));
    expect(url).toContain('search=QC');
    expect(url).toContain('status=active-unack');
  });
});
