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
