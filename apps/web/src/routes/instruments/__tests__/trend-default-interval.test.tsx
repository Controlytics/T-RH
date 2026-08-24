import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_INTERVAL } from '@digilog/shared';
import { useTrendPeriod } from '../use-trend-data';
import { ChartIntervalNote } from '../chart-interval-note';

/**
 * The bug this guards: the trend page charts at `period.intervalMs` and tables
 * the raw readings. While `DEFAULT_INTERVAL` was `'5m'` the page OPENED with
 * the chart showing a five-minute mean (22.4) next to a table showing the
 * stored reading for the same instant (22.5), with no disclosure — because
 * `ChartIntervalNote` only renders once a bucket is selected. Two different
 * numbers for one moment, and nothing saying which is the record.
 *
 * A test that only checked "the note appears when a bucket is chosen" would
 * pass against exactly that defect, so the DEFAULT is asserted here too.
 */

function Probe() {
  const { period } = useTrendPeriod();
  return (
    <>
      <span data-testid="interval">{String(period.intervalMs)}</span>
      <ChartIntervalNote intervalMs={period.intervalMs} />
    </>
  );
}

describe('trend page default aggregation', () => {
  it('DEFAULT_INTERVAL is raw — the chart and the table cannot disagree on first load', () => {
    expect(DEFAULT_INTERVAL).toBe('raw');
  });

  it('a page opened with no interval in the URL charts every stored reading', () => {
    render(<MemoryRouter initialEntries={['/instruments/i-1/trend']}><Probe /></MemoryRouter>);
    expect(screen.getByTestId('interval')).toHaveTextContent('null');
  });

  it('and therefore discloses nothing — there is no derived value to disclose', () => {
    render(<MemoryRouter initialEntries={['/instruments/i-1/trend']}><Probe /></MemoryRouter>);
    expect(screen.queryByText(/Averaged over/)).toBeNull();
  });

  it('but the disclosure appears the moment a non-raw interval is chosen', () => {
    render(<MemoryRouter initialEntries={['/instruments/i-1/trend?interval=5m']}><Probe /></MemoryRouter>);
    expect(screen.getByTestId('interval')).toHaveTextContent('300000');
    expect(screen.getByText(/Averaged over 5 minutes/)).toBeInTheDocument();
  });
});
