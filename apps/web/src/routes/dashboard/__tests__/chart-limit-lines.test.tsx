import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimeSeriesChart, type ChartSeries } from '../time-series-chart';

/**
 * The limit lines are the chart's answer to the only question the trend page
 * asks: did this ever leave its limits? They were drawn as bare dashed rules,
 * which left the reader to infer each bound off the y-axis — on the one
 * element that exists to make a breach readable as geometry.
 *
 * These assert the VALUES are printed, at the series' own precision, and that
 * nothing is drawn when nothing was administered: a labelled line where no
 * limit exists would assert a bound the record does not hold.
 */

const series = (decimals: number, values: number[]): ChartSeries => ({
  id: 't',
  label: 'Temperature',
  decimals,
  points: values.map((value, i) => ({
    ts: new Date(Date.UTC(2026, 7, 24, 10, i)).toISOString(),
    value,
  })),
});

describe('TimeSeriesChart limit lines', () => {
  it('prints both bounds beside their lines', () => {
    render(<TimeSeriesChart title="Temperature" unit="°C" spanMs={3_600_000} min={18} max={27} series={[series(1, [22.4, 23.1])]} />);
    expect(screen.getByText('Max 27.0')).toBeInTheDocument();
    expect(screen.getByText('Min 18.0')).toBeInTheDocument();
  });

  it('prints a bound at the finest precision on the chart, never rounded away', () => {
    // A 2-decimal probe against a 27.05 limit: "27.1" would be a bound nobody set.
    render(<TimeSeriesChart title="Temperature" unit="°C" spanMs={3_600_000} min={18.25} max={27.05} series={[series(2, [22.4, 23.1])]} />);
    expect(screen.getByText('Max 27.05')).toBeInTheDocument();
    expect(screen.getByText('Min 18.25')).toBeInTheDocument();
  });

  it('draws only the bound that exists on a half-open band', () => {
    render(<TimeSeriesChart title="Temperature" unit="°C" spanMs={3_600_000} max={27} series={[series(1, [22.4])]} />);
    expect(screen.getByText('Max 27.0')).toBeInTheDocument();
    expect(screen.queryByText(/^Min /)).toBeNull();
  });

  it('draws no limit line at all when none is administered', () => {
    render(<TimeSeriesChart title="Temperature" unit="°C" spanMs={3_600_000} series={[series(1, [22.4])]} />);
    expect(screen.queryByText(/^Max /)).toBeNull();
    expect(screen.queryByText(/^Min /)).toBeNull();
  });

  it('cannot be broken by a silly decimals attribute (toFixed would throw)', () => {
    expect(() =>
      render(<TimeSeriesChart title="Temperature" unit="°C" spanMs={3_600_000} min={18} max={27} series={[series(900, [22.4])]} />),
    ).not.toThrow();
  });
});
