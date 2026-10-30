import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { GAUGES_SHOWN_MAX, type CustomWidget, type LatestKeyValue, type LatestValuesRow } from '@digilog/shared';

// Stable module-level objects only: a fresh object per call re-runs effects forever.
const state: {
  ids: { ids: string[]; loading: boolean };
  latest: { rows: LatestValuesRow[]; loading: boolean; error: unknown };
} = {
  ids: { ids: [], loading: false },
  latest: { rows: [], loading: false, error: undefined },
};
vi.mock('../use-widget-data', () => ({
  useWidgetInstrumentIds: () => state.ids,
  useLatestValues: () => state.latest,
}));
const WORDS = { failure: 'Error', outOfRange: 'OL' };
vi.mock('@/hooks/use-failure-text', () => ({ useSensorWords: () => WORDS }));
const FORMAT = { formatDateTime: (v: string) => v, formatDate: (v: string) => v, formatTime: (v: string) => v };
vi.mock('@/hooks/use-datetime-format', () => ({ useDatetimeFormat: () => FORMAT }));
const PAGING = { options: [10, 25, 50], defaultLimit: 25 };
vi.mock('@/hooks/use-pagination-config', () => ({ usePaginationDefaults: () => PAGING }));
/** Every prop set the chart wrapper was given, in render order. */
const charts: { option: Record<string, any>; height: number; ariaLabel: string }[] = [];
vi.mock('../charts/lazy-echart', () => ({
  LazyEChart: (p: { option: Record<string, any>; height: number; ariaLabel: string }) => {
    charts.push(p);
    return <div data-testid="echart" aria-label={p.ariaLabel} />;
  },
}));

import { WidgetBody } from '../widget-panel';
import { NEUTRAL_HEX, STATUS_HEX } from '../charts/chart-colors';
import { GAUGE_SIZE } from '../gauge-model';

const SEL = { directOnly: false };
const widget = (over: Partial<CustomWidget> = {}): CustomWidget => ({
  id: '11111111-1111-4111-8111-111111111111', type: 'gauge', title: 'Gauges',
  source: { mode: 'selection' },
  keys: [{ source: 'telemetry', key: 't', label: 'Temperature' }, { source: 'telemetry', key: 'Pressure', unit: 'kPa' }],
  options: { min: 0, max: 10 },
  ...over,
});
const measured = (value: unknown, over: Partial<NonNullable<LatestKeyValue['judged']>> = {}): LatestKeyValue => ({
  source: 'telemetry', key: 't', value, ts: '2026-10-30T10:00:00.000Z', unit: '°C', decimals: 1, display: null,
  judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false, ...over },
});
const raw = (value: unknown, over: Partial<LatestKeyValue> = {}): LatestKeyValue => ({
  source: 'telemetry', key: 'Pressure', value, ts: '2026-10-30T10:00:00.000Z', unit: null, decimals: null, display: null,
  judged: null, ...over,
});
const row = (id: string, values: LatestKeyValue[], over: Partial<LatestValuesRow> = {}): LatestValuesRow => ({
  instrumentId: id, code: `CWH/RDU/${id}`, name: id, functionalLocationName: 'QC', locationAttribute: 'Room',
  reporting: true, lastSeenAt: null, values, ...over,
});
const setRows = (rows: LatestValuesRow[], ids = rows.map((r) => r.instrumentId)) => {
  state.ids = { ids, loading: false };
  state.latest = { rows, loading: false, error: undefined };
};
const series = (n: number) => charts[n].option.series[0];
const VERDICT_HEXES = Object.entries(STATUS_HEX).filter(([k]) => k !== 'NOT_JUDGED').map(([, hex]) => hex.toLowerCase());

beforeEach(() => {
  setRows([]);
  charts.length = 0;
});

