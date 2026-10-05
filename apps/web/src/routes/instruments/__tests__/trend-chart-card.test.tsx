import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TrendChartCard, chartCardSubtitle } from '../trend-chart-card';
import { TimeSeriesChart } from '@/routes/dashboard/time-series-chart';

/**
 * The restyled trend chart card (2026-08-31).
 *
 * Three things here are §11 claims rather than styling, and each is the kind of
 * defect that looks perfectly fine on a rendered page:
 *
 * 1. The reference image hardcodes a green "Live" pill on both cards. Most
 *    instruments on this installation are NOT reporting, and a green "Live"
 *    over a silent probe asserts a fact about a regulated record that is
 *    false. The pill must print the app's own status word — "Offline" for a
 *    STALE instrument, "Out of limit" for a breaching one — from the
 *    SERVER-resolved status the rest of the page already prints.
 *
 * 2. A bound the instrument switches off arrives as NULL and must draw no line
 *    and no pill. A labelled limit where none is administered states a bound
 *    the record does not hold, on the one element the page exists to evidence
 *    a breach against.
 *
 * 3. The download control is now an ICON. A button whose only content is an
 *    `aria-hidden` glyph has no accessible name, which would make the governed
 *    §11 download unreachable to a screen reader with nothing on screen looking
 *    wrong. Asserted through `getByRole(..., { name })`, which reads the
 *    accessible name and not the text content.
 *
 * `useExportOptions` is stubbed to allow PDF only — the role gate is that
 * hook's own concern and is tested where it lives; here it only has to let the
 * trigger render.
 */

vi.mock('@/hooks/use-export-options', () => ({
  useExportOptions: () => ({ pdf: true, excel: false }),
}));

const series = (values: number[]) => ({
  id: 't',
  label: 'Temperature',
  decimals: 1,
  points: values.map((value, i) => ({
    ts: new Date(Date.UTC(2026, 7, 24, 10, i)).toISOString(),
    value,
  })),
});

function renderCard(props: Partial<React.ComponentProps<typeof TrendChartCard>> = {}, chart?: React.ReactNode) {
  return render(
    <TrendChartCard
      title="Temperature Trend"
      icon={<span />}
      accent="#2a78d6"
      status="OK"
      locationParts={['Dissolution & UV Room']}
      code="CWH/RDU/006-00"
      onExportPdf={() => {}}
      {...props}
    >
      {chart ?? <div>chart</div>}
    </TrendChartCard>,
  );
}

describe('TrendChartCard status pill', () => {
  it('says "Offline" for an instrument that is not reporting — never "Live"', () => {
    renderCard({ status: 'STALE' });
    expect(screen.getByTestId('trend-chart-status')).toHaveTextContent('Offline');
    expect(screen.queryByText('Live')).toBeNull();
  });

  it('is amber, not green, for that instrument', () => {
    renderCard({ status: 'STALE' });
    const pill = screen.getByTestId('trend-chart-status');
    expect(pill.className).toContain('text-amber-700');
    expect(pill.className).not.toContain('emerald');
  });

  it('says "Out of limit" for a breaching instrument', () => {
    renderCard({ status: 'OUT_OF_SPEC' });
    expect(screen.getByTestId('trend-chart-status')).toHaveTextContent('Out of limit');
  });

  it('goes green only when the instrument is genuinely in limit', () => {
    renderCard({ status: 'OK' });
    const pill = screen.getByTestId('trend-chart-status');
    expect(pill).toHaveTextContent('In limit');
    expect(pill.className).toContain('text-emerald-700');
  });

  it('prints NO pill while the status is unknown — an absent pill is not a green one', () => {
    renderCard({ status: null });
    expect(screen.queryByTestId('trend-chart-status')).toBeNull();
  });
});

describe('TrendChartCard subtitle', () => {
  it('drops a room code that merely repeats the instrument code', () => {
    // The normal case on this installation: `floorplan_rooms.code` IS the
    // instrument's own code and `label` is blank.
    expect(chartCardSubtitle([null, 'CWH/RDU/006-00'], 'CWH/RDU/006-00')).toBe('CWH/RDU/006-00');
  });

  it('keeps a real room name ahead of the code', () => {
    expect(chartCardSubtitle(['Dissolution & UV Room'], 'CWH/RDU/006-00'))
      .toBe('Dissolution & UV Room • CWH/RDU/006-00');
  });

  it('never leads with a separator when nothing is recorded', () => {
    expect(chartCardSubtitle([null, undefined, '  '], 'CWH/RDU/006-00')).toBe('CWH/RDU/006-00');
  });

  it('drops a repeat regardless of case, and de-duplicates the parts', () => {
    expect(chartCardSubtitle(['Room A', 'room a', 'cwh/rdu/006-00'], 'CWH/RDU/006-00'))
      .toBe('Room A • CWH/RDU/006-00');
  });

  it('renders on the card', () => {
    renderCard();
    expect(screen.getByTestId('trend-chart-subtitle'))
      .toHaveTextContent('Dissolution & UV Room • CWH/RDU/006-00');
  });
});

