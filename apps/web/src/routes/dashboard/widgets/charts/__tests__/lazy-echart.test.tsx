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

import { LazyEChart } from '../lazy-echart';

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
});
