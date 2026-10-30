import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { CustomWidget, LatestValuesRow, LatestKeyValue } from '@digilog/shared';
import { FAULT_INK, statusClasses } from '../../status';

// ── Data: set per test, returned as STABLE objects (a fresh object per call
// re-runs effects forever — the UI v3 vitest hang). ─────────────────────────
const state: {
  ids: { ids: string[]; loading: boolean };
  latest: { rows: LatestValuesRow[]; loading: boolean; error: unknown };
  history: { byInstrument: Map<string, unknown>; loading: boolean };
  series: { rows: { instrumentId: string; ts: string; values: Record<string, unknown> }[]; total: number; loading: boolean };
} = {
  ids: { ids: [], loading: false },
  latest: { rows: [], loading: false, error: undefined },
  history: { byInstrument: new Map(), loading: false },
  series: { rows: [], total: 0, loading: false },
};
const historyCalls: unknown[][] = [];
const seriesCalls: unknown[][] = [];
vi.mock('../use-widget-data', () => ({
  useWidgetInstrumentIds: () => state.ids,
  useLatestValues: () => state.latest,
  useWidgetHistory: (...a: unknown[]) => { historyCalls.push(a); return state.history; },
  useWidgetTimeseries: (...a: unknown[]) => { seriesCalls.push(a); return state.series; },
}));
const FORMAT = { formatDateTime: (v: string) => `T:${v}`, formatDate: (v: string) => v, formatTime: (v: string) => v };
vi.mock('@/hooks/use-datetime-format', () => ({ useDatetimeFormat: () => FORMAT }));
const WORDS = { failure: 'Error', outOfRange: 'OL' };
vi.mock('@/hooks/use-failure-text', () => ({ useSensorWords: () => WORDS }));
const PAGING = { options: [10, 25, 50], defaultLimit: 25 };
vi.mock('@/hooks/use-pagination-config', () => ({ usePaginationDefaults: () => PAGING }));
const chartProps: Record<string, unknown>[] = [];
vi.mock('../../time-series-chart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../time-series-chart')>()),
  TimeSeriesChart: (p: Record<string, unknown>) => { chartProps.push(p); return <div data-testid="chart" />; },
}));

import { WidgetBody } from '../widget-panel';

const SEL = { directOnly: false };
const widget = (over: Partial<CustomWidget>): CustomWidget => ({
  id: '11111111-1111-4111-8111-111111111111', type: 'value_cards', title: 'W',
  source: { mode: 'selection' }, keys: [{ source: 'telemetry', key: 't' }], options: {}, ...over,
});
const measuredT = (value: unknown, over: Partial<LatestKeyValue> = {}): LatestKeyValue => ({
  source: 'telemetry', key: 't', value, ts: '2026-10-28T10:00:00.000Z', unit: '°C', decimals: 1, display: null,
  judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false },
  ...over,
});
const rawP = (value: unknown): LatestKeyValue => ({
  source: 'telemetry', key: 'p', value, ts: '2026-10-28T10:00:00.000Z', unit: null, decimals: null, display: null, judged: null,
});
const row = (id: string, values: LatestKeyValue[], over: Partial<LatestValuesRow> = {}): LatestValuesRow => ({
  instrumentId: id, code: `CODE-${id}`, name: id, functionalLocationName: 'Area 1', locationAttribute: `Room ${id}`,
  reporting: true, lastSeenAt: null, values, ...over,
});
const setRows = (rows: LatestValuesRow[], ids = rows.map((r) => r.instrumentId)) => {
  state.ids = { ids, loading: false };
  state.latest = { rows, loading: false, error: undefined };
};

beforeEach(() => {
  setRows([]);
  state.history = { byInstrument: new Map(), loading: false };
  state.series = { rows: [], total: 0, loading: false };
  chartProps.length = 0;
  historyCalls.length = 0;
});

