import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig, useSWRConfig, type SWRConfiguration } from 'swr';
import type { CustomWidget } from '@digilog/shared';
import type { OverviewRow } from '../../use-telemetry';
import type { AlarmCounts } from '../use-widget-data';

/**
 * I-1 (fix round 1): an answer held from a DIFFERENT scope is never drawn as the
 * current scope's. REAL SWR over a mocked `apiClient`, so `keepPreviousData` and
 * the cache behave as they do in the app: mount on Block A, then drill down to
 * Block B and let B's request load, fail or succeed. And the SAME scope's failed
 * refresh still keeps its answer, said in the widget's own words.
 */

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
const WORDS = { failure: 'Error', outOfRange: 'OL' };
vi.mock('@/hooks/use-failure-text', () => ({ useAlarmTypeNames: () => undefined, useSensorWords: () => WORDS }));
const charts: { option: unknown }[] = [];
vi.mock('../charts/lazy-echart', () => ({
  LazyEChart: (p: { option: unknown; ariaLabel: string }) => {
    charts.push(p);
    return <div data-testid="echart" aria-label={p.ariaLabel} />;
  },
}));

import { WidgetBody } from '../widget-panel';

const A = { functionalLocationId: 'block-a', directOnly: false };
const B = { functionalLocationId: 'block-b', directOnly: false };
/** Everything in view — the scope a drill UP from Block A lands on. */
const ALL = { directOnly: false };
const W = (type: CustomWidget['type'], options: CustomWidget['options'] = {}): CustomWidget => ({
  id: '99999999-9999-4999-8999-999999999999', type, title: 'W', source: { mode: 'selection' }, keys: [], options,
});

const counts = (activeUnack: number): AlarmCounts => ({
  quadrants: { activeUnack, activeAck: 0, clearedUnack: 0, clearedAck: 0 },
  byType: [{ type: 'TEMP_HIGH', active: activeUnack, unacknowledged: activeUnack }],
});
const COUNTS_A = counts(41);
const COUNTS_B = counts(7);
const row = (id: string, code: string): OverviewRow => ({
  instrumentId: id, code, name: code, isActive: true, room: null, limits: null, limitSource: null,
  temperature: null, humidity: null, decimals: { temperature: 1, humidity: 1 }, reporting: true, judged: true, status: 'OK',
});
const ROWS_A = { data: [row('a1', 'BLOCK-A/001')] };
const ROWS_B = { data: [row('b1', 'BLOCK-B/001')] };

/** Everything in view (no location): Block A's instrument AND Block B's — a drill UP's new scope. */
const ROWS_ALL = { data: [row('a1', 'BLOCK-A/001'), row('b1', 'BLOCK-B/001')] };

type Outcome = 'resolve' | 'pending' | 'reject';
/** `all` is the latest-values request for everything in view (a1 + b1); its overview always resolves. */
const outcome: { a: Outcome; b: Outcome; all: Outcome } = { a: 'resolve', b: 'resolve', all: 'resolve' };
const down = () => Object.assign(new Error('HTTP 502'), { status: 502 });
const answer = (o: Outcome, value: unknown) => (o === 'resolve' ? Promise.resolve(value)
  : o === 'reject' ? Promise.reject(down()) : new Promise(() => {}));

function route(url: string): Promise<unknown> {
  if (url === '/api/instruments/telemetry-overview') return Promise.resolve(ROWS_ALL);
  const inA = url.includes('block-a');
  const o = inA ? outcome.a : outcome.b;
  if (url.startsWith('/api/alarms/counts')) return answer(o, inA ? COUNTS_A : COUNTS_B);
  if (url.startsWith('/api/instruments/telemetry-overview')) return answer(o, inA ? ROWS_A : ROWS_B);
  return Promise.resolve(undefined);
}

/** Each instrument's latest `t` — a measured temperature in limit, so a held ring would read "In limit". */
const latest = (id: string, code: string) => ({
  instrumentId: id, code, name: code, functionalLocationName: 'Area', locationAttribute: 'Room', reporting: true, lastSeenAt: null,
  values: [{
    source: 'telemetry', key: 't', value: 21.5, ts: '2026-10-31T10:00:00.000Z', unit: '°C', decimals: 1, display: null,
    judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false },
  }],
});
function routePost(url: string, body: { instrumentIds: string[] }): Promise<unknown> {
  if (url !== '/api/instruments/latest-values') return Promise.resolve({ data: [] });
  const ids = body.instrumentIds.join(',');
  if (ids === 'a1') return answer(outcome.a, { data: [latest('a1', 'BLOCK-A/001')] });
  if (ids === 'b1') return answer(outcome.b, { data: [latest('b1', 'BLOCK-B/001')] });
  return answer(outcome.all, { data: [latest('a1', 'BLOCK-A/001'), latest('b1', 'BLOCK-B/001')] });
}

