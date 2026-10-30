import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { WIDGET_INSTRUMENTS_MAX, type CustomWidget, type LatestKeyValue, type LatestValuesRow } from '@digilog/shared';
import type { TelemetryBuckets } from '../use-widget-data';

// Stable module-level objects only: a fresh object per call re-runs effects forever.
const state: {
  ids: { ids: string[]; loading: boolean };
  latest: { rows: LatestValuesRow[]; loading: boolean; error: unknown };
  buckets: { data: TelemetryBuckets | undefined; loading: boolean; error: unknown };
} = {
  ids: { ids: [], loading: false },
  latest: { rows: [], loading: false, error: undefined },
  buckets: { data: undefined, loading: false, error: undefined },
};
/** Every call of the buckets hook: (ids, keys, range, bucket, agg, groupBy). */
const bucketCalls: unknown[][] = [];
vi.mock('../use-widget-data', () => ({
  useWidgetInstrumentIds: () => state.ids,
  useLatestValues: () => state.latest,
  useTelemetryBuckets: (...a: unknown[]) => { bucketCalls.push(a); return state.buckets; },
}));
const WORDS = { failure: 'Error', outOfRange: 'OL' };
vi.mock('@/hooks/use-failure-text', () => ({ useSensorWords: () => WORDS }));
const FORMAT = { formatDateTime: (v: string) => `DT:${v}`, formatDate: (v: string) => `D:${v}`, formatTime: (v: string) => v };
vi.mock('@/hooks/use-datetime-format', () => ({ useDatetimeFormat: () => FORMAT }));
const charts: { option: Record<string, any>; height: number; ariaLabel: string }[] = [];
vi.mock('../charts/lazy-echart', () => ({
  LazyEChart: (p: { option: Record<string, any>; height: number; ariaLabel: string }) => {
    charts.push(p);
    return <div data-testid="echart" aria-label={p.ariaLabel} />;
  },
}));

import { WidgetBody } from '../widget-panel';
import { BAR_HEIGHT, LEGEND_ROW_PX } from '../bar-chart-model';
import { SERIES_HEX } from '../charts/chart-colors';

const SEL = { directOnly: false };
const WINDOW = { mode: 'fixed' as const, from: '2026-10-23T09:00:00.000Z', to: '2026-10-30T09:00:00.000Z' };
const widget = (over: Partial<CustomWidget> = {}): CustomWidget => ({
  id: '33333333-3333-4333-8333-333333333333', type: 'bar_chart', title: 'Room temperature',
  source: { mode: 'selection' },
  keys: [{ source: 'telemetry', key: 't', label: 'Temperature' }, { source: 'telemetry', key: 'Voltage', unit: 'V' }],
  options: {},
  ...over,
});
const measured = (value: unknown, over: Partial<LatestKeyValue> = {}): LatestKeyValue => ({
  source: 'telemetry', key: 't', value, ts: '2026-10-30T08:00:00.000Z', unit: '°C', decimals: 1, display: null,
  judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false },
  ...over,
});
const raw = (value: unknown, over: Partial<LatestKeyValue> = {}): LatestKeyValue => ({
  source: 'telemetry', key: 'Voltage', value, ts: '2026-10-30T08:00:00.000Z', unit: null, decimals: null, display: null,
  judged: null, ...over,
});
const row = (id: string, values: LatestKeyValue[]): LatestValuesRow => ({
  instrumentId: id, code: `CWH/RDU/${id}`, name: id, functionalLocationName: 'QC', locationAttribute: 'Room',
  reporting: true, lastSeenAt: null, values,
});
const setRows = (rows: LatestValuesRow[], ids = rows.map((r) => r.instrumentId)) => {
  state.ids = { ids, loading: false };
  state.latest = { rows, loading: false, error: undefined };
};
const DAY0 = Date.parse('2026-10-22T18:30:00.000Z');
const day = (n: number) => new Date(DAY0 + n * 86_400_000).toISOString();
const BUCKETS: TelemetryBuckets = {
  from: WINDOW.from, to: WINDOW.to, bucket: 'day', agg: 'avg', timezone: 'Asia/Kolkata', bucketSeconds: 86_400,
  series: [{ instrumentId: null, key: 't', points: [1, 2, 3].map((n) => ({ ts: day(n), value: 21 + n / 10, readings: 1440, instruments: 2 })) }],
};
const lastCall = () => bucketCalls.at(-1)!;

beforeEach(() => {
  setRows([]);
  state.buckets = { data: undefined, loading: false, error: undefined };
  bucketCalls.length = 0;
  charts.length = 0;
});