describe('value cards', () => {
  it('a measured key in limit is green; a raw key is grey and says Not judged', () => {
    setRows([row('a', [measuredT(21.46), rawP(0.05)])]);
    render(<WidgetBody widget={widget({ keys: [{ source: 'telemetry', key: 't' }, { source: 'telemetry', key: 'p', unit: 'kPa' }] })} selection={SEL} />);
    const [t, p] = screen.getAllByTestId('value-card');
    expect(t.dataset.judged).toBe('true');
    expect(within(t).getByTestId('value-card-value').textContent).toBe('21.5');
    expect(t.innerHTML).toContain(statusClasses('OK').dot);
    expect(within(t).getByTestId('value-card-status').textContent).toBe('In limit');

    expect(p.dataset.judged).toBe('false');
    expect(within(p).getByTestId('value-card-value').textContent).toBe('0.05');
    expect(within(p).getByText('kPa')).toBeTruthy();
    expect(within(p).getByTestId('value-card-status').textContent).toBe('Not judged');
    expect(p.innerHTML).not.toContain(statusClasses('OK').dot);
    expect(p.innerHTML).not.toContain(statusClasses('OK').text);
  });

  it('value cards say how many they did not draw', () => {
    setRows(Array.from({ length: 61 }, (_, n) => row(`i${n}`, [measuredT(20)])));
    render(<WidgetBody widget={widget({})} selection={SEL} />);
    expect(screen.getAllByTestId('value-card')).toHaveLength(60);
    expect(screen.getByTestId('widget-cap-note').textContent).toBe('Showing 60 of 61 cards');
  });

  it('instruments missing from the response are not drawn', () => {
    setRows([row('a', [measuredT(20)])], ['a', 'hidden']);
    render(<WidgetBody widget={widget({ source: { mode: 'instruments', ids: ['a', 'hidden'] } as never })} selection={SEL} />);
    expect(screen.getAllByTestId('value-card')).toHaveLength(1);
    expect(screen.queryByTestId('widget-cap-note')).toBeNull();
  });

  it('none in view prints No instruments in your view', () => {
    setRows([], ['hidden']);
    render(<WidgetBody widget={widget({})} selection={SEL} />);
    expect(screen.getByText('No instruments in your view')).toBeTruthy();
  });

  it('an offline instrument reads Offline, a faulted probe its fault word', () => {
    setRows([row('a', [measuredT(60, { judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: true } })], { reporting: false })]);
    render(<WidgetBody widget={widget({})} selection={SEL} />);
    expect(screen.getByTestId('value-card-value').textContent).toBe('OL');
  });

  it('the fault WORD prints in the one fault ink (as the trend card and the gauge); a number keeps its slate', () => {
    setRows([
      row('a', [measuredT('NA', { judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: true, rangeError: false } })]),
      row('b', [measuredT(21.5)]),
    ]);
    render(<WidgetBody widget={widget({})} selection={SEL} />);
    const [fault, number] = screen.getAllByTestId('value-card-value');
    expect(fault.textContent).toBe('Error');
    expect(fault.className.split(/\s+/)).toContain(FAULT_INK);
    expect(number.className.split(/\s+/)).not.toContain(FAULT_INK);
    expect(number.className.split(/\s+/)).toContain('text-slate-900');
  });
});

