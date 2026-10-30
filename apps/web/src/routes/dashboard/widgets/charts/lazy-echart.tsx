/**
 * The way a widget draws an ECharts chart. ECharts itself lives in `echart.tsx`,
 * which only this file names, and only through `import()` — so the library is
 * its own chunk, fetched the first time a chart is drawn, and the dashboard's
 * main bundle never carries it. The PWA precaches that chunk with the rest, so an
 * install with no internet route still draws charts.
 *
 * Two things are kept inside the chart's box, so the panel never jumps and one
 * chart never takes the dashboard down:
 * - while the chunk loads, a placeholder of the chart's own height;
 * - if the chunk cannot load (a deploy replaced it under a page left open all
 *   day) or the chart throws while drawing, "Could not load this widget." at the
 *   same height — reported to the console, never hidden. A DRAWING failure is
 *   tried again with the next option (the next poll's data); a chunk that could
 *   not load stays failed, since `React.lazy` keeps the rejection until reload.
 */
import { Component, lazy, Suspense, type ReactNode } from 'react';
// Type-only, and erased from the build: nothing here pulls ECharts in statically.
import type { EChartsCoreOption } from 'echarts/core';
import { LOAD_FAILED } from '../widget-common';

export interface EChartProps {
  /**
   * Built by a pure `build…Option` function with the app's colours passed
   * explicitly. **MEMOISE IT** — `useMemo(() => build…Option(…), [server data,
   * widget options])`: every NEW object is a full redraw (`notMerge`), which also
   * closes an open tooltip, so an option rebuilt inline would redraw on every
   * parent render instead of once per poll.
   */
  option: EChartsCoreOption;
  /** The chart's height in px; the width is its container's. */
  height: number;
  /** What the chart shows, for a screen reader: the box is `role="img"`. */
  ariaLabel: string;
}

/** The chart module could not be fetched: React.lazy caches this, so it is final until a reload. */
export class ChartChunkError extends Error {
  constructor(cause: unknown) {
    super('The chart module could not be loaded', { cause });
    this.name = 'ChartChunkError';
  }
}

const EChart = lazy(() => import('./echart').catch((e: unknown) => { throw new ChartChunkError(e); }));

export function LazyEChart(props: EChartProps) {
  return (
    <ChartBoundary height={props.height} resetKey={props.option}>
      <Suspense
        fallback={(
          <div
            aria-hidden="true"
            data-testid="echart-fallback"
            className="w-full animate-pulse rounded-md bg-slate-50"
            style={{ height: props.height }}
          />
        )}
      >
        <EChart {...props} />
      </Suspense>
    </ChartBoundary>
  );
}

/**
 * Keeps a chart's failure inside its box. A drawing failure clears when
 * `resetKey` changes (LazyEChart passes the option, so the next poll's data is
 * tried); a `ChartChunkError` stays — re-rendering a cached rejection would only
 * log it again on every poll.
 */
export class ChartBoundary extends Component<
  { height: number; resetKey: unknown; children: ReactNode },
  { failed: boolean; sticky: boolean }
> {
  state = { failed: false, sticky: false };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, sticky: error instanceof ChartChunkError };
  }

  componentDidCatch(error: Error) {
    console.error('[chart] failed to load or draw:', error);
  }

  componentDidUpdate(prev: { resetKey: unknown }) {
    if (this.state.failed && !this.state.sticky && prev.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p
        role="alert"
        data-testid="echart-failed"
        className="flex items-center justify-center text-center text-sm text-red-700"
        style={{ minHeight: this.props.height }}
      >
        {LOAD_FAILED}
      </p>
    );
  }
}