// One config object for the whole mount, so a rerender keeps its cache.
const SWR: SWRConfiguration = {
  provider: () => new Map(), fetcher: (u: string) => get(u), dedupingInterval: 0, shouldRetryOnError: false, revalidateOnFocus: false,
};
const revalidate: { fn: ((key: string | unknown[]) => Promise<unknown>) | null } = { fn: null };
function Revalidator() {
  const { mutate } = useSWRConfig();
  revalidate.fn = (key: string | unknown[]) => mutate(key);
  return null;
}
const tree = (w: CustomWidget, selection: typeof A | typeof ALL) => (
  <SWRConfig value={SWR}>
    <MemoryRouter>
      <Revalidator />
      <WidgetBody widget={w} selection={selection} trail={[]} />
    </MemoryRouter>
  </SWRConfig>
);

const activeFigure = () => screen.queryByTestId('alarm-figure-active');
let quiet: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  outcome.a = 'resolve';
  outcome.b = 'resolve';
  outcome.all = 'resolve';
  charts.length = 0;
  get.mockReset().mockImplementation(route);
  post.mockReset().mockImplementation(routePost);
  // A non-refusal failure is reported once through the app's handler (Task 6's policy).
  quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => quiet.mockRestore());

describe('alarm counts across a scope change (I-1)', () => {
  const mountOnA = async () => {
    const view = render(tree(W('alarm_counts'), A));
    await waitFor(() => expect(within(activeFigure()!).getByTestId('alarm-figure-value').textContent).toBe('41'));
    return view;
  };

  it('while the new scope LOADS: "Loading…", never the previous scope\'s counts', async () => {
    const view = await mountOnA();
    outcome.b = 'pending';
    view.rerender(tree(W('alarm_counts'), B));
    await waitFor(() => expect(screen.getByText('Loading…')).toBeInTheDocument());
    expect(activeFigure()).toBeNull();
    expect(screen.queryByText('41')).toBeNull();
  });

  it('when the new scope FAILS: "Could not load this widget.", never the previous scope\'s counts with a refresh note', async () => {
    const view = await mountOnA();
    outcome.b = 'reject';
    view.rerender(tree(W('alarm_counts'), B));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load this widget.');
    expect(activeFigure()).toBeNull();
    expect(screen.queryByTestId('widget-refresh-failed')).toBeNull();
  });

  it('when the new scope SUCCEEDS: its own counts', async () => {
    const view = await mountOnA();
    view.rerender(tree(W('alarm_counts'), B));
    await waitFor(() => expect(within(activeFigure()!).getByTestId('alarm-figure-value').textContent).toBe('7'));
  });

  it('the SAME scope\'s failed refresh keeps its counts, and says so in alarm words', async () => {
    await mountOnA();
    outcome.a = 'reject';
    await act(async () => { await revalidate.fn!('/api/alarms/counts?functionalLocationId=block-a'); });
    await waitFor(() => expect(screen.getByTestId('widget-refresh-failed').textContent)
      .toBe('These alarms could not be refreshed. Showing the last ones that loaded.'));
    expect(within(activeFigure()!).getByTestId('alarm-figure-value').textContent).toBe('41');
  });
});

describe('the alarm-type pie across a scope change (I-1)', () => {
  it('when the new scope fails, no ring of the previous scope is drawn', async () => {
    const view = render(tree(W('pie_chart', { of: 'alarm_types' }), A));
    await waitFor(() => expect(screen.getByTestId('echart')).toBeInTheDocument());
    outcome.b = 'reject';
    view.rerender(tree(W('pie_chart', { of: 'alarm_types' }), B));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load this widget.');
    expect(screen.queryByTestId('echart')).toBeNull();
  });
});

describe('status grid across a scope change (I-1)', () => {
  const codes = () => screen.queryAllByTestId('status-tile-code').map((e) => e.textContent);
  const mountOnA = async () => {
    const view = render(tree(W('status_grid'), A));
    await waitFor(() => expect(codes()).toEqual(['BLOCK-A/001']));
    return view;
  };

  it('while the new scope LOADS: "Loading…", never the previous scope\'s tiles', async () => {
    const view = await mountOnA();
    outcome.b = 'pending';
    view.rerender(tree(W('status_grid'), B));
    await waitFor(() => expect(screen.getByText('Loading…')).toBeInTheDocument());
    expect(codes()).toEqual([]);
  });

  it('when the new scope FAILS: "Could not load this widget.", as the readings table on the same key says it cannot load', async () => {
    const view = await mountOnA();
    outcome.b = 'reject';
    view.rerender(tree(W('status_grid'), B));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load this widget.');
    expect(codes()).toEqual([]);
  });

  it('when the new scope SUCCEEDS: its own tiles', async () => {
    const view = await mountOnA();
    view.rerender(tree(W('status_grid'), B));
    await waitFor(() => expect(codes()).toEqual(['BLOCK-B/001']));
  });

  it('the SAME scope\'s failed refresh keeps its tiles, and says so', async () => {
    await mountOnA();
    outcome.a = 'reject';
    await act(async () => { await revalidate.fn!('/api/instruments/telemetry-overview?functionalLocationId=block-a'); });
    await waitFor(() => expect(screen.getByTestId('widget-refresh-failed')).toBeInTheDocument());
    expect(codes()).toEqual(['BLOCK-A/001']);
  });
});