describe('gauge widget', () => {
  it('one gauge per instrument × key, titled code · label, the number and unit on the page', () => {
    setRows([row('101-01', [measured(21.46), raw(2.5)])]);
    render(<WidgetBody widget={widget()} selection={SEL} />);
    const gauges = screen.getAllByTestId('gauge');
    expect(gauges).toHaveLength(2);
    expect(within(gauges[0]).getByTestId('gauge-title').textContent).toBe('CWH/RDU/101-01 · Temperature');
    expect(within(gauges[0]).getByTestId('gauge-title').getAttribute('title')).toBe('CWH/RDU/101-01 · Temperature');
    expect(within(gauges[1]).getByTestId('gauge-title').textContent).toBe('CWH/RDU/101-01 · Pressure');
    expect(within(gauges[0]).getByTestId('gauge-value').textContent).toBe('21.5');
    expect(within(gauges[0]).getByTestId('gauge-unit').textContent).toBe('°C');
    expect(within(gauges[1]).getByTestId('gauge-value').textContent).toBe('2.5');
    expect(within(gauges[1]).getByTestId('gauge-unit').textContent).toBe('kPa');
    expect(charts.map((c) => c.height)).toEqual([GAUGE_SIZE.height, GAUGE_SIZE.height]);
    expect(charts[0].ariaLabel).toBe('CWH/RDU/101-01 · Temperature: 21.5 °C');
  });

  it('the measured key takes its verdict; the raw key is neutral and says Not judged', () => {
    setRows([row('101-01', [measured(21.46), raw(2.5)])]);
    render(<WidgetBody widget={widget()} selection={SEL} />);
    const [t, p] = screen.getAllByTestId('gauge');
    expect(t.dataset.kind).toBe('banded');
    expect(series(0).progress.itemStyle.color).toBe(STATUS_HEX.OK);
    expect(within(t).getByTestId('gauge-status').textContent).toBe('In limit');
    expect(within(t).getByTestId('gauge-scale').textContent).toBe('Limits18.0 - 27.0 °C');
    expect(p.dataset.kind).toBe('scaled');
    expect(series(1).progress.itemStyle.color).toBe(NEUTRAL_HEX);
    expect(within(p).getByTestId('gauge-status').textContent).toBe('Not judged');
    expect(within(p).getByTestId('gauge-scale').textContent).toBe('Scale0 - 10 kPa');
    const rawJson = JSON.stringify(charts[1].option).toLowerCase();
    for (const hex of VERDICT_HEXES) expect(rawJson).not.toContain(hex);
  });

  it('Review Focus 5: a raw key with no scale is its value on a NEUTRAL FULL RING; a measured key with no bound reads Not assessed, neutral', () => {
    setRows([row('101-01', [measured(21, { limitMin: null, limitMax: null }), raw(2.5)])]);
    render(<WidgetBody widget={widget({ options: {} })} selection={SEL} />);
    const [t, p] = screen.getAllByTestId('gauge');
    expect(p.dataset.kind).toBe('value-only');
    expect(series(1).progress.show).toBe(false);
    expect(series(1).axisLine.lineStyle.color).toEqual([[1, NEUTRAL_HEX]]);
    expect(within(p).getByTestId('gauge-value').textContent).toBe('2.5');
    expect(within(p).queryByTestId('gauge-scale')).toBeNull();

    expect(t.dataset.kind).toBe('value-only');
    expect(within(t).getByTestId('gauge-status').textContent).toBe('Not assessed');
    expect(series(0).axisLine.lineStyle.color).toEqual([[1, NEUTRAL_HEX]]);
    for (const n of [0, 1]) {
      const json = JSON.stringify(charts[n].option).toLowerCase();
      for (const hex of VERDICT_HEXES) expect(json).not.toContain(hex);
    }
  });

  it('a fault word replaces the number, in red, with no unit', () => {
    setRows([row('101-01', [measured(60, { rangeError: true })])]);
    render(<WidgetBody widget={widget({ keys: [{ source: 'telemetry', key: 't' }] })} selection={SEL} />);
    const value = screen.getByTestId('gauge-value');
    expect(value.textContent).toBe('OL');
    expect(value.className).toContain('text-red-600');
    expect(screen.queryByTestId('gauge-unit')).toBeNull();
    expect(series(0).progress.show).toBe(false);
  });

  it(`draws at most ${GAUGES_SHOWN_MAX} and says how many it did not`, () => {
    setRows(Array.from({ length: 13 }, (_, n) => row(`i${n}`, [measured(20), raw(1)])));
    render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getAllByTestId('gauge')).toHaveLength(GAUGES_SHOWN_MAX);
    expect(screen.getByTestId('widget-cap-note').textContent).toBe(`Showing ${GAUGES_SHOWN_MAX} of 26 gauges`);
  });

  it('spends its gauges only on keys an instrument has sent; none sent says so', () => {
    setRows([row('a', [measured(20), raw(null, { ts: null })]), row('b', [measured(21), raw(3)])]);
    render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getAllByTestId('gauge-title').map((t) => t.textContent)).toEqual([
      'CWH/RDU/a · Temperature', 'CWH/RDU/b · Temperature', 'CWH/RDU/b · Pressure',
    ]);
    expect(screen.queryByTestId('widget-cap-note')).toBeNull();
  });

  it('nothing sent at all: No instrument here has sent these keys yet', () => {
    setRows([row('a', [measured(null), raw(null)].map((v) => ({ ...v, ts: null })))]);
    render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByText('No instrument here has sent these keys yet.')).toBeTruthy();
    expect(charts).toHaveLength(0);
  });

  it('loading, a failed request and nothing in view are each said, in the widget', () => {
    state.ids = { ids: ['a'], loading: false };
    state.latest = { rows: [], loading: true, error: undefined };
    const { unmount } = render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    unmount();
    state.latest = { rows: [], loading: false, error: new Error('403') };
    const second = render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByRole('alert').textContent).toBe('Could not load this widget.');
    second.unmount();
    setRows([], ['hidden']);
    render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByText('No instruments in your view')).toBeTruthy();
  });

  it('re-renders with EQUAL data hand the chart the SAME option (no redraw); a new value, a new one', () => {
    setRows([row('101-01', [measured(21.46)])]);
    const w = widget({ keys: [{ source: 'telemetry', key: 't' }] });
    const { rerender } = render(<WidgetBody widget={w} selection={SEL} />);
    const first = charts.at(-1)!.option;
    // A poll returns equal content in NEW objects (and the selection-mode ids are a new array every render).
    setRows([row('101-01', [measured(21.46)])]);
    rerender(<WidgetBody widget={{ ...w, keys: [{ source: 'telemetry', key: 't' }] }} selection={{ ...SEL }} />);
    expect(charts.at(-1)!.option).toBe(first);
    setRows([row('101-01', [measured(25)])]);
    rerender(<WidgetBody widget={w} selection={SEL} />);
    expect(charts.at(-1)!.option).not.toBe(first);
    expect(charts.at(-1)!.option.series[0].data[0].value).toBeCloseTo(7 / 9, 10);
  });
});