describe('bar chart widget', () => {
  it('says what the bars are computed from, on its face, and asks for exactly that', () => {
    setRows([row('101-01', [measured(21), raw(230)])]);
    state.buckets = { data: BUCKETS, loading: false, error: undefined };
    const { unmount } = render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByTestId('bar-caption').textContent).toBe('Hourly average');
    expect(lastCall().slice(3)).toEqual(['hour', 'avg', 'all']);
    unmount();
    render(<WidgetBody widget={widget({ options: { bucket: 'day', agg: 'max', groupBy: 'all' } })} selection={SEL} />);
    expect(screen.getByTestId('bar-caption').textContent).toBe('Daily maximum');
    expect(lastCall().slice(3)).toEqual(['day', 'max', 'all']);
    expect(charts.at(-1)!.height).toBe(BAR_HEIGHT);
    expect(charts.at(-1)!.option.series[0].itemStyle.color).toBe(SERIES_HEX[0]);
  });

  it("follows the dashboard window when it has no period of its own, and its own period when it has one", () => {
    setRows([row('101-01', [measured(21), raw(230)])]);
    const { unmount } = render(<WidgetBody widget={widget()} selection={{ ...SEL, window: WINDOW }} />);
    expect(lastCall()[2]).toEqual({ from: WINDOW.from, to: WINDOW.to });
    expect((screen.getByLabelText('Period') as HTMLSelectElement).value).toBe('dashboard');
    unmount();
    render(<WidgetBody widget={widget({ options: { period: '1h' } })} selection={{ ...SEL, window: WINDOW }} />);
    const range = lastCall()[2] as { from: string; to: string };
    expect(Date.parse(range.to) - Date.parse(range.from)).toBe(3_600_000);
    expect(range).not.toEqual({ from: WINDOW.from, to: WINDOW.to });
  });

  it(`asks at most ${WIDGET_INSTRUMENTS_MAX} instruments, those that have SENT a key, and says how many of how many`, () => {
    const rows = [row('quiet', [measured(null, { ts: null }), raw(null, { ts: null })])];
    for (let n = 0; n < WIDGET_INSTRUMENTS_MAX + 7; n += 1) rows.push(row(`i${n}`, [measured(21), raw(230)]));
    setRows(rows);
    state.buckets = { data: BUCKETS, loading: false, error: undefined };
    render(<WidgetBody widget={widget()} selection={SEL} />);
    const ids = lastCall()[0] as string[];
    expect(ids).toHaveLength(WIDGET_INSTRUMENTS_MAX);
    expect(ids[0]).toBe('i0');
    expect(ids).not.toContain('quiet');
    expect(lastCall()[1]).toEqual(['t', 'Voltage']);
    const cap = screen.getByTestId('widget-cap-note');
    expect(cap.textContent).toBe(`Showing ${WIDGET_INSTRUMENTS_MAX} of ${WIDGET_INSTRUMENTS_MAX + 7} instruments`);
    // The two notes share one wrapping line, so the chart keeps its room.
    expect(screen.getByTestId('widget-no-readings').parentElement).toBe(cap.parentElement);
  });

  it('each instrument, more series than the palette: no chart, no request, and the counts said as numbers', () => {
    setRows(['101-01', '102-01', '103-01', '104-01'].map((id) => row(id, [measured(21), raw(230)])));
    render(<WidgetBody widget={widget({ options: { groupBy: 'instrument' } })} selection={SEL} />);
    expect(screen.getByText('Too many bars: 4 instruments × 2 keys. Show all instruments combined, or choose fewer.')).toBeTruthy();
    expect(charts).toHaveLength(0);
    expect(bucketCalls.length).toBeGreaterThan(0);
    for (const call of bucketCalls) expect(call[0]).toEqual([]);
  });

  it("a 400 prints the server's own words; the caption and the period stay, so the window can be changed", () => {
    setRows([row('101-01', [measured(21), raw(230)])]);
    const words = 'That window holds more than 1,000 hours; choose a larger bucket or a shorter window';
    state.buckets = { data: undefined, loading: false, error: Object.assign(new Error(words), { status: 400 }) };
    render(<WidgetBody widget={widget()} selection={{ ...SEL, window: { mode: 'fixed', from: '2026-08-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' } }} />);
    expect(screen.getByRole('alert').textContent).toBe(words);
    expect(screen.queryByText('Could not load this widget.')).toBeNull();
    expect(screen.getByTestId('bar-caption').textContent).toBe('Hourly average');
    expect(screen.getByLabelText('Period')).toBeTruthy();
    expect(charts).toHaveLength(0);
  });

  it('any other failure is the generic one', () => {
    setRows([row('101-01', [measured(21), raw(230)])]);
    state.buckets = { data: BUCKETS, loading: false, error: Object.assign(new Error('Internal Server Error'), { status: 500 }) };
    render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByRole('alert').textContent).toBe('Could not load this widget.');
    expect(screen.queryByText('Internal Server Error')).toBeNull();
    expect(charts).toHaveLength(0);
  });

  it('a key with no readings in the window is named, and the others are drawn', () => {
    setRows([row('101-01', [measured(21), raw(230)])]);
    state.buckets = { data: BUCKETS, loading: false, error: undefined };
    render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByTestId('widget-no-readings').textContent).toBe('No readings for Voltage');
    expect(charts.at(-1)!.option.series.map((s: { name: string }) => s.name)).toEqual(['Temperature']);
    expect(charts.at(-1)!.ariaLabel).toBe('Room temperature: Hourly average of Temperature');
  });

  it('nothing sent, loading, a failed request and nothing in view are each said, in the widget', () => {
    setRows([row('a', [measured(null, { ts: null }), raw(null, { ts: null })])]);
    const first = render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByText('No instrument here has sent these keys yet.')).toBeTruthy();
    for (const call of bucketCalls) expect(call[0]).toEqual([]);
    first.unmount();
    state.ids = { ids: ['a'], loading: false };
    state.latest = { rows: [], loading: true, error: undefined };
    const second = render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    second.unmount();
    state.latest = { rows: [], loading: false, error: new Error('500') };
    const third = render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByRole('alert').textContent).toBe('Could not load this widget.');
    third.unmount();
    setRows([], ['hidden']);
    render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByText('No instruments in your view')).toBeTruthy();
    expect(charts).toHaveLength(0);
  });

  it('while the buckets load, the caption stands and the chart area says Loading…', () => {
    setRows([row('101-01', [measured(21), raw(230)])]);
    state.buckets = { data: undefined, loading: true, error: undefined };
    render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByTestId('bar-caption').textContent).toBe('Hourly average');
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(charts).toHaveLength(0);
  });

  it("while a new window loads over the previous one's bars, no key is said to have no readings", () => {
    setRows([row('101-01', [measured(21), raw(230)])]);
    // keepPreviousData: the last window's answer, still on screen, the new one in flight.
    state.buckets = { data: BUCKETS, loading: true, error: undefined };
    render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.queryByTestId('widget-no-readings')).toBeNull();
    expect(charts.length).toBeGreaterThan(0);
  });

  it('re-renders with EQUAL data hand the chart the SAME option; new data, a new one', () => {
    setRows([row('101-01', [measured(21), raw(230)])]);
    state.buckets = { data: BUCKETS, loading: false, error: undefined };
    const w = widget();
    const { rerender } = render(<WidgetBody widget={w} selection={SEL} />);
    const first = charts.at(-1)!.option;
    setRows([row('101-01', [measured(21), raw(230)])]);
    state.buckets = { data: structuredClone(BUCKETS), loading: false, error: undefined };
    rerender(<WidgetBody widget={{ ...w, keys: w.keys.map((k) => ({ ...k })) }} selection={{ ...SEL }} />);
    expect(charts.at(-1)!.option).toBe(first);
    const next = structuredClone(BUCKETS);
    next.series[0].points[0].value = 30;
    state.buckets = { data: next, loading: false, error: undefined };
    rerender(<WidgetBody widget={w} selection={SEL} />);
    expect(charts.at(-1)!.option).not.toBe(first);
  });

  it("each instrument in a third-width card: the plot starts below the legend's MEASURED rows", () => {
    const observers: ResizeObserverCallback[] = [];
    const Original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) { observers.push(cb); }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const ids = ['101-01', '102-01', '001-00'];
      setRows(ids.map((id) => row(id, [measured(21), raw(230)])));
      state.buckets = {
        data: { ...BUCKETS, series: ids.map((id) => ({ instrumentId: id, key: 't', points: BUCKETS.series[0].points })) },
        loading: false,
        error: undefined,
      };
      render(<WidgetBody widget={widget({ keys: [{ source: 'telemetry', key: 't', label: 'Temperature' }], options: { groupBy: 'instrument' } })} selection={SEL} />);
      act(() => {
        observers.at(-1)!([{ contentRect: { width: 361 } } as ResizeObserverEntry], {} as ResizeObserver);
      });
      expect(charts.at(-1)!.option.grid.top).toBe(3 * LEGEND_ROW_PX + 28);
      act(() => {
        observers.at(-1)!([{ contentRect: { width: 1140 } } as ResizeObserverEntry], {} as ResizeObserver);
      });
      expect(charts.at(-1)!.option.grid.top).toBe(LEGEND_ROW_PX + 28);
    } finally {
      globalThis.ResizeObserver = Original;
    }
  });

  it("168 hourly bars in a half-width card: the labels stand upright with a stride, never overlapping", () => {
    const observers: ResizeObserverCallback[] = [];
    const Original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) { observers.push(cb); }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      setRows([row('101-01', [measured(21), raw(230)])]);
      const from = Date.parse('2026-10-23T09:00:00.000Z');
      state.buckets = {
        data: {
          from: new Date(from).toISOString(), to: new Date(from + 168 * 3_600_000).toISOString(),
          bucket: 'hour', agg: 'avg', timezone: 'Asia/Kolkata', bucketSeconds: 3600,
          series: [{ instrumentId: null, key: 't', points: Array.from({ length: 168 }, (_, n) => ({ ts: new Date(from + 1_800_000 + n * 3_600_000).toISOString(), value: 21, readings: 60, instruments: 1 })) }],
        },
        loading: false,
        error: undefined,
      };
      render(<WidgetBody widget={widget()} selection={SEL} />);
      act(() => {
        observers.at(-1)!([{ contentRect: { width: 562 } } as ResizeObserverEntry], {} as ResizeObserver);
      });
      const label = charts.at(-1)!.option.xAxis.axisLabel;
      expect(charts.at(-1)!.option.xAxis.data.length).toBeGreaterThanOrEqual(168);
      expect(label.rotate).toBe(90);
      expect(label.interval).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.ResizeObserver = Original;
    }
  });
});