describe('the status pie across a scope change (I-1)', () => {
  it('when the new scope fails, no ring of the previous scope is drawn', async () => {
    const view = render(tree(W('pie_chart', { of: 'status' }), A));
    await waitFor(() => expect(screen.getByTestId('echart')).toBeInTheDocument());
    outcome.b = 'reject';
    view.rerender(tree(W('pie_chart', { of: 'status' }), B));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load this widget.');
    expect(screen.queryByTestId('echart')).toBeNull();
  });
});

/**
 * F-I1 / F-I2 (final fix wave): the KEY widgets — gauges, comparison bars, value
 * cards, the latest table and the history widgets — took their instruments from
 * the overview with the readings table's hold and dropped its error. A failed
 * first load read "No instruments in your view"; a failed drill-down drew the
 * previous scope's instruments; a drill UP drew the old scope's subset as the new
 * one's; and a failed refresh kept a green "In limit" ring with no word. Now the
 * ONE held-answer rule (`answerState`) decides, as for the status widgets.
 */
describe('key widgets across a scope change (F-I1 / F-I2)', () => {
  const KEYS: CustomWidget['keys'] = [{ source: 'telemetry', key: 't', label: 'Temperature' }];
  const K = (type: CustomWidget['type']): CustomWidget => ({ ...W(type), keys: KEYS });
  const LATEST_A_KEY = ['widget-latest-values', 'a1', JSON.stringify([{ source: 'telemetry', key: 't' }])];
  const mountOnA = async (type: CustomWidget['type'] = 'gauge') => {
    const view = render(tree(K(type), A));
    await waitFor(() => expect(screen.getAllByText('BLOCK-A/001').length).toBeGreaterThan(0));
    return view;
  };

  it('a FAILED first load is "Could not load this widget.", never "No instruments in your view"', async () => {
    outcome.a = 'reject';
    render(tree(K('gauge'), A));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load this widget.');
    expect(screen.queryByText('No instruments in your view')).toBeNull();
  });

  it('a drill-down still LOADING: "Loading…", never the previous scope\'s gauges', async () => {
    const view = await mountOnA();
    outcome.b = 'pending';
    view.rerender(tree(K('gauge'), B));
    await waitFor(() => expect(screen.getByText('Loading…')).toBeInTheDocument());
    expect(screen.queryByText('BLOCK-A/001')).toBeNull();
  });

  it('a drill-down whose request FAILS: "Could not load this widget.", never the previous scope\'s gauges', async () => {
    const view = await mountOnA();
    outcome.b = 'reject';
    view.rerender(tree(K('gauge'), B));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load this widget.');
    expect(screen.queryByText('BLOCK-A/001')).toBeNull();
    expect(screen.queryByTestId('widget-refresh-failed')).toBeNull();
  });

  it('a drill UP to a scope holding the previous one: "Loading…" until its own values land, never the old subset as its answer', async () => {
    const view = await mountOnA();
    outcome.all = 'pending';
    view.rerender(tree(K('gauge'), ALL));
    await waitFor(() => expect(screen.getByText('Loading…')).toBeInTheDocument());
    expect(screen.queryByText('BLOCK-A/001')).toBeNull();
  });

  it('a drill-down that SUCCEEDS draws its own instruments', async () => {
    const view = await mountOnA();
    view.rerender(tree(K('gauge'), B));
    await waitFor(() => expect(screen.getByText('BLOCK-B/001')).toBeInTheDocument());
    expect(screen.queryByText('BLOCK-A/001')).toBeNull();
  });

  it('the SAME scope\'s failed refresh of its VALUES keeps the gauge and SAYS so — no silent "In limit"', async () => {
    await mountOnA('gauge');
    outcome.a = 'reject';
    await act(async () => { await revalidate.fn!(LATEST_A_KEY); });
    await waitFor(() => expect(screen.getByTestId('widget-refresh-failed')).toBeInTheDocument());
    expect(screen.getByText('BLOCK-A/001')).toBeInTheDocument();
  });

  it('the SAME scope\'s failed refresh of its INSTRUMENTS keeps the gauge and says so', async () => {
    await mountOnA('gauge');
    outcome.a = 'reject';
    await act(async () => { await revalidate.fn!('/api/instruments/telemetry-overview?functionalLocationId=block-a'); });
    await waitFor(() => expect(screen.getByTestId('widget-refresh-failed')).toBeInTheDocument());
    expect(screen.getByText('BLOCK-A/001')).toBeInTheDocument();
  });

  it.each(['comparison_bar', 'value_cards', 'latest_table', 'trend_chart', 'timeseries_table', 'bar_chart'] as const)('%s: a failed refresh is said, the held answer kept', async (type) => {
    if (type === 'comparison_bar' || type === 'trend_chart' || type === 'timeseries_table' || type === 'bar_chart') {
      // Drawn from the held rows; their own history requests are not what is asked here.
      render(tree(K(type), A));
      await waitFor(() => expect(post).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    } else {
      await mountOnA(type);
    }
    outcome.a = 'reject';
    await act(async () => { await revalidate.fn!(LATEST_A_KEY); });
    await waitFor(() => expect(screen.getByTestId('widget-refresh-failed')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
