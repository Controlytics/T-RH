import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// The ECharts entry points are mocked: the wrapper's contract is WHEN it calls
// init / setOption / resize / dispose, not what ECharts draws.
const ec = vi.hoisted(() => {
  const instance = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
  return { instance, init: vi.fn(() => instance), use: vi.fn() };
});
vi.mock('echarts/core', () => ({ init: ec.init, use: ec.use }));
vi.mock('echarts/charts', () => ({ GaugeChart: 'GaugeChart', BarChart: 'BarChart', PieChart: 'PieChart' }));
vi.mock('echarts/components', () => ({
  GridComponent: 'GridComponent', TooltipComponent: 'TooltipComponent',
  LegendComponent: 'LegendComponent', MarkLineComponent: 'MarkLineComponent',
}));
vi.mock('echarts/renderers', () => ({ SVGRenderer: 'SVGRenderer' }));

// jsdom has no ResizeObserver: a stub that hands the test its callback.
const ro = { callbacks: [] as (() => void)[], observed: [] as Element[], disconnect: vi.fn() };
class StubResizeObserver {
  constructor(cb: () => void) { ro.callbacks.push(cb); }
  observe(el: Element) { ro.observed.push(el); }
  unobserve() {}
  disconnect() { ro.disconnect(); }
}

import EChart from '../echart';
import { NEUTRAL_HEX } from '../chart-colors';

const OPTION_A = { series: [{ type: 'bar', data: [1, 2] }] };
const OPTION_B = { series: [{ type: 'bar', data: [3] }] };

beforeEach(() => {
  ec.init.mockClear();
  ec.instance.setOption.mockClear();
  ec.instance.resize.mockClear();
  ec.instance.dispose.mockClear();
  ro.callbacks.length = 0;
  ro.observed.length = 0;
  ro.disconnect.mockClear();
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
});
afterEach(() => vi.unstubAllGlobals());

describe('EChart', () => {
  it('registers the chart, component and SVG renderer modules', () => {
    expect(ec.use).toHaveBeenCalledWith([
      'GaugeChart', 'BarChart', 'PieChart',
      'GridComponent', 'TooltipComponent', 'LegendComponent', 'MarkLineComponent',
      'SVGRenderer',
    ]);
  });

  it('inits ONCE on mount with the SVG renderer, in a div role="img" of the given height', () => {
    render(<EChart option={OPTION_A} height={240} ariaLabel="Hourly average of t" />);
    const box = screen.getByRole('img', { name: 'Hourly average of t' });
    expect(box.style.height).toBe('240px');
    expect(ec.init).toHaveBeenCalledTimes(1);
    expect(ec.init).toHaveBeenCalledWith(box, undefined, { renderer: 'svg' });
  });

  it('sets the option with notMerge and animation off, once per new option', () => {
    const { rerender } = render(<EChart option={OPTION_A} height={240} ariaLabel="c" />);
    expect(ec.instance.setOption).toHaveBeenCalledTimes(1);
    expect(ec.instance.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({ ...OPTION_A, animation: false }), { notMerge: true },
    );
    // The same option object again is not a change.
    rerender(<EChart option={OPTION_A} height={240} ariaLabel="c" />);
    expect(ec.instance.setOption).toHaveBeenCalledTimes(1);
    rerender(<EChart option={OPTION_B} height={240} ariaLabel="c" />);
    expect(ec.instance.setOption).toHaveBeenCalledTimes(2);
    expect(ec.instance.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({ ...OPTION_B, animation: false }), { notMerge: true },
    );
    // Never re-initialised by a new option.
    expect(ec.init).toHaveBeenCalledTimes(1);
  });

  it('an option that asks for animation still gets none', () => {
    render(<EChart option={{ ...OPTION_A, animation: true }} height={240} ariaLabel="c" />);
    expect(ec.instance.setOption.mock.calls[0][0]).toMatchObject({ animation: false });
  });

  it("a builder that forgets its colours draws NEUTRAL - never ECharts' default palette; its own colours win", () => {
    const { rerender } = render(<EChart option={OPTION_A} height={240} ariaLabel="c" />);
    expect(ec.instance.setOption.mock.calls[0][0].color).toEqual([NEUTRAL_HEX]);
    const coloured = { ...OPTION_B, color: ['#2a78d6', '#eb6834'] };
    rerender(<EChart option={coloured} height={240} ariaLabel="c" />);
    expect(ec.instance.setOption.mock.calls[1][0].color).toEqual(['#2a78d6', '#eb6834']);
  });

  it('resizes when its box is resized', () => {
    render(<EChart option={OPTION_A} height={240} ariaLabel="c" />);
    expect(ro.observed).toEqual([screen.getByRole('img', { name: 'c' })]);
    expect(ec.instance.resize).not.toHaveBeenCalled();
    ro.callbacks[0]();
    expect(ec.instance.resize).toHaveBeenCalledTimes(1);
  });

  it('disposes the instance and disconnects the observer on unmount', () => {
    const { unmount } = render(<EChart option={OPTION_A} height={240} ariaLabel="c" />);
    expect(ec.instance.dispose).not.toHaveBeenCalled();
    unmount();
    expect(ro.disconnect).toHaveBeenCalledTimes(1);
    expect(ec.instance.dispose).toHaveBeenCalledTimes(1);
  });
});