describe('latest values table', () => {
  it('one row per instrument, one column per key, and the search narrows the rows', () => {
    setRows([row('a', [measuredT(20), rawP('RUN')]), row('b', [measuredT(30), rawP('STOP')])]);
    render(<WidgetBody widget={widget({ type: 'latest_table', keys: [{ source: 'telemetry', key: 't', label: 'Temp' }, { source: 'telemetry', key: 'p', label: 'State' }] })} selection={SEL} />);
    const table = screen.getByTestId('latest-table');
    expect(within(table).getByText('Temp')).toBeTruthy();
    expect(within(table).getByText('State')).toBeTruthy();
    expect(screen.getAllByTestId('latest-table-row')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search this widget'), { target: { value: 'stop' } });
    expect(screen.getAllByTestId('latest-table-row')).toHaveLength(1);
    expect(screen.getByText('CODE-b')).toBeTruthy();
  });
});

describe('trend chart', () => {
  const hist = (key: string, values: unknown[], summary = { count: values.length, numericCount: values.length, min: 1, max: 2, avg: 1.5 }) => ({
    history: values.map((value, n) => ({ key, value, ts: `2026-10-28T10:0${n}:00.000Z` })),
    summaries: { [key]: summary },
    historySampled: false,
    historyTotal: values.length,
  });

  it('draws limit lines only when every series is measured with the same bounds', () => {
    setRows([row('a', [measuredT(20)]), row('b', [measuredT(21)])]);
    state.history = { byInstrument: new Map([['a', hist('t', [20])], ['b', hist('t', [21])]]), loading: false };
    const { unmount } = render(<WidgetBody widget={widget({ type: 'trend_chart' })} selection={SEL} />);
    expect(chartProps.at(-1)).toMatchObject({ min: 18, max: 27, unit: '°C' });
    unmount();

    // One raw series beside a measured one: no lines, and no shared unit.
    setRows([row('a', [measuredT(20), rawP(3)])]);
    state.history = { byInstrument: new Map([['a', { ...hist('t', [20]), history: [...hist('t', [20]).history, ...hist('p', [3]).history], summaries: { ...hist('t', [20]).summaries, ...hist('p', [3]).summaries } }]]), loading: false };
    render(<WidgetBody widget={widget({ type: 'trend_chart', keys: [{ source: 'telemetry', key: 't' }, { source: 'telemetry', key: 'p' }] })} selection={SEL} />);
    expect(chartProps.at(-1)).toMatchObject({ min: null, max: null, unit: '' });
  });

  it('says how many text readings it could not plot, and plots the numbers', () => {
    setRows([row('a', [rawP('NA')])]);
    state.history = { byInstrument: new Map([['a', hist('p', ['NA', '1.5', 2], { count: 3, numericCount: 2, min: 1.5, max: 2, avg: 1.75 })]]), loading: false };
    render(<WidgetBody widget={widget({ type: 'trend_chart', keys: [{ source: 'telemetry', key: 'p' }] })} selection={SEL} />);
    expect(screen.getByTestId('widget-not-plotted').textContent).toBe('1 text readings not plotted');
    const series = (chartProps.at(-1)!.series as { points: { value: number }[]; decimals: number }[])[0];
    expect(series.points.map((p) => p.value)).toEqual([1.5, 2]);
    expect(series.decimals).toBe(1); // the precision the device sent, nothing invented
  });

  it('12 series → Showing 6 of 12 series, and history asked only for the shown instruments', () => {
    // 6 = the palette: a seventh series would repeat a colour (review 2026-10-29).
    setRows(Array.from({ length: 12 }, (_, n) => row(`i${n}`, [measuredT(20)])));
    state.history = { byInstrument: new Map(), loading: false };
    render(<WidgetBody widget={widget({ type: 'trend_chart' })} selection={SEL} />);
    expect(screen.getByTestId('widget-cap-note').textContent).toBe('Showing 6 of 12 series');
    expect((historyCalls.at(-1)![0] as string[])).toHaveLength(6);
  });

  it('plots the instruments that CARRY the key, not the first ones in the selection', () => {
    // Review 2026-10-29: a key only a few instruments send was cut behind
    // empty series from instruments that never sent it.
    const never = (id: string) => row(id, [measuredT(null, { ts: null })]);
    setRows([never('n1'), never('n2'), never('n3'), never('n4'), never('n5'), never('n6'), never('n7'),
      row('c1', [measuredT(20)]), row('c2', [measuredT(21)])]);
    state.history = { byInstrument: new Map(), loading: false };
    render(<WidgetBody widget={widget({ type: 'trend_chart' })} selection={SEL} />);
    expect(historyCalls.at(-1)![0]).toEqual(['c1', 'c2']);
    expect(screen.queryByTestId('widget-cap-note')).toBeNull();
  });

  it('says so when no instrument in view has sent the key yet', () => {
    setRows([row('n1', [measuredT(null, { ts: null })])]);
    render(<WidgetBody widget={widget({ type: 'trend_chart' })} selection={SEL} />);
    expect(screen.getByText('No instrument here has sent these keys yet.')).toBeTruthy();
    expect(screen.queryByTestId('chart')).toBeNull();
  });

  it('every series drawn has its own colour; a key colour applies only to a single instrument', () => {
    const hist1 = (key: string) => ({ history: [{ key, value: 1, ts: '2026-10-28T10:00:00.000Z' }], summaries: {}, historySampled: false, historyTotal: 1 });
    setRows(Array.from({ length: 6 }, (_, n) => row(`i${n}`, [measuredT(20)])));
    state.history = { byInstrument: new Map(Array.from({ length: 6 }, (_, n) => [`i${n}`, hist1('t')])), loading: false };
    const { unmount } = render(<WidgetBody widget={widget({ type: 'trend_chart', keys: [{ source: 'telemetry', key: 't', color: 2 }] })} selection={SEL} />);
    const colours = (chartProps.at(-1)!.series as { color: string }[]).map((s) => s.color);
    expect(new Set(colours).size).toBe(6);
    unmount();

    setRows([row('only', [measuredT(20)])]);
    state.history = { byInstrument: new Map([['only', hist1('t')]]), loading: false };
    render(<WidgetBody widget={widget({ type: 'trend_chart', keys: [{ source: 'telemetry', key: 't', color: 2 }] })} selection={SEL} />);
    expect((chartProps.at(-1)!.series as { color: string }[])[0].color).toContain('--chart-series-3');
  });

  it('m-7: one instrument, a key without a colour never lands on the slot another key chose', () => {
    const hist = { history: [{ key: 't', value: 1, ts: '2026-10-28T10:00:00.000Z' }, { key: 'p', value: 2, ts: '2026-10-28T10:00:00.000Z' }], summaries: {}, historySampled: false, historyTotal: 2 };
    setRows([row('only', [measuredT(20), rawP(2)])]);
    state.history = { byInstrument: new Map([['only', hist]]), loading: false };
    // Before: t took slot 0 by position — the slot p chose.
    render(<WidgetBody widget={widget({ type: 'trend_chart', keys: [{ source: 'telemetry', key: 't' }, { source: 'telemetry', key: 'p', color: 0 }] })} selection={SEL} />);
    const colours = (chartProps.at(-1)!.series as { color: string }[]).map((s) => s.color);
    expect(colours[0]).toContain('--chart-series-2');
    expect(colours[1]).toContain('--chart-series-1');
  });
});

describe('time series table', () => {
  it('queries the instruments that carry a key, not the first fifty', () => {
    const never = (id: string) => row(id, [measuredT(null, { ts: null })]);
    setRows([...Array.from({ length: 55 }, (_, n) => never(`n${n}`)), row('c1', [measuredT(20)])]);
    render(<WidgetBody widget={widget({ type: 'timeseries_table' })} selection={SEL} />);
    expect(seriesCalls.at(-1)![0]).toEqual(['c1']);
    expect(screen.queryByTestId('widget-cap-note')).toBeNull();
  });

  it("prints a measured cell at the server's decimals and a raw one as received", () => {
    setRows([row('a', [measuredT(20), rawP(0.05)])]);
    state.series = { rows: [{ instrumentId: 'a', ts: '2026-10-28T10:00:00.000Z', values: { t: '21.456', p: 0.05 } }], total: 1, loading: false };
    render(<WidgetBody widget={widget({ type: 'timeseries_table', keys: [{ source: 'telemetry', key: 't' }, { source: 'telemetry', key: 'p' }] })} selection={SEL} />);
    const r = screen.getByTestId('timeseries-row');
    expect(within(r).getByText('21.5')).toBeTruthy();
    expect(within(r).getByText('0.05')).toBeTruthy();
    expect(within(r).getByText('CODE-a')).toBeTruthy();
    expect(within(r).getByText('T:2026-10-28T10:00:00.000Z')).toBeTruthy();
  });
});

/**
 * The three widget tables wear the app's table (ruling R5, 2026-10-29): they
 * were raw `<table class="tbl tbl-grid">` with no cell padding and a pale
 * header under white borders. Each now has the shared band header, lined cells
 * and padded cells — the Table primitive's look.
 */
describe('widget tables wear the shared table look', () => {
  const looksShared = (table: HTMLElement) => {
    const thead = table.querySelector('thead')!;
    expect(thead.getAttribute('data-band')).toBe('gradient');
    expect(thead.getAttribute('style')).toContain('var(--band-gradient)');
    expect(table.className).toMatch(/(^|\s)tbl-grid(\s|$)/);
    const cell = table.querySelector('tbody td')!;
    expect(cell.className).toMatch(/(^|\s)px-4(\s|$)/);
  };

  it('latest values table: band header, lined and padded cells', () => {
    setRows([row('a', [measuredT(20)])]);
    render(<WidgetBody widget={widget({ type: 'latest_table' })} selection={SEL} />);
    looksShared(screen.getByTestId('latest-table'));
  });

  it('time series table: band header, lined and padded cells', () => {
    setRows([row('a', [measuredT(20)])]);
    state.series = { rows: [{ instrumentId: 'a', ts: '2026-10-28T10:00:00.000Z', values: { t: 20 } }], total: 1, loading: false };
    render(<WidgetBody widget={widget({ type: 'timeseries_table' })} selection={SEL} />);
    looksShared(screen.getByTestId('timeseries-table'));
  });

  it('trend chart series strip: band header, lined and padded cells', () => {
    setRows([row('a', [measuredT(20)])]);
    state.history = {
      byInstrument: new Map([['a', { history: [{ key: 't', value: 20, ts: '2026-10-28T10:00:00.000Z' }], summaries: {}, historySampled: false, historyTotal: 1 }]]),
      loading: false,
    };
    render(<WidgetBody widget={widget({ type: 'trend_chart' })} selection={SEL} />);
    looksShared(screen.getByTestId('trend-widget-strip'));
  });
});
