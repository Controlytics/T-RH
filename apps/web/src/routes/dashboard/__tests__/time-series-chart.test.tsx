import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimeSeriesChart } from '../time-series-chart';

const empty = { id: 'temperature', label: 'Temperature', decimals: 1, points: [] };

describe('TimeSeriesChart empty state', () => {
  it('says "No data available" rather than drawing an empty grid', () => {
    render(<TimeSeriesChart series={[empty]} unit="°C" spanMs={3_600_000} title="Temperature Trend" />);
    expect(screen.getByText(/no data available/i)).toBeInTheDocument();
  });

  it('still shows the title, so the reader knows WHICH chart is empty', () => {
    render(<TimeSeriesChart series={[empty]} unit="°C" spanMs={3_600_000} title="Temperature Trend" />);
    expect(screen.getByText('Temperature Trend')).toBeInTheDocument();
  });

  it('draws normally when there are points', () => {
    const series = { ...empty, points: [{ ts: new Date().toISOString(), value: 21.5 }] };
    render(<TimeSeriesChart series={[series]} unit="°C" spanMs={3_600_000} title="Temperature Trend" />);
    expect(screen.queryByText(/no data available/i)).not.toBeInTheDocument();
  });
});

/**
 * The trend page's charts are TALLER than the dashboard's (operator,
 * 2026-10-06: "increase trend view height more"). The viewBox height is per
 * variant, and a caller may name one — the trend REPORT's raster does, so the
 * printed chart is the shape of the one on screen.
 */
describe('TimeSeriesChart height', () => {
  const series = { ...empty, points: [{ ts: '2026-10-06T10:00:00.000Z', value: 21.5 }, { ts: '2026-10-06T11:00:00.000Z', value: 22.5 }] };
  const viewBox = () => document.querySelector('svg')!.getAttribute('viewBox');

  it('the plain variant keeps 900 x 260', () => {
    render(<TimeSeriesChart series={[series]} unit="°C" spanMs={3_600_000} title="T" />);
    expect(viewBox()).toBe('0 0 900 260');
  });

  it('the trend variant is 900 x CHART_HEIGHTS.trend, taller than plain', async () => {
    const { CHART_HEIGHTS } = await import('../time-series-chart');
    expect(CHART_HEIGHTS.trend).toBeGreaterThan(CHART_HEIGHTS.plain);
    render(<TimeSeriesChart variant="trend" series={[series]} unit="°C" spanMs={3_600_000} title="T" />);
    expect(viewBox()).toBe(`0 0 900 ${CHART_HEIGHTS.trend}`);
  });

  it('a caller may name the height, and the x-axis labels follow it to the foot', () => {
    render(<TimeSeriesChart series={[series]} unit="°C" spanMs={3_600_000} title="T" height={500} />);
    expect(viewBox()).toBe('0 0 900 500');
    const texts = Array.from(document.querySelectorAll('svg text'));
    expect(texts.some((t) => t.getAttribute('y') === String(500 - 8))).toBe(true);
    expect(texts.some((t) => t.getAttribute('y') === String(260 - 8))).toBe(false);
  });
});
