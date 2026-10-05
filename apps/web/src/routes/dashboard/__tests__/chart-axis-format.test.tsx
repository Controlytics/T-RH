import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

/**
 * Audit 2026-10-03, WEB-2: the chart's x-axis printed the BROWSER's locale and
 * zone (`toLocaleDateString(undefined, …)`) while the hover table beside it
 * used the administered formatter — on a workstation whose clock zone differs
 * from the site's the two disagreed by hours, and the rasterised chart in the
 * signed Trend PDF carried the wrong labels. The axis uses the same hook now.
 */
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({
    formatDate: (d: Date | string) => `D:${new Date(d).toISOString().slice(0, 10)}`,
    formatTime: (d: Date | string) => `T:${new Date(d).toISOString().slice(11, 16)}`,
    formatDateTime: (d: Date | string) => `DT:${new Date(d).toISOString()}`,
    formatIfDate: (d: unknown) => String(d),
    config: {},
  }),
}));

const { TimeSeriesChart } = await import('../time-series-chart');

const points = [
  { ts: '2026-10-03T06:00:00.000Z', value: 21.5 },
  { ts: '2026-10-03T07:00:00.000Z', value: 22.0 },
  { ts: '2026-10-03T08:00:00.000Z', value: 22.5 },
];
const series = { id: 'temperature', label: 'Temperature', decimals: 1, points };

describe('TimeSeriesChart x-axis labels', () => {
  it('prints the administered TIME format on a span under a day', () => {
    const { container } = render(<TimeSeriesChart series={[series]} unit="°C" spanMs={3 * 3_600_000} title="T" />);
    expect(container.textContent).toContain('T:');
    expect(container.textContent).not.toMatch(/\d{1,2}:\d{2}\s?[AP]M/);
  });

  it('prints the administered DATE format on a span over a day', () => {
    const wide = { ...series, points: [
      { ts: '2026-10-01T06:00:00.000Z', value: 21 },
      { ts: '2026-10-03T06:00:00.000Z', value: 22 },
    ] };
    const { container } = render(<TimeSeriesChart series={[wide]} unit="°C" spanMs={3 * 24 * 3_600_000} title="T" />);
    expect(container.textContent).toContain('D:2026-10-0');
  });
});
