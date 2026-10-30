import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CustomWidget, InstrumentStatus } from '@digilog/shared';
import type { OverviewRow } from '../../use-telemetry';
import type { AlarmCounts } from '../use-widget-data';

// Stable module-level objects only: a fresh object per call re-runs effects forever.
const state: {
  overview: { rows: OverviewRow[]; loading: boolean; error: unknown };
  counts: { data: AlarmCounts | undefined; loading: boolean; error: unknown };
} = {
  overview: { rows: [], loading: false, error: undefined },
  counts: { data: undefined, loading: false, error: undefined },
};
const countCalls: unknown[] = [];
vi.mock('../use-widget-data', () => ({
  useWidgetOverview: () => state.overview,
  useAlarmCounts: (scope: unknown) => { countCalls.push(scope); return state.counts; },
}));
const NAMES = { limitTemperatureHigh: 'Room too warm' };
vi.mock('@/hooks/use-failure-text', () => ({ useAlarmTypeNames: () => NAMES }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an ECharts option is untyped JSON.
type Drawn = { option: Record<string, any>; height: number; ariaLabel: string };
const charts: Drawn[] = [];
vi.mock('../charts/lazy-echart', () => ({
  LazyEChart: (p: Drawn) => {
    charts.push(p);
    return <div data-testid="echart" aria-label={p.ariaLabel} />;
  },
}));

import { WidgetBody } from '../widget-panel';
import { NEUTRAL_HEX, SERIES_HEX, STATUS_HEX } from '../charts/chart-colors';
import { PIE_HEIGHT } from '../pie-model';

const SEL = { functionalLocationId: 'fl-1', directOnly: false };
const pie = (of: 'status' | 'alarm_types', source: CustomWidget['source'] = { mode: 'selection' }): CustomWidget => ({
  id: '88888888-8888-4888-8888-888888888888', type: 'pie_chart', title: 'Health', source, keys: [], options: { of },
});
const row = (id: string, status: InstrumentStatus, over: Partial<OverviewRow> = {}): OverviewRow => ({
  instrumentId: id, code: `CWH/RDU/${id}`, name: id, isActive: true, room: null,
  limits: null, limitSource: null, temperature: null, humidity: null,
  decimals: { temperature: 1, humidity: 1 }, reporting: true, judged: true, status, ...over,
});
const ROWS = [row('a', 'OK'), row('b', 'OK'), row('c', 'NO_DATA', { judged: false }), row('d', 'OUT_OF_SPEC')];
const COUNTS: AlarmCounts = {
  quadrants: { activeUnack: 3, activeAck: 2, clearedUnack: 0, clearedAck: 9 },
  byType: [
    { type: 'TEMP_HIGH', active: 4, unacknowledged: 3 },
    { type: 'TEMP_LOW', active: 0, unacknowledged: 0 },
    { type: 'OFFLINE', active: 1, unacknowledged: 0 },
  ],
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an ECharts option is untyped JSON.
const slicesOf = (d: Drawn) => d.option.series[0].data.map((x: any) => [x.name, x.value, x.itemStyle.color]);

beforeEach(() => {
  state.overview = { rows: ROWS, loading: false, error: undefined };
  state.counts = { data: COUNTS, loading: false, error: undefined };
  charts.length = 0;
  countCalls.length = 0;
});

describe('pie chart widget — instrument status', () => {
  it('draws the selection\'s instruments by their instrumentLook, in status colours', () => {
    render(<WidgetBody widget={pie('status')} selection={SEL} />);
    const drawn = charts.at(-1)!;
    expect(drawn.height).toBe(PIE_HEIGHT);
    expect(slicesOf(drawn)).toEqual([
      ['Out of limit', 1, STATUS_HEX.OUT_OF_SPEC],
      ['Not judged', 1, STATUS_HEX.NOT_JUDGED],
      ['In limit', 2, STATUS_HEX.OK],
    ]);
    expect(drawn.ariaLabel).toBe('Health: 4 instruments — Out of limit 1, Not judged 1, In limit 2');
    // R7-1, through the widget.
    expect(drawn.option.legend.selectedMode).toBe(false);
  });

  it('Review Focus 1: the reporting pressure-only instrument is a neutral "Not judged" slice — never "No data", never green', () => {
    state.overview = { rows: [row('p', 'NO_DATA', { judged: false, reporting: true })], loading: false, error: undefined };
    render(<WidgetBody widget={pie('status')} selection={SEL} />);
    const [[name, , color]] = slicesOf(charts.at(-1)!);
    expect(name).toBe('Not judged');
    expect(color).toBe(NEUTRAL_HEX);
    expect(color).not.toBe(STATUS_HEX.OK);
    expect(color).not.toBe(STATUS_HEX.NO_DATA);
  });

  it('Review Focus 1: not reporting, it is an "Offline" slice', () => {
    state.overview = { rows: [row('p', 'NO_DATA', { judged: false, reporting: false })], loading: false, error: undefined };
    render(<WidgetBody widget={pie('status')} selection={SEL} />);
    expect(slicesOf(charts.at(-1)!)).toEqual([['Offline', 1, STATUS_HEX.STALE]]);
  });

  it('one draw however often it renders: the option is keyed on what it shows', () => {
    const { rerender } = render(<WidgetBody widget={pie('status')} selection={SEL} />);
    // A poll hands NEW row objects with the same content.
    state.overview = { rows: ROWS.map((r) => ({ ...r })), loading: false, error: undefined };
    rerender(<WidgetBody widget={pie('status')} selection={SEL} />);
    expect(charts.length).toBeGreaterThan(1);
    expect(new Set(charts.map((c) => c.option)).size).toBe(1);
  });

  it('nothing in view says so and draws no ring; a failed load says so', () => {
    state.overview = { rows: [], loading: false, error: undefined };
    const a = render(<WidgetBody widget={pie('status')} selection={SEL} />);
    expect(screen.getByText('No instruments in your view')).toBeTruthy();
    expect(charts).toHaveLength(0);
    a.unmount();
    state.overview = { rows: [], loading: false, error: Object.assign(new Error('500'), { status: 500 }) };
    render(<WidgetBody widget={pie('status')} selection={SEL} />);
    expect(screen.getByRole('alert').textContent).toBe('Could not load this widget.');
  });
});

describe('pie chart widget — active alarms by type', () => {
  it('draws each type with an active alarm, named as administered, in series colours', () => {
    render(<WidgetBody widget={pie('alarm_types')} selection={SEL} />);
    expect(slicesOf(charts.at(-1)!)).toEqual([
      ['Room too warm', 4, SERIES_HEX[0]],
      ['Inactivity', 1, SERIES_HEX[1]],
    ]);
    expect(charts.at(-1)!.option.legend.selectedMode).toBe(false);
  });

  it('asks with the widget\'s alarm scope: its own instruments when it has them', () => {
    render(<WidgetBody widget={pie('alarm_types', { mode: 'instruments', ids: ['x'] })} selection={SEL} />);
    expect(countCalls.at(-1)).toEqual({ instrumentIds: ['x'] });
  });

  it('no active alarm: "Nothing to show", in text — not an empty ring', () => {
    state.counts = {
      data: { quadrants: { activeUnack: 0, activeAck: 0, clearedUnack: 1, clearedAck: 4 }, byType: [{ type: 'TEMP_HIGH', active: 0, unacknowledged: 1 }] },
      loading: false, error: undefined,
    };
    render(<WidgetBody widget={pie('alarm_types')} selection={SEL} />);
    expect(screen.getByText('Nothing to show')).toBeTruthy();
    expect(charts).toHaveLength(0);
  });

  it('Review Focus 4: a 403 is "Could not load this widget."', () => {
    state.counts = { data: undefined, loading: false, error: Object.assign(new Error('HTTP 403'), { status: 403 }) };
    render(<WidgetBody widget={pie('alarm_types')} selection={SEL} />);
    expect(screen.getByRole('alert').textContent).toBe('Could not load this widget.');
    expect(charts).toHaveLength(0);
  });

  it('an empty instrument list asks nothing and says so', () => {
    state.counts = { data: undefined, loading: false, error: undefined };
    render(<WidgetBody widget={pie('alarm_types')} selection={{ directOnly: false, instrumentIds: [] }} />);
    expect(screen.getByText('No instruments in your view')).toBeTruthy();
  });
});
