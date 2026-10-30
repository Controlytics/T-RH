import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { CustomWidget } from '@digilog/shared';
import type { AlarmCounts } from '../use-widget-data';

// Stable module-level objects only: a fresh object per call re-runs effects forever.
const state: { counts: { data: AlarmCounts | undefined; loading: boolean; error: unknown } } = {
  counts: { data: undefined, loading: false, error: undefined },
};
const countCalls: unknown[] = [];
vi.mock('../use-widget-data', () => ({
  useAlarmCounts: (scope: unknown) => { countCalls.push(scope); return state.counts; },
}));
const NAMES: { current: Record<string, string> | undefined } = { current: { limitTemperatureHigh: 'Room too warm' } };
vi.mock('@/hooks/use-failure-text', () => ({ useAlarmTypeNames: () => NAMES.current }));

import { WidgetBody } from '../widget-panel';

const SEL = { functionalLocationId: 'fl-1', directOnly: true };
const widget = (source: CustomWidget['source'] = { mode: 'selection' }): CustomWidget => ({
  id: '77777777-7777-4777-8777-777777777777', type: 'alarm_counts', title: 'Alarms now', source, keys: [], options: {},
});
// A DISTINCT number in every quadrant, so each figure can only be one sum.
const QUADRANTS = { activeUnack: 3, activeAck: 5, clearedUnack: 7, clearedAck: 11 };
const BY_TYPE: AlarmCounts['byType'] = [
  { type: 'TEMP_HIGH', active: 4, unacknowledged: 6 },
  { type: 'TEMP_LOW', active: 0, unacknowledged: 2 },
  { type: 'RH_HIGH', active: 2, unacknowledged: 1 },
  { type: 'RH_LOW', active: 0, unacknowledged: 0 },
  { type: 'OFFLINE', active: 1, unacknowledged: 1 },
  { type: 'RS485', active: 1, unacknowledged: 0 },
  { type: 'RANGE', active: 0, unacknowledged: 0 },
  // A token this browser's bundle does not know.
  { type: 'VIBRATION', active: 2, unacknowledged: 2 },
];
const COUNTS: AlarmCounts = { quadrants: QUADRANTS, byType: BY_TYPE };
const setCounts = (data: AlarmCounts | undefined, error?: unknown, loading = false) => {
  state.counts = { data, loading, error };
};
const view = (w = widget(), selection: Parameters<typeof WidgetBody>[0]['selection'] = SEL) =>
  render(<WidgetBody widget={w} selection={selection} />);
const figure = (name: string) => screen.getByTestId(`alarm-figure-${name}`);
const typeRows = () => screen.getAllByTestId('alarm-type-row');

beforeEach(() => {
  setCounts(COUNTS);
  countCalls.length = 0;
  NAMES.current = { limitTemperatureHigh: 'Room too warm' };
});

describe('alarm counts widget', () => {
  it('"Active" and "Unacknowledged" are the server\'s quadrants summed — and nothing else', () => {
    view();
    expect(within(figure('active')).getByTestId('alarm-figure-label').textContent).toBe('Active');
    expect(within(figure('active')).getByTestId('alarm-figure-value').textContent).toBe('8');
    expect(within(figure('unacknowledged')).getByTestId('alarm-figure-label').textContent).toBe('Unacknowledged');
    expect(within(figure('unacknowledged')).getByTestId('alarm-figure-value').textContent).toBe('10');
    // Not a count of the type list (4 + 2 + 1 + 1 + 2 = 10 active there): only the quadrants.
    setCounts({ quadrants: { activeUnack: 0, activeAck: 1, clearedUnack: 0, clearedAck: 0 }, byType: BY_TYPE });
    view();
    expect(screen.getAllByTestId('alarm-figure-value').map((e) => e.textContent)).toEqual(['8', '10', '1', '0']);
  });

  it('every type the server lists, with its active count, named as administered; zeros muted, not hidden', () => {
    view();
    expect(typeRows().map((r) => [
      within(r).getByTestId('alarm-type-name').textContent, within(r).getByTestId('alarm-type-count').textContent,
    ])).toEqual([
      ['Room too warm', '4'],
      ['Low Temperature', '0'],
      ['High Humidity', '2'],
      ['Low Humidity', '0'],
      ['Inactivity', '1'],
      ['RS485 Temperature Failure / RS485 Humidity Failure', '1'],
      ['Temperature Failure / Humidity Failure', '0'],
      // The server's own token, never a blank.
      ['VIBRATION', '2'],
    ]);
    const zero = typeRows()[1];
    const four = typeRows()[0];
    expect(zero.getAttribute('data-zero')).toBe('true');
    expect(within(zero).getByTestId('alarm-type-count').className).toContain('text-slate-400');
    expect(within(four).getByTestId('alarm-type-count').className).not.toContain('text-slate-400');
  });

  it('asks with the widget\'s alarm scope: the selection, or its own instruments', () => {
    view();
    expect(countCalls.at(-1)).toEqual({ functionalLocationId: 'fl-1', directOnly: true, profileId: undefined, instrumentIds: undefined });
    view(widget({ mode: 'instruments', ids: ['a', 'b'] }));
    expect(countCalls.at(-1)).toEqual({ instrumentIds: ['a', 'b'] });
  });

  it('Review Focus 4: a 403 (no ALARM_READ) is "Could not load this widget." — even over counts it held', () => {
    const refused = Object.assign(new Error('HTTP 403'), { status: 403 });
    setCounts(undefined, refused);
    const a = view();
    expect(screen.getByRole('alert').textContent).toBe('Could not load this widget.');
    expect(screen.queryByTestId('alarm-figure-active')).toBeNull();
    a.unmount();
    setCounts(COUNTS, refused);
    view();
    expect(screen.getByRole('alert').textContent).toBe('Could not load this widget.');
    expect(screen.queryByTestId('alarm-figure-active')).toBeNull();
  });

  it('a failed refresh keeps the counts it holds and says so; a failure with none is a failure', () => {
    const down = Object.assign(new Error('HTTP 502'), { status: 502 });
    setCounts(COUNTS, down);
    const a = view();
    expect(within(figure('active')).getByTestId('alarm-figure-value').textContent).toBe('8');
    expect(screen.getByTestId('widget-refresh-failed')).toBeTruthy();
    a.unmount();
    setCounts(undefined, down);
    view();
    expect(screen.getByRole('alert').textContent).toBe('Could not load this widget.');
  });

  it('loading is said; an empty instrument list asks nothing and says so', () => {
    setCounts(undefined, undefined, true);
    const a = view();
    expect(screen.getByText('Loading…')).toBeTruthy();
    a.unmount();
    setCounts(undefined);
    view(widget(), { directOnly: false, instrumentIds: [] });
    expect(screen.getByText('No instruments in your view')).toBeTruthy();
  });
});
