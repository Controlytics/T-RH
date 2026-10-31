import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { WIDGET_INSTRUMENTS_MAX, type CustomWidget, type LatestKeyValue, type LatestValuesRow } from '@digilog/shared';

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
  // The real constant's value: `useWidgetRows` asks the latest values for THIS request only.
  THIS_REQUEST_ONLY: { keepPreviousData: false },
}));
const WORDS = { failure: 'Error', outOfRange: 'OL' };
vi.mock('@/hooks/use-failure-text', () => ({ useSensorWords: () => WORDS }));
const FORMAT = { formatDateTime: (v: string) => v, formatDate: (v: string) => v, formatTime: (v: string) => v };
vi.mock('@/hooks/use-datetime-format', () => ({ useDatetimeFormat: () => FORMAT }));
const PAGING = { options: [10, 25, 50], defaultLimit: 25 };
vi.mock('@/hooks/use-pagination-config', () => ({ usePaginationDefaults: () => PAGING }));
const charts: { option: Record<string, any>; height: number; ariaLabel: string }[] = [];
vi.mock('../charts/lazy-echart', () => ({
  LazyEChart: (p: { option: Record<string, any>; height: number; ariaLabel: string }) => {
    charts.push(p);
    return <div data-testid="echart" aria-label={p.ariaLabel} />;
  },
}));

import { WidgetBody } from '../widget-panel';
import { SERIES_HEX } from '../charts/chart-colors';
import { COMPARISON_HEIGHT, LEGEND_ROW_PX } from '../comparison-model';

