import { describe, it, expect, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import type { DashboardTimeWindow } from '@digilog/shared';

vi.mock('../use-widget-data', () => ({}));

import { useWidgetRange, PeriodSelect } from '../widget-common';

describe('useWidgetRange with a dashboard window', () => {
  it('a relative 7d window gives a 7-day range', () => {
    const w: DashboardTimeWindow = { mode: 'relative', period: '7d' };
    const { result } = renderHook(() => useWidgetRange(undefined, w));
    expect(result.current.preset).toBe('dashboard');
    const ms = Date.parse(result.current.range.to) - Date.parse(result.current.range.from);
    expect(ms).toBe(7 * 86_400_000);
    expect(Date.parse(result.current.range.to) % 60_000).toBe(0);
  });

  it('a fixed window gives exactly its from / to', () => {
    const w: DashboardTimeWindow = { mode: 'fixed', from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T06:30:00.000Z' };
    const { result } = renderHook(() => useWidgetRange(undefined, w));
    expect(result.current.range).toEqual({ from: w.from, to: w.to });
  });

  it('a widget own period wins over the window', () => {
    const w: DashboardTimeWindow = { mode: 'relative', period: '7d' };
    const { result } = renderHook(() => useWidgetRange('1h', w));
    expect(result.current.preset).toBe('1h');
    expect(Date.parse(result.current.range.to) - Date.parse(result.current.range.from)).toBe(3_600_000);
  });

  it('with no window it is exactly as before', () => {
    const { result } = renderHook(() => useWidgetRange(undefined));
    expect(result.current.preset).toBe('24h');
  });

  it('says whether the range ROLLS with the clock (a period) or is fixed (a fixed window)', () => {
    const fixed: DashboardTimeWindow = { mode: 'fixed', from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T06:30:00.000Z' };
    expect(renderHook(() => useWidgetRange(undefined, fixed)).result.current.rolling).toBe(false);
    expect(renderHook(() => useWidgetRange('7d', fixed)).result.current.rolling).toBe(true);
    expect(renderHook(() => useWidgetRange(undefined, { mode: 'relative', period: '7d' })).result.current.rolling).toBe(true);
    expect(renderHook(() => useWidgetRange(undefined)).result.current.rolling).toBe(true);
  });

  it('a zoom is a fixed range', () => {
    const { result } = renderHook(() => useWidgetRange('24h'));
    act(() => result.current.zoomTo(new Date('2026-10-01T00:00:00.000Z'), new Date('2026-10-01T06:00:00.000Z')));
    expect(result.current.rolling).toBe(false);
  });
});

describe('PeriodSelect', () => {
  it('Dashboard window is the first option only when asked for', () => {
    const { rerender } = render(<PeriodSelect name="p" value="24h" onChange={() => {}} />);
    expect(screen.getAllByRole('option')[0].textContent).toBe('Last 15 minutes');
    expect(screen.queryByRole('option', { name: 'Dashboard window' })).toBeNull();
    rerender(<PeriodSelect name="p" value="dashboard" onChange={() => {}} withDashboard />);
    const first = screen.getAllByRole('option')[0] as HTMLOptionElement;
    expect(first.textContent).toBe('Dashboard window');
    expect(first.value).toBe('dashboard');
  });
});
