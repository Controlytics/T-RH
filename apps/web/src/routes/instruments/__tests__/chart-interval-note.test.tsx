import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChartIntervalNote } from '../chart-interval-note';

describe('ChartIntervalNote', () => {
  it('renders nothing when raw (intervalMs is null) — every point is a stored reading', () => {
    const { container } = render(<ChartIntervalNote intervalMs={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('states the averaging window in plain language when an interval is selected', () => {
    render(<ChartIntervalNote intervalMs={300_000} />);
    expect(screen.getByText(/averaged over 5 minutes/i)).toBeInTheDocument();
    expect(screen.getByText(/the table below shows every reading/i)).toBeInTheDocument();
  });

  it('uses the interval’s own human label, not a formatted millisecond value', () => {
    render(<ChartIntervalNote intervalMs={3_600_000} />);
    expect(screen.getByText(/averaged over 1 hour/i)).toBeInTheDocument();
    expect(screen.queryByText(/3600000/)).toBeNull();
  });
});
