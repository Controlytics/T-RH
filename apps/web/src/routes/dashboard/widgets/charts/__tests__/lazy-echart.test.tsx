import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// The lazily imported module is mocked: what is asserted is the boundary
// (fallback height, props passed through, a failure kept in the card).
const state = vi.hoisted(() => ({ fail: false, props: [] as unknown[] }));
vi.mock('../echart', () => ({
  default: (props: { option: unknown; height: number; ariaLabel: string }) => {
    if (state.fail) throw new Error('chunk failed to load');
    state.props.push(props);
    return <div role="img" aria-label={props.ariaLabel} data-testid="echart" />;
  },
}));

import { ChartBoundary, ChartChunkError, LazyEChart } from '../lazy-echart';

/** Throws `error` while drawing, else draws a marker. */
function Child({ error }: { error?: Error }) {
  if (error) throw error;
  return <p data-testid="drawn">drawn</p>;
}

const OPTION = { series: [] };

beforeEach(() => {
  state.fail = false;
  state.props.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('LazyEChart', () => {
  it('reserves the chart height while the chart module loads, then draws it with the same props', async () => {
    render(<LazyEChart option={OPTION} height={220} ariaLabel="Daily maximum of t" />);
    const fallback = screen.getByTestId('echart-fallback');
    expect(fallback.style.height).toBe('220px');
    expect(await screen.findByTestId('echart')).toBeTruthy();
    expect(screen.queryByTestId('echart-fallback')).toBeNull();
    expect(state.props.at(-1)).toEqual({ option: OPTION, height: 220, ariaLabel: 'Daily maximum of t' });
  });

  it('a chart that cannot load or draw stays in its own box, at its height, and is reported', async () => {
    state.fail = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div>
        <LazyEChart option={OPTION} height={180} ariaLabel="c" />
        <p>the rest of the card</p>
      </div>,
    );
    const failed = await screen.findByTestId('echart-failed');
    expect(failed.textContent).toBe('Could not load this widget.');
    expect(failed.style.minHeight).toBe('180px');
    expect(screen.getByText('the rest of the card')).toBeTruthy();
    expect(error.mock.calls.some((c) => String(c[0]).includes('[chart]'))).toBe(true);
  });

  it('a chart that failed to DRAW is tried again with the next option, and draws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    state.fail = true;
    const { rerender } = render(<LazyEChart option={OPTION} height={180} ariaLabel="c" />);
    expect(await screen.findByTestId('echart-failed')).toBeTruthy();
    state.fail = false;
    // The same option object again is not a reason to retry.
    rerender(<LazyEChart option={OPTION} height={180} ariaLabel="c" />);
    expect(screen.getByTestId('echart-failed')).toBeTruthy();
    rerender(<LazyEChart option={{ series: [] }} height={180} ariaLabel="c" />);
    expect(await screen.findByTestId('echart')).toBeTruthy();
    expect(screen.queryByTestId('echart-failed')).toBeNull();
  });
});

describe('ChartBoundary', () => {
  it('a drawing failure resets when resetKey changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(<ChartBoundary height={100} resetKey="a"><Child error={new Error('bad data')} /></ChartBoundary>);
    expect(screen.getByTestId('echart-failed')).toBeTruthy();
    rerender(<ChartBoundary height={100} resetKey="b"><Child /></ChartBoundary>);
    expect(screen.getByTestId('drawn')).toBeTruthy();
  });

  it('a chunk that could not load stays failed whatever the resetKey', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <ChartBoundary height={100} resetKey="a"><Child error={new ChartChunkError(new Error('404'))} /></ChartBoundary>,
    );
    expect(screen.getByTestId('echart-failed')).toBeTruthy();
    const logged = error.mock.calls.length;
    rerender(<ChartBoundary height={100} resetKey="b"><Child /></ChartBoundary>);
    expect(screen.getByTestId('echart-failed')).toBeTruthy();
    expect(screen.queryByTestId('drawn')).toBeNull();
    // Not re-thrown, so not re-logged on every poll.
    expect(error.mock.calls.length).toBe(logged);
  });
});
