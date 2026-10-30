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
vi.mock('@/lib/api-client', () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));
vi.mock('@/hooks/use-failure-text', () => ({ useAlarmTypeNames: () => undefined }));
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

type Outcome = 'resolve' | 'pending' | 'reject';
const outcome: { a: Outcome; b: Outcome } = { a: 'resolve', b: 'resolve' };
const down = () => Object.assign(new Error('HTTP 502'), { status: 502 });
const answer = (o: Outcome, value: unknown) => (o === 'resolve' ? Promise.resolve(value)
  : o === 'reject' ? Promise.reject(down()) : new Promise(() => {}));

function route(url: string): Promise<unknown> {
  const inA = url.includes('block-a');
  const o = inA ? outcome.a : outcome.b;
  if (url.startsWith('/api/alarms/counts')) return answer(o, inA ? COUNTS_A : COUNTS_B);
  if (url.startsWith('/api/instruments/telemetry-overview')) return answer(o, inA ? ROWS_A : ROWS_B);
  return Promise.resolve(undefined);
}

// One config object for the whole mount, so a rerender keeps its cache.
const SWR: SWRConfiguration = {
  provider: () => new Map(), fetcher: (u: string) => get(u), dedupingInterval: 0, shouldRetryOnError: false, revalidateOnFocus: false,
};
const revalidate: { fn: ((key: string) => Promise<unknown>) | null } = { fn: null };
function Revalidator() {
  const { mutate } = useSWRConfig();
  revalidate.fn = (key: string) => mutate(key);
  return null;
}
const tree = (w: CustomWidget, selection: typeof A) => (
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
  charts.length = 0;
  get.mockReset().mockImplementation(route);
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
