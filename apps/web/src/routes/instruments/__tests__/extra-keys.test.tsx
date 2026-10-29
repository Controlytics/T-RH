import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { LatestKeyValue, WidgetKey } from '@digilog/shared';
import { statusClasses } from '@/routes/dashboard/status';

vi.mock('@/hooks/use-export-options', () => ({ useExportOptions: () => ({ pdf: true, excel: false }) }));
const PAGING = { options: [10, 25, 50], defaultLimit: 25 };
vi.mock('@/hooks/use-pagination-config', () => ({ usePaginationDefaults: () => PAGING }));

import { ExtraKeyCard, extraColumnCell } from '../extra-key-card';
import { TrendChartCard } from '../trend-chart-card';
import { TimeseriesTableCard } from '../timeseries-table-card';

const WORDS = { failure: 'Error', outOfRange: 'OL' };
const fmt = (ts: string) => `T:${ts}`;
const P: WidgetKey = { source: 'telemetry', key: 'p', label: 'Pressure', unit: 'kPa' };
const T: WidgetKey = { source: 'telemetry', key: 'dp', label: 'Diff pressure' };
const raw = (value: unknown): LatestKeyValue => ({
  source: 'telemetry', key: 'p', value, ts: '2026-10-29T08:00:00.000Z', unit: null, decimals: null, display: null, judged: null,
});
const measured = (value: unknown, min: number | null = 10, max: number | null = 20): LatestKeyValue => ({
  source: 'telemetry', key: 'dp', value, ts: '2026-10-29T08:00:00.000Z', unit: 'Pa', decimals: 1, display: null,
  judged: { limitMin: min, limitMax: max, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false },
});
const notOk = (el: HTMLElement) => {
  const ok = statusClasses('OK');
  for (const f of ['dot', 'text', 'bg', 'border'] as const) expect(el.innerHTML).not.toContain(ok[f]);
};

describe('ExtraKeyCard', () => {
  it('a raw extra key is neutral and printed as received', () => {
    render(<ExtraKeyCard widgetKey={P} value={raw(0.05)} reporting words={WORDS} formatTs={fmt} />);
    const card = screen.getByTestId('extra-key-card');
    expect(card.dataset.judged).toBe('false');
    expect(within(card).getByText('0.05')).toBeTruthy();
    expect(within(card).getByText('kPa')).toBeTruthy();
    expect(within(card).getByText('Not judged')).toBeTruthy();
    expect(within(card).getByText('T:2026-10-29T08:00:00.000Z')).toBeTruthy();
    notOk(card);
  });

  it("a measured extra key wears the server's verdict and decimals", () => {
    render(<ExtraKeyCard widgetKey={T} value={measured('25.04')} reporting words={WORDS} formatTs={fmt} />);
    const card = screen.getByTestId('extra-key-card');
    expect(card.dataset.judged).toBe('true');
    expect(within(card).getByText('25.0')).toBeTruthy();
    expect(within(card).getByText('Pa')).toBeTruthy();
    expect(within(card).getByText('Out of limit')).toBeTruthy();
  });

  it('a measured extra key with no bound in force reads Not assessed, neutral', () => {
    render(<ExtraKeyCard widgetKey={T} value={measured(15, null, null)} reporting words={WORDS} formatTs={fmt} />);
    const card = screen.getByTestId('extra-key-card');
    expect(within(card).getByText('Not assessed')).toBeTruthy();
    notOk(card);
  });

  it('a text value is printed, not called a sensor error', () => {
    render(<ExtraKeyCard widgetKey={P} value={raw('RUN')} reporting words={WORDS} formatTs={fmt} />);
    const card = screen.getByTestId('extra-key-card');
    expect(within(card).getByText('RUN')).toBeTruthy();
    expect(within(card).queryByText('Error')).toBeNull();
    expect(within(card).queryByText('kPa')).toBeNull();
  });

  it('a key this instrument never sent reads NA with no instant', () => {
    render(<ExtraKeyCard widgetKey={P} value={undefined} reporting words={WORDS} formatTs={fmt} />);
    const card = screen.getByTestId('extra-key-card');
    expect(within(card).getByText('NA')).toBeTruthy();
    expect(within(card).getByText('—')).toBeTruthy();
  });
});

describe('extraColumnCell', () => {
  it('judges a measured value against the server bounds, at the server decimals', () => {
    const cell = extraColumnCell(measured(15), T);
    expect(cell('25.04')).toEqual({ text: '25.0', tone: 'out' });
    expect(cell(15)).toEqual({ text: '15.0', tone: 'in' });
  });

  it('prints a raw value as received, never judged', () => {
    const cell = extraColumnCell(raw(1), P);
    expect(cell(0.05)).toEqual({ text: '0.05', tone: 'unjudged' });
    expect(cell('RUN')).toEqual({ text: 'RUN', tone: 'unjudged' });
  });
});

describe('the Time Series card with extra columns', () => {
  it('shows each extra key, — where the instant has no value, and never the failure word', () => {
    const rows = [
      { ts: '2026-10-29T08:01:00.000Z', values: { t: 21, h: 40 }, errors: {} },
      { ts: '2026-10-29T08:00:00.000Z', values: { t: 21, h: 40 }, errors: {} },
    ];
    const rawAt: Record<string, Record<string, unknown>> = { '2026-10-29T08:01:00.000Z': { p: 'RUN' } };
    render(
      <TimeseriesTableCard
        rows={rows}
        slots={[{ key: 't', heading: 'Temperature', decimals: 1, min: 18, max: 27 }, { key: 'h', heading: 'Humidity', decimals: 1, min: null, max: null }]}
        extraColumns={[{ key: 'p', heading: 'Pressure (kPa)', cell: extraColumnCell(raw(1), P) }]}
        extraRaw={(ts, key) => rawAt[ts]?.[key]}
        failureWord="Error"
        formatTs={fmt}
        title="Time Series"
        subtitle=""
        timestampHeading="Time"
        onExportPdf={() => {}}
        page={1}
        pageSize={50}
        totalItems={2}
        onPageChange={() => {}}
      />,
    );
    expect(screen.getByText('Pressure (kPa)')).toBeTruthy();
    const [first, second] = screen.getAllByTestId('ts-row');
    expect(within(first).getByTestId('ts-extra-p').textContent).toBe('RUN');
    expect(within(second).getByTestId('ts-extra-p').textContent).toBe('—');
    expect(screen.queryByText('Error')).toBeNull();
  });
});

describe('TrendChartCard', () => {
  it('a chart card without onExportPdf has no export icon', () => {
    render(
      <TrendChartCard title="Pressure" icon={<span />} accent="#2a78d6" status={null} locationParts={[]} code="X">
        <div />
      </TrendChartCard>,
    );
    expect(screen.queryByRole('button', { name: /pdf|export|download/i })).toBeNull();
  });
});