describe('TrendChartCard header controls', () => {
  it('gives the icon-only download button an accessible name', () => {
    renderCard();
    const btn = screen.getByRole('button', { name: 'Export as PDF' });
    // Icon-only really means icon-only: the name is on the element, not in it.
    expect(btn.textContent).toBe('');
    expect(btn).toHaveAttribute('title', 'Export as PDF');
  });

  it('fires the per-chart export, so this card keeps its own audit reportType', () => {
    const onExportPdf = vi.fn();
    renderCard({ onExportPdf });
    screen.getByRole('button', { name: 'Export as PDF' }).click();
    expect(onExportPdf).toHaveBeenCalledTimes(1);
  });

  it('gives the fullscreen button an accessible name naming its chart', () => {
    renderCard({ title: 'Humidity Trend' });
    expect(screen.getByRole('button', { name: 'Fullscreen — Humidity Trend' })).toBeInTheDocument();
  });
});

describe('TrendChartCard limit lines', () => {
  it('draws no pill for a bound the server withheld', () => {
    // `max` administered, `min` switched off via Enable_Temp_NLT — the server
    // has already nulled it, and the browser must never fill one back in.
    renderCard({}, (
      <TimeSeriesChart
        variant="trend" title="Temperature Trend" unit="°C" spanMs={3_600_000}
        max={27} min={null} series={[series([22.4, 23.1])]}
      />
    ));
    expect(screen.getByText('High Limit 27.0 °C')).toBeInTheDocument();
    expect(screen.queryByText(/^Low Limit/)).toBeNull();
  });

  it('draws neither pill when neither bound is administered', () => {
    renderCard({}, (
      <TimeSeriesChart
        variant="trend" title="Temperature Trend" unit="°C" spanMs={3_600_000}
        series={[series([22.4, 23.1])]}
      />
    ));
    expect(screen.queryByText(/^High Limit/)).toBeNull();
    expect(screen.queryByText(/^Low Limit/)).toBeNull();
  });

  it('draws the line at the TRUE limit, not at the gridline nearest it', () => {
    // The reference image puts its "High Limit 27.0" pill on the 28 gridline.
    // That is a mock error: a line drawn at a rounded bound evidences a limit
    // nobody administered. 27 is 1.0 below the 28 tick, so the two y positions
    // are provably different.
    const { container } = renderCard({}, (
      <TimeSeriesChart
        variant="trend" title="Temperature Trend" unit="°C" spanMs={3_600_000}
        min={18} max={27} series={[series([20, 26])]}
      />
    ));
    const pill = screen.getByText('High Limit 27.0 °C');
    const limitLine = pill.parentElement!.querySelector('line')!;
    const y = Number(limitLine.getAttribute('y1'));

    // Every gridline the axis drew, from the tick labels' own y positions.
    const tickYs = [...container.querySelectorAll('text')]
      .filter((t) => /^\d+(\.\d+)?$/.test(t.textContent ?? ''))
      .map((t) => Number(t.getAttribute('y')) - 3);
    expect(tickYs.length).toBeGreaterThan(1);
    // The limit sits strictly between two gridlines — it is not ON one.
    expect(tickYs.every((t) => Math.abs(t - y) > 1)).toBe(true);
  });
});

describe('TrendChartCard chart chrome', () => {
  it('keeps Reset zoom reachable, with the title suppressed above it', () => {
    const { container } = renderCard({}, (
      <TimeSeriesChart
        variant="trend" title="Temperature Trend" unit="°C" spanMs={3_600_000}
        series={[series([22.4, 23.1])]}
        onZoom={() => {}} onResetZoom={() => {}}
      />
    ));
    expect(screen.getByText('Reset zoom')).toBeInTheDocument();
    // The card's header carries the title; the chart must not repeat it.
    expect(screen.getAllByText('Temperature Trend')).toHaveLength(1);
    // ...and the one that IS on screen is the card's heading, not the chart's.
    const header = container.querySelector('h3')!;
    expect(within(header).getByText('Temperature Trend')).toBeInTheDocument();
  });

  // The "shows the latest STORED reading" case went with the `lastReading`
  // prop (audit 2026-10-03, WEB-9) — nothing had fed it since 2026-09-01.
});

describe('TrendChartCard — the header wears the site band (2026-09-25)', () => {
  // Operator: "do it same for trends page … all pages should colorful". The
  // header is the band (`.widget-band`, white ink on `--band-gradient`); the
  // body below it stays white for the chart.
  it('puts .widget-band on the header and white ink on the title', () => {
    const { container } = renderCard();
    const header = container.querySelector('header');
    expect(header?.className).toMatch(/(^|\s)widget-band(\s|$)/);
    expect(screen.getByText('Temperature Trend').className).toMatch(/(^|\s)text-white(\s|$)/);
  });
});
