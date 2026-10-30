/**
 * The ONE file that imports ECharts. It is loaded only through `lazy-echart.tsx`
 * (`React.lazy`), so the library lands in its own chunk and the dashboard's main
 * bundle never carries it — import `LazyEChart`, never this file.
 *
 * Only `echarts/core`, with the modules the widgets use registered once, and the
 * SVG renderer: crisp text at any size, and no canvas, so jsdom can load it.
 *
 * The lifecycle is the whole contract (dashboards stay open all day, so a leaked
 * instance or observer is a defect): `init` once on mount, `setOption` with
 * `notMerge` on every new option, `resize` from a ResizeObserver on the box,
 * `disconnect` + `dispose` on unmount. Every option is drawn with `animation:
 * false` whatever the builder said: a poll that re-draws must not replay a sweep.
 */
import { useEffect, useRef } from 'react';
import { init, use, type EChartsType } from 'echarts/core';
import { BarChart, GaugeChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartProps } from './lazy-echart';

use([GaugeChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, SVGRenderer]);

export default function EChart({ option, height, ariaLabel }: EChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);

  // Declared BEFORE the option effect, so on mount the instance exists when the
  // first option is set (effects run in declaration order).
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    // The renderer must be named: registering SVGRenderer alone still defaults to canvas.
    const instance = init(el, undefined, { renderer: 'svg' });
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption({ ...option, animation: false }, { notMerge: true });
  }, [option]);

  return <div ref={box} role="img" aria-label={ariaLabel} style={{ height, width: '100%' }} />;
}