const SEL = { directOnly: false };
const widget = (over: Partial<CustomWidget> = {}): CustomWidget => ({
  id: '22222222-2222-4222-8222-222222222222', type: 'comparison_bar', title: 'Side by side',
  source: { mode: 'selection' },
  keys: [{ source: 'telemetry', key: 't', label: 'Temperature' }, { source: 'telemetry', key: 'Pressure', unit: 'kPa', color: 3 }],
  options: {},
  ...over,
});
const measured = (value: unknown): LatestKeyValue => ({
  source: 'telemetry', key: 't', value, ts: '2026-10-30T10:00:00.000Z', unit: '°C', decimals: 1, display: null,
  judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false },
});
const raw = (value: unknown, over: Partial<LatestKeyValue> = {}): LatestKeyValue => ({
  source: 'telemetry', key: 'Pressure', value, ts: '2026-10-30T10:00:00.000Z', unit: null, decimals: null, display: null,
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

beforeEach(() => {
  setRows([]);
  charts.length = 0;
});

describe('comparison bar widget', () => {
  it('draws the instruments side by side, one bar series per key in its colour, a gap for a missing value', () => {
    setRows([row('101-01', [measured(21.46), raw(2.5)]), row('001-00', [measured(23), raw('RUN')])]);
    render(<WidgetBody widget={widget()} selection={SEL} />);
    // One option object however many renders (the box measuring itself is one): one draw.
    expect(new Set(charts.map((c) => c.option)).size).toBe(1);
    const { option, height, ariaLabel } = charts[0];
    expect(height).toBe(COMPARISON_HEIGHT);
    expect(option.xAxis.data).toEqual(['CWH/RDU/101-01', 'CWH/RDU/001-00']);
    expect(option.series.map((s: any) => s.itemStyle.color)).toEqual([SERIES_HEX[0], SERIES_HEX[3]]);
    expect(option.series[1].data).toEqual([2.5, null]);
    expect(ariaLabel).toBe('Side by side: Temperature, Pressure for 2 instruments');
    expect(screen.queryByTestId('widget-cap-note')).toBeNull();
  });

  it(`instruments beyond ${WIDGET_INSTRUMENTS_MAX} are not drawn, and the widget says how many it drew`, () => {
    setRows(Array.from({ length: WIDGET_INSTRUMENTS_MAX + 7 }, (_, n) => row(`i${n}`, [measured(20), raw(1)])));
    render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(charts[0].option.xAxis.data).toHaveLength(WIDGET_INSTRUMENTS_MAX);
    expect(screen.getByTestId('widget-cap-note').textContent).toBe(`Showing ${WIDGET_INSTRUMENTS_MAX} of ${WIDGET_INSTRUMENTS_MAX + 7} instruments`);
  });

  it('nothing sent: says so, draws no empty chart', () => {
    setRows([row('a', [{ ...measured(null), ts: null }, raw(null, { ts: null })])]);
    render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByText('No instrument here has sent these keys yet.')).toBeTruthy();
    expect(charts).toHaveLength(0);
  });

  it('loading, a failed request and nothing in view are each said, in the widget', () => {
    state.ids = { ids: ['a'], loading: false };
    state.latest = { rows: [], loading: true, error: undefined };
    const first = render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    first.unmount();
    state.latest = { rows: [], loading: false, error: new Error('500') };
    const second = render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByRole('alert').textContent).toBe('Could not load this widget.');
    second.unmount();
    setRows([], ['hidden']);
    render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByText('No instruments in your view')).toBeTruthy();
  });

  it("turns the codes by the chart's MEASURED width, and redraws only when that decision changes", () => {
    const observers: { cb: ResizeObserverCallback; el?: Element }[] = [];
    const Original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) { this.cb = cb; observers.push({ cb }); }
      observe(el: Element) { observers[observers.length - 1].el = el; }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      setRows([row('101-01', [measured(21), raw(2)]), row('102-01', [measured(22), raw(3)]), row('103-01', [measured(23), raw(4)])]);
      render(<WidgetBody widget={widget()} selection={SEL} />);
      expect(charts.at(-1)!.option.xAxis.axisLabel.rotate).toBe(0);
      const resize = (width: number) => act(() => {
        observers.at(-1)!.cb([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
      });
      resize(260);
      expect(charts.at(-1)!.option.xAxis.axisLabel.rotate).toBe(45);
      const turned = charts.at(-1)!.option;
      resize(250);
      expect(charts.at(-1)!.option).toBe(turned);
      resize(1140);
      expect(charts.at(-1)!.option.xAxis.axisLabel.rotate).toBe(0);
    } finally {
      globalThis.ResizeObserver = Original;
    }
  });

  it('fifty codes in a half-width card stand upright with a stride (M3)', () => {
    const observers: ResizeObserverCallback[] = [];
    const Original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) { observers.push(cb); }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      setRows(Array.from({ length: 50 }, (_, n) => row(`${100 + n}-01`, [measured(20), raw(1)])));
      render(<WidgetBody widget={widget()} selection={SEL} />);
      act(() => {
        observers.at(-1)!([{ contentRect: { width: 562 } } as ResizeObserverEntry], {} as ResizeObserver);
      });
      const label = charts.at(-1)!.option.xAxis.axisLabel;
      expect(label.rotate).toBe(90);
      expect(label.interval).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.ResizeObserver = Original;
    }
  });

  it("four keys in a quarter-width card: the plot starts below the legend's MEASURED rows (render check 2026-10-31)", () => {
    const observers: ResizeObserverCallback[] = [];
    const Original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) { observers.push(cb); }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const keys = [
        ...widget().keys,
        { source: 'telemetry' as const, key: 'Power', unit: 'W' },
        { source: 'telemetry' as const, key: 'Voltage', unit: 'V' },
      ];
      setRows([row('101-01', [measured(21), raw(101.7), raw(1380, { key: 'Power' }), raw(231, { key: 'Voltage' })])]);
      render(<WidgetBody widget={widget({ keys })} selection={SEL} />);
      const resize = (width: number) => act(() => {
        observers.at(-1)!([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
      });
      // "Temperature (°C)", "Pressure (kPa)", "Power (W)", "Voltage (V)" — mixed units, so no axis
      // name and 14 px over the plot: three rows at the narrowest card, one at full width.
      resize(262);
      expect(charts.at(-1)!.option.grid.top).toBe(3 * LEGEND_ROW_PX + 14);
      resize(1140);
      expect(charts.at(-1)!.option.grid.top).toBe(LEGEND_ROW_PX + 14);
    } finally {
      globalThis.ResizeObserver = Original;
    }
  });

  it(`a key only instruments past the ${WIDGET_INSTRUMENTS_MAX}-cap have sent: not drawn, no "No readings" note — "Showing 50 of N" covers it`, () => {
    const rows = Array.from({ length: WIDGET_INSTRUMENTS_MAX + 2 }, (_, n) => row(`i${n}`, [measured(20), raw(null, { ts: null })]));
    rows[WIDGET_INSTRUMENTS_MAX + 1] = row(`i${WIDGET_INSTRUMENTS_MAX + 1}`, [measured(20), raw(101.3)]);
    setRows(rows);
    render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.queryByTestId('widget-no-readings')).toBeNull();
    expect(screen.getByTestId('widget-cap-note').textContent).toBe(`Showing ${WIDGET_INSTRUMENTS_MAX} of ${WIDGET_INSTRUMENTS_MAX + 2} instruments`);
    expect(charts.at(-1)!.option.series.map((s: { name: string }) => s.name)).toEqual(['Temperature']);
  });

  it('m-6: the cap and the keys with no readings share ONE note row — the bar chart and gauge layout', () => {
    const keys = [...widget().keys, { source: 'telemetry' as const, key: 'Voltage', label: 'Voltage' }];
    setRows(Array.from({ length: WIDGET_INSTRUMENTS_MAX + 3 }, (_, n) => row(`i${n}`, [measured(20), raw(1), raw(null, { key: 'Voltage', ts: null })])));
    render(<WidgetBody widget={widget({ keys })} selection={SEL} />);
    const notes = screen.getByTestId('widget-notes');
    expect(notes.contains(screen.getByTestId('widget-cap-note'))).toBe(true);
    expect(notes.contains(screen.getByTestId('widget-no-readings'))).toBe(true);
  });

  it('a key no drawn instrument has sent is SAID, not drawn as an empty legend entry (M5)', () => {
    setRows([row('101-01', [measured(21), raw(null, { ts: null })]), row('102-01', [measured(22), raw(null, { ts: null })])]);
    render(<WidgetBody widget={widget()} selection={SEL} />);
    expect(screen.getByTestId('widget-no-readings').textContent).toBe('No readings for Pressure');
    expect(charts.at(-1)!.option.series.map((s: { name: string }) => s.name)).toEqual(['Temperature']);
    expect(charts.at(-1)!.option.legend.show).toBe(false);
  });

  it('re-renders with EQUAL data hand the chart the SAME option; a new value, a new one', () => {
    setRows([row('101-01', [measured(21.46), raw(2.5)])]);
    const w = widget();
    const { rerender } = render(<WidgetBody widget={w} selection={SEL} />);
    const first = charts.at(-1)!.option;
    setRows([row('101-01', [measured(21.46), raw(2.5)])]);
    rerender(<WidgetBody widget={{ ...w, keys: w.keys.map((k) => ({ ...k })) }} selection={{ ...SEL }} />);
    expect(charts.at(-1)!.option).toBe(first);
    setRows([row('101-01', [measured(21.46), raw(3)])]);
    rerender(<WidgetBody widget={w} selection={SEL} />);
    expect(charts.at(-1)!.option).not.toBe(first);
    expect(charts.at(-1)!.option.series[1].data).toEqual([3]);
  });
});
